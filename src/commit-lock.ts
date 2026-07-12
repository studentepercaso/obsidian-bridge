import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import type { Stats } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  rename,
  rm,
  type FileHandle,
} from "node:fs/promises";
import path from "node:path";

const LOCKS_DIRECTORY = "commit-locks";
const OWNER_FILE = "owner.json";
const MAX_OWNER_BYTES = 4_096;
const TRANSIENT_RENAME_RETRY_DELAYS_MS = [10, 25, 50] as const;

export const DEFAULT_COMMIT_LOCK_TIMEOUT_MS = 10_000;
export const DEFAULT_COMMIT_LOCK_RETRY_DELAY_MS = 50;
export const DEFAULT_COMMIT_LOCK_STALE_AFTER_MS = 10 * 60_000;

export type CommitLockErrorCode =
  | "INVALID_LOCK_OPTIONS"
  | "LOCK_ABORTED"
  | "LOCK_IO_ERROR"
  | "LOCK_OWNERSHIP_LOST"
  | "LOCK_TIMEOUT"
  | "UNSAFE_LOCK_PATH";

export class CommitLockError extends Error {
  constructor(
    readonly code: CommitLockErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CommitLockError";
  }
}

export interface CommitLockOptions {
  /** Absolute bridge data directory. Locks are stored below it. */
  readonly dataDirectory: string;
  /** Stable vault identifier or other canonical vault selector. */
  readonly vault: string;
  /** Canonical vault-relative note path. */
  readonly notePath: string;
  /** Match the path policy used to authorize the note. */
  readonly caseSensitive?: boolean;
  readonly timeoutMs?: number;
  readonly retryDelayMs?: number;
  readonly staleAfterMs?: number;
  readonly signal?: AbortSignal;
}

export interface CommitLock {
  /** SHA-256 lock key. It contains neither the vault nor the note path. */
  readonly key: string;
  /** Release is idempotent after its first successful call. */
  release(): Promise<void>;
}

/**
 * The protected operation completed and returned a result, but releasing its
 * filesystem lock failed afterwards. Callers can therefore report the
 * completed operation without incorrectly reclassifying it as a write failure.
 */
export class CommitLockReleaseAfterOperationError extends CommitLockError {
  constructor(
    readonly operationResult: unknown,
    readonly releaseError: CommitLockError,
  ) {
    super(
      releaseError.code,
      "commit operation completed but its lock could not be released cleanly",
      { cause: releaseError },
    );
    this.name = "CommitLockReleaseAfterOperationError";
  }
}

interface LockOwner {
  readonly token: string;
  readonly pid: number;
  readonly createdAt: string;
}

interface LockSnapshot {
  readonly stats: Stats;
  readonly owner: LockOwner | null;
}

function isNodeErrorWithCode(error: unknown, code: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === code
  );
}

function hasNodeErrorWithCode(error: unknown, code: string): boolean {
  let current = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (isNodeErrorWithCode(current, code)) return true;
    if (
      typeof current !== "object" ||
      current === null ||
      !("cause" in current)
    ) {
      return false;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function invalidOption(message: string): never {
  throw new CommitLockError("INVALID_LOCK_OPTIONS", message);
}

function validateIdentityPart(value: string, name: string): void {
  if (typeof value !== "string" || value.length === 0) {
    invalidOption(`${name} must be a non-empty string`);
  }
  if (value.includes("\u0000")) {
    invalidOption(`${name} must not contain NUL characters`);
  }
}

function validateMilliseconds(
  value: number,
  name: string,
  minimum: number,
): void {
  if (!Number.isSafeInteger(value) || value < minimum) {
    invalidOption(`${name} must be a safe integer greater than or equal to ${minimum}`);
  }
}

/** Derive a filename-safe key without exposing either user-controlled path. */
export function deriveCommitLockKey(
  vault: string,
  notePath: string,
  caseSensitive = true,
): string {
  validateIdentityPart(vault, "vault");
  validateIdentityPart(notePath, "notePath");
  const pathKey = caseSensitive
    ? notePath.normalize("NFC")
    : notePath.normalize("NFC").toLocaleLowerCase("en-US");
  return createHash("sha256")
    .update(vault, "utf8")
    .update("\u0000", "utf8")
    .update(pathKey, "utf8")
    .digest("hex");
}

/** Return the deterministic lock path. No filesystem access is performed. */
export function commitLockPath(
  dataDirectory: string,
  vault: string,
  notePath: string,
  caseSensitive = true,
): string {
  if (typeof dataDirectory !== "string" || !path.isAbsolute(dataDirectory)) {
    invalidOption("dataDirectory must be an absolute path");
  }
  return path.join(
    path.resolve(dataDirectory),
    LOCKS_DIRECTORY,
    `${deriveCommitLockKey(vault, notePath, caseSensitive)}.lock`,
  );
}

async function inspectDirectory(directory: string): Promise<Stats> {
  let stats;
  try {
    stats = await lstat(directory);
  } catch (error) {
    throw new CommitLockError("LOCK_IO_ERROR", "lock directory cannot be inspected", {
      cause: error,
    });
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new CommitLockError(
      "UNSAFE_LOCK_PATH",
      "lock path is not a real directory",
    );
  }
  return stats;
}

/**
 * Create and inspect every missing directory component independently. This
 * rejects symlinks and Windows junctions reported by lstat as reparse links.
 * Node has no portable openat(2), so every sensitive child is checked again
 * immediately before it is used.
 */
async function ensureSafeDirectoryChain(directory: string): Promise<void> {
  if (!path.isAbsolute(directory)) {
    invalidOption("dataDirectory must be an absolute path");
  }

  const normalized = path.resolve(directory);
  const root = path.parse(normalized).root;
  const relative = path.relative(root, normalized);
  const segments = relative === "" ? [] : relative.split(path.sep);
  let current = root;

  await inspectDirectory(root);
  for (const segment of segments) {
    current = path.join(current, segment);
    try {
      await mkdir(current, { mode: 0o700 });
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw new CommitLockError(
          "LOCK_IO_ERROR",
          "lock directory hierarchy cannot be created",
          { cause: error },
        );
      }
    }
    await inspectDirectory(current);
  }
}

function validateOwner(value: unknown): LockOwner {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is malformed");
  }

  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    typeof record.token !== "string" ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(
      record.token,
    ) ||
    !Number.isSafeInteger(record.pid) ||
    (record.pid as number) <= 0 ||
    typeof record.createdAt !== "string"
  ) {
    throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is malformed");
  }

  const createdAtMs = Date.parse(record.createdAt);
  if (
    !Number.isFinite(createdAtMs) ||
    new Date(createdAtMs).toISOString() !== record.createdAt
  ) {
    throw new CommitLockError(
      "UNSAFE_LOCK_PATH",
      "lock owner has an invalid creation time",
    );
  }

  return {
    token: record.token,
    pid: record.pid as number,
    createdAt: record.createdAt,
  };
}

async function safelyOpenOwner(ownerPath: string): Promise<FileHandle> {
  try {
    return await open(
      ownerPath,
      process.platform === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new CommitLockError("LOCK_IO_ERROR", "lock owner cannot be opened", {
      cause: error,
    });
  }
}

async function readOwner(lockDirectory: string): Promise<LockOwner | null> {
  const ownerPath = path.join(lockDirectory, OWNER_FILE);
  let linkStats;
  try {
    linkStats = await lstat(ownerPath);
  } catch (error) {
    if (isNodeErrorWithCode(error, "ENOENT")) return null;
    throw new CommitLockError("LOCK_IO_ERROR", "lock owner cannot be inspected", {
      cause: error,
    });
  }

  if (
    linkStats.isSymbolicLink() ||
    !linkStats.isFile() ||
    linkStats.nlink !== 1 ||
    linkStats.size > MAX_OWNER_BYTES
  ) {
    throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is not a safe file");
  }

  const handle = await safelyOpenOwner(ownerPath);
  try {
    const stats = await handle.stat();
    if (!stats.isFile() || stats.nlink !== 1 || stats.size > MAX_OWNER_BYTES) {
      throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is not a safe file");
    }
    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_OWNER_BYTES) {
      throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is too large");
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch (error) {
      throw new CommitLockError("UNSAFE_LOCK_PATH", "lock owner is not valid JSON", {
        cause: error,
      });
    }
    return validateOwner(parsed);
  } finally {
    await handle.close();
  }
}

async function snapshotLock(lockDirectory: string): Promise<LockSnapshot> {
  const stats = await inspectDirectory(lockDirectory);
  const owner = await readOwner(lockDirectory);
  return { stats, owner };
}

async function writeOwner(lockDirectory: string, owner: LockOwner): Promise<void> {
  const temporaryPath = path.join(lockDirectory, `.owner-${owner.token}.tmp`);
  const ownerPath = path.join(lockDirectory, OWNER_FILE);
  let handle: FileHandle | undefined;
  try {
    handle = await open(temporaryPath, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(owner)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await rename(temporaryPath, ownerPath);
    const stored = await readOwner(lockDirectory);
    if (
      stored === null ||
      stored.token !== owner.token ||
      stored.pid !== owner.pid ||
      stored.createdAt !== owner.createdAt
    ) {
      throw new CommitLockError(
        "LOCK_OWNERSHIP_LOST",
        "lock owner changed while it was being created",
      );
    }
  } catch (error) {
    if (error instanceof CommitLockError) throw error;
    throw new CommitLockError("LOCK_IO_ERROR", "lock owner cannot be written", {
      cause: error,
    });
  } finally {
    if (handle !== undefined) await handle.close().catch(() => undefined);
    await rm(temporaryPath, { force: true }).catch(() => undefined);
  }
}

function sameDirectory(left: LockSnapshot["stats"], right: LockSnapshot["stats"]): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameOwner(left: LockOwner | null, right: LockOwner | null): boolean {
  if (left === null || right === null) return left === right;
  return (
    left.token === right.token &&
    left.pid === right.pid &&
    left.createdAt === right.createdAt
  );
}

function isTransientRenameError(error: unknown): boolean {
  return (
    isNodeErrorWithCode(error, "EPERM") ||
    isNodeErrorWithCode(error, "EBUSY")
  );
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

async function verifyLockStillMatches(
  lockDirectory: string,
  expected: LockSnapshot,
): Promise<boolean> {
  let current: LockSnapshot;
  try {
    current = await snapshotLock(lockDirectory);
  } catch (error) {
    if (hasNodeErrorWithCode(error, "ENOENT")) return false;
    throw error;
  }

  if (!sameDirectory(expected.stats, current.stats)) {
    throw new CommitLockError(
      "UNSAFE_LOCK_PATH",
      "lock directory identity changed before an atomic transition",
    );
  }
  if (!sameOwner(expected.owner, current.owner)) {
    throw new CommitLockError(
      "LOCK_OWNERSHIP_LOST",
      "lock owner changed before an atomic transition",
    );
  }
  return true;
}

function processMayStillBeAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // Permission errors are treated as evidence that the process may exist.
    return !isNodeErrorWithCode(error, "ESRCH");
  }
}

function isStale(snapshot: LockSnapshot, staleAfterMs: number, now: number): boolean {
  if (snapshot.owner !== null && processMayStillBeAlive(snapshot.owner.pid)) {
    return false;
  }
  const timestamp =
    snapshot.owner === null
      ? snapshot.stats.mtimeMs
      : Date.parse(snapshot.owner.createdAt);
  return now - timestamp >= staleAfterMs;
}

async function restoreUnexpectedDirectory(
  quarantinePath: string,
  lockDirectory: string,
): Promise<never> {
  try {
    await rename(quarantinePath, lockDirectory);
  } catch (error) {
    throw new CommitLockError(
      "UNSAFE_LOCK_PATH",
      "lock identity changed and its directory could not be restored",
      { cause: error },
    );
  }
  throw new CommitLockError(
    "UNSAFE_LOCK_PATH",
    "lock identity changed during an atomic transition",
  );
}

async function renameVerifiedAndRemove(
  lockDirectory: string,
  snapshot: LockSnapshot,
  transition: "release" | "stale",
): Promise<boolean> {
  const quarantinePath = `${lockDirectory}.${transition}-${randomUUID()}`;
  for (let attempt = 0; ; attempt += 1) {
    if (!(await verifyLockStillMatches(lockDirectory, snapshot))) return false;

    try {
      await rename(lockDirectory, quarantinePath);
      break;
    } catch (error) {
      if (isNodeErrorWithCode(error, "ENOENT")) return false;
      if (isTransientRenameError(error)) {
        const retryDelayMs = TRANSIENT_RENAME_RETRY_DELAYS_MS[attempt];
        if (retryDelayMs !== undefined) {
          await delay(retryDelayMs);
          continue;
        }
      }
      throw new CommitLockError(
        "LOCK_IO_ERROR",
        "lock cannot be renamed safely",
        { cause: error },
      );
    }
  }

  let moved: LockSnapshot;
  try {
    moved = await snapshotLock(quarantinePath);
  } catch (error) {
    // Never recursively remove a directory that cannot be proven to be the
    // exact lock inspected before the rename.
    return restoreUnexpectedDirectory(quarantinePath, lockDirectory);
  }

  if (
    !sameDirectory(snapshot.stats, moved.stats) ||
    !sameOwner(snapshot.owner, moved.owner)
  ) {
    return restoreUnexpectedDirectory(quarantinePath, lockDirectory);
  }

  try {
    await rm(quarantinePath, { recursive: true });
  } catch (error) {
    throw new CommitLockError("LOCK_IO_ERROR", "renamed lock cannot be removed", {
      cause: error,
    });
  }
  return true;
}

async function reclaimIfStale(
  lockDirectory: string,
  staleAfterMs: number,
): Promise<boolean> {
  const snapshot = await snapshotLock(lockDirectory);
  if (!isStale(snapshot, staleAfterMs, Date.now())) return false;
  return renameVerifiedAndRemove(lockDirectory, snapshot, "stale");
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const options = signal.reason === undefined ? undefined : { cause: signal.reason };
  throw new CommitLockError("LOCK_ABORTED", "commit lock acquisition was aborted", options);
}

async function abortableDelay(
  milliseconds: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  throwIfAborted(signal);
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, milliseconds);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      const options = signal?.reason === undefined ? undefined : { cause: signal.reason };
      reject(
        new CommitLockError(
          "LOCK_ABORTED",
          "commit lock acquisition was aborted",
          options,
        ),
      );
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function cleanFailedAcquisition(lockDirectory: string, token: string): Promise<void> {
  let snapshot: LockSnapshot;
  try {
    snapshot = await snapshotLock(lockDirectory);
  } catch {
    // A missing/partial owner is expected if initialization itself failed. It
    // will be reclaimed after the configured stale interval.
    return;
  }
  if (snapshot.owner?.token !== token) return;
  await renameVerifiedAndRemove(lockDirectory, snapshot, "release");
}

/** Acquire an exclusive cross-process lock for one canonical vault/note pair. */
export async function acquireCommitLock(
  options: CommitLockOptions,
): Promise<CommitLock> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_COMMIT_LOCK_TIMEOUT_MS;
  const retryDelayMs =
    options.retryDelayMs ?? DEFAULT_COMMIT_LOCK_RETRY_DELAY_MS;
  const staleAfterMs =
    options.staleAfterMs ?? DEFAULT_COMMIT_LOCK_STALE_AFTER_MS;
  validateMilliseconds(timeoutMs, "timeoutMs", 0);
  validateMilliseconds(retryDelayMs, "retryDelayMs", 1);
  validateMilliseconds(staleAfterMs, "staleAfterMs", 1);

  const lockDirectory = commitLockPath(
    options.dataDirectory,
    options.vault,
    options.notePath,
    options.caseSensitive ?? true,
  );
  const lockRoot = path.dirname(lockDirectory);
  throwIfAborted(options.signal);
  await ensureSafeDirectoryChain(options.dataDirectory);
  await ensureSafeDirectoryChain(lockRoot);
  throwIfAborted(options.signal);

  const deadline = Date.now() + timeoutMs;
  for (;;) {
    throwIfAborted(options.signal);
    await inspectDirectory(lockRoot);

    let acquired = false;
    try {
      await mkdir(lockDirectory, { mode: 0o700 });
      acquired = true;
    } catch (error) {
      if (!isNodeErrorWithCode(error, "EEXIST")) {
        throw new CommitLockError("LOCK_IO_ERROR", "commit lock cannot be created", {
          cause: error,
        });
      }
    }

    if (acquired) {
      const owner: LockOwner = {
        token: randomUUID(),
        pid: process.pid,
        createdAt: new Date().toISOString(),
      };
      try {
        await writeOwner(lockDirectory, owner);
        throwIfAborted(options.signal);
      } catch (error) {
        await cleanFailedAcquisition(lockDirectory, owner.token).catch(
          () => undefined,
        );
        throw error;
      }

      let released = false;
      return {
        key: deriveCommitLockKey(
          options.vault,
          options.notePath,
          options.caseSensitive ?? true,
        ),
        async release(): Promise<void> {
          if (released) return;
          const snapshot = await snapshotLock(lockDirectory);
          if (snapshot.owner?.token !== owner.token) {
            throw new CommitLockError(
              "LOCK_OWNERSHIP_LOST",
              "commit lock is no longer owned by this handle",
            );
          }
          const removed = await renameVerifiedAndRemove(
            lockDirectory,
            snapshot,
            "release",
          );
          if (!removed) {
            throw new CommitLockError(
              "LOCK_OWNERSHIP_LOST",
              "commit lock disappeared before release",
            );
          }
          released = true;
        },
      };
    }

    let reclaimed = false;
    try {
      reclaimed = await reclaimIfStale(lockDirectory, staleAfterMs);
    } catch (error) {
      // A normal owner may release between our EEXIST result and inspection.
      if (hasNodeErrorWithCode(error, "ENOENT")) continue;
      throw error;
    }
    if (reclaimed) continue;

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new CommitLockError(
        "LOCK_TIMEOUT",
        `commit lock was not acquired within ${timeoutMs} ms`,
      );
    }
    await abortableDelay(Math.min(retryDelayMs, remaining), options.signal);
  }
}

/** Execute an operation while holding its per-vault/note commit lock. */
export async function withCommitLock<T>(
  options: CommitLockOptions,
  operation: () => Promise<T>,
): Promise<T> {
  const lock = await acquireCommitLock(options);
  let result: T;
  try {
    result = await operation();
  } catch (operationError) {
    // Preserve the operation's primary failure. A release failure here is
    // secondary and must not replace its already-recorded recovery outcome.
    await lock.release().catch(() => undefined);
    throw operationError;
  }

  try {
    await lock.release();
  } catch (error) {
    const releaseError =
      error instanceof CommitLockError
        ? error
        : new CommitLockError(
            "LOCK_IO_ERROR",
            "commit lock could not be released after the operation completed",
            { cause: error },
          );
    throw new CommitLockReleaseAfterOperationError(result, releaseError);
  }
  return result;
}
