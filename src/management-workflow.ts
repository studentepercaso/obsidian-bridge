import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  rename,
  unlink,
} from "node:fs/promises";
import path from "node:path";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  buildManagementVaultArgs,
  type CliInvocationOptions,
  type ObsidianCliRunner,
} from "./cli.js";
import {
  CommitLockReleaseAfterOperationError,
  deriveCommitLockKey,
  withCommitLock as withFileCommitLock,
} from "./commit-lock.js";
import {
  readExactVaultDocument,
  type ExactVaultDocument,
  type ExactVaultDocumentReadOptions,
} from "./exact-vault-document.js";
import {
  MANAGEMENT_PROTOCOL_VERSION,
  MAX_MANAGEMENT_REQUEST_BYTES,
  type FrontmatterValue,
  type ManagementOperation,
  type ManagementRequest,
  type ManagementResponse,
} from "./management-protocol.js";
import { assertPathAllowed, type PathPolicy } from "./path-policy.js";
import { assertPhysicalVaultPath } from "./physical-scope.js";
import type {
  ManagementPermissions,
  VaultAccess,
  VaultAccessResolver,
} from "./shared-settings.js";
import { jsonResult } from "./tool-helpers.js";
import { assertVaultIdentity } from "./vault-identity.js";
import {
  ChangeConflictError,
  ChangeNotFoundError,
  createPreviewDiff,
  hashDocumentState,
  type DocumentState,
} from "./write-workflow.js";

export const MAX_MANAGED_DOCUMENT_BYTES = 1_048_576;
export const MAX_MANAGED_PREVIEW_BYTES = 131_072;
export const DEFAULT_MAX_PENDING_MANAGEMENT_CHANGES = 50;
export const DEFAULT_MAX_PENDING_MANAGEMENT_BYTES = 8_388_608;

const controlCharactersExceptNewlineAndTab =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const PropertyName = z
  .string()
  .min(1)
  .max(128)
  .refine((value) => value === value.trim().normalize("NFC"), {
    message: "frontmatter property names must be trimmed and NFC-normalized",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "frontmatter property name contains control characters",
  })
  .refine(
    (value) =>
      value !== "__proto__" &&
      value !== "constructor" &&
      value !== "prototype",
    {
      message: "frontmatter property name is reserved",
    },
  );
const FrontmatterScalarSchema = z.union([
  z
    .string()
    .max(32_768)
    .refine(
      (value) => !controlCharactersExceptNewlineAndTab.test(value),
      "frontmatter string contains unsupported control characters",
    ),
  z.number().finite(),
  z.boolean(),
  z.null(),
]);
const FrontmatterValueSchema = z.union([
  FrontmatterScalarSchema,
  z.array(FrontmatterScalarSchema).max(256),
]);
const ManagedContent = z
  .string()
  .max(MAX_MANAGED_DOCUMENT_BYTES)
  .refine(
    (value) => !controlCharactersExceptNewlineAndTab.test(value),
    "content contains unsupported control characters",
  )
  .refine(
    (value) => Buffer.byteLength(value, "utf8") <= MAX_MANAGED_DOCUMENT_BYTES,
    `content must not exceed ${MAX_MANAGED_DOCUMENT_BYTES} UTF-8 bytes`,
  );
const VaultName = z.string().trim().min(1).max(256);
const MarkdownPath = z.string().min(4).max(1_024).regex(/\.md$/iu);

const ReplaceInput = z
  .object({
    vault: VaultName,
    path: MarkdownPath,
    operation: z.literal("replace"),
    content: ManagedContent,
  })
  .strict();
const ReplaceTextInput = z
  .object({
    vault: VaultName,
    path: MarkdownPath,
    operation: z.literal("replace_text"),
    find: z.string().min(1).max(131_072),
    replacement: z.string().max(131_072),
    expected_occurrences: z.number().int().min(1).max(1_000).default(1),
  })
  .strict();
const FrontmatterInput = z
  .object({
    vault: VaultName,
    path: MarkdownPath,
    operation: z.literal("frontmatter"),
    set: z.record(PropertyName, FrontmatterValueSchema),
    remove: z.array(PropertyName).max(100),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.set).length + value.remove.length === 0) {
      context.addIssue({
        code: "custom",
        message: "frontmatter requires at least one set or remove entry",
      });
    }
    if (Object.keys(value.set).some((name) => value.remove.includes(name))) {
      context.addIssue({
        code: "custom",
        message: "a frontmatter property cannot be both set and removed",
      });
    }
  });
const MoveInput = z
  .object({
    vault: VaultName,
    path: MarkdownPath,
    operation: z.literal("move"),
    destination_path: MarkdownPath,
  })
  .strict();
const TrashInput = z
  .object({
    vault: VaultName,
    path: MarkdownPath,
    operation: z.literal("trash"),
  })
  .strict();

export const ManagementToolInputSchemas = Object.freeze({
  prepareChange: z.discriminatedUnion("operation", [
    ReplaceInput,
    ReplaceTextInput,
    FrontmatterInput,
    MoveInput,
    TrashInput,
  ]),
  commitChange: z.object({ change_id: z.string().uuid() }).strict(),
});

export type PrepareManagementChangeInput = z.infer<
  typeof ManagementToolInputSchemas.prepareChange
>;
export type CommitManagementChangeInput = z.infer<
  typeof ManagementToolInputSchemas.commitChange
>;

type ManagementCapability = keyof ManagementPermissions;

export interface PreparedManagementChange {
  readonly changeId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly vault: string;
  readonly vaultLabel: string;
  readonly operation: ManagementOperation;
  readonly requestedOperation:
    | ManagementOperation
    | "replace_text";
  readonly capability: ManagementCapability;
  readonly notePath: string;
  readonly targetPath?: string;
  readonly before: DocumentState;
  readonly targetBefore?: DocumentState;
  readonly afterContent?: string;
  readonly afterSha256?: string;
  readonly frontmatterSet?: Readonly<Record<string, FrontmatterValue>>;
  readonly frontmatterRemove?: readonly string[];
  readonly preview: Readonly<Record<string, unknown>>;
  readonly lockCaseSensitive: boolean;
  readonly estimatedBytes: number;
}

export interface PreparedManagementStoreOptions {
  readonly ttlMs: number;
  readonly now?: () => number;
  readonly createId?: () => string;
  readonly maxPending?: number;
  readonly maxPendingBytes?: number;
}

export class PreparedManagementStore {
  readonly #ttlMs: number;
  readonly #now: () => number;
  readonly #createId: () => string;
  readonly #maxPending: number;
  readonly #maxPendingBytes: number;
  readonly #changes = new Map<string, PreparedManagementChange>();
  #pendingBytes = 0;

  constructor(options: PreparedManagementStoreOptions) {
    this.#ttlMs = options.ttlMs;
    this.#now = options.now ?? Date.now;
    this.#createId = options.createId ?? randomUUID;
    this.#maxPending =
      options.maxPending ?? DEFAULT_MAX_PENDING_MANAGEMENT_CHANGES;
    this.#maxPendingBytes =
      options.maxPendingBytes ?? DEFAULT_MAX_PENDING_MANAGEMENT_BYTES;
    if (!Number.isSafeInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new RangeError("ttlMs must be a positive integer");
    }
  }

  create(
    value: Omit<
      PreparedManagementChange,
      "changeId" | "createdAt" | "expiresAt"
    >,
  ): PreparedManagementChange {
    const now = this.#now();
    this.#removeExpired(now);
    if (this.#changes.size >= this.#maxPending) {
      throw new Error("too many pending management changes");
    }
    if (this.#pendingBytes + value.estimatedBytes > this.#maxPendingBytes) {
      throw new Error("pending management previews exceed the memory budget");
    }
    const change = Object.freeze({
      ...value,
      changeId: this.#createId(),
      createdAt: now,
      expiresAt: now + this.#ttlMs,
    });
    this.#changes.set(change.changeId, change);
    this.#pendingBytes += change.estimatedBytes;
    return change;
  }

  take(changeId: string): PreparedManagementChange {
    const change = this.#changes.get(changeId);
    this.#changes.delete(changeId);
    if (change !== undefined) this.#pendingBytes -= change.estimatedBytes;
    if (change === undefined || change.expiresAt <= this.#now()) {
      throw new ChangeNotFoundError();
    }
    return change;
  }

  #removeExpired(now: number): void {
    for (const [id, change] of this.#changes) {
      if (change.expiresAt > now) continue;
      this.#changes.delete(id);
      this.#pendingBytes -= change.estimatedBytes;
    }
  }
}

const ManagementResponseSchema = z
  .object({
    version: z.literal(MANAGEMENT_PROTOCOL_VERSION),
    request_id: z.string().uuid(),
    change_id: z.string().uuid(),
    status: z.enum(["committed", "failed"]),
    operation: z.enum(["replace", "frontmatter", "move", "trash"]),
    path: MarkdownPath,
    target_path: MarkdownPath.optional(),
    before_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    after_sha256: z.string().regex(/^[0-9a-f]{64}$/u),
    verified: z.boolean(),
    backup_id: z.string().min(1).max(200).optional(),
    audit_recorded: z.boolean(),
    error_code: z.string().min(1).max(128).optional(),
    rollback_attempted: z.boolean().optional(),
    rollback_succeeded: z.boolean().optional(),
    rollback_reason: z.string().min(1).max(256).optional(),
  })
  .strict();

export interface ManagementToolRuntime {
  readonly runner: ObsidianCliRunner;
  readonly readPolicy: PathPolicy;
  readonly writablePolicy: PathPolicy;
  readonly store: PreparedManagementStore;
  readonly resolveAccess: VaultAccessResolver;
  readonly dataDirectory: string;
  readonly now?: () => number;
  /** Test seam; production always uses readExactVaultDocument(). */
  readonly exactDocumentReader?: (
    vaultPath: string,
    notePath: string,
    options: ExactVaultDocumentReadOptions,
  ) => Promise<ExactVaultDocument>;
}

function countOccurrences(content: string, needle: string): number {
  let count = 0;
  let offset = 0;
  while (true) {
    const index = content.indexOf(needle, offset);
    if (index === -1) return count;
    count += 1;
    offset = index + needle.length;
  }
}

function replaceAllLiteral(
  content: string,
  find: string,
  replacement: string,
): string {
  return content.split(find).join(replacement);
}

function assertDocumentBytes(content: string): void {
  if (Buffer.byteLength(content, "utf8") > MAX_MANAGED_DOCUMENT_BYTES) {
    throw new RangeError(
      `managed document must not exceed ${MAX_MANAGED_DOCUMENT_BYTES} UTF-8 bytes`,
    );
  }
}

function assertPreviewBytes(preview: unknown): void {
  if (
    Buffer.byteLength(JSON.stringify(preview), "utf8") >
    MAX_MANAGED_PREVIEW_BYTES
  ) {
    throw new RangeError("management preview exceeds the safe display limit");
  }
}

function capabilityForOperation(
  operation: PrepareManagementChangeInput["operation"],
): ManagementCapability {
  if (
    operation === "replace" ||
    operation === "replace_text" ||
    operation === "frontmatter"
  ) {
    return "edit";
  }
  return operation === "move" ? "move" : "trash";
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stats = await lstat(directory);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error("management request directory is not a safe directory");
  }
  try {
    await chmod(directory, 0o700);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function writeRequestFile(
  dataDirectory: string,
  request: ManagementRequest,
): Promise<string> {
  const directory = path.join(dataDirectory, "management", "requests");
  await ensurePrivateDirectory(dataDirectory);
  await ensurePrivateDirectory(path.join(dataDirectory, "management"));
  await ensurePrivateDirectory(directory);
  const serialized = `${JSON.stringify(request)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_MANAGEMENT_REQUEST_BYTES) {
    throw new RangeError("management request exceeds the safe file limit");
  }
  const finalPath = path.join(directory, `${request.request_id}.json`);
  const temporaryPath = path.join(
    directory,
    `.${request.request_id}.${process.pid}.${randomUUID()}.tmp`,
  );
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, finalPath);
  return finalPath;
}

async function removeOwnedRequest(filePath: string): Promise<void> {
  try {
    const stats = await lstat(filePath);
    if (!stats.isFile() || stats.isSymbolicLink()) return;
    await unlink(filePath);
  } catch (error) {
    if (
      typeof error !== "object" ||
      error === null ||
      !("code" in error) ||
      error.code !== "ENOENT"
    ) {
      throw error;
    }
  }
}

function sameVault(original: VaultAccess, current: VaultAccess): boolean {
  return (
    original.vaultSelector === current.vaultSelector &&
    original.vaultPath === current.vaultPath
  );
}

async function withManagementLocks<T>(
  runtime: ManagementToolRuntime,
  vault: string,
  notePaths: readonly string[],
  caseSensitive: boolean,
  signal: AbortSignal | undefined,
  operation: () => Promise<T>,
): Promise<{
  readonly result: T;
  readonly releaseErrors: readonly string[];
}> {
  const targets = [...new Set(notePaths)]
    .map((notePath) => ({
      notePath,
      key: deriveCommitLockKey(vault, notePath, caseSensitive),
    }))
    .sort((left, right) => left.key.localeCompare(right.key));
  const releaseErrors: string[] = [];

  const acquire = async (index: number): Promise<T> => {
    const target = targets[index];
    if (target === undefined) return await operation();
    try {
      return await withFileCommitLock(
        {
          dataDirectory: runtime.dataDirectory,
          vault,
          notePath: target.notePath,
          caseSensitive,
          ...(signal === undefined ? {} : { signal }),
        },
        async () => await acquire(index + 1),
      );
    } catch (error) {
      if (error instanceof CommitLockReleaseAfterOperationError) {
        releaseErrors.push(error.releaseError.code);
        return error.operationResult as T;
      }
      throw error;
    }
  };

  return { result: await acquire(0), releaseErrors };
}

export function createManagementToolHandlers(runtime: ManagementToolRuntime) {
  const now = runtime.now ?? Date.now;
  const exactDocumentReader =
    runtime.exactDocumentReader ?? readExactVaultDocument;
  let consecutiveFailures = 0;
  let paused = false;

  async function readManagedDocument(
    access: VaultAccess,
    notePath: string,
    allowMissing: boolean,
    options: CliInvocationOptions,
  ): Promise<DocumentState> {
    if (access.source !== "settings" || access.vaultPath === undefined) {
      throw new Error(
        "managed operations require a settings-backed verified physical vault path",
      );
    }
    const exact = await exactDocumentReader(access.vaultPath, notePath, {
      allowMissing,
      maxBytes: MAX_MANAGED_DOCUMENT_BYTES,
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

  function assertCircuitOpen(): void {
    if (!paused) return;
    throw new Error(
      "managed operations are paused after three consecutive failures; inspect recent bridge events, return to Accesso autonomo, and start a new task before enabling Gestione completa again",
    );
  }

  async function authorize(
    vault: string,
    notePath: string,
    capability: ManagementCapability,
    targetPath?: string,
  ): Promise<{
    readonly access: VaultAccess;
    readonly notePath: string;
    readonly targetPath?: string;
  }> {
    const access = await runtime.resolveAccess(vault);
    if (access.accessMode !== "management") {
      throw new Error("managed operations require Gestione completa");
    }
    if (!access.managementPermissions[capability]) {
      throw new Error(`management permission ${capability} is disabled`);
    }
    const readable = assertPathAllowed(notePath, access.readPolicy);
    const writable = assertPathAllowed(readable, access.writablePolicy);
    const normalizedTarget =
      targetPath === undefined
        ? undefined
        : assertPathAllowed(
            assertPathAllowed(targetPath, access.readPolicy),
            access.writablePolicy,
          );
    return {
      access,
      notePath: writable,
      ...(normalizedTarget === undefined
        ? {}
        : { targetPath: normalizedTarget }),
    };
  }

  async function verifyPhysical(
    access: VaultAccess,
    notePath: string,
    options: CliInvocationOptions,
    allowMissingLeaf: boolean,
    requireExistingParent = false,
  ): Promise<void> {
    await assertVaultIdentity(runtime.runner, access, options);
    if (access.source === "settings" && access.vaultPath !== undefined) {
      if (allowMissingLeaf && requireExistingParent) {
        const parent = path.posix.dirname(notePath);
        if (parent !== ".") {
          await assertPhysicalVaultPath(access.vaultPath, parent);
        }
      }
      await assertPhysicalVaultPath(access.vaultPath, notePath, {
        allowMissingLeaf,
      });
    }
  }

  return {
    async prepareChange(
      input: PrepareManagementChangeInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      assertCircuitOpen();
      try {
        const capability = capabilityForOperation(input.operation);
        const initial = await authorize(
          input.vault,
          input.path,
          capability,
          input.operation === "move" ? input.destination_path : undefined,
        );
        await verifyPhysical(initial.access, initial.notePath, options, true);
        if (initial.targetPath !== undefined) {
          await verifyPhysical(
            initial.access,
            initial.targetPath,
            options,
            true,
            true,
          );
        }
        const before = await readManagedDocument(
          initial.access,
          initial.notePath,
          true,
          options,
        );
        if (!before.exists || before.content === undefined) {
          throw new ChangeConflictError(
            `${input.operation} requires an existing note`,
          );
        }
        assertDocumentBytes(before.content);

        let targetBefore: DocumentState | undefined;
        let operation: ManagementOperation;
        let afterContent: string | undefined;
        let afterSha256: string | undefined;
        let frontmatterSet: Readonly<Record<string, FrontmatterValue>> | undefined;
        let frontmatterRemove: readonly string[] | undefined;
        let preview: Readonly<Record<string, unknown>>;

        if (input.operation === "replace") {
          operation = "replace";
          afterContent = input.content;
          afterSha256 = hashDocumentState(true, afterContent);
          preview = {
            diff: createPreviewDiff(
              initial.notePath,
              before.content,
              afterContent,
            ),
            before_sha256: before.sha256,
            after_sha256: afterSha256,
          };
        } else if (input.operation === "replace_text") {
          const occurrences = countOccurrences(before.content, input.find);
          if (occurrences !== input.expected_occurrences) {
            throw new ChangeConflictError(
              `expected ${input.expected_occurrences} exact occurrence(s), found ${occurrences}`,
            );
          }
          operation = "replace";
          afterContent = replaceAllLiteral(
            before.content,
            input.find,
            input.replacement,
          );
          assertDocumentBytes(afterContent);
          afterSha256 = hashDocumentState(true, afterContent);
          preview = {
            diff: createPreviewDiff(
              initial.notePath,
              before.content,
              afterContent,
            ),
            exact_match_count: occurrences,
            before_sha256: before.sha256,
            after_sha256: afterSha256,
          };
        } else if (input.operation === "frontmatter") {
          operation = "frontmatter";
          frontmatterSet = Object.freeze({ ...input.set });
          frontmatterRemove = Object.freeze([...new Set(input.remove)]);
          preview = {
            set: frontmatterSet,
            remove: frontmatterRemove,
            before_sha256: before.sha256,
          };
        } else if (input.operation === "move") {
          operation = "move";
          if (initial.targetPath === undefined) {
            throw new Error("move destination was not normalized");
          }
          if (
            initial.access.writablePolicy.caseSensitive
              ? initial.targetPath === initial.notePath
              : initial.targetPath.toLocaleLowerCase("en-US") ===
                initial.notePath.toLocaleLowerCase("en-US")
          ) {
            throw new ChangeConflictError(
              "move destination must differ from the source; case-only rename is not supported",
            );
          }
          targetBefore = await readManagedDocument(
            initial.access,
            initial.targetPath,
            true,
            options,
          );
          if (targetBefore.exists) {
            throw new ChangeConflictError("move destination already exists");
          }
          preview = {
            from: initial.notePath,
            to: initial.targetPath,
            source_sha256: before.sha256,
            link_updates:
              "Other notes are not rewritten automatically; review backlinks after the move.",
          };
        } else {
          operation = "trash";
          preview = {
            path: initial.notePath,
            before_sha256: before.sha256,
            deletion: "Obsidian trash only; permanent deletion is unavailable.",
          };
        }

        assertPreviewBytes(preview);
        const current = await authorize(
          input.vault,
          initial.notePath,
          capability,
          initial.targetPath,
        );
        if (!sameVault(initial.access, current.access)) {
          throw new Error("vault identity changed during preparation");
        }
        const estimatedBytes =
          Buffer.byteLength(before.content, "utf8") +
          Buffer.byteLength(afterContent ?? "", "utf8") +
          Buffer.byteLength(JSON.stringify(preview), "utf8");
        const change = runtime.store.create({
          vault: initial.access.vaultSelector,
          vaultLabel: initial.access.vaultName,
          operation,
          requestedOperation: input.operation,
          capability,
          notePath: initial.notePath,
          ...(initial.targetPath === undefined
            ? {}
            : { targetPath: initial.targetPath }),
          before,
          ...(targetBefore === undefined ? {} : { targetBefore }),
          ...(afterContent === undefined ? {} : { afterContent }),
          ...(afterSha256 === undefined ? {} : { afterSha256 }),
          ...(frontmatterSet === undefined ? {} : { frontmatterSet }),
          ...(frontmatterRemove === undefined
            ? {}
            : { frontmatterRemove }),
          preview,
          lockCaseSensitive: initial.access.writablePolicy.caseSensitive,
          estimatedBytes,
        });

        return jsonResult({
          status: "prepared",
          change_id: change.changeId,
          expires_at: new Date(change.expiresAt).toISOString(),
          vault: change.vaultLabel,
          path: change.notePath,
          ...(change.targetPath === undefined
            ? {}
            : { target_path: change.targetPath }),
          operation: change.requestedOperation,
          authorization_mode: "management",
          approval_required: false,
          preview: change.preview,
        });
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) paused = true;
        throw error;
      }
    },

    async commitChange(
      input: CommitManagementChangeInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      assertCircuitOpen();
      try {
        const change = runtime.store.take(input.change_id);
        const initial = await authorize(
          change.vault,
          change.notePath,
          change.capability,
          change.targetPath,
        );
        const locked = await withManagementLocks(
          runtime,
          initial.access.vaultSelector,
          [change.notePath, ...(change.targetPath === undefined ? [] : [change.targetPath])],
          change.lockCaseSensitive,
          options.signal,
          async () => {
            const currentGrant = await authorize(
              change.vault,
              change.notePath,
              change.capability,
              change.targetPath,
            );
            if (!sameVault(initial.access, currentGrant.access)) {
              throw new Error("vault identity changed before management commit");
            }
            await verifyPhysical(
              currentGrant.access,
              change.notePath,
              options,
              true,
            );
            if (change.targetPath !== undefined) {
              await verifyPhysical(
                currentGrant.access,
                change.targetPath,
                options,
                true,
                true,
              );
            }
            const current = await readManagedDocument(
              currentGrant.access,
              change.notePath,
              true,
              options,
            );
            if (
              current.exists !== change.before.exists ||
              current.sha256 !== change.before.sha256
            ) {
              throw new ChangeConflictError(
                "the source note changed after management preparation",
              );
            }
            if (change.targetPath !== undefined) {
              const target = await readManagedDocument(
                currentGrant.access,
                change.targetPath,
                true,
                options,
              );
              if (
                change.targetBefore === undefined ||
                target.exists !== change.targetBefore.exists ||
                target.sha256 !== change.targetBefore.sha256
              ) {
                throw new ChangeConflictError(
                  "the move destination changed after preparation",
                );
              }
            }

            const requestId = randomUUID();
            const token = randomBytes(32).toString("hex");
            const createdAt = now();
            const base = {
              version: MANAGEMENT_PROTOCOL_VERSION,
              request_id: requestId,
              token,
              change_id: change.changeId,
              created_at: new Date(createdAt).toISOString(),
              expires_at: new Date(
                Math.min(change.expiresAt, createdAt + 60_000),
              ).toISOString(),
              vault_id: currentGrant.access.vaultSelector,
              operation: change.operation,
              path: change.notePath,
              before_sha256: change.before.sha256,
            } as const;
            let request: ManagementRequest;
            if (change.operation === "replace") {
              if (
                change.afterContent === undefined ||
                change.afterSha256 === undefined
              ) {
                throw new Error("replace change is missing prepared content");
              }
              request = {
                ...base,
                operation: "replace",
                payload: {
                  content: change.afterContent,
                  after_sha256: change.afterSha256,
                },
              };
            } else if (change.operation === "frontmatter") {
              request = {
                ...base,
                operation: "frontmatter",
                payload: {
                  set: change.frontmatterSet ?? {},
                  remove: change.frontmatterRemove ?? [],
                },
              };
            } else if (change.operation === "move") {
              if (change.targetPath === undefined) {
                throw new Error("move change is missing its destination");
              }
              request = {
                ...base,
                operation: "move",
                payload: { destination: change.targetPath },
              };
            } else {
              request = {
                ...base,
                operation: "trash",
                payload: {},
              };
            }

            const requestPath = await writeRequestFile(
              runtime.dataDirectory,
              request,
            );
            let response: ManagementResponse;
            try {
              const result = await runtime.runner(
                buildManagementVaultArgs(
                  currentGrant.access.vaultSelector,
                  "bridge-control:commit",
                  [`request=${requestId}`, `token=${token}`],
                ),
                options,
              );
              let parsed: unknown;
              try {
                parsed = JSON.parse(result.stdout.trim()) as unknown;
              } catch (error) {
                throw new Error("Bridge Control returned invalid management JSON", {
                  cause: error,
                });
              }
              response = ManagementResponseSchema.parse(parsed);
              if (
                response.request_id !== requestId ||
                response.change_id !== change.changeId ||
                response.operation !== change.operation ||
                response.path !== change.notePath ||
                response.before_sha256 !== change.before.sha256 ||
                response.target_path !== change.targetPath
              ) {
                throw new Error("Bridge Control response does not match the request");
              }
              if (
                response.status === "committed" &&
                change.operation === "replace" &&
                response.after_sha256 !== change.afterSha256
              ) {
                throw new Error(
                  "Bridge Control returned an unexpected replacement hash",
                );
              }
            } finally {
              await removeOwnedRequest(requestPath).catch(() => undefined);
            }
            return response;
          },
        );

        const response = locked.result;
        const result = jsonResult({
          ...response,
          authorization_mode: "management",
          locks_released: locked.releaseErrors.length === 0,
          ...(locked.releaseErrors.length === 0
            ? {}
            : { lock_release_errors: locked.releaseErrors }),
        });
        if (
          response.status === "failed" ||
          !response.verified ||
          !response.audit_recorded
        ) {
          consecutiveFailures += 1;
          if (consecutiveFailures >= 3) paused = true;
          return { ...result, isError: true };
        }
        consecutiveFailures = 0;
        return result;
      } catch (error) {
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) paused = true;
        throw error;
      }
    },
  };
}

export type ObsidianManagementToolHandlers = ReturnType<
  typeof createManagementToolHandlers
>;
