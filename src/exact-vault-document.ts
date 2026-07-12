import { constants, type BigIntStats } from "node:fs";
import { lstat, open } from "node:fs/promises";

import { assertPhysicalVaultPath } from "./physical-scope.js";

const READ_CHUNK_BYTES = 64 * 1024;

export type ExactVaultDocument =
  | { readonly exists: false }
  | { readonly exists: true; readonly content: string };

export interface ExactVaultDocumentReadOptions {
  readonly allowMissing: boolean;
  readonly maxBytes: number;
  readonly signal?: AbortSignal;
}

export class ExactVaultDocumentReadError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ExactVaultDocumentReadError";
  }
}

function isMissingError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "ENOENT"
  );
}

function assertRegularSingleLinkFile(stats: BigIntStats): void {
  if (!stats.isFile() || stats.isSymbolicLink()) {
    throw new ExactVaultDocumentReadError(
      "vault document must be a regular file",
    );
  }
  if (stats.nlink !== 1n) {
    throw new ExactVaultDocumentReadError(
      "vault document must not have multiple filesystem links",
    );
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.nlink === right.nlink
  );
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function assertBoundedSize(stats: BigIntStats, maxBytes: number): number {
  if (stats.size > BigInt(maxBytes)) {
    throw new RangeError(
      `vault document must not exceed ${maxBytes} UTF-8 bytes`,
    );
  }
  return Number(stats.size);
}

async function lstatIfPresent(filePath: string): Promise<BigIntStats | null> {
  try {
    return await lstat(filePath, { bigint: true });
  } catch (error) {
    if (isMissingError(error)) return null;
    throw new ExactVaultDocumentReadError(
      "vault document cannot be inspected",
      { cause: error },
    );
  }
}

/**
 * Read one vault document byte-for-byte without the Obsidian CLI's output
 * normalization. The path and the open handle are both checked before and
 * after the bounded read so a link or file swap fails closed.
 */
export async function readExactVaultDocument(
  vaultPath: string,
  notePath: string,
  options: ExactVaultDocumentReadOptions,
): Promise<ExactVaultDocument> {
  options.signal?.throwIfAborted();
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new RangeError("maxBytes must be a non-negative safe integer");
  }

  let physicalPath = await assertPhysicalVaultPath(vaultPath, notePath, {
    // Missing is established below with two contained lstat checks. This lets
    // callers turn a vanished source into a normal CAS conflict.
    allowMissingLeaf: true,
  });
  let pathBefore = await lstatIfPresent(physicalPath);
  if (pathBefore === null) {
    if (!options.allowMissing) {
      throw new ExactVaultDocumentReadError("vault document does not exist");
    }

    // Re-run the full containment walk before returning a negative snapshot.
    // A target created during the first check is read normally instead.
    options.signal?.throwIfAborted();
    physicalPath = await assertPhysicalVaultPath(vaultPath, notePath, {
      allowMissingLeaf: true,
    });
    pathBefore = await lstatIfPresent(physicalPath);
    if (pathBefore === null) {
      options.signal?.throwIfAborted();
      return { exists: false };
    }
  }

  assertRegularSingleLinkFile(pathBefore);
  assertBoundedSize(pathBefore, options.maxBytes);

  const noFollowFlag = process.platform === "win32" ? 0 : constants.O_NOFOLLOW;
  let handle;
  options.signal?.throwIfAborted();
  try {
    handle = await open(physicalPath, constants.O_RDONLY | noFollowFlag);
  } catch (error) {
    throw new ExactVaultDocumentReadError(
      "vault document cannot be opened safely",
      { cause: error },
    );
  }

  let bytes: Buffer;
  try {
    options.signal?.throwIfAborted();
    const opened = await handle.stat({ bigint: true });
    assertRegularSingleLinkFile(opened);
    if (!sameFileIdentity(pathBefore, opened)) {
      throw new ExactVaultDocumentReadError(
        "vault document changed while it was being opened",
      );
    }
    const expectedBytes = assertBoundedSize(opened, options.maxBytes);
    bytes = Buffer.allocUnsafe(expectedBytes);
    let offset = 0;
    while (offset < expectedBytes) {
      options.signal?.throwIfAborted();
      const { bytesRead } = await handle.read(
        bytes,
        offset,
        Math.min(READ_CHUNK_BYTES, expectedBytes - offset),
        offset,
      );
      if (bytesRead === 0) {
        throw new ExactVaultDocumentReadError(
          "vault document changed while it was being read",
        );
      }
      offset += bytesRead;
    }

    // Detect growth even if filesystem metadata is momentarily stale.
    options.signal?.throwIfAborted();
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, expectedBytes)).bytesRead !== 0) {
      throw new ExactVaultDocumentReadError(
        "vault document changed while it was being read",
      );
    }

    options.signal?.throwIfAborted();
    const openedAfter = await handle.stat({ bigint: true });
    assertRegularSingleLinkFile(openedAfter);
    if (!sameFileSnapshot(opened, openedAfter)) {
      throw new ExactVaultDocumentReadError(
        "vault document changed while it was being read",
      );
    }

    options.signal?.throwIfAborted();
    const physicalPathAfter = await assertPhysicalVaultPath(
      vaultPath,
      notePath,
      { allowMissingLeaf: false },
    );
    const pathAfter = await lstatIfPresent(physicalPathAfter);
    if (
      pathAfter === null ||
      physicalPathAfter !== physicalPath ||
      !sameFileSnapshot(openedAfter, pathAfter)
    ) {
      throw new ExactVaultDocumentReadError(
        "vault document path changed while it was being read",
      );
    }
  } finally {
    await handle.close();
  }

  options.signal?.throwIfAborted();
  try {
    return {
      exists: true,
      // ignoreBOM:true means "do not use the BOM as a decoding signature";
      // this deliberately preserves U+FEFF in the returned document.
      content: new TextDecoder("utf-8", {
        fatal: true,
        ignoreBOM: true,
      }).decode(bytes),
    };
  } catch (error) {
    throw new ExactVaultDocumentReadError(
      "vault document is not valid UTF-8",
      { cause: error },
    );
  }
}
