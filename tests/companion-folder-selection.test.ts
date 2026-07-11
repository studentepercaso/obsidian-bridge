import { describe, expect, it } from "vitest";
import {
  collapseFolderSelection,
  coveringParent,
  folderIsInside,
  hiddenFolder,
} from "../companion/obsidian-bridge-control/src/folder-selection.js";

describe("companion folder selection", () => {
  it("collapses duplicate and nested selections under their parent", () => {
    expect(
      collapseFolderSelection([
        "Scuola/Primo anno",
        "Scuola",
        "Scuola",
        "Appunti",
      ]),
    ).toEqual(["Appunti", "Scuola"]);
  });

  it("keeps sibling folders as separate scopes", () => {
    expect(collapseFolderSelection(["Progetti/Uno", "Progetti/Due"])).toEqual([
      "Progetti/Due",
      "Progetti/Uno",
    ]);
  });

  it("recognizes parent coverage without treating similarly named folders as children", () => {
    expect(folderIsInside("Scuola/Anno I", "Scuola")).toBe(true);
    expect(folderIsInside("Scuola 2", "Scuola")).toBe(false);
    expect(coveringParent("Scuola/Anno I", new Set(["Scuola"]))).toBe(
      "Scuola",
    );
  });

  it("hides every path containing a dot-prefixed segment", () => {
    expect(hiddenFolder(".obsidian/plugins")).toBe(true);
    expect(hiddenFolder("Progetti/.privato")).toBe(true);
    expect(hiddenFolder("Progetti/Attivi")).toBe(false);
  });
});
