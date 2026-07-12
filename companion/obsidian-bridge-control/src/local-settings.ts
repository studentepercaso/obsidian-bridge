import {
  parseFolderList,
  type ReadMode,
  type VaultBridgeSettings,
} from "./shared-settings";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeLoadedFolders(
  value: unknown,
  fallback: readonly string[],
): { folders: string[]; valid: boolean } {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return { folders: [...fallback], valid: false };
  }
  const parsed = parseFolderList(value.join("\n"));
  return parsed.errors.length === 0
    ? { folders: parsed.folders, valid: true }
    : { folders: [...fallback], valid: false };
}

/**
 * Recover only the low-risk folder draft cached in Obsidian's plugin data.
 * The cache is not an authorization source: it can never restore full access.
 */
export function coerceProtectedLocalSettings(
  value: unknown,
  fallback: VaultBridgeSettings,
): VaultBridgeSettings {
  if (!isRecord(value)) {
    return {
      ...fallback,
      accessMode: "protected",
      readFolders: [...fallback.readFolders],
      writeFolders: [...fallback.writeFolders],
    };
  }

  const readMode: ReadMode =
    value.readMode === "off" || value.readMode === "all" || value.readMode === "folders"
      ? value.readMode
      : fallback.readMode;
  const loadedReadFolders = normalizeLoadedFolders(value.readFolders, fallback.readFolders);
  const readFolders =
    readMode === "folders" && loadedReadFolders.folders.length === 0
      ? [...fallback.readFolders]
      : loadedReadFolders.folders;
  const loadedWriteFolders = normalizeLoadedFolders(value.writeFolders, fallback.writeFolders);
  const requestedWriteEnabled =
    typeof value.writeEnabled === "boolean" ? value.writeEnabled : fallback.writeEnabled;

  return {
    accessMode: "protected",
    enabled: typeof value.enabled === "boolean" ? value.enabled : fallback.enabled,
    readMode,
    readFolders,
    writeEnabled:
      requestedWriteEnabled && loadedWriteFolders.valid && loadedWriteFolders.folders.length > 0,
    writeFolders: loadedWriteFolders.folders,
  };
}
