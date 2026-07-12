import { createHash } from "node:crypto";
import path from "node:path";

export const MANAGEMENT_REQUEST_VERSION = 1 as const;
export const MAX_MANAGEMENT_REQUEST_BYTES = 1024 * 1024;
export const MAX_MANAGEMENT_REQUEST_TTL_MS = 15 * 60 * 1000;
export const MAX_MANAGEMENT_CONTENT_BYTES = 1024 * 1024;

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TOKEN = /^[0-9a-f]{64}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const VAULT_ID = /^[0-9a-f]{16}$/u;
const ISO_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/u;
const CONTENT_CONTROL_CHARACTER = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u;
const RESERVED_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const BASE_KEYS = new Set([
  "version",
  "request_id",
  "token",
  "change_id",
  "created_at",
  "expires_at",
  "vault_id",
  "operation",
  "path",
  "before_sha256",
  "payload",
]);

export type ManagementOperation = "replace" | "frontmatter" | "move" | "trash";
export type FrontmatterScalar = string | number | boolean | null;
export type FrontmatterValue = FrontmatterScalar | readonly FrontmatterScalar[];

export interface ReplacePayload {
  readonly content: string;
  readonly after_sha256: string;
}

export interface FrontmatterPayload {
  readonly set: Readonly<Record<string, FrontmatterValue>>;
  readonly remove: readonly string[];
}

export interface MovePayload {
  readonly destination: string;
}

export type TrashPayload = Readonly<Record<never, never>>;

interface ManagementRequestBase {
  readonly version: typeof MANAGEMENT_REQUEST_VERSION;
  readonly request_id: string;
  readonly token: string;
  readonly change_id: string;
  readonly created_at: string;
  readonly expires_at: string;
  readonly vault_id: string;
  readonly path: string;
  readonly before_sha256: string;
}

export interface ReplaceManagementRequest extends ManagementRequestBase {
  readonly operation: "replace";
  readonly payload: ReplacePayload;
}

export interface FrontmatterManagementRequest extends ManagementRequestBase {
  readonly operation: "frontmatter";
  readonly payload: FrontmatterPayload;
}

export interface MoveManagementRequest extends ManagementRequestBase {
  readonly operation: "move";
  readonly payload: MovePayload;
}

export interface TrashManagementRequest extends ManagementRequestBase {
  readonly operation: "trash";
  readonly payload: TrashPayload;
}

export type ManagementRequest =
  | ReplaceManagementRequest
  | FrontmatterManagementRequest
  | MoveManagementRequest
  | TrashManagementRequest;

export class ManagementProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string, cause?: unknown) {
    super(message);
    this.name = "ManagementProtocolError";
    this.code = code;
    if (cause !== undefined) {
      Object.defineProperty(this, "cause", { value: cause, configurable: true });
    }
  }
}

function reject(message: string): never {
  throw new ManagementProtocolError("REQUEST_INVALID", message);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, expected: ReadonlySet<string>): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.size && keys.every((key) => expected.has(key));
}

function requireString(
  value: unknown,
  label: string,
  pattern: RegExp,
): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    reject(`${label} is invalid`);
  }
  return value;
}

function parseTimestamp(value: unknown, label: string): { text: string; time: number } {
  const text = requireString(value, label, ISO_TIMESTAMP);
  const time = Date.parse(text);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== text) {
    reject(`${label} is invalid`);
  }
  return { text, time };
}

/** A normalized, visible Markdown path relative to the vault root. */
export function isVisibleMarkdownPath(value: unknown): value is string {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 1_024 ||
    Buffer.byteLength(value, "utf8") > 4_096 ||
    CONTROL_CHARACTER.test(value) ||
    value.includes("\\") ||
    value.startsWith("/") ||
    /^[A-Za-z]:/u.test(value) ||
    !value.toLowerCase().endsWith(".md")
  ) {
    return false;
  }

  const segments = value.split("/");
  return segments.every(
    (segment) =>
      segment.length > 0 &&
      segment !== "." &&
      segment !== ".." &&
      !segment.startsWith("."),
  );
}

export function assertVisibleMarkdownPath(value: unknown, label = "path"): string {
  if (!isVisibleMarkdownPath(value)) reject(`${label} must be a visible .md path`);
  return value;
}

export function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID.test(value);
}

export function isManagementToken(value: unknown): value is string {
  return typeof value === "string" && TOKEN.test(value);
}

/** Hash format shared with the MCP workflow, including file-presence state. */
export function hashPresentDocument(content: string): string {
  return createHash("sha256")
    .update("present\0", "utf8")
    .update(content, "utf8")
    .digest("hex");
}

export function hashMissingDocument(): string {
  return createHash("sha256").update("missing\0", "utf8").digest("hex");
}

function parseFrontmatterKey(value: unknown, label: string): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > 128 ||
    value !== value.trim() ||
    value !== value.normalize("NFC") ||
    CONTROL_CHARACTER.test(value) ||
    RESERVED_OBJECT_KEYS.has(value)
  ) {
    reject(`${label} is invalid`);
  }
  return value;
}

function parseFrontmatterScalar(value: unknown, label: string): FrontmatterScalar {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) reject(`${label} must be finite`);
    return value;
  }
  if (typeof value === "string") {
    if (value.length > 32_768 || CONTENT_CONTROL_CHARACTER.test(value)) {
      reject(`${label} is invalid`);
    }
    return value;
  }
  reject(`${label} must be a JSON scalar`);
}

function parseFrontmatterValue(value: unknown, label: string): FrontmatterValue {
  if (!Array.isArray(value)) return parseFrontmatterScalar(value, label);
  if (value.length > 256) reject(`${label} has too many values`);
  return Object.freeze(
    value.map((item, index) => parseFrontmatterScalar(item, `${label}[${index}]`)),
  );
}

function parseReplacePayload(value: unknown): ReplacePayload {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["content", "after_sha256"]))) {
    reject("replace payload is invalid");
  }
  if (
    typeof value.content !== "string" ||
    Buffer.byteLength(value.content, "utf8") > MAX_MANAGEMENT_CONTENT_BYTES ||
    CONTENT_CONTROL_CHARACTER.test(value.content)
  ) {
    reject("replace content is invalid");
  }
  const afterSha256 = requireString(value.after_sha256, "after_sha256", SHA256);
  if (hashPresentDocument(value.content) !== afterSha256) {
    reject("after_sha256 does not match replace content");
  }
  return Object.freeze({ content: value.content, after_sha256: afterSha256 });
}

function parseFrontmatterPayload(value: unknown): FrontmatterPayload {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["set", "remove"]))) {
    reject("frontmatter payload is invalid");
  }
  if (!isRecord(value.set) || !Array.isArray(value.remove)) {
    reject("frontmatter payload is invalid");
  }
  const setKeys = Object.keys(value.set);
  if (setKeys.length > 256 || value.remove.length > 256) {
    reject("frontmatter payload has too many properties");
  }

  const set: Record<string, FrontmatterValue> = Object.create(null) as Record<
    string,
    FrontmatterValue
  >;
  for (const rawKey of setKeys) {
    const key = parseFrontmatterKey(rawKey, "frontmatter set key");
    set[key] = parseFrontmatterValue(value.set[rawKey], `frontmatter.${key}`);
  }

  const remove = value.remove.map((item, index) =>
    parseFrontmatterKey(item, `frontmatter remove[${index}]`),
  );
  if (new Set(remove).size !== remove.length) {
    reject("frontmatter remove contains duplicates");
  }
  if (remove.some((key) => Object.prototype.hasOwnProperty.call(set, key))) {
    reject("frontmatter property cannot be set and removed together");
  }
  if (setKeys.length === 0 && remove.length === 0) {
    reject("frontmatter payload must change at least one property");
  }
  return Object.freeze({ set: Object.freeze(set), remove: Object.freeze(remove) });
}

function parseMovePayload(value: unknown, sourcePath: string): MovePayload {
  if (!isRecord(value) || !hasOnlyKeys(value, new Set(["destination"]))) {
    reject("move payload is invalid");
  }
  const destination = assertVisibleMarkdownPath(value.destination, "destination");
  if (destination === sourcePath) reject("move destination must differ from path");
  return Object.freeze({ destination });
}

function parseTrashPayload(value: unknown): TrashPayload {
  if (!isRecord(value) || Object.keys(value).length !== 0) {
    reject("trash payload must be empty");
  }
  return Object.freeze({});
}

/** Parse an exact v1 request. Unknown fields and ambiguous values fail closed. */
export function parseManagementRequest(input: string | Uint8Array): ManagementRequest {
  const bytes = typeof input === "string" ? Buffer.from(input, "utf8") : Buffer.from(input);
  if (bytes.length < 2 || bytes.length > MAX_MANAGEMENT_REQUEST_BYTES) {
    reject(`request must be between 2 and ${MAX_MANAGEMENT_REQUEST_BYTES} bytes`);
  }
  const canonical = bytes.toString("utf8");
  if (!Buffer.from(canonical, "utf8").equals(bytes)) reject("request is not valid UTF-8");

  let value: unknown;
  try {
    value = JSON.parse(canonical) as unknown;
  } catch (error) {
    throw new ManagementProtocolError("REQUEST_INVALID", "request is not valid JSON", error);
  }
  if (!isRecord(value) || !hasOnlyKeys(value, BASE_KEYS)) reject("request shape is invalid");
  if (value.version !== MANAGEMENT_REQUEST_VERSION) reject("request version is unsupported");

  const requestId = requireString(value.request_id, "request_id", UUID);
  const token = requireString(value.token, "token", TOKEN);
  const changeId = requireString(value.change_id, "change_id", UUID);
  const createdAt = parseTimestamp(value.created_at, "created_at");
  const expiresAt = parseTimestamp(value.expires_at, "expires_at");
  if (
    expiresAt.time <= createdAt.time ||
    expiresAt.time - createdAt.time > MAX_MANAGEMENT_REQUEST_TTL_MS
  ) {
    reject("request expiry window is invalid");
  }
  const vaultId = requireString(value.vault_id, "vault_id", VAULT_ID);
  const notePath = assertVisibleMarkdownPath(value.path);
  const beforeSha256 = requireString(value.before_sha256, "before_sha256", SHA256);

  const base = {
    version: MANAGEMENT_REQUEST_VERSION,
    request_id: requestId,
    token,
    change_id: changeId,
    created_at: createdAt.text,
    expires_at: expiresAt.text,
    vault_id: vaultId,
    path: notePath,
    before_sha256: beforeSha256,
  } as const;

  switch (value.operation) {
    case "replace":
      return Object.freeze({
        ...base,
        operation: "replace",
        payload: parseReplacePayload(value.payload),
      });
    case "frontmatter":
      return Object.freeze({
        ...base,
        operation: "frontmatter",
        payload: parseFrontmatterPayload(value.payload),
      });
    case "move":
      return Object.freeze({
        ...base,
        operation: "move",
        payload: parseMovePayload(value.payload, notePath),
      });
    case "trash":
      return Object.freeze({
        ...base,
        operation: "trash",
        payload: parseTrashPayload(value.payload),
      });
    default:
      return reject("operation is unsupported");
  }
}

function absoluteDataDirectory(dataDirectory: string): string {
  if (!path.isAbsolute(dataDirectory) || CONTROL_CHARACTER.test(dataDirectory)) {
    throw new ManagementProtocolError(
      "DATA_DIRECTORY_INVALID",
      "management data directory must be an absolute path",
    );
  }
  return path.resolve(dataDirectory);
}

export function managementRequestsDirectory(dataDirectory: string): string {
  return path.join(absoluteDataDirectory(dataDirectory), "management", "requests");
}

export function managementProcessingDirectory(dataDirectory: string): string {
  return path.join(absoluteDataDirectory(dataDirectory), "management", "processing");
}

export function managementRequestPath(dataDirectory: string, requestId: string): string {
  if (!isUuid(requestId)) {
    throw new ManagementProtocolError("REQUEST_ID_INVALID", "request_id is invalid");
  }
  return path.join(managementRequestsDirectory(dataDirectory), `${requestId}.json`);
}
