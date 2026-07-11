import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const mainSource = readFileSync(new URL("../src/main.ts", import.meta.url), "utf8");
const sharedSource = readFileSync(
  new URL("../src/shared-settings.ts", import.meta.url),
  "utf8",
);

describe("security policy guardrails", () => {
  it("never trusts an external settings path loaded from vault plugin data", () => {
    expect(mainSource).not.toContain("loaded.sharedSettingsPath");
    expect(mainSource).not.toContain("sharedSettingsPath: this.sharedPath");
  });

  it("does not execute CLI diagnostics automatically", () => {
    expect(mainSource).not.toContain("void this.refreshCliDiagnostic()");
    expect(mainSource).not.toContain("if (!plugin.cliDiagnostic)");
    expect(mainSource).toContain('button.setButtonText("Esegui diagnostica")');
  });

  it("does not discover executable candidates from the ambient PATH", () => {
    expect(sharedSource).not.toMatch(/env\.PATH|process\.env\.PATH/u);
  });

  it("uses scoped CSS classes instead of inline style mutation", () => {
    expect(mainSource).not.toContain(".style.setProperty");
  });
});
