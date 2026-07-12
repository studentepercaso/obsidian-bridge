import { describe, expect, it } from "vitest";
import {
  collapseFolderSelection,
  coveringParent,
  folderIsInside,
  hiddenFolder,
  restrictedFolder,
} from "../src/folder-selection.js";

describe("companion folder selection", () => {
  it("collapses duplicate and nested selections under their parent", () => {
    expect(
      collapseFolderSelection([
        "School/First year",
        "School",
        "School",
        "Notes",
      ]),
    ).toEqual(["Notes", "School"]);
  });

  it("keeps sibling folders as separate scopes", () => {
    expect(collapseFolderSelection(["Projects/One", "Projects/Two"])).toEqual([
      "Projects/One",
      "Projects/Two",
    ]);
  });

  it("recognizes parent coverage without treating similarly named folders as children", () => {
    expect(folderIsInside("School/Year One", "School")).toBe(true);
    expect(folderIsInside("School 2", "School")).toBe(false);
    expect(coveringParent("School/Year One", new Set(["School"]))).toBe(
      "School",
    );
  });

  it("hides every path containing a dot-prefixed segment", () => {
    expect(hiddenFolder(".obsidian/plugins")).toBe(true);
    expect(hiddenFolder("Projects/.private")).toBe(true);
    expect(hiddenFolder("Projects/Active")).toBe(false);
  });

  it("also hides the configured Obsidian configuration directory", () => {
    expect(restrictedFolder("Config", "Config")).toBe(true);
    expect(restrictedFolder("Config/plugins", "Config")).toBe(true);
    expect(restrictedFolder("Workspace", "Workspace/Config")).toBe(true);
    expect(restrictedFolder("config/plugins", "Config")).toBe(true);
    expect(restrictedFolder("workspace", "Workspace/Config")).toBe(true);
    expect(restrictedFolder("Config notes", "Config")).toBe(false);
    expect(restrictedFolder("Notes", "Config")).toBe(false);
  });
});
