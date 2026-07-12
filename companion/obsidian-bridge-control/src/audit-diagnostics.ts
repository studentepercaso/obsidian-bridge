import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import type { DesktopPlatform } from "./shared-settings.js";

export const AUDIT_TAIL_MAX_BYTES = 128 * 1024;
export const AUDIT_RESULT_MAX_RECORDS = 20;

const DEFAULT_RESULT_LIMIT = 10;
const MAX_AUDIT_LINES = 4_096;
const MAX_AUDIT_LINE_BYTES = 16 * 1024;
const VAULT_ID = /^[0-9a-f]{16}$/u;
const CHANGE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const BACKUP_ID = /^[0-9A-Za-z._+-]{1,200}$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const WRITE_ERROR_CODES = new Set([
  "WRITE_FAILED_ROLLBACK_SUCCEEDED",
  "WRITE_FAILED_ROLLBACK_FAILED",
  "WRITE_FAILED_MANUAL_RECOVERY_REQUIRED",
]);
const VERIFICATION_ERROR_CODES = new Set([
  "VERIFICATION_FAILED_ROLLBACK_SUCCEEDED",
  "VERIFICATION_FAILED_ROLLBACK_FAILED",
  "VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED",
]);
const COMMIT_ERROR_CODES = new Set([
  "COMMIT_INVALID_LOCK_OPTIONS",
  "COMMIT_LOCK_ABORTED",
  "COMMIT_LOCK_IO_ERROR",
  "COMMIT_LOCK_OWNERSHIP_LOST",
  "COMMIT_LOCK_TIMEOUT",
  "COMMIT_UNSAFE_LOCK_PATH",
]);
const CAUSE_CODES = new Set([
  "CLI_INVALID_ARGUMENTS",
  "CLI_SPAWN_FAILED",
  "CLI_TIMEOUT",
  "CLI_OUTPUT_LIMIT",
  "CLI_ABORTED",
  "CLI_NOT_ENABLED",
  "CLI_REPORTED_ERROR",
  "CLI_NON_ZERO_EXIT",
  "CHANGE_CONFLICT",
  "PHYSICAL_PATH_NOT_ALLOWED",
  "COMMIT_INVALID_LOCK_OPTIONS",
  "COMMIT_LOCK_ABORTED",
  "COMMIT_LOCK_IO_ERROR",
  "COMMIT_LOCK_OWNERSHIP_LOST",
  "COMMIT_LOCK_TIMEOUT",
  "COMMIT_UNSAFE_LOCK_PATH",
  "POST_WRITE_VERIFICATION",
  "POST_WRITE_MISMATCH",
  "RANGE_ERROR",
  "UNEXPECTED_ERROR",
]);

const AUDIT_KEYS = new Set([
  "timestamp",
  "change_id",
  "vault",
  "path",
  "target_path",
  "operation",
  "status",
  "authorization_mode",
  "before_sha256",
  "after_sha256",
  "backup_id",
  "error_code",
  "failure_stage",
  "cause_code",
  "rollback_attempted",
  "rollback_succeeded",
  "rollback_reason",
]);

export type AuditDiagnosticState = "ready" | "missing" | "unsafe" | "error";
export type AuditSeverity = "success" | "warning" | "error";
export type AuditOperation =
  | "create"
  | "append"
  | "replace"
  | "frontmatter"
  | "move"
  | "trash";
export type AuditRecovery =
  | "none-needed"
  | "not-applied"
  | "restored"
  | "manual-review";
export type AuditFailureStage =
  | "pre_write"
  | "write"
  | "verification"
  | "commit_lock";

export interface AuditDiagnosticRecord {
  readonly timestamp: string;
  readonly changeId: string;
  readonly path: string;
  readonly targetPath?: string;
  readonly operation: AuditOperation;
  readonly status: "committed" | "failed";
  readonly authorizationMode: "protected" | "autonomous" | "management";
  readonly errorCode?: string;
  readonly failureStage?: AuditFailureStage;
  readonly causeCode?: string;
  readonly backupId?: string;
  readonly rollbackAttempted: boolean;
  readonly rollbackSucceeded: boolean | null;
  readonly rollbackReason?: string;
  readonly severity: AuditSeverity;
  readonly recovery: AuditRecovery;
  readonly summary: string;
  readonly guidance: string;
}

export interface AuditDiagnosticsResult {
  readonly state: AuditDiagnosticState;
  readonly dataDirectory: string;
  readonly auditPath: string;
  /** Newest record first. This collection never contains note bodies. */
  readonly records: readonly AuditDiagnosticRecord[];
  /** Newest failed records, retained independently from later successes. */
  readonly failedRecords: readonly AuditDiagnosticRecord[];
  readonly scannedLines: number;
  readonly malformedLines: number;
  readonly truncated: boolean;
  readonly detail: string;
  readonly errorCode?: string;
}

export interface ReadAuditDiagnosticsOptions {
  readonly platform?: DesktopPlatform;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDirectory?: string;
  /** Values above 20 are deliberately capped. */
  readonly limit?: number;
}

interface ParsedAuditRecord {
  readonly timestamp: string;
  readonly changeId: string;
  readonly vault: string;
  readonly path: string;
  readonly targetPath?: string;
  readonly operation: AuditOperation;
  readonly status: "committed" | "failed";
  readonly authorizationMode: "protected" | "autonomous" | "management";
  readonly errorCode?: string;
  readonly failureStage?: AuditFailureStage;
  readonly causeCode?: string;
  readonly backupId?: string;
  readonly rollbackAttempted?: boolean;
  readonly rollbackSucceeded?: boolean;
  readonly rollbackReason?: string;
}

function currentDesktopPlatform(): DesktopPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function platformPath(platform: DesktopPlatform): typeof path.posix {
  return platform === "windows" ? path.win32 : path.posix;
}

function validAbsolutePath(
  value: string,
  platform: DesktopPlatform,
): boolean {
  return platformPath(platform).isAbsolute(value) && !CONTROL_CHARACTER.test(value);
}

/** Resolve the same private data directory used by the bridge server. */
export function bridgeDataDirectory(
  platform: DesktopPlatform = currentDesktopPlatform(),
  env: NodeJS.ProcessEnv = process.env,
  homeDirectory: string = homedir(),
): string {
  const pathApi = platformPath(platform);
  const override = env.OBSIDIAN_BRIDGE_DATA_DIR?.trim();
  if (override) {
    if (!validAbsolutePath(override, platform)) {
      throw new Error(
        "OBSIDIAN_BRIDGE_DATA_DIR deve essere un percorso assoluto valido.",
      );
    }
    return pathApi.resolve(override);
  }

  let candidate: string;
  if (platform === "windows" && env.LOCALAPPDATA?.trim()) {
    candidate = pathApi.join(env.LOCALAPPDATA.trim(), "obsidian-bridge");
  } else if (platform === "macos") {
    candidate = pathApi.join(
      homeDirectory,
      "Library",
      "Application Support",
      "obsidian-bridge",
    );
  } else {
    const dataRoot = env.XDG_DATA_HOME?.trim() ||
      pathApi.join(homeDirectory, ".local", "share");
    candidate = pathApi.join(dataRoot, "obsidian-bridge");
  }

  if (!validAbsolutePath(candidate, platform)) {
    throw new Error(
      "La cartella dati del bridge deve essere un percorso assoluto valido.",
    );
  }
  return pathApi.resolve(candidate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBoundedText(
  value: unknown,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximumLength &&
    !CONTROL_CHARACTER.test(value)
  );
}

function isSafeNotePath(value: unknown): value is string {
  if (
    !isBoundedText(value, 1_024) ||
    !value.endsWith(".md") ||
    value.startsWith("/") ||
    value.startsWith("\\") ||
    /^[A-Za-z]:/u.test(value)
  ) {
    return false;
  }
  const segments = value.replace(/\\/gu, "/").split("/");
  return segments.every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}

function hasConsistentFailureStage(
  operation: unknown,
  errorCode: unknown,
  failureStage: unknown,
): boolean {
  if (failureStage === undefined) return true;
  if (typeof errorCode !== "string") return false;

  if (operation === "create" || operation === "append") {
    if (failureStage === "pre_write") {
      return errorCode === "PRE_WRITE_FAILED" || errorCode === "CHANGE_CONFLICT";
    }
    if (failureStage === "write") return WRITE_ERROR_CODES.has(errorCode);
    if (failureStage === "verification") {
      return VERIFICATION_ERROR_CODES.has(errorCode);
    }
    if (failureStage === "commit_lock") {
      return COMMIT_ERROR_CODES.has(errorCode);
    }
    return false;
  }
  return false;
}

function parseAuditLine(line: string): ParsedAuditRecord | undefined {
  if (
    line.length === 0 ||
    Buffer.byteLength(line, "utf8") > MAX_AUDIT_LINE_BYTES
  ) {
    return undefined;
  }

  let value: unknown;
  try {
    value = JSON.parse(line) as unknown;
  } catch {
    return undefined;
  }
  if (!isRecord(value)) return undefined;

  const keys = Object.keys(value);
  if (keys.length > AUDIT_KEYS.size || keys.some((key) => !AUDIT_KEYS.has(key))) {
    return undefined;
  }
  if (
    typeof value.timestamp !== "string" ||
    !ISO_TIMESTAMP.test(value.timestamp) ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    typeof value.change_id !== "string" ||
    !CHANGE_ID.test(value.change_id) ||
    typeof value.vault !== "string" ||
    !VAULT_ID.test(value.vault) ||
    !isSafeNotePath(value.path) ||
    (value.target_path !== undefined && !isSafeNotePath(value.target_path)) ||
    (value.operation !== "create" &&
      value.operation !== "append" &&
      value.operation !== "replace" &&
      value.operation !== "frontmatter" &&
      value.operation !== "move" &&
      value.operation !== "trash") ||
    (value.status !== "committed" && value.status !== "failed") ||
    (value.authorization_mode !== undefined &&
      value.authorization_mode !== "protected" &&
      value.authorization_mode !== "autonomous" &&
      value.authorization_mode !== "management") ||
    typeof value.before_sha256 !== "string" ||
    !SHA256.test(value.before_sha256) ||
    typeof value.after_sha256 !== "string" ||
    !SHA256.test(value.after_sha256)
  ) {
    return undefined;
  }

  if (
    (value.backup_id !== undefined &&
      (typeof value.backup_id !== "string" || !BACKUP_ID.test(value.backup_id))) ||
    (value.error_code !== undefined &&
      (typeof value.error_code !== "string" || !ERROR_CODE.test(value.error_code))) ||
    (value.failure_stage !== undefined &&
      value.failure_stage !== "pre_write" &&
      value.failure_stage !== "write" &&
      value.failure_stage !== "verification" &&
      value.failure_stage !== "commit_lock") ||
    (value.cause_code !== undefined &&
      (typeof value.cause_code !== "string" || !CAUSE_CODES.has(value.cause_code))) ||
    (value.rollback_attempted !== undefined &&
      typeof value.rollback_attempted !== "boolean") ||
    (value.rollback_succeeded !== undefined &&
      typeof value.rollback_succeeded !== "boolean") ||
    (value.rollback_reason !== undefined &&
      !isBoundedText(value.rollback_reason, 256))
  ) {
    return undefined;
  }

  if (
    (value.operation === "move" && value.target_path === undefined) ||
    (value.operation !== "move" && value.target_path !== undefined) ||
    (value.status === "committed" && value.error_code !== undefined) ||
    (value.status === "failed" && value.error_code === undefined) ||
    ((value.failure_stage === undefined) !==
      (value.cause_code === undefined)) ||
    (value.status !== "failed" && value.failure_stage !== undefined) ||
    !hasConsistentFailureStage(
      value.operation,
      value.error_code,
      value.failure_stage,
    ) ||
    (value.rollback_succeeded !== undefined &&
      value.rollback_attempted === undefined)
  ) {
    return undefined;
  }

  return {
    timestamp: value.timestamp,
    changeId: value.change_id,
    vault: value.vault,
    path: value.path,
    ...(value.target_path === undefined
      ? {}
      : { targetPath: value.target_path }),
    operation: value.operation,
    status: value.status,
    authorizationMode:
      value.authorization_mode === "autonomous" ||
      value.authorization_mode === "management"
        ? value.authorization_mode
        : "protected",
    ...(value.error_code === undefined ? {} : { errorCode: value.error_code }),
    ...(value.failure_stage === undefined
      ? {}
      : { failureStage: value.failure_stage as AuditFailureStage }),
    ...(value.cause_code === undefined ? {} : { causeCode: value.cause_code }),
    ...(value.backup_id === undefined ? {} : { backupId: value.backup_id }),
    ...(value.rollback_attempted === undefined
      ? {}
      : { rollbackAttempted: value.rollback_attempted }),
    ...(value.rollback_succeeded === undefined
      ? {}
      : { rollbackSucceeded: value.rollback_succeeded }),
    ...(value.rollback_reason === undefined
      ? {}
      : { rollbackReason: value.rollback_reason }),
  };
}

function classifyAuditRecord(record: ParsedAuditRecord): AuditDiagnosticRecord {
  const errorCode = record.errorCode;
  const inferredRollbackAttempted =
    record.rollbackAttempted ?? errorCode?.includes("_ROLLBACK_") ?? false;
  const inferredRollbackSucceeded =
    record.rollbackSucceeded ??
    (errorCode?.endsWith("_ROLLBACK_SUCCEEDED")
      ? true
      : errorCode?.endsWith("_ROLLBACK_FAILED")
        ? false
        : null);

  let severity: AuditSeverity;
  let recovery: AuditRecovery;
  let summary: string;
  let guidance: string;

  if (record.status === "committed") {
    severity = "success";
    recovery = "none-needed";
    summary = "Modifica completata e verificata.";
    guidance = "Non è richiesta alcuna azione.";
  } else if (inferredRollbackSucceeded === true) {
    severity = "warning";
    recovery = "restored";
    summary = "Errore recuperato automaticamente.";
    guidance = "Il contenuto precedente risulta ripristinato; puoi riprovare.";
  } else if (
    errorCode === "WRITE_FAILED_MANUAL_RECOVERY_REQUIRED" ||
    errorCode === "VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED"
  ) {
    severity = "error";
    recovery = "manual-review";
    summary = "Recupero manuale necessario.";
    guidance =
      "Il bridge non ha sovrascritto automaticamente la nota: controlla il contenuto e usa il backup indicato prima di riprovare.";
  } else if (
    errorCode === "PRE_WRITE_FAILED" ||
    errorCode === "CHANGE_CONFLICT" ||
    errorCode?.startsWith("COMMIT_LOCK_") === true
  ) {
    severity = "warning";
    recovery = "not-applied";
    summary = "Operazione fermata prima della scrittura.";
    guidance = "Nessuna modifica del bridge risulta applicata; controlla i permessi e riprova.";
  } else {
    severity = "error";
    recovery = "manual-review";
    summary = "Errore di scrittura da controllare.";
    guidance = inferredRollbackAttempted
      ? "Il ripristino automatico non è stato confermato: apri la nota e verificane il contenuto."
      : "Apri la nota e verificane il contenuto prima di riprovare.";
  }

  return Object.freeze({
    timestamp: record.timestamp,
    changeId: record.changeId,
    path: record.path,
    ...(record.targetPath === undefined
      ? {}
      : { targetPath: record.targetPath }),
    operation: record.operation,
    status: record.status,
    authorizationMode: record.authorizationMode,
    ...(errorCode === undefined ? {} : { errorCode }),
    ...(record.failureStage === undefined
      ? {}
      : { failureStage: record.failureStage }),
    ...(record.causeCode === undefined ? {} : { causeCode: record.causeCode }),
    ...(record.backupId === undefined ? {} : { backupId: record.backupId }),
    rollbackAttempted: inferredRollbackAttempted,
    rollbackSucceeded: inferredRollbackSucceeded,
    ...(record.rollbackReason === undefined
      ? {}
      : { rollbackReason: record.rollbackReason }),
    severity,
    recovery,
    summary,
    guidance,
  });
}

function errorCodeOf(error: unknown): string | undefined {
  if (!isRecord(error) || typeof error.code !== "string") return undefined;
  return error.code.slice(0, 64);
}

function emptyResult(
  state: Exclude<AuditDiagnosticState, "ready">,
  dataDirectory: string,
  auditPath: string,
  detail: string,
  errorCode?: string,
): AuditDiagnosticsResult {
  return Object.freeze({
    state,
    dataDirectory,
    auditPath,
    records: Object.freeze([]),
    failedRecords: Object.freeze([]),
    scannedLines: 0,
    malformedLines: 0,
    truncated: false,
    detail,
    ...(errorCode === undefined ? {} : { errorCode }),
  });
}

function sameFile(
  first: { readonly dev: number; readonly ino: number },
  second: { readonly dev: number; readonly ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

/**
 * Read a bounded, read-only audit tail for one stable vault identity.
 * Unsafe filesystem objects are reported to the caller and are never opened.
 */
export async function readAuditDiagnostics(
  vaultId: string,
  options: ReadAuditDiagnosticsOptions = {},
): Promise<AuditDiagnosticsResult> {
  if (!VAULT_ID.test(vaultId)) {
    throw new Error("vaultId deve essere un identificatore stabile di 16 caratteri esadecimali.");
  }
  const requestedLimit = options.limit ?? DEFAULT_RESULT_LIMIT;
  if (!Number.isSafeInteger(requestedLimit) || requestedLimit < 1) {
    throw new RangeError("limit deve essere un intero positivo.");
  }
  const limit = Math.min(requestedLimit, AUDIT_RESULT_MAX_RECORDS);
  const platform = options.platform ?? currentDesktopPlatform();
  const dataDirectory = bridgeDataDirectory(
    platform,
    options.env ?? process.env,
    options.homeDirectory ?? homedir(),
  );
  const auditPath = platformPath(platform).join(dataDirectory, "audit.ndjson");

  let initialStat;
  try {
    initialStat = await lstat(auditPath);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT") {
      return emptyResult(
        "missing",
        dataDirectory,
        auditPath,
        "Nessun registro audit è stato ancora creato.",
      );
    }
    return emptyResult(
      "error",
      dataDirectory,
      auditPath,
      "Il registro audit non può essere controllato in questo momento.",
      code,
    );
  }

  if (initialStat.isSymbolicLink()) {
    return emptyResult(
      "unsafe",
      dataDirectory,
      auditPath,
      "Il registro audit è un collegamento simbolico e non verrà letto.",
      "SYMLINK",
    );
  }
  if (!initialStat.isFile()) {
    return emptyResult(
      "unsafe",
      dataDirectory,
      auditPath,
      "Il percorso audit non è un file regolare e non verrà letto.",
      "NOT_REGULAR_FILE",
    );
  }

  let handle;
  try {
    const noFollow = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
    handle = await open(auditPath, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = errorCodeOf(error);
    if (code === "ENOENT") {
      return emptyResult(
        "missing",
        dataDirectory,
        auditPath,
        "Il registro audit è stato rimosso prima della lettura.",
      );
    }
    if (code === "ELOOP") {
      return emptyResult(
        "unsafe",
        dataDirectory,
        auditPath,
        "Il registro audit è diventato un collegamento simbolico e non verrà letto.",
        code,
      );
    }
    return emptyResult(
      "error",
      dataDirectory,
      auditPath,
      "Il registro audit non può essere aperto in sola lettura.",
      code,
    );
  }

  let bytes = Buffer.alloc(0);
  let start = 0;
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      !sameFile(initialStat, openedStat) ||
      !Number.isSafeInteger(openedStat.size) ||
      openedStat.size < 0
    ) {
      return emptyResult(
        "unsafe",
        dataDirectory,
        auditPath,
        "Il registro audit è cambiato durante il controllo e non verrà letto.",
        "FILE_CHANGED",
      );
    }

    const readLength = Math.min(openedStat.size, AUDIT_TAIL_MAX_BYTES);
    start = openedStat.size - readLength;
    bytes = Buffer.alloc(readLength);
    let totalRead = 0;
    while (totalRead < readLength) {
      const result = await handle.read(
        bytes,
        totalRead,
        readLength - totalRead,
        start + totalRead,
      );
      if (result.bytesRead === 0) break;
      totalRead += result.bytesRead;
    }
    bytes = bytes.subarray(0, totalRead);

    const finalStat = await lstat(auditPath);
    if (
      finalStat.isSymbolicLink() ||
      !finalStat.isFile() ||
      !sameFile(openedStat, finalStat)
    ) {
      return emptyResult(
        "unsafe",
        dataDirectory,
        auditPath,
        "Il registro audit è cambiato durante la lettura; i dati letti sono stati scartati.",
        "FILE_CHANGED",
      );
    }
  } catch (error) {
    return emptyResult(
      "error",
      dataDirectory,
      auditPath,
      "La lettura sicura del registro audit non è riuscita.",
      errorCodeOf(error),
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  if (start > 0) {
    const firstNewline = bytes.indexOf(0x0a);
    bytes = firstNewline === -1
      ? Buffer.alloc(0)
      : bytes.subarray(firstNewline + 1);
  }

  const allLines = bytes.toString("utf8").split("\n");
  if (allLines[allLines.length - 1] === "") allLines.pop();
  const lineWindowTruncated = allLines.length > MAX_AUDIT_LINES;
  const lines = lineWindowTruncated
    ? allLines.slice(allLines.length - MAX_AUDIT_LINES)
    : allLines;
  const matching: AuditDiagnosticRecord[] = [];
  const matchingFailures: AuditDiagnosticRecord[] = [];
  let malformedLines = 0;

  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    const parsed = parseAuditLine(line);
    if (parsed === undefined) {
      malformedLines += 1;
      continue;
    }
    if (parsed.vault !== vaultId) continue;
    const classified = classifyAuditRecord(parsed);
    matching.push(classified);
    if (matching.length > limit) matching.shift();
    if (classified.status === "failed") {
      matchingFailures.push(classified);
      if (matchingFailures.length > limit) matchingFailures.shift();
    }
  }

  matching.reverse();
  matchingFailures.reverse();
  return Object.freeze({
    state: "ready",
    dataDirectory,
    auditPath,
    records: Object.freeze(matching),
    failedRecords: Object.freeze(matchingFailures),
    scannedLines: lines.length,
    malformedLines,
    truncated: start > 0 || lineWindowTruncated,
    detail:
      malformedLines === 0
        ? "Registro audit letto correttamente."
        : `${malformedLines} righe audit non valide sono state ignorate.`,
  });
}
