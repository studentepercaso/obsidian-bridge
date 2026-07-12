import { constants } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { randomUUID, timingSafeEqual } from "node:crypto";
import path from "node:path";

import {
  MANAGEMENT_REQUEST_VERSION,
  MAX_MANAGEMENT_REQUEST_BYTES,
  managementProcessingDirectory,
  managementRequestPath,
  managementRequestsDirectory,
  parseManagementRequest,
  isManagementToken,
  isUuid,
  hashMissingDocument,
  hashPresentDocument,
  type FrontmatterValue,
  type ManagementOperation,
  type ManagementRequest,
} from "./management-protocol.js";

export const MANAGEMENT_BACKUP_VERSION = 2 as const;
export const MANAGEMENT_BACKUP_RETENTION = 20;
export const MISSING_DOCUMENT_SHA256 = hashMissingDocument();
export const MAX_MANAGEMENT_BACKUP_BYTES = 4 * 1024 * 1024;

const VAULT_ID = /^[0-9a-f]{16}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const MAX_CLOCK_SKEW_MS = 30_000;
const MAX_AUDIT_LINE_BYTES = 16 * 1024;

export type ManagementAuthorizationMode = "management";
export type ManagementAuthorizationPhase = "initial" | "commit";

export interface ManagementAuthorizationDecision {
  readonly allowed: boolean;
  readonly mode: ManagementAuthorizationMode;
  readonly error_code?: string;
}

export interface ManagementVaultApi {
  /** Return null only when the visible Markdown file does not exist. */
  readMarkdown(path: string): Promise<string | null>;
  /** Production adapter: Vault.process(). */
  processMarkdown(path: string, update: (content: string) => string): Promise<string>;
  /** Production adapter: Vault.process() with a same-callback source-hash CAS. */
  rewriteFrontMatterMarkdown(
    path: string,
    beforeSha256: string,
    update: (frontmatter: Record<string, unknown>) => void,
  ): Promise<string>;
  /** Read parsed frontmatter after processFrontMatter for semantic verification. */
  readFrontMatter(path: string): Promise<Readonly<Record<string, unknown>>>;
  /** Production adapter: Vault.rename(); other notes are intentionally untouched. */
  renameFile(path: string, destination: string): Promise<void>;
  /** Production adapter: FileManager.trashFile(); permanent delete is intentionally absent. */
  trashFile(path: string): Promise<void>;
}

export interface ManagementHandlerDependencies {
  readonly dataDirectory: string;
  readonly vaultId: string;
  readonly api: ManagementVaultApi;
  readonly authorize: (
    request: ManagementRequest,
    phase: ManagementAuthorizationPhase,
  ) => Promise<ManagementAuthorizationDecision>;
  readonly now?: () => number;
  readonly createId?: () => string;
}

export interface ManagementCommandInput {
  readonly request_id: string;
  readonly token: string;
}

export interface ManagementCommandResponse {
  readonly version: typeof MANAGEMENT_REQUEST_VERSION;
  readonly request_id: string;
  readonly change_id: string;
  readonly status: "committed" | "failed";
  readonly operation: ManagementOperation;
  readonly path: string;
  readonly target_path?: string;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly verified: boolean;
  readonly backup_id?: string;
  readonly audit_recorded: boolean;
  readonly error_code?: string;
  readonly rollback_attempted?: boolean;
  readonly rollback_succeeded?: boolean;
  readonly rollback_reason?: string;
}

export interface ManagementRejectedResponse {
  readonly version: typeof MANAGEMENT_REQUEST_VERSION;
  readonly request_id: string;
  readonly status: "failed";
  readonly verified: false;
  readonly audit_recorded: false;
  readonly error_code: string;
}

interface ClaimedRequest {
  readonly path: string;
  readonly bytes: Buffer;
}

interface ExecutionState {
  authorizationMode: ManagementAuthorizationMode;
  backupId?: string;
  afterSha256: string;
  knownAppliedSha256?: string;
  mutationStarted: boolean;
  mutationCompleted: boolean;
  rollbackAttempted?: boolean;
  rollbackSucceeded?: boolean;
  rollbackReason?: string;
}

interface AuditEvent {
  readonly timestamp: string;
  readonly change_id: string;
  readonly vault: string;
  readonly path: string;
  readonly target_path?: string;
  readonly operation: ManagementOperation;
  readonly status: "committed" | "failed";
  readonly authorization_mode: ManagementAuthorizationMode;
  readonly before_sha256: string;
  readonly after_sha256: string;
  readonly backup_id?: string;
  readonly error_code?: string;
  readonly rollback_attempted?: boolean;
  readonly rollback_succeeded?: boolean;
  readonly rollback_reason?: string;
}

class ManagementHandlerError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ManagementHandlerError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true });
    }
  }
}

function errorCode(error: unknown, fallback = "MANAGEMENT_FAILED"): string {
  if (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string" &&
    ERROR_CODE.test(error.code)
  ) {
    return error.code;
  }
  return fallback;
}

function sameFile(
  first: { readonly dev: number; readonly ino: number },
  second: { readonly dev: number; readonly ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

async function setPrivateMode(file: string, mode: number): Promise<void> {
  try {
    await chmod(file, mode);
  } catch (error) {
    if (process.platform !== "win32") throw error;
  }
}

async function ensurePrivateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const stat = await lstat(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new ManagementHandlerError(
      "UNSAFE_DATA_DIRECTORY",
      "management directory is not a regular directory",
    );
  }
  await setPrivateMode(directory, 0o700);
}

async function readClaimedFile(file: string): Promise<Buffer> {
  const initial = await lstat(file);
  if (initial.isSymbolicLink() || !initial.isFile()) {
    throw new ManagementHandlerError(
      "UNSAFE_REQUEST_FILE",
      "claimed request is not a regular file",
    );
  }
  if (initial.size < 2 || initial.size > MAX_MANAGEMENT_REQUEST_BYTES) {
    throw new ManagementHandlerError(
      "REQUEST_INVALID",
      "claimed request has an invalid size",
    );
  }

  const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  const handle = await open(file, constants.O_RDONLY | noFollow);
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(initial, opened)) {
      throw new ManagementHandlerError(
        "UNSAFE_REQUEST_FILE",
        "claimed request changed before it was opened",
      );
    }
    const bytes = await handle.readFile();
    if (bytes.length !== opened.size || bytes.length > MAX_MANAGEMENT_REQUEST_BYTES) {
      throw new ManagementHandlerError(
        "REQUEST_INVALID",
        "claimed request changed while it was read",
      );
    }
    const final = await lstat(file);
    if (final.isSymbolicLink() || !final.isFile() || !sameFile(opened, final)) {
      throw new ManagementHandlerError(
        "UNSAFE_REQUEST_FILE",
        "claimed request changed while it was read",
      );
    }
    return bytes;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function tokensEqual(first: string, second: string): boolean {
  const firstBytes = Buffer.from(first, "ascii");
  const secondBytes = Buffer.from(second, "ascii");
  return firstBytes.length === secondBytes.length && timingSafeEqual(firstBytes, secondBytes);
}

function targetPath(request: ManagementRequest): string | undefined {
  return request.operation === "move" ? request.payload.destination : undefined;
}

function cloneFrontmatterValue(value: FrontmatterValue): FrontmatterValue {
  if (value === null || typeof value !== "object") return value;
  return [...value];
}

function frontmatterValueEquals(actual: unknown, expected: FrontmatterValue): boolean {
  if (!Array.isArray(expected)) return Object.is(actual, expected);
  return (
    Array.isArray(actual) &&
    actual.length === expected.length &&
    actual.every((value, index) => Object.is(value, expected[index]))
  );
}

function frontmatterMatches(
  actual: Readonly<Record<string, unknown>>,
  request: Extract<ManagementRequest, { readonly operation: "frontmatter" }>,
): boolean {
  for (const [key, expected] of Object.entries(request.payload.set)) {
    if (
      !Object.prototype.hasOwnProperty.call(actual, key) ||
      !frontmatterValueEquals(actual[key], expected)
    ) {
      return false;
    }
  }
  return request.payload.remove.every(
    (key) => !Object.prototype.hasOwnProperty.call(actual, key),
  );
}

function applyFrontmatter(
  frontmatter: Record<string, unknown>,
  request: Extract<ManagementRequest, { readonly operation: "frontmatter" }>,
): void {
  for (const [key, value] of Object.entries(request.payload.set)) {
    Object.defineProperty(frontmatter, key, {
      configurable: true,
      enumerable: true,
      writable: true,
      value: cloneFrontmatterValue(value),
    });
  }
  for (const key of request.payload.remove) delete frontmatter[key];
}

/**
 * Consumes one request file and executes its mutation serially inside Obsidian.
 * The public `handle` method returns compact JSON suitable for registerCliHandler.
 */
export class ManagementRequestHandler {
  readonly #dataDirectory: string;
  readonly #vaultId: string;
  readonly #api: ManagementVaultApi;
  readonly #authorize: ManagementHandlerDependencies["authorize"];
  readonly #now: () => number;
  readonly #createId: () => string;
  #queue: Promise<void> = Promise.resolve();

  constructor(dependencies: ManagementHandlerDependencies) {
    if (!path.isAbsolute(dependencies.dataDirectory)) {
      throw new ManagementHandlerError(
        "DATA_DIRECTORY_INVALID",
        "management data directory must be absolute",
      );
    }
    if (!VAULT_ID.test(dependencies.vaultId)) {
      throw new ManagementHandlerError("VAULT_ID_INVALID", "vaultId is invalid");
    }
    this.#dataDirectory = path.resolve(dependencies.dataDirectory);
    this.#vaultId = dependencies.vaultId;
    this.#api = dependencies.api;
    this.#authorize = dependencies.authorize;
    this.#now = dependencies.now ?? Date.now;
    this.#createId = dependencies.createId ?? randomUUID;
  }

  async handle(input: ManagementCommandInput): Promise<string> {
    const response = await this.handleResult(input);
    return JSON.stringify(response);
  }

  async handleResult(
    input: ManagementCommandInput,
  ): Promise<ManagementCommandResponse | ManagementRejectedResponse> {
    const operation = this.#queue.then(
      async () => await this.#execute(input),
      async () => await this.#execute(input),
    );
    this.#queue = operation.then(
      () => undefined,
      () => undefined,
    );
    return await operation;
  }

  async #claim(requestId: string): Promise<ClaimedRequest> {
    await ensurePrivateDirectory(this.#dataDirectory);
    await ensurePrivateDirectory(path.join(this.#dataDirectory, "management"));
    await ensurePrivateDirectory(managementRequestsDirectory(this.#dataDirectory));
    const processingDirectory = managementProcessingDirectory(this.#dataDirectory);
    await ensurePrivateDirectory(processingDirectory);

    const source = managementRequestPath(this.#dataDirectory, requestId);
    const claimedPath = path.join(
      processingDirectory,
      `${requestId}-${this.#nextId()}.json`,
    );
    try {
      await rename(source, claimedPath);
    } catch (error) {
      throw new ManagementHandlerError(
        errorCode(error) === "ENOENT" ? "REQUEST_NOT_FOUND" : "REQUEST_CLAIM_FAILED",
        "management request cannot be claimed",
        error,
      );
    }

    try {
      return { path: claimedPath, bytes: await readClaimedFile(claimedPath) };
    } catch (error) {
      await unlink(claimedPath).catch(() => undefined);
      throw error;
    }
  }

  async #execute(
    input: ManagementCommandInput,
  ): Promise<ManagementCommandResponse | ManagementRejectedResponse> {
    const requestId = typeof input.request_id === "string" ? input.request_id : "";
    if (!isUuid(requestId) || !isManagementToken(input.token)) {
      return this.#rejected(requestId, "REQUEST_ARGUMENTS_INVALID");
    }

    let claimed: ClaimedRequest;
    try {
      claimed = await this.#claim(requestId);
    } catch (error) {
      return this.#rejected(requestId, errorCode(error));
    }

    // Remove the claimed body before parsing, authorizing, or mutating. A
    // cleanup failure stops the operation so a sensitive request cannot linger
    // in the processing directory while its mutation is applied.
    try {
      await unlink(claimed.path);
    } catch {
      return this.#rejected(requestId, "REQUEST_CLEANUP_FAILED");
    }

    try {
      let request: ManagementRequest;
      try {
        request = parseManagementRequest(claimed.bytes);
      } catch (error) {
        return this.#rejected(requestId, errorCode(error, "REQUEST_INVALID"));
      }
      // Do not disclose request metadata to a caller that does not possess the
      // one-time token. The claimed file is still consumed fail-closed.
      if (!tokensEqual(request.token, input.token)) {
        return this.#rejected(requestId, "REQUEST_TOKEN_MISMATCH");
      }
      if (request.request_id !== requestId) {
        return this.#rejected(requestId, "REQUEST_ID_MISMATCH");
      }
      return await this.#executeClaimed(request);
    } catch (error) {
      // A valid parsed request is handled inside #executeClaimed. Reaching this
      // guard means an unexpected implementation failure occurred before its
      // structured failure response could be built.
      return this.#rejected(requestId, errorCode(error));
    }
  }

  #rejected(requestId: string, code: string): ManagementRejectedResponse {
    return Object.freeze({
      version: MANAGEMENT_REQUEST_VERSION,
      request_id: requestId,
      status: "failed",
      verified: false,
      audit_recorded: false,
      error_code: ERROR_CODE.test(code) ? code : "MANAGEMENT_FAILED",
    });
  }

  async #executeClaimed(
    request: ManagementRequest,
  ): Promise<ManagementCommandResponse> {
    const state: ExecutionState = {
      authorizationMode: "management",
      afterSha256: request.before_sha256,
      mutationStarted: false,
      mutationCompleted: false,
    };

    try {
      this.#validateEnvelope(request);
      const initialAuthorization = await this.#authorization(request, "initial");
      state.authorizationMode = initialAuthorization.mode;
      if (!initialAuthorization.allowed) {
        throw new ManagementHandlerError(
          initialAuthorization.error_code ?? "AUTHORIZATION_DENIED",
          "management request is not authorized",
        );
      }

      const beforeContent = await this.#api.readMarkdown(request.path);
      if (beforeContent === null) {
        throw new ManagementHandlerError("NOTE_NOT_FOUND", "source note does not exist");
      }
      if (hashPresentDocument(beforeContent) !== request.before_sha256) {
        throw new ManagementHandlerError("CHANGE_CONFLICT", "source note changed");
      }
      if (
        request.operation === "move" &&
        (await this.#api.readMarkdown(request.payload.destination)) !== null
      ) {
        throw new ManagementHandlerError("TARGET_EXISTS", "move destination already exists");
      }

      try {
        state.backupId = await this.#createBackup(request, beforeContent);
      } catch (error) {
        throw new ManagementHandlerError(
          "BACKUP_FAILED",
          "backup v2 could not be created",
          error,
        );
      }

      const commitAuthorization = await this.#authorization(request, "commit");
      state.authorizationMode = commitAuthorization.mode;
      if (!commitAuthorization.allowed) {
        throw new ManagementHandlerError(
          commitAuthorization.error_code ?? "AUTHORIZATION_REVOKED",
          "management authorization was revoked before commit",
        );
      }

      await this.#assertCurrentPrecondition(request);
      state.mutationStarted = true;
      try {
        await this.#apply(request, state);
        state.mutationCompleted = true;
      } catch (error) {
        if (await this.#postcondition(request, state).catch(() => false)) {
          state.mutationCompleted = true;
        } else {
          const code = errorCode(error, "MUTATION_FAILED");
          throw new ManagementHandlerError(
            code,
            "managed mutation did not reach its postcondition",
            error,
          );
        }
      }

      if (!(await this.#postcondition(request, state))) {
        throw new ManagementHandlerError(
          "VERIFICATION_FAILED",
          "management postcondition was not verified",
        );
      }

      const response = this.#response(request, state, "committed", true);
      const auditRecorded = await this.#appendAudit(
        this.#auditEvent(request, state, "committed"),
      );
      return Object.freeze({ ...response, audit_recorded: auditRecorded });
    } catch (error) {
      const code = errorCode(error);
      if (state.mutationStarted && !(await this.#postcondition(request, state).catch(() => false))) {
        await this.#attemptRollback(request, state);
      }
      const event = this.#auditEvent(request, state, "failed", code);
      const auditRecorded = await this.#appendAudit(event);
      return Object.freeze({
        ...this.#response(request, state, "failed", false, code),
        audit_recorded: auditRecorded,
      });
    }
  }

  #validateEnvelope(request: ManagementRequest): void {
    if (request.vault_id !== this.#vaultId) {
      throw new ManagementHandlerError("VAULT_MISMATCH", "request targets another vault");
    }
    const now = this.#now();
    if (Date.parse(request.created_at) > now + MAX_CLOCK_SKEW_MS) {
      throw new ManagementHandlerError("REQUEST_NOT_YET_VALID", "request is not yet valid");
    }
    if (Date.parse(request.expires_at) <= now) {
      throw new ManagementHandlerError("REQUEST_EXPIRED", "request has expired");
    }
  }

  async #authorization(
    request: ManagementRequest,
    phase: ManagementAuthorizationPhase,
  ): Promise<ManagementAuthorizationDecision> {
    let decision: ManagementAuthorizationDecision;
    try {
      decision = await this.#authorize(request, phase);
    } catch (error) {
      throw new ManagementHandlerError(
        "AUTHORIZATION_FAILED",
        "authorization callback failed",
        error,
      );
    }
    if (
      typeof decision?.allowed !== "boolean" ||
      decision.mode !== "management" ||
      (decision.error_code !== undefined && !ERROR_CODE.test(decision.error_code))
    ) {
      throw new ManagementHandlerError(
        "AUTHORIZATION_INVALID",
        "authorization callback returned an invalid decision",
      );
    }
    return decision;
  }

  async #assertCurrentPrecondition(request: ManagementRequest): Promise<void> {
    const current = await this.#api.readMarkdown(request.path);
    if (current === null || hashPresentDocument(current) !== request.before_sha256) {
      throw new ManagementHandlerError("CHANGE_CONFLICT", "source note changed before commit");
    }
    if (
      request.operation === "move" &&
      (await this.#api.readMarkdown(request.payload.destination)) !== null
    ) {
      throw new ManagementHandlerError("TARGET_EXISTS", "move destination appeared before commit");
    }
  }

  async #apply(request: ManagementRequest, state: ExecutionState): Promise<void> {
    switch (request.operation) {
      case "replace": {
        const written = await this.#api.processMarkdown(request.path, (current) => {
          if (hashPresentDocument(current) !== request.before_sha256) {
            throw new ManagementHandlerError("CHANGE_CONFLICT", "source changed inside process");
          }
          return request.payload.content;
        });
        state.knownAppliedSha256 = hashPresentDocument(written);
        state.afterSha256 = state.knownAppliedSha256;
        return;
      }
      case "frontmatter": {
        const written = await this.#api.rewriteFrontMatterMarkdown(
          request.path,
          request.before_sha256,
          (frontmatter) => applyFrontmatter(frontmatter, request),
        );
        state.knownAppliedSha256 = hashPresentDocument(written);
        state.afterSha256 = state.knownAppliedSha256;
        return;
      }
      case "move":
        await this.#api.renameFile(request.path, request.payload.destination);
        state.knownAppliedSha256 = request.before_sha256;
        state.afterSha256 = request.before_sha256;
        return;
      case "trash":
        await this.#api.trashFile(request.path);
        state.knownAppliedSha256 = MISSING_DOCUMENT_SHA256;
        state.afterSha256 = MISSING_DOCUMENT_SHA256;
        return;
    }
  }

  async #postcondition(request: ManagementRequest, state: ExecutionState): Promise<boolean> {
    switch (request.operation) {
      case "replace": {
        const current = await this.#api.readMarkdown(request.path);
        if (current === null) return false;
        state.afterSha256 = hashPresentDocument(current);
        return state.afterSha256 === request.payload.after_sha256;
      }
      case "frontmatter": {
        const current = await this.#api.readMarkdown(request.path);
        if (current === null) return false;
        state.afterSha256 = hashPresentDocument(current);
        const frontmatter = await this.#api.readFrontMatter(request.path);
        return frontmatterMatches(frontmatter, request);
      }
      case "move": {
        const [source, destination] = await Promise.all([
          this.#api.readMarkdown(request.path),
          this.#api.readMarkdown(request.payload.destination),
        ]);
        if (source !== null || destination === null) return false;
        state.afterSha256 = hashPresentDocument(destination);
        return state.afterSha256 === request.before_sha256;
      }
      case "trash": {
        const source = await this.#api.readMarkdown(request.path);
        if (source !== null) {
          state.afterSha256 = hashPresentDocument(source);
          return false;
        }
        state.afterSha256 = MISSING_DOCUMENT_SHA256;
        return true;
      }
    }
  }

  async #attemptRollback(request: ManagementRequest, state: ExecutionState): Promise<void> {
    state.rollbackAttempted = true;
    try {
      if (request.operation === "replace" || request.operation === "frontmatter") {
        const backup = await this.#readBackupContent(state.backupId, request);
        const current = await this.#api.readMarkdown(request.path);
        if (
          backup === undefined ||
          current === null ||
          state.knownAppliedSha256 === undefined ||
          hashPresentDocument(current) !== state.knownAppliedSha256
        ) {
          state.rollbackSucceeded = false;
          state.rollbackReason = "recovery_scope_changed";
          return;
        }
        await this.#api.processMarkdown(request.path, (observed) => {
          if (hashPresentDocument(observed) !== state.knownAppliedSha256) {
            throw new ManagementHandlerError(
              "ROLLBACK_CONFLICT",
              "note changed before rollback",
            );
          }
          return backup;
        });
        const restored = await this.#api.readMarkdown(request.path);
        state.rollbackSucceeded =
          restored !== null && hashPresentDocument(restored) === request.before_sha256;
        if (state.rollbackSucceeded) {
          state.afterSha256 = request.before_sha256;
          state.knownAppliedSha256 = request.before_sha256;
        }
        state.rollbackReason = state.rollbackSucceeded
          ? "backup_restored"
          : "verification_failed";
        return;
      }

      if (request.operation === "move") {
        const [source, destination] = await Promise.all([
          this.#api.readMarkdown(request.path),
          this.#api.readMarkdown(request.payload.destination),
        ]);
        if (
          source !== null ||
          destination === null ||
          hashPresentDocument(destination) !== request.before_sha256
        ) {
          state.rollbackSucceeded = false;
          state.rollbackReason = "recovery_scope_changed";
          return;
        }
        await this.#api.renameFile(request.payload.destination, request.path);
        const restored = await this.#api.readMarkdown(request.path);
        state.rollbackSucceeded =
          restored !== null && hashPresentDocument(restored) === request.before_sha256;
        state.rollbackReason = state.rollbackSucceeded
          ? "move_reversed"
          : "verification_failed";
        return;
      }

      state.rollbackSucceeded = false;
      state.rollbackReason = "trash_requires_backup_restore";
    } catch {
      state.rollbackSucceeded = false;
      state.rollbackReason = "rollback_failed";
    }
  }

  async #createBackup(request: ManagementRequest, content: string): Promise<string> {
    const backupDirectory = path.join(this.#dataDirectory, "backups");
    await ensurePrivateDirectory(backupDirectory);
    const backupId = `${new Date(this.#now()).toISOString().replace(/:/gu, "-")}-${this.#nextId()}`;
    const backupPath = path.join(backupDirectory, `${backupId}.json`);
    const bundle = {
      version: MANAGEMENT_BACKUP_VERSION,
      created_at: new Date(this.#now()).toISOString(),
      request_id: request.request_id,
      change_id: request.change_id,
      vault_id: request.vault_id,
      operation: request.operation,
      path: request.path,
      ...(request.operation === "move"
        ? { target_path: request.payload.destination }
        : {}),
      before_sha256: request.before_sha256,
      files: [
        {
          path: request.path,
          sha256: request.before_sha256,
          content,
        },
      ],
    };
    try {
      await writeFile(backupPath, JSON.stringify(bundle), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      await setPrivateMode(backupPath, 0o600);
      const verified = await this.#readBackupContent(backupId, request);
      if (verified !== content) {
        throw new ManagementHandlerError(
          "BACKUP_VERIFICATION_FAILED",
          "backup v2 did not pass read-back verification",
        );
      }
    } catch (error) {
      await unlink(backupPath).catch(() => undefined);
      throw error;
    }
    // Retention is shared with legacy v1 writer backups. Pruning is deliberately
    // best-effort: a verified recovery copy must not turn a valid mutation into
    // a false failure merely because an older file could not be removed.
    await this.#pruneBackups(backupDirectory, path.basename(backupPath)).catch(
      () => undefined,
    );
    return backupId;
  }

  async #pruneBackups(
    backupDirectory: string,
    currentBackupName: string,
  ): Promise<void> {
    const names = (await readdir(backupDirectory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort()
      .reverse();
    const retained = new Set(
      [
        currentBackupName,
        ...names.filter((name) => name !== currentBackupName),
      ].slice(0, MANAGEMENT_BACKUP_RETENTION),
    );

    for (const name of names) {
      if (retained.has(name)) continue;
      const candidate = path.join(backupDirectory, name);
      try {
        const stat = await lstat(candidate);
        if (stat.isSymbolicLink() || !stat.isFile()) continue;
        await unlink(candidate);
      } catch {
        // Another writer, permissions, or a hostile replacement must not make
        // the already-verified backup or the pending mutation look unsuccessful.
      }
    }
  }

  async #readBackupContent(
    backupId: string | undefined,
    request: ManagementRequest,
  ): Promise<string | undefined> {
    if (backupId === undefined || !/^[0-9A-Za-z._+-]{1,200}$/u.test(backupId)) {
      return undefined;
    }
    const backupPath = path.join(this.#dataDirectory, "backups", `${backupId}.json`);
    const stat = await lstat(backupPath);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_MANAGEMENT_BACKUP_BYTES) {
      return undefined;
    }
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    const raw = await open(backupPath, constants.O_RDONLY | noFollow);
    try {
      const opened = await raw.stat();
      if (!opened.isFile() || !sameFile(stat, opened)) return undefined;
      const text = await raw.readFile({ encoding: "utf8" });
      const final = await lstat(backupPath);
      if (final.isSymbolicLink() || !final.isFile() || !sameFile(opened, final)) {
        return undefined;
      }
      const parsed = JSON.parse(text) as unknown;
      if (
        parsed === null ||
        typeof parsed !== "object" ||
        !("version" in parsed) ||
        parsed.version !== MANAGEMENT_BACKUP_VERSION ||
        !("request_id" in parsed) ||
        parsed.request_id !== request.request_id ||
        !("change_id" in parsed) ||
        parsed.change_id !== request.change_id ||
        !("vault_id" in parsed) ||
        parsed.vault_id !== request.vault_id ||
        !("operation" in parsed) ||
        parsed.operation !== request.operation ||
        !("path" in parsed) ||
        parsed.path !== request.path ||
        !("before_sha256" in parsed) ||
        parsed.before_sha256 !== request.before_sha256 ||
        !("files" in parsed) ||
        !Array.isArray(parsed.files) ||
        parsed.files.length !== 1
      ) {
        return undefined;
      }
      const file = parsed.files[0] as unknown;
      if (
        file === null ||
        typeof file !== "object" ||
        !("path" in file) ||
        file.path !== request.path ||
        !("sha256" in file) ||
        file.sha256 !== request.before_sha256 ||
        !("content" in file) ||
        typeof file.content !== "string" ||
        hashPresentDocument(file.content) !== request.before_sha256
      ) {
        return undefined;
      }
      return file.content;
    } finally {
      await raw.close().catch(() => undefined);
    }
  }

  #nextId(): string {
    const value = this.#createId();
    if (
      !/^[0-9A-Za-z_+.-]{1,100}$/u.test(value) ||
      value === "." ||
      value === ".."
    ) {
      throw new ManagementHandlerError("ID_GENERATION_FAILED", "generated ID is unsafe");
    }
    return value;
  }

  #auditEvent(
    request: ManagementRequest,
    state: ExecutionState,
    status: "committed" | "failed",
    failureCode?: string,
  ): AuditEvent {
    const destination = targetPath(request);
    return Object.freeze({
      timestamp: new Date(this.#now()).toISOString(),
      change_id: request.change_id,
      vault: request.vault_id,
      path: request.path,
      ...(destination === undefined ? {} : { target_path: destination }),
      operation: request.operation,
      status,
      authorization_mode: state.authorizationMode,
      before_sha256: request.before_sha256,
      after_sha256: state.afterSha256,
      ...(state.backupId === undefined ? {} : { backup_id: state.backupId }),
      ...(failureCode === undefined ? {} : { error_code: failureCode }),
      ...(state.rollbackAttempted === undefined
        ? {}
        : { rollback_attempted: state.rollbackAttempted }),
      ...(state.rollbackSucceeded === undefined
        ? {}
        : { rollback_succeeded: state.rollbackSucceeded }),
      ...(state.rollbackReason === undefined
        ? {}
        : { rollback_reason: state.rollbackReason }),
    });
  }

  async #appendAudit(event: AuditEvent): Promise<boolean> {
    try {
      await ensurePrivateDirectory(this.#dataDirectory);
      const auditPath = path.join(this.#dataDirectory, "audit.ndjson");
      try {
        const stat = await lstat(auditPath);
        if (stat.isSymbolicLink() || !stat.isFile()) return false;
      } catch (error) {
        if (errorCode(error) !== "ENOENT") return false;
      }
      const line = `${JSON.stringify(event)}\n`;
      if (Buffer.byteLength(line, "utf8") > MAX_AUDIT_LINE_BYTES) return false;
      const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
      const handle = await open(
        auditPath,
        constants.O_APPEND | constants.O_CREAT | constants.O_WRONLY | noFollow,
        0o600,
      );
      try {
        const stat = await handle.stat();
        if (!stat.isFile()) return false;
        await handle.writeFile(line, { encoding: "utf8" });
      } finally {
        await handle.close().catch(() => undefined);
      }
      await setPrivateMode(auditPath, 0o600);
      return true;
    } catch {
      return false;
    }
  }

  #response(
    request: ManagementRequest,
    state: ExecutionState,
    status: "committed" | "failed",
    verified: boolean,
    failureCode?: string,
  ): Omit<ManagementCommandResponse, "audit_recorded"> {
    const destination = targetPath(request);
    return Object.freeze({
      version: MANAGEMENT_REQUEST_VERSION,
      request_id: request.request_id,
      change_id: request.change_id,
      status,
      operation: request.operation,
      path: request.path,
      ...(destination === undefined ? {} : { target_path: destination }),
      before_sha256: request.before_sha256,
      after_sha256: state.afterSha256,
      verified,
      ...(state.backupId === undefined ? {} : { backup_id: state.backupId }),
      ...(failureCode === undefined ? {} : { error_code: failureCode }),
      ...(state.rollbackAttempted === undefined
        ? {}
        : { rollback_attempted: state.rollbackAttempted }),
      ...(state.rollbackSucceeded === undefined
        ? {}
        : { rollback_succeeded: state.rollbackSucceeded }),
      ...(state.rollbackReason === undefined
        ? {}
        : { rollback_reason: state.rollbackReason }),
    });
  }
}
