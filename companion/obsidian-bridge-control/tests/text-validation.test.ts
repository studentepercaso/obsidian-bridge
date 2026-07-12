import { describe, expect, it } from "vitest";

import {
  hasControlCharacter,
  hasUnsafeContentControlCharacter,
} from "../src/text-validation.js";

describe("text validation", () => {
  it("rejects every C0 control and DEL in path-like values", () => {
    for (let codeUnit = 0; codeUnit <= 0x1f; codeUnit += 1) {
      expect(hasControlCharacter(`safe${String.fromCharCode(codeUnit)}path`)).toBe(true);
    }
    expect(hasControlCharacter(`safe${String.fromCharCode(0x7f)}path`)).toBe(true);
    expect(hasControlCharacter("safe path/Nota.md")).toBe(false);
  });

  it("allows Markdown whitespace while rejecting all other C0 controls and DEL", () => {
    expect(hasUnsafeContentControlCharacter("line\tvalue\r\nnext")).toBe(false);
    for (const codeUnit of [0x00, 0x08, 0x0b, 0x0c, 0x0e, 0x1f, 0x7f]) {
      expect(
        hasUnsafeContentControlCharacter(`safe${String.fromCharCode(codeUnit)}content`),
      ).toBe(true);
    }
  });
});
