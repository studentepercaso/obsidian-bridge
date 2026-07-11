export interface FolderAccessSelection {
  readFolders: string[];
  writeFolders: string[];
}

export function folderIsInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(`${parent}/`);
}

function compareVaultFolders(left: string, right: string): number {
  const depthDifference = left.split("/").length - right.split("/").length;
  return depthDifference || left.localeCompare(right, "it", { numeric: true, sensitivity: "base" });
}

export function collapseFolderSelection(folders: Iterable<string>): string[] {
  const unique = [...new Set(folders)].sort(compareVaultFolders);
  const collapsed: string[] = [];
  for (const folder of unique) {
    if (!collapsed.some((parent) => folderIsInside(folder, parent))) collapsed.push(folder);
  }
  return collapsed;
}

export function hiddenFolder(path: string): boolean {
  return path.split("/").some((segment) => segment.startsWith("."));
}

export function coveringParent(path: string, folders: Set<string>): string | undefined {
  return [...folders].find((folder) => folder !== path && folderIsInside(path, folder));
}
