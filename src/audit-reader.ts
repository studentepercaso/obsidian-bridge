import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { normalizeMarkdownPath } from "./path-policy.js";

export const AUDIT_TAIL_MAX_BYTES = 128 * 1024;
export const AUDIT_RESULT_MAX_RECORDS = 20;
export const AUDIT_LINE_MAX_BYTES = 16 * 1024;

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,127}$/u;
const BACKUP_ID = /^[0-9A-Za-z._+-]{1,200}$/u;

const AuditLineSchema = z
  .object({
    timestamp: z
      .string()
      .min(1)
      .max(64)
      .refine(
        (value) =>
          /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value) &&
          Number.isFinite(Date.parse(value)),
        { message: "timestamp must be an ISO UTC date-time" },
      ),
    change_id: z.string().regex(UUID),
    vault: z
      .string()
      .min(1)
      .max(256)
      .refine(
        (value) =>
          value === value.trim().normalize("NFC") &&
          !CONTROL_CHARACTERS.test(value),
        { message: "vault must be normalized text" },
      ),
    path: z
      .string()
      .min(4)
      .max(1_024)
      .refine((value) => {
        try {
          return normalizeMarkdownPath(value) === value;
        } catch {
          return false;
        }
      }, { message: "path must be a normalized visible Markdown path" }),
    operation: z.enum(["create", "append"]),
    status: z.enum(["committed", "failed"]),
    authorization_mode: z.enum(["protected", "autonomous"]).optional(),
    before_sha256: z.string().regex(SHA256),
    after_sha256: z.string().regex(SHA256),
    backup_id: z.string().regex(BACKUP_ID).optional(),
    error_code: z.string().regex(ERROR_CODE).optional(),
    rollback_attempted: z.boolean().optional(),
    rollback_succeeded: z.boolean().optional(),
    rollback_reason: z
      .enum([
        "unchanged",
        "restored",
        "concurrent_change",
        "delete_disabled",
        "restore_unrepresentable",
        "restore_too_large",
        "recovery_scope_changed",
        "read_failed",
        "restore_failed",
      ])
      .optional(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.status === "committed" && value.error_code !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "committed records cannot contain an error code",
      });
    }
    if (value.status === "failed" && value.error_code === undefined) {
      context.addIssue({
        code: "custom",
        path: ["error_code"],
        message: "failed records require an error code",
      });
    }
    if (
      (value.rollback_succeeded !== undefined ||
        value.rollback_reason !== undefined) &&
      value.rollback_attempted === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: ["rollback_attempted"],
        message: "rollback outcome requires rollback_attempted",
      });
    }
  });

type ParsedAuditLine = z.infer<typeof AuditLineSchema>;

export type AuditLogErrorCode =
  | "AUDIT_PATH_INVALID"
  | "AUDIT_UNSAFE_SYMLINK"
  | "AUDIT_NOT_REGULAR"
  | "AUDIT_OPEN_FAILED"
  | "AUDIT_CHANGED"
  | "AUDIT_READ_FAILED"
  | "AUDIT_INVALID_UTF8"
  | "AUDIT_LINE_TOO_LARGE"
  | "AUDIT_MALFORMED";

export class AuditLogReadError extends Error {
  readonly code: AuditLogErrorCode;

  constructor(code: AuditLogErrorCode, message: string, options?: ErrorOptions) {
    super(`${code}: ${message}`, options);
    this.name = "AuditLogReadError";
    this.code = code;
  }
}

/** Metadata-only audit event. Note and backup bodies are never represented. */
export interface AuditMetadataEvent {
  readonly timestamp: string;
  readonly change_id: string;
  readonly vault: string;
  readonly path: string;
  readonly operation: "create" | "append";
  readonly authorization_mode: "protected" | "autonomous";
  readonly status: "committed" | "failed";
  readonly error_code?: string;
  readonly rollback_attempted?: boolean;
  readonly rollback_succeeded?: boolean;
  readonly rollback_reason?: string;
  readonly backup_id?: string;
}

export interface AuditTailResult {
  /** Newest event first. */
  readonly events: readonly AuditMetadataEvent[];
  readonly truncated: boolean;
}

function errorCode(error: unknown): string | undefined {
  return error !== null &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

function sameFile(
  first: { readonly dev: number; readonly ino: number },
  second: { readonly dev: number; readonly ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

function sanitizeAuditLine(value: ParsedAuditLine): AuditMetadataEvent {
  return Object.freeze({
    timestamp: value.timestamp,
    change_id: value.change_id,
    vault: value.vault,
    path: value.path,
    operation: value.operation,
    authorization_mode: value.authorization_mode ?? "protected",
    status: value.status,
    ...(value.error_code === undefined
      ? {}
      : { error_code: value.error_code }),
    ...(value.rollback_attempted === undefined
      ? {}
      : { rollback_attempted: value.rollback_attempted }),
    ...(value.rollback_succeeded === undefined
      ? {}
      : { rollback_succeeded: value.rollback_succeeded }),
    ...(value.rollback_reason === undefined
      ? {}
      : { rollback_reason: value.rollback_reason }),
    ...(value.backup_id === undefined ? {} : { backup_id: value.backup_id }),
  });
}

function parseAuditLines(bytes: Buffer): readonly AuditMetadataEvent[] {
  if (bytes.byteLength === 0) return Object.freeze([]);
  if (bytes[bytes.byteLength - 1] !== 0x0a) {
    throw new AuditLogReadError(
      "AUDIT_MALFORMED",
      "the audit tail ends with an incomplete record",
    );
  }

  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    throw new AuditLogReadError(
      "AUDIT_INVALID_UTF8",
      "the audit contains invalid UTF-8",
      { cause: error },
    );
  }

  const lines = decoded.split("\n");
  lines.pop();
  const events: AuditMetadataEvent[] = [];
  for (const rawLine of lines) {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
    if (Buffer.byteLength(line, "utf8") > AUDIT_LINE_MAX_BYTES) {
      throw new AuditLogReadError(
        "AUDIT_LINE_TOO_LARGE",
        `an audit record exceeds ${AUDIT_LINE_MAX_BYTES} bytes`,
      );
    }
    if (line.length === 0) {
      throw new AuditLogReadError(
        "AUDIT_MALFORMED",
        "the audit contains an empty record",
      );
    }

    let candidate: unknown;
    try {
      candidate = JSON.parse(line) as unknown;
    } catch (error) {
      throw new AuditLogReadError(
        "AUDIT_MALFORMED",
        "the audit contains invalid JSON",
        { cause: error },
      );
    }
    const parsed = AuditLineSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new AuditLogReadError(
        "AUDIT_MALFORMED",
        "the audit contains a record outside the metadata-only schema",
        { cause: parsed.error },
      );
    }
    events.push(sanitizeAuditLine(parsed.data));
  }
  events.reverse();
  return Object.freeze(events);
}

/**
 * Read only the fixed audit file inside the configured bridge data directory.
 * The path is never supplied by an MCP caller and unsafe filesystem objects
 * fail closed. A missing audit is a normal empty result.
 */
export async function readAuditTail(
  dataDirectory: string,
): Promise<AuditTailResult> {
  if (
    !path.isAbsolute(dataDirectory) ||
    CONTROL_CHARACTERS.test(dataDirectory)
  ) {
    throw new AuditLogReadError(
      "AUDIT_PATH_INVALID",
      "the configured bridge data directory must be absolute",
    );
  }
  const auditPath = path.join(path.resolve(dataDirectory), "audit.ndjson");

  let initialStat;
  try {
    initialStat = await lstat(auditPath);
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return Object.freeze({ events: Object.freeze([]), truncated: false });
    }
    throw new AuditLogReadError(
      "AUDIT_OPEN_FAILED",
      "the audit cannot be inspected",
      { cause: error },
    );
  }
  if (initialStat.isSymbolicLink()) {
    throw new AuditLogReadError(
      "AUDIT_UNSAFE_SYMLINK",
      "the audit path is a symbolic link",
    );
  }
  if (!initialStat.isFile()) {
    throw new AuditLogReadError(
      "AUDIT_NOT_REGULAR",
      "the audit path is not a regular file",
    );
  }

  let handle;
  try {
    handle = await open(
      auditPath,
      constants.O_RDONLY |
        (process.platform === "win32" ? 0 : constants.O_NOFOLLOW),
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") {
      return Object.freeze({ events: Object.freeze([]), truncated: false });
    }
    throw new AuditLogReadError(
      errorCode(error) === "ELOOP"
        ? "AUDIT_UNSAFE_SYMLINK"
        : "AUDIT_OPEN_FAILED",
      "the audit cannot be opened read-only",
      { cause: error },
    );
  }

  let bytes: Buffer;
  let truncated = false;
  try {
    const openedStat = await handle.stat();
    if (
      !openedStat.isFile() ||
      !sameFile(initialStat, openedStat) ||
      !Number.isSafeInteger(openedStat.size) ||
      openedStat.size < 0
    ) {
      throw new AuditLogReadError(
        "AUDIT_CHANGED",
        "the audit changed before it could be read",
      );
    }

    const readLength = Math.min(openedStat.size, AUDIT_TAIL_MAX_BYTES);
    const start = openedStat.size - readLength;
    truncated = start > 0;
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
    if (totalRead !== readLength) {
      throw new AuditLogReadError(
        "AUDIT_CHANGED",
        "the audit changed while it was being read",
      );
    }

    const finalStat = await lstat(auditPath);
    if (
      finalStat.isSymbolicLink() ||
      !finalStat.isFile() ||
      !sameFile(openedStat, finalStat) ||
      finalStat.size !== openedStat.size
    ) {
      throw new AuditLogReadError(
        "AUDIT_CHANGED",
        "the audit changed while it was being read",
      );
    }

    if (truncated) {
      const firstNewline = bytes.indexOf(0x0a);
      if (firstNewline === -1) {
        throw new AuditLogReadError(
          "AUDIT_LINE_TOO_LARGE",
          `an audit record exceeds the ${AUDIT_TAIL_MAX_BYTES}-byte read window`,
        );
      }
      if (firstNewline > AUDIT_LINE_MAX_BYTES) {
        throw new AuditLogReadError(
          "AUDIT_LINE_TOO_LARGE",
          `an audit record exceeds ${AUDIT_LINE_MAX_BYTES} bytes`,
        );
      }
      bytes = bytes.subarray(firstNewline + 1);
    }
  } catch (error) {
    if (error instanceof AuditLogReadError) throw error;
    throw new AuditLogReadError(
      "AUDIT_READ_FAILED",
      "the bounded audit read failed",
      { cause: error },
    );
  } finally {
    await handle.close().catch(() => undefined);
  }

  return Object.freeze({
    events: parseAuditLines(bytes),
    truncated,
  });
}
