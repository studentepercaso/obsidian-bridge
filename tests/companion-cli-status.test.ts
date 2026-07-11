import { describe, expect, it } from "vitest";
import { cliReportsDisabled } from "../companion/obsidian-bridge-control/src/cli-status.js";

describe("companion CLI diagnostics", () => {
  it("recognizes Obsidian's successful-exit disabled message", () => {
    expect(
      cliReportsDisabled(
        "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.",
      ),
    ).toBe(true);
  });

  it("does not mistake a version string for a disabled CLI", () => {
    expect(cliReportsDisabled("1.12.7 (installer 1.11.5)")).toBe(false);
  });
});
