import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, unlink, writeFile, appendFile } from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  MAX_CLI_IPC_FRAME_BYTES,
  buildVaultArgs,
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
import { assertPhysicalVaultPath } from "./physical-scope.js";
import type { VaultAccess, VaultAccessResolver } from "./shared-settings.js";
import { jsonResult } from "./tool-helpers.js";
import { assertVaultIdentity } from "./vault-identity.js";

export const MAX_CHANGE_CONTENT_BYTES = 8_192;
export const MAX_DOCUMENT_BYTES = 16_384;
export const MAX_PREVIEW_BYTES = 16_384;
export const DEFAULT_BACKUP_RETENTION = 20;
export const DEFAULT_MAX_PENDING_CHANGES = 100;

export type ChangeOperation = "create" | "append";

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

interface DocumentState {
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
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly backup_id?: string;
  readonly error_code?: string;
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

function assertPreviewSize(diff: string): void {
  const bytes = Buffer.byteLength(diff, "utf8");
  if (bytes > MAX_PREVIEW_BYTES) {
    throw new RangeError(
      `preview diff must not exceed ${MAX_PREVIEW_BYTES} UTF-8 bytes`,
    );
  }
}

function isMissingNoteError(error: unknown, notePath: string): boolean {
  if (!(error instanceof ObsidianCliError)) return false;
  if (error.code === "CLI_REPORTED_ERROR") {
    return error.message === `Error: File "${notePath}" not found.`;
  }
  return (
    error.code === "NON_ZERO_EXIT" &&
    /(?:not found|does not exist|no (?:such )?file|cannot find|missing)/iu.test(
      error.message,
    )
  );
}

async function readDocument(
  runner: ObsidianCliRunner,
  vault: string,
  notePath: string,
  options: CliInvocationOptions,
): Promise<DocumentState> {
  try {
    const result = await runner(
      buildVaultArgs(vault, "read", [`path=${notePath}`]),
      options,
    );
    const content = result.stdout;
    return {
      exists: true,
      content,
      sha256: hashDocumentState(true, content),
    };
  } catch (error) {
    if (!isMissingNoteError(error, notePath)) throw error;
    return { exists: false, sha256: hashDocumentState(false) };
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
  beforeChunk: (allowMissingLeaf: boolean) => Promise<void>,
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
    await beforeChunk(firstCreate);

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
      observed = await readDocument(
        runner,
        change.vault,
        change.notePath,
        options,
      );
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
  runner: ObsidianCliRunner,
  change: PreparedChange,
  options: CliInvocationOptions,
  bridgeWrittenHashes: ReadonlySet<string>,
): Promise<{
  readonly attempted: boolean;
  readonly succeeded: boolean;
  readonly reason:
    | "unchanged"
    | "restored"
    | "concurrent_change"
    | "delete_disabled"
    | "restore_unrepresentable"
    | "restore_too_large"
    | "read_failed"
    | "restore_failed";
}> {
  let current: DocumentState;
  try {
    current = await readDocument(
      runner,
      change.vault,
      change.notePath,
      options,
    );
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

  if (
    !isCliContentRepresentable(change.before.content) ||
    change.before.content.includes("\r")
  ) {
    // The original remains in the plaintext backup, but the official CLI's
    // content parameter cannot restore literal backslash-n/backslash-t text
    // or CR/CRLF line endings losslessly.
    return {
      attempted: false,
      succeeded: false,
      reason: "restore_unrepresentable",
    };
  }

  let rollbackChunks: string[];
  try {
    rollbackChunks = splitCliWriteContent(
      change.vault,
      change.notePath,
      change.before.content,
    );
  } catch {
    return {
      attempted: false,
      succeeded: false,
      reason: "restore_too_large",
    };
  }
  if (rollbackChunks.length !== 1) {
    // Never truncate first and rebuild recovery through multiple commands.
    // The plaintext backup remains the source for manual recovery.
    return {
      attempted: false,
      succeeded: false,
      reason: "restore_too_large",
    };
  }

  try {
    await runner(
      buildWriteVaultArgs(change.vault, "create", [
        `path=${change.notePath}`,
        `content=${encodeCliContent(rollbackChunks[0]!)}`,
        "overwrite",
      ]),
      options,
    );
    const restored = await readDocument(
      runner,
      change.vault,
      change.notePath,
      options,
    );
    return {
      attempted: true,
      succeeded:
        restored.exists && restored.sha256 === change.before.sha256,
      reason:
        restored.exists && restored.sha256 === change.before.sha256
          ? "restored"
          : "restore_failed",
    };
  } catch {
    return { attempted: true, succeeded: false, reason: "restore_failed" };
  }
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
}

export function createWriteToolHandlers(runtime: WriteToolRuntime) {
  const now = runtime.now ?? Date.now;
  const commitLocks = new Map<string, Promise<void>>();

  async function effectiveAccess(vault: string): Promise<VaultAccess> {
    if (runtime.resolveAccess !== undefined) {
      return await runtime.resolveAccess(vault);
    }
    return {
      readPolicy: runtime.readPolicy,
      writablePolicy: runtime.writablePolicy,
      writeEnabled: runtime.writableVaults.includes(vault),
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
      access.writablePolicy.allowedFolders === null ||
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
      });
    }
  }

  async function withCommitLock<T>(
    key: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const previous = commitLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    commitLocks.set(key, current);
    await previous;
    try {
      return await operation();
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
      const vault = input.vault;
      const initial = await assertChangeAllowed(vault, input.path);
      const notePath = initial.notePath;
      await verifyPhysicalGrant(
        initial.access,
        notePath,
        options,
        input.operation === "create",
      );
      const before = await readDocument(
        runtime.runner,
        initial.access.vaultSelector,
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
    },

    async commitChange(
      input: CommitChangeInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const change = runtime.store.take(input.change_id);
      return await withCommitLock(
        `${change.vault}\u0000${change.notePath}`,
        async () => {
          let backupId: string | undefined;
          let writeAttempted = false;
          const bridgeWrittenHashes = new Set<string>([change.afterSha256]);

          try {
        // Re-read GUI settings after preview. A revoked vault or folder grant
        // must stop the commit before any vault read, backup, or mutation.
        const initial = await assertChangeAllowed(change.vault, change.notePath);
        await verifyPhysicalGrant(
          initial.access,
          change.notePath,
          options,
          change.operation === "create",
        );
        const current = await readDocument(
          runtime.runner,
          initial.access.vaultSelector,
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
          const afterBackup = await readDocument(
            runtime.runner,
            change.vault,
            change.notePath,
            options,
          );
          assertSameState(change.before, afterBackup);
        }

        // Recheck GUI permission, stable identity and physical scope before
        // every bounded mutation. Each chunk is then read back and hashed
        // before the next one is allowed to run.
        let chunkVerificationFailed = false;
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
            },
            () => {
              writeAttempted = true;
            },
          );
        } catch (error) {
          if (!(error instanceof PostWriteVerificationError)) throw error;
          chunkVerificationFailed = true;
        }

        let verificationSucceeded = false;
        try {
          if (chunkVerificationFailed) {
            throw new PostWriteVerificationError(
              "an intermediate chunk failed verification",
            );
          }
          const verified = await readDocument(
            runtime.runner,
            change.vault,
            change.notePath,
            options,
          );
          verificationSucceeded =
            verified.exists && verified.sha256 === change.afterSha256;
        } catch {
          verificationSucceeded = false;
        }
        if (!verificationSucceeded) {
          const rollback = await attemptRollback(
            runtime.runner,
            change,
            {},
            bridgeWrittenHashes,
          );
          let auditRecorded = true;
          try {
            await runtime.storage.appendAudit({
              timestamp: new Date(now()).toISOString(),
              change_id: change.changeId,
              vault: change.vault,
              path: change.notePath,
              operation: change.operation,
              status: "failed",
              before_sha256: change.before.sha256,
              after_sha256: change.afterSha256,
              ...(backupId === undefined ? {} : { backup_id: backupId }),
              error_code: rollback.succeeded
                ? "VERIFICATION_FAILED_ROLLBACK_SUCCEEDED"
                : "VERIFICATION_FAILED_ROLLBACK_FAILED",
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
            error: "post_write_verification_failed",
            verified: false,
            rollback_attempted: rollback.attempted,
            rollback_succeeded: rollback.succeeded,
            rollback_reason: rollback.reason,
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
          before_sha256: change.before.sha256,
          after_sha256: change.afterSha256,
          verified: true,
          ...(backupId === undefined ? {} : { backup_id: backupId }),
          audit_recorded: auditRecorded,
        });
          } catch (error) {
        if (writeAttempted) {
          const rollback = await attemptRollback(
            runtime.runner,
            change,
            {},
            bridgeWrittenHashes,
          );
          let auditRecorded = true;
          try {
            await runtime.storage.appendAudit({
              timestamp: new Date(now()).toISOString(),
              change_id: change.changeId,
              vault: change.vault,
              path: change.notePath,
              operation: change.operation,
              status: "failed",
              before_sha256: change.before.sha256,
              after_sha256: change.afterSha256,
              ...(backupId === undefined ? {} : { backup_id: backupId }),
              error_code: rollback.succeeded
                ? "WRITE_FAILED_ROLLBACK_SUCCEEDED"
                : "WRITE_FAILED_ROLLBACK_FAILED",
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
            error: "write_failed",
            verified: false,
            rollback_attempted: rollback.attempted,
            rollback_succeeded: rollback.succeeded,
            rollback_reason: rollback.reason,
            ...(backupId === undefined ? {} : { backup_id: backupId }),
            audit_recorded: auditRecorded,
          });
          return { ...result, isError: true };
        }

        try {
          await runtime.storage.appendAudit({
            timestamp: new Date(now()).toISOString(),
            change_id: change.changeId,
            vault: change.vault,
            path: change.notePath,
            operation: change.operation,
            status: "failed",
            before_sha256: change.before.sha256,
            after_sha256: change.afterSha256,
            ...(backupId === undefined ? {} : { backup_id: backupId }),
            error_code:
              error instanceof ChangeConflictError
                ? error.code
                : "PRE_WRITE_FAILED",
          });
        } catch {
          // Preserve the primary failure; audit contains no note content.
        }
            throw error;
          }
        },
      );
    },
  };
}

export type ObsidianWriteToolHandlers = ReturnType<
  typeof createWriteToolHandlers
>;
