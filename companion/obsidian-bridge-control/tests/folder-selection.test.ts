import { describe, expect, it } from "vitest";
import {
  collapseFolderSelection,
  coveringParent,
  folderIsInside,
  hiddenFolder,
} from "../src/folder-selection.js";

describe("folder selection", () => {
  it("collapses duplicate and nested selections under their parent", () => {
    expect(
      collapseFolderSelection([
        "Courses/Year One",
        "Courses",
        "Courses",
        "Projects",
      ]),
    ).toEqual(["Courses", "Projects"]);
  });

  it("keeps sibling folders as separate scopes", () => {
    expect(collapseFolderSelection(["Projects/One", "Projects/Two"])).toEqual([
      "Projects/One",
      "Projects/Two",
    ]);
  });

  it("recognizes parent coverage without treating similarly named folders as children", () => {
    expect(folderIsInside("Courses/Year One", "Courses")).toBe(true);
    expect(folderIsInside("Courses 2", "Courses")).toBe(false);
    expect(coveringParent("Courses/Year One", new Set(["Courses"]))).toBe(
      "Courses",
    );
  });

  it("hides every path containing a dot-prefixed segment", () => {
    expect(hiddenFolder(".obsidian/plugins")).toBe(true);
    expect(hiddenFolder("Projects/.private")).toBe(true);
    expect(hiddenFolder("Projects/Active")).toBe(false);
  });
});
