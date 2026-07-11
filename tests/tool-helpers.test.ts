import { describe, expect, it } from "vitest";

import { createPathPolicy } from "../src/path-policy.js";
import {
  extractAllowedNotePaths,
  numberLineSelection,
  selectLineRange,
} from "../src/tool-helpers.js";

describe("tool output helpers", () => {
  it("selects an inclusive one-based range and normalizes newlines", () => {
    const selection = selectLineRange("one\r\ntwo\rthree\nfour\n", 2, 3);

    expect(selection).toEqual({
      content: "two\nthree",
      startLine: 2,
      endLine: 3,
      totalLines: 4,
    });
    expect(numberLineSelection(selection)).toBe("2: two\n3: three");
  });

  it("returns an empty excerpt, while retaining the requested start, past EOF", () => {
    expect(selectLineRange("one\ntwo", 10, 20)).toEqual({
      content: "",
      startLine: 10,
      endLine: 2,
      totalLines: 2,
    });
  });

  it.each([
    [0, undefined],
    [1.5, undefined],
    [3, 2],
    [1, Number.POSITIVE_INFINITY],
  ])("rejects invalid line range %j..%j", (startLine, endLine) => {
    expect(() => selectLineRange("content", startLine, endLine)).toThrow(
      RangeError,
    );
  });

  it("extracts only allowed Markdown paths from nested JSON output", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects"],
      deniedFolders: ["Projects/Private"],
    });
    const output = JSON.stringify({
      matches: [
        { path: "Projects/Alpha.md", score: 1 },
        { file: "Projects\\Beta.md" },
        { target: "Projects/Private/Secret.md" },
        { source: ".obsidian/Config.md" },
        { path: "../Outside.md" },
        { path: "Projects/Alpha.md" },
      ],
    });

    expect(extractAllowedNotePaths(output, policy)).toEqual([
      "Projects/Alpha.md",
      "Projects/Beta.md",
    ]);
  });

  it("filters untrusted newline output using the same path policy", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects"],
      deniedFolders: ["Projects/Private"],
    });

    expect(
      extractAllowedNotePaths(
        [
          "- Projects/Alpha.md",
          "Projects/Private/Secret.md\tprivate",
          '"Projects/Beta.md"',
          "/absolute/Outside.md",
        ].join("\n"),
        policy,
      ),
    ).toEqual(["Projects/Alpha.md", "Projects/Beta.md"]);
  });
});
