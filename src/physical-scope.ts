import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/u;
const WINDOWS_DRIVE_PREFIX = /^[a-zA-Z]:/u;
const WINDOWS_RESERVED_BASENAME =
  /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
const WINDOWS_INVALID_CHARACTERS = /[<>:"|?*]/u;
const WINDOWS_SHORT_NAME_ALIAS = /~[0-9]+(?:\.|$)/iu;

export class PhysicalScopeError extends Error {
  readonly code = "PHYSICAL_PATH_NOT_ALLOWED";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PhysicalScopeError";
  }
}

export interface PhysicalScopeOptions {
  /**
   * Permit a target that does not exist yet. Once the first missing component
   * is reached, the remaining components are accepted only after the complete
   * lexical target has been confirmed to remain below the physical vault root.
   */
  readonly allowMissingLeaf?: boolean;
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertContained(root: string, candidate: string): void {
  const relative = path.relative(root, candidate);
  if (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  ) {
    return;
  }

  throw new PhysicalScopeError("path resolves outside the physical vault root");
}

export function assertWindowsSafePathSegment(segment: string): void {
  if (
    WINDOWS_INVALID_CHARACTERS.test(segment) ||
    WINDOWS_SHORT_NAME_ALIAS.test(segment) ||
    /[. ]$/u.test(segment) ||
    WINDOWS_RESERVED_BASENAME.test(segment)
  ) {
    throw new PhysicalScopeError(
      "path contains non-canonical or reserved Windows syntax",
    );
  }
}

export function assertCanonicalWindowsPathSegment(
  requested: string,
  canonical: string,
): void {
  if (
    requested.toLocaleLowerCase("en-US") !==
    canonical.toLocaleLowerCase("en-US")
  ) {
    throw new PhysicalScopeError(
      "path uses a non-canonical Windows filesystem alias",
    );
  }
}

function normalizeRelativePath(value: string): readonly string[] {
  if (typeof value !== "string") {
    throw new PhysicalScopeError("path must be a string");
  }
  if (value.length === 0) {
    throw new PhysicalScopeError("path must not be empty");
  }
  if (CONTROL_CHARACTERS.test(value)) {
    throw new PhysicalScopeError("path contains control characters");
  }

  const normalizedSeparators = value.replaceAll("\\", "/");
  if (
    path.isAbsolute(value) ||
    path.posix.isAbsolute(normalizedSeparators) ||
    path.win32.isAbsolute(value) ||
    WINDOWS_DRIVE_PREFIX.test(value)
  ) {
    throw new PhysicalScopeError("path must be relative to the vault");
  }

  const segments = normalizedSeparators.split("/");
  if (segments.some((segment) => segment.length === 0)) {
    throw new PhysicalScopeError("path contains an empty segment");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new PhysicalScopeError("path contains traversal segments");
  }
  if (process.platform === "win32") {
    for (const segment of segments) assertWindowsSafePathSegment(segment);
  }

  return segments;
}

/**
 * Resolve a vault-relative path without allowing an existing filesystem link
 * to redirect access outside the vault. Callers that create a missing target
 * should invoke this again immediately before the filesystem mutation.
 */
export async function assertPhysicalVaultPath(
  vaultRoot: string,
  relativePath: string,
  options: PhysicalScopeOptions = {},
): Promise<string> {
  if (typeof vaultRoot !== "string" || !path.isAbsolute(vaultRoot)) {
    throw new PhysicalScopeError("vault root must be an absolute path");
  }

  let physicalRoot: string;
  try {
    physicalRoot = await realpath(vaultRoot);
  } catch (error) {
    throw new PhysicalScopeError("vault root cannot be resolved", {
      cause: error,
    });
  }

  let rootStats;
  try {
    rootStats = await lstat(physicalRoot);
  } catch (error) {
    throw new PhysicalScopeError("vault root cannot be inspected", {
      cause: error,
    });
  }
  if (!rootStats.isDirectory()) {
    throw new PhysicalScopeError("vault root must be a directory");
  }

  const segments = normalizeRelativePath(relativePath);
  const lexicalTarget = path.resolve(physicalRoot, ...segments);
  assertContained(physicalRoot, lexicalTarget);

  let current = physicalRoot;
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    if (segment === undefined) {
      throw new PhysicalScopeError("path contains an invalid segment");
    }
    const candidate = path.join(current, segment);

    let candidateStats;
    try {
      candidateStats = await lstat(candidate);
    } catch (error) {
      if (isMissingError(error)) {
        if (!options.allowMissingLeaf) {
          throw new PhysicalScopeError("path does not exist", { cause: error });
        }

        // All remaining components are missing descendants of the last safe,
        // existing directory. The complete target was contained above.
        return lexicalTarget;
      }
      throw new PhysicalScopeError("path cannot be inspected", {
        cause: error,
      });
    }

    // Node reports Windows directory junctions and filesystem symlinks through
    // lstat().isSymbolicLink(), so the same check covers every supported host.
    if (candidateStats.isSymbolicLink()) {
      throw new PhysicalScopeError(
        "path crosses a symbolic link or filesystem junction",
      );
    }

    const isLeaf = index === segments.length - 1;
    if (isLeaf && candidateStats.isFile() && candidateStats.nlink > 1) {
      throw new PhysicalScopeError(
        "path targets a multiply-linked file outside the enforceable vault boundary",
      );
    }
    if (!isLeaf && !candidateStats.isDirectory()) {
      throw new PhysicalScopeError("path ancestor is not a directory");
    }

    let physicalCandidate: string;
    try {
      physicalCandidate = await realpath(candidate);
    } catch (error) {
      throw new PhysicalScopeError("path cannot be resolved", {
        cause: error,
      });
    }
    assertContained(physicalRoot, physicalCandidate);
    if (process.platform === "win32") {
      assertCanonicalWindowsPathSegment(
        segment,
        path.basename(physicalCandidate),
      );
    }
    current = physicalCandidate;
  }

  let physicalTarget: string;
  try {
    physicalTarget = await realpath(lexicalTarget);
  } catch (error) {
    throw new PhysicalScopeError("path cannot be resolved", { cause: error });
  }
  assertContained(physicalRoot, physicalTarget);
  return physicalTarget;
}
