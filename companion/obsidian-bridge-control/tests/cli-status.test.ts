import { describe, expect, it } from "vitest";
import {
  cliReportsDisabled,
  cliReportsVersion,
} from "../src/cli-status.js";

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

  it("accepts recognized Obsidian CLI version formats", () => {
    expect(cliReportsVersion("1.12.7")).toBe(true);
    expect(cliReportsVersion("1.12.7 (installer 1.11.5)")).toBe(true);
    expect(cliReportsVersion("1.13.0-beta.1")).toBe(true);
  });

  it("rejects arbitrary successful output as a CLI version", () => {
    expect(cliReportsVersion("ready")).toBe(false);
    expect(cliReportsVersion("1.12")).toBe(false);
    expect(cliReportsVersion("1.12.7\nextra output")).toBe(false);
  });
});
