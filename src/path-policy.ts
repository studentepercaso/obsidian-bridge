import path from "node:path";

import { DEFAULT_DENIED_FOLDERS } from "./config.js";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/u;

export class PathPolicyError extends Error {
  readonly code = "PATH_NOT_ALLOWED";

  constructor(message: string) {
    super(message);
    this.name = "PathPolicyError";
  }
}

export interface PathPolicyOptions {
  readonly allowedFolders?: readonly string[] | null;
  readonly deniedFolders?: readonly string[];
  /** Deny-only paths checked without case sensitivity on every platform. */
  readonly caseInsensitiveDeniedFolders?: readonly string[];
  readonly caseSensitive?: boolean;
}

export interface PathPolicy {
  readonly allowedFolders: readonly string[] | null;
  readonly deniedFolders: readonly string[];
  readonly caseInsensitiveDeniedFolders: readonly string[];
  readonly caseSensitive: boolean;
}

function normalizeRelativePath(
  value: string,
  kind: "note" | "folder" | "policy-deny",
): string {
  if (typeof value !== "string") {
    throw new PathPolicyError(`${kind} path must be a string`);
  }

  const trimmed = value.trim().normalize("NFC");
  if (trimmed.length === 0) {
    if (kind === "folder") {
      return "";
    }
    throw new PathPolicyError(`${kind} path must not be empty`);
  }
  if (trimmed.length > 1_024) {
    throw new PathPolicyError(`${kind} path is too long`);
  }
  if (CONTROL_CHARACTERS.test(trimmed)) {
    throw new PathPolicyError(`${kind} path contains control characters`);
  }

  const normalizedSeparators = trimmed.replaceAll("\\", "/");
  if (
    path.posix.isAbsolute(normalizedSeparators) ||
    path.win32.isAbsolute(trimmed) ||
    WINDOWS_DRIVE_PREFIX.test(trimmed)
  ) {
    throw new PathPolicyError(`${kind} path must be relative to the vault`);
  }

  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new PathPolicyError(`${kind} path contains an empty segment`);
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new PathPolicyError(`${kind} path contains traversal segments`);
    }
    if (kind !== "policy-deny" && segment.startsWith(".")) {
      throw new PathPolicyError(`${kind} path contains a hidden segment`);
    }
  }

  return segments.join("/");
}

export function normalizeMarkdownPath(value: string): string {
  const normalized = normalizeRelativePath(value, "note");
  if (!/\.md$/iu.test(normalized)) {
    throw new PathPolicyError("note path must end in .md");
  }
  return normalized;
}

export function normalizeRelativeFolder(value: string): string {
  const normalized = normalizeRelativePath(value, "folder");
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

function normalizeDeniedFolder(value: string): string {
  return normalizeRelativePath(value, "policy-deny");
}

function comparisonKey(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

function containsPath(
  parent: string,
  candidate: string,
  caseSensitive: boolean,
): boolean {
  const parentKey = comparisonKey(parent, caseSensitive);
  const candidateKey = comparisonKey(candidate, caseSensitive);
  return (
    parentKey === "" ||
    candidateKey === parentKey ||
    candidateKey.startsWith(`${parentKey}/`)
  );
}

export function constrainSearchFolders(
  folder: string | undefined,
  policy: PathPolicy,
): Array<string | undefined> {
  if (policy.allowedFolders === null) {
    return folder === undefined
      ? [undefined]
      : [assertFolderAllowed(folder, policy)];
  }

  if (folder === undefined) {
    return [...policy.allowedFolders];
  }

  const candidate = assertFolderAllowed(folder, policy);
  const containingAllowlistFolder = policy.allowedFolders.find((allowed) =>
    containsPath(allowed, candidate, policy.caseSensitive),
  );
  if (containingAllowlistFolder !== undefined) {
    return [candidate];
  }

  return policy.allowedFolders.filter((allowed) =>
    containsPath(candidate, allowed, policy.caseSensitive),
  );
}

function collapseFolders(
  folders: readonly string[],
  caseSensitive: boolean,
): string[] {
  const seen = new Set<string>();
  const unique = folders.filter((folder) => {
    const key = comparisonKey(folder, caseSensitive);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const sorted = unique.sort(
    (left, right) => left.length - right.length || left.localeCompare(right),
  );
  return sorted.filter(
    (folder, index) =>
      !sorted
        .slice(0, index)
        .some((parent) => containsPath(parent, folder, caseSensitive)),
  );
}

function defaultCaseSensitivity(): boolean {
  return process.platform !== "win32" && process.platform !== "darwin";
}

export function createPathPolicy(
  options: PathPolicyOptions | readonly string[] | null = {},
  deniedFolders: readonly string[] = [],
): PathPolicy {
  const isLegacyArguments = Array.isArray(options) || options === null;
  const allowedInput = isLegacyArguments
    ? options
    : (options as PathPolicyOptions).allowedFolders;
  const deniedInput = isLegacyArguments
    ? deniedFolders
    : ((options as PathPolicyOptions).deniedFolders ?? []);
  const caseInsensitiveDeniedInput = isLegacyArguments
    ? []
    : ((options as PathPolicyOptions).caseInsensitiveDeniedFolders ?? []);
  const caseSensitive = isLegacyArguments
    ? defaultCaseSensitivity()
    : ((options as PathPolicyOptions).caseSensitive ??
      defaultCaseSensitivity());

  const allowed = allowedInput?.map(normalizeRelativeFolder) ?? [];
  const denied = [...DEFAULT_DENIED_FOLDERS, ...deniedInput].map(
    normalizeDeniedFolder,
  );
  const caseInsensitiveDenied = caseInsensitiveDeniedInput.map(
    normalizeDeniedFolder,
  );

  return Object.freeze({
    allowedFolders:
      allowed.length > 0
        ? Object.freeze(collapseFolders(allowed, caseSensitive))
        : null,
    deniedFolders: Object.freeze(collapseFolders(denied, caseSensitive)),
    caseInsensitiveDeniedFolders: Object.freeze(
      collapseFolders(caseInsensitiveDenied, false),
    ),
    caseSensitive,
  });
}

/**
 * Build the separate write policy. Unlike the read policy, an empty allowlist
 * remains an empty array and therefore denies every path.
 */
export function createWritablePathPolicy(
  options: PathPolicyOptions = {},
): PathPolicy {
  const caseSensitive = options.caseSensitive ?? defaultCaseSensitivity();
  const allowed = (options.allowedFolders ?? []).map(normalizeRelativeFolder);
  const denied = [
    ...DEFAULT_DENIED_FOLDERS,
    ...(options.deniedFolders ?? []),
  ].map(normalizeDeniedFolder);
  const caseInsensitiveDenied = (
    options.caseInsensitiveDeniedFolders ?? []
  ).map(normalizeDeniedFolder);

  return Object.freeze({
    allowedFolders: Object.freeze(collapseFolders(allowed, caseSensitive)),
    deniedFolders: Object.freeze(collapseFolders(denied, caseSensitive)),
    caseInsensitiveDeniedFolders: Object.freeze(
      collapseFolders(caseInsensitiveDenied, false),
    ),
    caseSensitive,
  });
}

function assertNotDenied(candidate: string, policy: PathPolicy): void {
  if (
    policy.deniedFolders.some((folder) =>
      containsPath(folder, candidate, policy.caseSensitive),
    ) ||
    policy.caseInsensitiveDeniedFolders.some((folder) =>
      containsPath(folder, candidate, false),
    )
  ) {
    throw new PathPolicyError("path is inside a denied folder");
  }
}

function assertAllowlisted(candidate: string, policy: PathPolicy): void {
  if (
    policy.allowedFolders !== null &&
    !policy.allowedFolders.some((folder) =>
      containsPath(folder, candidate, policy.caseSensitive),
    )
  ) {
    throw new PathPolicyError("path is outside the configured allowed folders");
  }
}

export function assertPathAllowed(value: string, policy: PathPolicy): string {
  const candidate = normalizeMarkdownPath(value);
  assertNotDenied(candidate, policy);
  assertAllowlisted(candidate, policy);
  return candidate;
}

export function isPathAllowed(value: string, policy: PathPolicy): boolean {
  try {
    assertPathAllowed(value, policy);
    return true;
  } catch {
    return false;
  }
}

export function assertFolderAllowed(value: string, policy: PathPolicy): string {
  const candidate = normalizeRelativeFolder(value);
  assertNotDenied(candidate, policy);

  if (policy.allowedFolders !== null) {
    const intersectsAllowedFolder = policy.allowedFolders.some(
      (folder) =>
        containsPath(folder, candidate, policy.caseSensitive) ||
        containsPath(candidate, folder, policy.caseSensitive),
    );
    if (!intersectsAllowedFolder) {
      throw new PathPolicyError(
        "folder is outside the configured allowed folders",
      );
    }
  }

  return candidate;
}

export function isFolderAllowed(value: string, policy: PathPolicy): boolean {
  try {
    assertFolderAllowed(value, policy);
    return true;
  } catch {
    return false;
  }
}

export function filterAllowedPaths(
  values: readonly string[],
  policy: PathPolicy,
): string[] {
  const result: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    try {
      const allowed = assertPathAllowed(value, policy);
      if (!seen.has(allowed)) {
        seen.add(allowed);
        result.push(allowed);
      }
    } catch {
      // CLI output is untrusted; malformed and disallowed paths are omitted.
    }
  }

  return result;
}
