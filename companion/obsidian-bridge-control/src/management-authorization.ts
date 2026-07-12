import { folderIsInside, restrictedFolder } from "./folder-selection.js";
import type { ManagementRequest } from "./management-protocol.js";
import { normalizeVaultConfigDir } from "./shared-settings.js";

export type ConfigDirectoryAuthorization =
  | Readonly<{ allowed: true }>
  | Readonly<{ allowed: false; errorCode: string }>;

/**
 * Recheck the live Obsidian configuration directory immediately before a
 * managed mutation. This closes the race between external prepare/commit and
 * the final in-Obsidian handler authorization.
 */
export function authorizeManagementConfigDirectory(
  request: ManagementRequest,
  storedConfigDir: string | null,
  actualConfigDir: string,
): ConfigDirectoryAuthorization {
  if (storedConfigDir === null) {
    return { allowed: false, errorCode: "CONFIG_DIRECTORY_UNVERIFIED" };
  }

  const normalizedActual = normalizeVaultConfigDir(actualConfigDir);
  const sameDirectory =
    folderIsInside(storedConfigDir, normalizedActual, false) &&
    folderIsInside(normalizedActual, storedConfigDir, false);
  if (!sameDirectory) {
    return { allowed: false, errorCode: "CONFIG_DIRECTORY_CHANGED" };
  }

  const paths = [
    request.path,
    ...(request.operation === "move" ? [request.payload.destination] : []),
  ];
  if (
    paths.some((candidate) => restrictedFolder(candidate, normalizedActual))
  ) {
    return { allowed: false, errorCode: "CONFIG_DIRECTORY_PATH_DENIED" };
  }
  return { allowed: true };
}
