export interface FolderAccessSelection {
  readFolders: string[];
  writeFolders: string[];
}

function defaultCaseSensitive(): boolean {
  return process.platform !== "win32" && process.platform !== "darwin";
}

function comparisonKey(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

export function folderIsInside(
  child: string,
  parent: string,
  caseSensitive = defaultCaseSensitive(),
): boolean {
  const childKey = comparisonKey(child, caseSensitive);
  const parentKey = comparisonKey(parent, caseSensitive);
  return childKey === parentKey || childKey.startsWith(`${parentKey}/`);
}

function compareVaultFolders(left: string, right: string): number {
  const depthDifference = left.split("/").length - right.split("/").length;
  return (
    depthDifference ||
    left.localeCompare(right, "it", { numeric: true, sensitivity: "base" })
  );
}

export function collapseFolderSelection(folders: Iterable<string>): string[] {
  const unique = [...new Set(folders)].sort(compareVaultFolders);
  const collapsed: string[] = [];
  for (const folder of unique) {
    if (!collapsed.some((parent) => folderIsInside(folder, parent)))
      collapsed.push(folder);
  }
  return collapsed;
}

export function hiddenFolder(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function restrictedFolder(path: string, configDir: string): boolean {
  if (hiddenFolder(path)) return true;
  const normalizedConfigDir = configDir
    .trim()
    .replace(/\\/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .normalize("NFC");
  if (normalizedConfigDir.length === 0) return false;
  const normalizedPath = path.normalize("NFC");
  // The vault may live on a case-insensitive volume even when Obsidian runs
  // on Linux. A deny rule must therefore reject every case variant of the
  // authoritative configuration directory. This can only narrow access.
  const configDirCaseSensitive = false;
  return (
    folderIsInside(
      normalizedPath,
      normalizedConfigDir,
      configDirCaseSensitive,
    ) ||
    folderIsInside(normalizedConfigDir, normalizedPath, configDirCaseSensitive)
  );
}

export function coveringParent(
  path: string,
  folders: Set<string>,
): string | undefined {
  return [...folders].find(
    (folder) => folder !== path && folderIsInside(path, folder),
  );
}
