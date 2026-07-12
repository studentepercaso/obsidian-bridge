import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, unlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  MAX_CLI_IPC_FRAME_BYTES,
  buildWriteVaultArgs,
  assertCliContentRepresentable,
  cliIpcFrameBytes,
  encodeCliContent,
  isCliContentRepresentable,
  ObsidianCliError,
  type CliInvocationOptions,
  type ObsidianCliRunner,
} from "./cli.js";
import { assertPathAllowed, type PathPolicy } from "./path-policy.js";
import {
  assertPhysicalVaultPath,
  PhysicalScopeError,
} from "./physical-scope.js";
import type { VaultAccess, VaultAccessResolver } from "./shared-settings.js";
import { jsonResult } from "./tool-helpers.js";
import { assertVaultIdentity } from "./vault-identity.js";
import {
  CommitLockError,
  CommitLockReleaseAfterOperationError,
  deriveCommitLockKey,
  withCommitLock as withFileCommitLock,
} from "./commit-lock.js";
import {
  readExactVaultDocument,
  type ExactVaultDocument,
  type ExactVaultDocumentReadOptions,
} from "./exact-vault-document.js";

export const MAX_CHANGE_CONTENT_BYTES = 8_192;
export const MAX_DOCUMENT_BYTES = 16_384;
export const MAX_PREVIEW_BYTES = 16_384;
export const MAX_WRITE_OBSERVATION_BYTES = 1_048_576;
export const DEFAULT_BACKUP_RETENTION = 20;
export const DEFAULT_MAX_PENDING_CHANGES = 100;
export const MAX_CONSECUTIVE_AUTONOMOUS_FAILURES = 3;

export type ChangeOperation = "create" | "append";
export type WriteAuthorizationMode = "protected" | "autonomous";

const controlCharactersExceptNewlineAndTab = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;

const WriteContent = z
  .string()
  .min(1, "content must not be empty")
  .refine(
    (value) => !controlCharactersExceptNewlineAndTab.test(value),
    "content contains unsupported control characters",
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_CHANGE_CONTENT_BYTES,
    `content must not exceed ${MAX_CHANGE_CONTENT_BYTES} UTF-8 bytes`,
  )
  .refine(
    isCliContentRepresentable,
    "content contains a literal \\n or \\t sequence that the Obsidian CLI cannot represent losslessly",
  );

export const WriteToolInputSchemas = Object.freeze({
  prepareChange: z
    .object({
      vault: z.string().trim().min(1).max(256),
      path: z.string().min(4).max(1_024).regex(/\.md$/iu),
      operation: z.enum(["create", "append"]),
      content: WriteContent,
    })
    .strict(),
  commitChange: z
    .object({
      change_id: z.string().uuid(),
    })
    .strict(),
});

export type PrepareChangeInput = z.infer<
  typeof WriteToolInputSchemas.prepareChange
>;
export type CommitChangeInput = z.infer<typeof WriteToolInputSchemas.commitChange>;

export interface DocumentState {
  readonly exists: boolean;
  readonly content?: string;
  readonly sha256: string;
}

export interface PreparedChange {
  readonly changeId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  /** Stable ID used for CLI targeting and audit records. */
  readonly vault: string;
  /** Human-readable label shown in previews and commit results. */
  readonly vaultLabel: string;
  readonly notePath: string;
  readonly operation: ChangeOperation;
  readonly authorizationMode: WriteAuthorizationMode;
  /** Preserve the path-comparison semantics used by the authorizing policy. */
  readonly lockCaseSensitive: boolean;
  readonly before: DocumentState;
  readonly afterContent: string;
  readonly commandContent: string;
  readonly afterSha256: string;
  readonly previewDiff: string;
  readonly beforeLineCount: number;
  readonly afterLineCount: number;
}

export interface PreparedChangeStoreOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly maxPending?: number;
}

export class ChangeNotFoundError extends Error {
  readonly code = "CHANGE_NOT_FOUND";

  constructor(message = "change_id is unknown, expired, or already consumed") {
    super(message);
    this.name = "ChangeNotFoundError";
  }
}

export class ChangeConflictError extends Error {
  readonly code = "CHANGE_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "ChangeConflictError";
  }
}

class PostWriteVerificationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PostWriteVerificationError";
  }
}

export type AuditFailureStage =
  | "pre_write"
  | "write"
  | "verification"
  | "commit_lock";

/** Return a bounded code only; exception messages can contain note content. */
function diagnosticCauseCode(error: unknown): string {
  const classify = (current: unknown, depth: number): string => {
    if (depth > 3) return "UNEXPECTED_ERROR";
    try {
      if (current instanceof ObsidianCliError) {
        const code: unknown = current.code;
        switch (code) {
          case "INVALID_ARGUMENTS":
            return "CLI_INVALID_ARGUMENTS";
          case "SPAWN_FAILED":
            return "CLI_SPAWN_FAILED";
          case "TIMEOUT":
            return "CLI_TIMEOUT";
          case "OUTPUT_LIMIT":
            return "CLI_OUTPUT_LIMIT";
          case "ABORTED":
            return "CLI_ABORTED";
          case "CLI_NOT_ENABLED":
            return "CLI_NOT_ENABLED";
          case "CLI_REPORTED_ERROR":
            return "CLI_REPORTED_ERROR";
          case "NON_ZERO_EXIT":
            return "CLI_NON_ZERO_EXIT";
          default:
            return "UNEXPECTED_ERROR";
        }
      }
      if (current instanceof ChangeConflictError) return "CHANGE_CONFLICT";
      if (current instanceof PhysicalScopeError) {
        return "PHYSICAL_PATH_NOT_ALLOWED";
      }
      if (current instanceof CommitLockError) {
        const code: unknown = current.code;
        switch (code) {
          case "INVALID_LOCK_OPTIONS":
            return "COMMIT_INVALID_LOCK_OPTIONS";
          case "LOCK_ABORTED":
            return "COMMIT_LOCK_ABORTED";
          case "LOCK_IO_ERROR":
            return "COMMIT_LOCK_IO_ERROR";
          case "LOCK_OWNERSHIP_LOST":
            return "COMMIT_LOCK_OWNERSHIP_LOST";
          case "LOCK_TIMEOUT":
            return "COMMIT_LOCK_TIMEOUT";
          case "UNSAFE_LOCK_PATH":
            return "COMMIT_UNSAFE_LOCK_PATH";
          default:
            return "UNEXPECTED_ERROR";
        }
      }
      if (current instanceof PostWriteVerificationError) {
        const cause: unknown = current.cause;
        return cause === undefined
          ? "POST_WRITE_VERIFICATION"
          : classify(cause, depth + 1);
      }
      if (current instanceof RangeError) return "RANGE_ERROR";
      return "UNEXPECTED_ERROR";
    } catch {
      return "UNEXPECTED_ERROR";
    }
  };

  try {
    return classify(error, 0);
  } catch {
    return "UNEXPECTED_ERROR";
  }
}

export class PreparedChangeStore {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #maxPending: number;
  readonly #changes = new Map<string, PreparedChange>();

  constructor(options: PreparedChangeStoreOptions) {
    if (!Number.isSafeInteger(options.ttlMs) || options.ttlMs < 1) {
      throw new RangeError("ttlMs must be a positive integer");
    }
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#maxPending = options.maxPending ?? DEFAULT_MAX_PENDING_CHANGES;
  }

  create(
    value: Omit<PreparedChange, "changeId" | "createdAt" | "expiresAt">,
  ): PreparedChange {
    const now = this.#now();
    this.#removeExpired(now);
    if (this.#changes.size >= this.#maxPending) {
      throw new Error("too many pending changes; commit or wait for expiry");
    }

    const change: PreparedChange = Object.freeze({
      ...value,
      changeId: this.#createId(),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    });
    this.#changes.set(change.changeId, change);
    return change;
  }

  /** Remove first, so every commit attempt is strictly single-use. */
  take(changeId: string): PreparedChange {
    const change = this.#changes.get(changeId);
    this.#changes.delete(changeId);
    if (change === undefined || change.expiresAt <= this.#now()) {
      throw new ChangeNotFoundError();
    }
    return change;
  }

  get size(): number {
    this.#removeExpired(this.#now());
    return this.#changes.size;
  }

  #removeExpired(now: number): void {
    for (const [id, change] of this.#changes) {
      if (change.expiresAt <= now) this.#changes.delete(id);
    }
  }
}

export interface BackupInput {
  readonly vault: string;
  readonly notePath: string;
  readonly beforeSha256: string;
  readonly content: string;
  readonly createdAt: number;
}

export interface AuditEvent {
  readonly timestamp: string;
  readonly change_id: string;
  readonly vault: string;
  readonly path: string;
  readonly operation: ChangeOperation;
  readonly status: "committed" | "failed";
  readonly authorization_mode: WriteAuthorizationMode;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly backup_id?: string;
  readonly error_code?: string;
  readonly failure_stage?: AuditFailureStage;
  readonly cause_code?: string;
  readonly rollback_attempted?: boolean;
  readonly rollback_succeeded?: boolean;
  readonly rollback_reason?: string;
}

export interface ChangeStorage {
  createBackup(input: BackupInput): Promise<{ readonly backupId: string }>;
  appendAudit(event: AuditEvent): Promise<void>;
}

export class FileChangeStorage implements ChangeStorage {
  readonly #dataDirectory: string;
  readonly #backupRetention: number;

  constructor(dataDirectory: string, backupRetention = DEFAULT_BACKUP_RETENTION) {
    if (!path.isAbsolute(dataDirectory)) {
      throw new Error("change storage directory must be absolute");
    }
    if (!Number.isSafeInteger(backupRetention) || backupRetention < 1) {
      throw new RangeError("backupRetention must be a positive integer");
    }
    this.#dataDirectory = path.resolve(dataDirectory);
    this.#backupRetention = backupRetention;
  }

  async createBackup(input: BackupInput): Promise<{ readonly backupId: string }> {
    const backupDirectory = path.join(this.#dataDirectory, "backups");
    await ensurePrivateDirectory(this.#dataDirectory);
    await ensurePrivateDirectory(backupDirectory);

    const backupId = `${new Date(input.createdAt)
      .toISOString()
      .replaceAll(":", "-")}-${randomUUID()}`;
    const backupPath = path.join(backupDirectory, `${backupId}.json`);
    await writeFile(
      backupPath,
      JSON.stringify(
        {
          version: 1,
          created_at: new Date(input.createdAt).toISOString(),
          vault: input.vault,
          path: input.notePath,
          before_sha256: input.beforeSha256,
          content: input.content,
        },
        null,
        2,
      ),
      { encoding: "utf8", flag: "wx", mode: 0o600 },
    );
    await setPrivateFileMode(backupPath);
    await this.#pruneBackups(backupDirectory);
    return { backupId };
  }

  async appendAudit(event: AuditEvent): Promise<void> {
    await ensurePrivateDirectory(this.#dataDirectory);
    const auditPath = path.join(this.#dataDirectory, "audit.ndjson");
    await appendFile(auditPath, `${JSON.stringify(event)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await setPrivateFileMode(auditPath);
  }

  async #pruneBackups(backupDirectory: string): Promise<void> {
    const entries = (await readdir(backupDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    await Promise.all(
      entries
        .slice(this.#backupRetention)
        .map(async (name) => await unlink(path.join(backupDirectory, name))),
    );
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function setPrivateFileMode(file: string): Promise<void> {
  try {
    await chmod(file, 0o600);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

function normalizeContent(content: string): string {
  return content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
}

/**
 * Split on Unicode code-point boundaries and size the complete Obsidian IPC
 * frame, including vault, path, flags, cwd and JSON escaping. `create` with
 * `overwrite` is the largest write shape, so chunks that fit it also fit
 * `append inline`.
 */
export function splitCliWriteContent(
  vault: string,
  notePath: string,
  content: string,
): string[] {
  const normalized = normalizeContent(content);
  assertCliContentRepresentable(normalized);

  const fits = (candidate: string): boolean =>
    cliIpcFrameBytes([
      `vault=${vault}`,
      "create",
      `path=${notePath}`,
      `content=${encodeCliContent(candidate)}`,
      "overwrite",
    ]) <= MAX_CLI_IPC_FRAME_BYTES;

  if (normalized.length === 0) {
    if (!fits("")) {
      throw new RangeError("vault and note path leave no safe CLI payload capacity");
    }
    return [""];
  }

  const chunks: string[] = [];
  let current = "";
  for (const codePoint of normalized) {
    const candidate = `${current}${codePoint}`;
    if (fits(candidate)) {
      current = candidate;
      continue;
    }
    if (current.length === 0) {
      throw new RangeError("one content character cannot fit the safe CLI IPC frame");
    }
    chunks.push(current);
    current = codePoint;
    if (!fits(current)) {
      throw new RangeError("one content character cannot fit the safe CLI IPC frame");
    }
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export function hashDocumentState(
  exists: boolean,
  content = "",
): string {
  const hash = createHash("sha256");
  hash.update(exists ? "present\0" : "missing\0", "utf8");
  if (exists) hash.update(content, "utf8");
  return hash.digest("hex");
}

function lineArray(content: string): string[] {
  if (content.length === 0) return [];
  const lines = normalizeContent(content).split("\n");
  if (content.endsWith("\n")) lines.pop();
  return lines;
}

export function createPreviewDiff(
  notePath: string,
  beforeContent: string | undefined,
  afterContent: string,
): string {
  const before = lineArray(beforeContent ?? "");
  const after = lineArray(afterContent);
  let prefix = 0;
  while (
    prefix < before.length &&
    prefix < after.length &&
    before[prefix] === after[prefix]
  ) {
    prefix += 1;
  }
  let suffix = 0;
  while (
    suffix < before.length - prefix &&
    suffix < after.length - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix += 1;
  }

  const removed = before.slice(prefix, before.length - suffix);
  const added = after.slice(prefix, after.length - suffix);
  const oldStart = removed.length === 0 ? prefix : prefix + 1;
  const newStart = added.length === 0 ? prefix : prefix + 1;
  const header = [
    beforeContent === undefined ? "--- /dev/null" : `--- a/${notePath}`,
    `+++ b/${notePath}`,
    `@@ -${oldStart},${removed.length} +${newStart},${added.length} @@`,
  ];
  const diff = [
    ...header,
    ...removed.map((line) => `-${line}`),
    ...added.map((line) => `+${line}`),
  ];
  const normalizedBefore = normalizeContent(beforeContent ?? "");
  const normalizedAfter = normalizeContent(afterContent);
  if (beforeContent !== undefined) {
    const beforeEndsWithNewline = normalizedBefore.endsWith("\n");
    const afterEndsWithNewline = normalizedAfter.endsWith("\n");
    if (beforeEndsWithNewline !== afterEndsWithNewline) {
      diff.push(
        `\\ EOF newline changed: ${
          beforeEndsWithNewline ? "present" : "absent"
        } -> ${afterEndsWithNewline ? "present" : "absent"}`,
      );
    }
  } else if (normalizedAfter.length > 0 && !normalizedAfter.endsWith("\n")) {
    diff.push("\\ New file has no newline at end of file");
  }
  return diff.join("\n");
}

function assertDocumentSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_DOCUMENT_BYTES) {
    throw new RangeError(
      `resulting document must not exceed ${MAX_DOCUMENT_BYTES} UTF-8 bytes`,
    );
  }
}

function assertWriteObservationSize(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_WRITE_OBSERVATION_BYTES) {
    throw new RangeError(
      `resulting document must not exceed ${MAX_WRITE_OBSERVATION_BYTES} UTF-8 bytes`,
    );
  }
}

function assertPreviewSize(diff: string): void {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_PREVIEW_BYTES) {
    throw new RangeError(
      `preview diff must not exceed ${MAX_PREVIEW_BYTES} UTF-8 bytes`,
    );
  }
}

function assertSameState(
  expected: DocumentState,
  actual: DocumentState,
): void {
  if (expected.exists !== actual.exists || expected.sha256 !== actual.sha256) {
    throw new ChangeConflictError(
      "the note changed after preparation; prepare a new change",
    );
  }
}

async function writePreparedChangeInChunks(
  runner: ObsidianCliRunner,
  change: PreparedChange,
  options: CliInvocationOptions,
  bridgeWrittenHashes: Set<string>,
  beforeChunk: (allowMissingLeaf: boolean) => Promise<VaultAccess>,
  readCurrent: (
    access: VaultAccess,
    options: CliInvocationOptions,
  ) => Promise<DocumentState>,
  onWriteAttempt: () => void,
): Promise<void> {
  const content =
    change.operation === "create" ? change.afterContent : change.commandContent;
  const chunks = splitCliWriteContent(change.vault, change.notePath, content);
  let expectedContent =
    change.operation === "append" ? change.before.content : "";
  if (expectedContent === undefined) {
    throw new Error("append change is missing its prepared source content");
  }

  for (let index = 0; index < chunks.length; index += 1) {
    const chunk = chunks[index]!;
    const firstCreate = change.operation === "create" && index === 0;
    const currentAccess = await beforeChunk(firstCreate);

    expectedContent = `${expectedContent}${chunk}`;
    const expectedHash = hashDocumentState(true, expectedContent);
    bridgeWrittenHashes.add(expectedHash);
    onWriteAttempt();

    await runner(
      firstCreate
        ? buildWriteVaultArgs(change.vault, "create", [
            `path=${change.notePath}`,
            `content=${encodeCliContent(chunk)}`,
          ])
        : buildWriteVaultArgs(change.vault, "append", [
            `path=${change.notePath}`,
            `content=${encodeCliContent(chunk)}`,
            "inline",
          ]),
      options,
    );

    let observed: DocumentState;
    try {
      observed = await readCurrent(currentAccess, options);
    } catch (error) {
      throw new PostWriteVerificationError(
        "chunked CLI write could not be read back",
        { cause: error },
      );
    }
    if (!observed.exists || observed.sha256 !== expectedHash) {
      throw new PostWriteVerificationError(
        "chunked CLI write did not match its expected intermediate hash",
      );
    }
  }

  if (hashDocumentState(true, expectedContent) !== change.afterSha256) {
    throw new PostWriteVerificationError(
      "chunked CLI write did not reconstruct the prepared content",
    );
  }
}

async function attemptRollback(
  change: PreparedChange,
  options: CliInvocationOptions,
  bridgeWrittenHashes: ReadonlySet<string>,
  verifyRecoveryGrant: (allowMissingLeaf: boolean) => Promise<void>,
  readCurrent: (options: CliInvocationOptions) => Promise<DocumentState>,
): Promise<{
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly reason:
    | "unchanged"
    | "concurrent_change"
    | "delete_disabled"
    | "recovery_scope_changed"
    | "read_failed"
    | "manual_recovery_required";
}> {
  try {
    await verifyRecoveryGrant(change.operation === "create");
  } catch {
    return {
      attempted: false,
      succeeded: false,
      reason: "recovery_scope_changed",
    };
  }

  let current: DocumentState;
  try {
    current = await readCurrent(options);
  } catch {
    return { attempted: false, succeeded: false, reason: "read_failed" };
  }

  if (
    current.exists === change.before.exists &&
    current.sha256 === change.before.sha256
  ) {
    return { attempted: false, succeeded: true, reason: "unchanged" };
  }

  if (!current.exists || !bridgeWrittenHashes.has(current.sha256)) {
    // Never overwrite a state that may contain a concurrent manual edit.
    return {
      attempted: false,
      succeeded: false,
      reason: "concurrent_change",
    };
  }

  if (!change.before.exists || change.before.content === undefined) {
    // Deleting a newly created file is deliberately outside the CLI allowlist.
    return { attempted: false, succeeded: false, reason: "delete_disabled" };
  }

  // The official CLI has no compare-and-swap overwrite. Even a second exact
  // read would leave an IPC window in which Obsidian, sync software, or a user
  // could edit the note before `create overwrite` lands. Preserve the bounded
  // plaintext backup and require an explicit future recovery operation instead
  // of risking a destructive automatic rollback.
  return {
    attempted: false,
    succeeded: false,
    reason: "manual_recovery_required",
  };
}

export interface WriteToolRuntime {
  readonly runner: ObsidianCliRunner;
  readonly readPolicy: PathPolicy;
  readonly writablePolicy: PathPolicy;
  readonly writableVaults: readonly string[];
  readonly store: PreparedChangeStore;
  readonly storage: ChangeStorage;
  readonly now?: () => number;
  readonly resolveAccess?: VaultAccessResolver;
  /** The prompt-approved or separately auto-approved MCP writer channel. */
  readonly authorizationMode?: WriteAuthorizationMode;
  /** Enables serialization across protected and autonomous MCP processes. */
  readonly dataDirectory?: string;
  /** Test seam; settings-backed production reads use readExactVaultDocument(). */
  readonly exactDocumentReader?: (
    vaultPath: string,
    notePath: string,
    options: ExactVaultDocumentReadOptions,
  ) => Promise<ExactVaultDocument>;
  /** Unit-test seam; production server wiring never supplies this reader. */
  readonly documentStateReaderForTests?: (
    access: VaultAccess,
    notePath: string,
    options: CliInvocationOptions,
  ) => Promise<DocumentState>;
}

interface LockedOperationResult<T> {
  readonly result: T;
  readonly releaseError?: CommitLockError;
}

function annotateCommitLockResult(
  result: CallToolResult,
  releaseError: CommitLockError | undefined,
): CallToolResult {
  const first = result.content.length === 1 ? result.content[0] : undefined;
  if (first?.type !== "text") return result;

  try {
    const parsed = JSON.parse(first.text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return result;
    }
    const annotated = jsonResult({
      ...(parsed as Record<string, unknown>),
      lock_released: releaseError === undefined,
      ...(releaseError === undefined
        ? {}
        : { lock_release_error: releaseError.code }),
    });
    return { ...result, content: annotated.content };
  } catch {
    // Every internal commit outcome is JSON. Preserve it rather than turning a
    // completed vault operation into a new error if that invariant is broken.
    return result;
  }
}

export function createWriteToolHandlers(runtime: WriteToolRuntime) {
  const now = runtime.now ?? Date.now;
  const authorizationMode = runtime.authorizationMode ?? "protected";
  const exactDocumentReader =
    runtime.exactDocumentReader ?? readExactVaultDocument;
  const commitLocks = new Map<string, Promise<void>>();
  let consecutiveAutonomousFailures = 0;
  let autonomousWritesPaused = false;

  function assertAutonomousCircuitOpen(): void {
    if (authorizationMode !== "autonomous" || !autonomousWritesPaused) return;
    throw new Error(
      "autonomous writing is paused after three consecutive failures; inspect Problemi recenti, switch to protected access, and start a new task before enabling it again",
    );
  }

  function recordAutonomousSuccess(): void {
    if (authorizationMode !== "autonomous") return;
    consecutiveAutonomousFailures = 0;
  }

  function recordAutonomousFailure(): void {
    if (authorizationMode !== "autonomous") return;
    consecutiveAutonomousFailures += 1;
    if (
      consecutiveAutonomousFailures >= MAX_CONSECUTIVE_AUTONOMOUS_FAILURES
    ) {
      autonomousWritesPaused = true;
    }
  }

  async function effectiveAccess(vault: string): Promise<VaultAccess> {
    if (runtime.resolveAccess !== undefined) {
      return await runtime.resolveAccess(vault);
    }
    return {
      readPolicy: runtime.readPolicy,
      writablePolicy: runtime.writablePolicy,
      writeEnabled: runtime.writableVaults.includes(vault),
      accessMode: "protected",
      managementPermissions: { edit: false, move: false, trash: false },
      vaultSelector: vault,
      vaultName: vault,
      source: "environment",
    };
  }

  async function assertChangeAllowed(
    vault: string,
    notePath: string,
  ): Promise<{ readonly notePath: string; readonly access: VaultAccess }> {
    const access = await effectiveAccess(vault);
    if (
      access.source !== "settings" &&
      runtime.documentStateReaderForTests === undefined
    ) {
      throw new Error(
        "safe writing requires Bridge Control shared settings with a verified physical vault path; migrate the legacy environment-only writer configuration",
      );
    }
    const accessModeAllowed =
      authorizationMode === "autonomous"
        ? access.accessMode === "full" || access.accessMode === "management"
        : access.accessMode === "protected";
    if (!accessModeAllowed) {
      throw new Error(
        authorizationMode === "autonomous"
          ? "autonomous writing requires Accesso autonomo or Gestione completa for this vault in Bridge Control"
          : "this vault uses autonomous or management access; use the autonomous writer channel or return to protected access",
      );
    }
    if (!access.writeEnabled) {
      if (access.source === "environment") {
        throw new Error(
          runtime.writableVaults.length === 0
            ? "writing is disabled; configure OBSIDIAN_BRIDGE_WRITABLE_VAULTS"
            : "vault is outside OBSIDIAN_BRIDGE_WRITABLE_VAULTS",
        );
      }
      throw new Error("writing is disabled for this vault in shared settings");
    }
    if (
      access.writablePolicy.allowedFolders !== null &&
      access.writablePolicy.allowedFolders.length === 0
    ) {
      throw new Error(
        access.source === "environment"
          ? "writing is disabled; configure OBSIDIAN_BRIDGE_WRITABLE_FOLDERS"
          : "writing is disabled; choose a writable folder in shared settings",
      );
    }
    const readablePath = assertPathAllowed(notePath, access.readPolicy);
    return {
      notePath: assertPathAllowed(readablePath, access.writablePolicy),
      access,
    };
  }

  function assertSameVault(original: VaultAccess, current: VaultAccess): void {
    if (
      original.vaultSelector !== current.vaultSelector ||
      original.vaultPath !== current.vaultPath
    ) {
      throw new Error("vault identity changed while the change was running");
    }
  }

  async function verifyPhysicalGrant(
    access: VaultAccess,
    notePath: string,
    options: CliInvocationOptions,
    allowMissingLeaf: boolean,
  ): Promise<void> {
    await assertVaultIdentity(runtime.runner, access, options);
    if (access.source === "settings" && access.vaultPath !== undefined) {
      await assertPhysicalVaultPath(access.vaultPath, notePath, {
        allowMissingLeaf,
        requireExistingParent: allowMissingLeaf,
      });
    }
  }

  async function readAuthorizedDocument(
    access: VaultAccess,
    notePath: string,
    options: CliInvocationOptions,
  ): Promise<DocumentState> {
    if (runtime.documentStateReaderForTests !== undefined) {
      return await runtime.documentStateReaderForTests(
        access,
        notePath,
        options,
      );
    }
    if (access.source !== "settings" || access.vaultPath === undefined) {
      throw new Error(
        "safe writing requires Bridge Control shared settings with a verified physical vault path; migrate the legacy environment-only writer configuration",
      );
    }
    const exact = await exactDocumentReader(access.vaultPath, notePath, {
      allowMissing: true,
      maxBytes: MAX_WRITE_OBSERVATION_BYTES,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (!exact.exists) {
      return { exists: false, sha256: hashDocumentState(false) };
    }
    return {
      exists: true,
      content: exact.content,
      sha256: hashDocumentState(true, exact.content),
    };
  }

  async function withCommitLock<T>(
    vault: string,
    notePath: string,
    caseSensitive: boolean,
    signal: AbortSignal | undefined,
    operation: () => Promise<T>,
  ): Promise<LockedOperationResult<T>> {
    const key = deriveCommitLockKey(vault, notePath, caseSensitive);
    const previous = commitLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    commitLocks.set(key, current);
    await previous;
    try {
      if (runtime.dataDirectory === undefined) {
        return { result: await operation() };
      }
      try {
        return {
          result: await withFileCommitLock(
            {
              dataDirectory: runtime.dataDirectory,
              vault,
              notePath,
              caseSensitive,
              ...(signal === undefined ? {} : { signal }),
            },
            operation,
          ),
        };
      } catch (error) {
        if (error instanceof CommitLockReleaseAfterOperationError) {
          return {
            result: error.operationResult as T,
            releaseError: error.releaseError,
          };
        }
        throw error;
      }
    } finally {
      release();
      if (commitLocks.get(key) === current) commitLocks.delete(key);
    }
  }

  return {
    async prepareChange(
      input: PrepareChangeInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      assertAutonomousCircuitOpen();
      try {
      const vault = input.vault;
      const initial = await assertChangeAllowed(vault, input.path);
      const notePath = initial.notePath;
      await verifyPhysicalGrant(
        initial.access,
        notePath,
        options,
        input.operation === "create",
      );
      const before = await readAuthorizedDocument(
        initial.access,
        notePath,
        options,
      );
      const current = await assertChangeAllowed(vault, notePath);
      assertSameVault(initial.access, current.access);
      await verifyPhysicalGrant(
        current.access,
        notePath,
        options,
        input.operation === "create",
      );
      const commandContent = normalizeContent(input.content);

      let afterContent: string;
      if (input.operation === "create") {
        if (before.exists) {
          throw new ChangeConflictError("create requires a note that does not exist");
        }
        afterContent = commandContent;
      } else {
        if (!before.exists || before.content === undefined) {
          throw new ChangeConflictError(
            `${input.operation} requires an existing note`,
          );
        }
        afterContent = `${before.content}${commandContent}`;
      }

      assertWriteObservationSize(afterContent);

      // Append sends only the bounded delta through argv. Create sends the
      // whole new document and therefore retains a tighter document cap.
      if (input.operation === "create") {
        assertDocumentSize(afterContent);
        assertCliContentRepresentable(afterContent);
      }
      const afterSha256 = hashDocumentState(true, afterContent);
      const previewDiff = createPreviewDiff(
        notePath,
        before.content,
        afterContent,
      );
      assertPreviewSize(previewDiff);
      const change = runtime.store.create({
        vault: initial.access.vaultSelector,
        vaultLabel: initial.access.vaultName,
        notePath,
        operation: input.operation,
        authorizationMode,
        lockCaseSensitive: initial.access.writablePolicy.caseSensitive,
        before,
        afterContent,
        commandContent,
        afterSha256,
        previewDiff,
        beforeLineCount: lineArray(before.content ?? "").length,
        afterLineCount: lineArray(afterContent).length,
      });

      return jsonResult({
        status: "prepared",
        change_id: change.changeId,
        expires_at: new Date(change.expiresAt).toISOString(),
        vault: change.vaultLabel,
        path: change.notePath,
        operation: change.operation,
        authorization_mode: change.authorizationMode,
        approval_required: change.authorizationMode === "protected",
        before_sha256: change.before.sha256,
        after_sha256: change.afterSha256,
        preview: {
          diff: change.previewDiff,
          proposed_content: change.commandContent,
          proposed_content_json: JSON.stringify(change.commandContent),
          before_line_count: change.beforeLineCount,
          after_line_count: change.afterLineCount,
        },
      });
      } catch (error) {
        recordAutonomousFailure();
        throw error;
      }
    },

    async commitChange(
      input: CommitChangeInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      assertAutonomousCircuitOpen();
      let auditChange: PreparedChange | undefined;
      try {
        const change = runtime.store.take(input.change_id);
        auditChange = change;
        if (change.authorizationMode !== authorizationMode) {
          throw new Error(
            "change_id belongs to a different writer authorization channel",
          );
        }
        const locked = await withCommitLock(
          change.vault,
          change.notePath,
          change.lockCaseSensitive,
          options.signal,
          async () => {
          let backupId: string | undefined;
          let writeAttempted = false;
          let recoveryAccess: VaultAccess | undefined;
          const bridgeWrittenHashes = new Set<string>([change.afterSha256]);
          const verifyRecoveryGrant = async (
            allowMissingLeaf: boolean,
          ): Promise<void> => {
            if (recoveryAccess === undefined) {
              throw new Error("commit authorization was not established");
            }
            const currentGrant = await assertChangeAllowed(
              change.vault,
              change.notePath,
            );
            assertSameVault(recoveryAccess, currentGrant.access);
            await verifyPhysicalGrant(
              currentGrant.access,
              change.notePath,
              {},
              allowMissingLeaf,
            );
            recoveryAccess = currentGrant.access;
          };
          const readRecoveryDocument = async (
            readOptions: CliInvocationOptions,
          ): Promise<DocumentState> => {
            if (recoveryAccess === undefined) {
              throw new Error("commit authorization was not established");
            }
            return await readAuthorizedDocument(
              recoveryAccess,
              change.notePath,
              readOptions,
            );
          };

          try {
        // Re-read GUI settings after preview. A revoked vault or folder grant
        // must stop the commit before any vault read, backup, or mutation.
        const initial = await assertChangeAllowed(change.vault, change.notePath);
        recoveryAccess = initial.access;
        await verifyPhysicalGrant(
          initial.access,
          change.notePath,
          options,
          change.operation === "create",
        );
        const current = await readAuthorizedDocument(
          initial.access,
          change.notePath,
          options,
        );
        assertSameState(change.before, current);

        if (current.exists && current.content !== undefined) {
          const backup = await runtime.storage.createBackup({
            vault: change.vault,
            notePath: change.notePath,
            beforeSha256: current.sha256,
            content: current.content,
            createdAt: now(),
          });
          backupId = backup.backupId;

          // Close the longest practical conflict window before the CLI write.
          const afterBackup = await readAuthorizedDocument(
            initial.access,
            change.notePath,
            options,
          );
          assertSameState(change.before, afterBackup);
        }

        // Recheck GUI permission, stable identity and physical scope before
        // every bounded mutation. Each chunk is then read back and hashed
        // before the next one is allowed to run.
        let chunkVerificationFailed = false;
        let verificationCauseCode: string | undefined;
        let lastWriteAccess = initial.access;
        try {
          await writePreparedChangeInChunks(
            runtime.runner,
            change,
            options,
            bridgeWrittenHashes,
            async (allowMissingLeaf) => {
              const currentGrant = await assertChangeAllowed(
                change.vault,
                change.notePath,
              );
              assertSameVault(initial.access, currentGrant.access);
              await verifyPhysicalGrant(
                currentGrant.access,
                change.notePath,
                options,
                allowMissingLeaf,
              );
              lastWriteAccess = currentGrant.access;
              return currentGrant.access;
            },
            async (access, readOptions) =>
              await readAuthorizedDocument(
                access,
                change.notePath,
                readOptions,
              ),
            () => {
              writeAttempted = true;
            },
          );
        } catch (error) {
          if (!(error instanceof PostWriteVerificationError)) throw error;
          chunkVerificationFailed = true;
          verificationCauseCode = diagnosticCauseCode(error);
        }

        let verificationSucceeded = false;
        try {
          if (chunkVerificationFailed) {
            throw new PostWriteVerificationError(
              "an intermediate chunk failed verification",
            );
          }
          const verificationGrant = await assertChangeAllowed(
            change.vault,
            change.notePath,
          );
          assertSameVault(lastWriteAccess, verificationGrant.access);
          await verifyPhysicalGrant(
            verificationGrant.access,
            change.notePath,
            options,
            false,
          );
          const verified = await readAuthorizedDocument(
            verificationGrant.access,
            change.notePath,
            options,
          );
          verificationSucceeded =
            verified.exists && verified.sha256 === change.afterSha256;
          if (!verificationSucceeded) {
            verificationCauseCode ??= "POST_WRITE_MISMATCH";
          }
        } catch (error) {
          verificationCauseCode ??= diagnosticCauseCode(error);
          verificationSucceeded = false;
        }
        if (!verificationSucceeded) {
          const causeCode = verificationCauseCode ?? "POST_WRITE_VERIFICATION";
          const rollback = await attemptRollback(
            change,
            {},
            bridgeWrittenHashes,
            verifyRecoveryGrant,
            readRecoveryDocument,
          );
          let auditRecorded = true;
          try {
            await runtime.storage.appendAudit({
              timestamp: new Date(now()).toISOString(),
              change_id: change.changeId,
              vault: change.vault,
              path: change.notePath,
              operation: change.operation,
              authorization_mode: change.authorizationMode,
              status: "failed",
              before_sha256: change.before.sha256,
              after_sha256: change.afterSha256,
              ...(backupId === undefined ? {} : { backup_id: backupId }),
              error_code:
                rollback.reason === "manual_recovery_required"
                  ? "VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED"
                  : rollback.succeeded
                    ? "VERIFICATION_FAILED_ROLLBACK_SUCCEEDED"
                    : "VERIFICATION_FAILED_ROLLBACK_FAILED",
              failure_stage: "verification",
              cause_code: causeCode,
              rollback_attempted: rollback.attempted,
              rollback_succeeded: rollback.succeeded,
              rollback_reason: rollback.reason,
            });
          } catch {
            auditRecorded = false;
          }

          const result = jsonResult({
            status: "failed",
            change_id: change.changeId,
            vault: change.vaultLabel,
            path: change.notePath,
            operation: change.operation,
            authorization_mode: change.authorizationMode,
            error: "post_write_verification_failed",
            failure_stage: "verification",
            cause_code: causeCode,
            verified: false,
            rollback_attempted: rollback.attempted,
            rollback_succeeded: rollback.succeeded,
            rollback_reason: rollback.reason,
            ...(rollback.reason === "manual_recovery_required"
              ? { manual_recovery_required: true }
              : {}),
            ...(backupId === undefined ? {} : { backup_id: backupId }),
            audit_recorded: auditRecorded,
          });
          return { ...result, isError: true };
        }

        const auditEvent: AuditEvent = {
          timestamp: new Date(now()).toISOString(),
          change_id: change.changeId,
          vault: change.vault,
          path: change.notePath,
          operation: change.operation,
          authorization_mode: change.authorizationMode,
          status: "committed",
          before_sha256: change.before.sha256,
          after_sha256: change.afterSha256,
          ...(backupId === undefined ? {} : { backup_id: backupId }),
        };
        let auditRecorded = true;
        try {
          await runtime.storage.appendAudit(auditEvent);
        } catch {
          auditRecorded = false;
        }

        return jsonResult({
          status: "committed",
          change_id: change.changeId,
          vault: change.vaultLabel,
          path: change.notePath,
          operation: change.operation,
          authorization_mode: change.authorizationMode,
          before_sha256: change.before.sha256,
          after_sha256: change.afterSha256,
          verified: true,
          ...(backupId === undefined ? {} : { backup_id: backupId }),
          audit_recorded: auditRecorded,
        });
          } catch (error) {
        if (writeAttempted) {
          const rollback = await attemptRollback(
            change,
            {},
            bridgeWrittenHashes,
            verifyRecoveryGrant,
            readRecoveryDocument,
          );
          const causeCode = diagnosticCauseCode(error);
          let auditRecorded = true;
          try {
            await runtime.storage.appendAudit({
              timestamp: new Date(now()).toISOString(),
              change_id: change.changeId,
              vault: change.vault,
              path: change.notePath,
              operation: change.operation,
              authorization_mode: change.authorizationMode,
              status: "failed",
              before_sha256: change.before.sha256,
              after_sha256: change.afterSha256,
              ...(backupId === undefined ? {} : { backup_id: backupId }),
              error_code:
                rollback.reason === "manual_recovery_required"
                  ? "WRITE_FAILED_MANUAL_RECOVERY_REQUIRED"
                  : rollback.succeeded
                    ? "WRITE_FAILED_ROLLBACK_SUCCEEDED"
                    : "WRITE_FAILED_ROLLBACK_FAILED",
              failure_stage: "write",
              cause_code: causeCode,
              rollback_attempted: rollback.attempted,
              rollback_succeeded: rollback.succeeded,
              rollback_reason: rollback.reason,
            });
          } catch {
            auditRecorded = false;
          }

          const result = jsonResult({
            status: "failed",
            change_id: change.changeId,
            vault: change.vaultLabel,
            path: change.notePath,
            operation: change.operation,
            authorization_mode: change.authorizationMode,
            error: "write_failed",
            failure_stage: "write",
            cause_code: causeCode,
            verified: false,
            rollback_attempted: rollback.attempted,
            rollback_succeeded: rollback.succeeded,
            rollback_reason: rollback.reason,
            ...(rollback.reason === "manual_recovery_required"
              ? { manual_recovery_required: true }
              : {}),
            ...(backupId === undefined ? {} : { backup_id: backupId }),
            audit_recorded: auditRecorded,
          });
          return { ...result, isError: true };
        }

        try {
          const causeCode = diagnosticCauseCode(error);
          await runtime.storage.appendAudit({
            timestamp: new Date(now()).toISOString(),
            change_id: change.changeId,
            vault: change.vault,
            path: change.notePath,
            operation: change.operation,
            authorization_mode: change.authorizationMode,
            status: "failed",
            before_sha256: change.before.sha256,
            after_sha256: change.afterSha256,
            ...(backupId === undefined ? {} : { backup_id: backupId }),
            error_code:
              error instanceof ChangeConflictError
                ? error.code
                : "PRE_WRITE_FAILED",
            failure_stage: "pre_write",
            cause_code: causeCode,
          });
        } catch {
          // Preserve the primary failure; audit contains no note content.
        }
            throw error;
          }
          },
        );
        const result = annotateCommitLockResult(
          locked.result,
          locked.releaseError,
        );
        if (result.isError === true) {
          recordAutonomousFailure();
        } else {
          recordAutonomousSuccess();
        }
        return result;
      } catch (error) {
        recordAutonomousFailure();
        if (auditChange !== undefined && error instanceof CommitLockError) {
          try {
            await runtime.storage.appendAudit({
              timestamp: new Date(now()).toISOString(),
              change_id: auditChange.changeId,
              vault: auditChange.vault,
              path: auditChange.notePath,
              operation: auditChange.operation,
              authorization_mode: auditChange.authorizationMode,
              status: "failed",
              before_sha256: auditChange.before.sha256,
              after_sha256: auditChange.afterSha256,
              error_code: `COMMIT_${error.code}`,
              failure_stage: "commit_lock",
              cause_code: diagnosticCauseCode(error),
            });
          } catch {
            // Preserve the lock failure; audit contains no note content.
          }
        }
        throw error;
      }
    },
  };
}

export type ObsidianWriteToolHandlers = ReturnType<
  typeof createWriteToolHandlers
>;
