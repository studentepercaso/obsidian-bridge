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

  it("passes one CSS token at a time to HTMLElement.addClass", () => {
    expect(mainSource).not.toMatch(
      /\.addClass\(\s*["'][^"']*\s+[^"']*["']\s*\)/u,
    );
  });

  it("routes managed mutations only through public Obsidian file APIs", () => {
    expect(mainSource).toContain('this.registerCliHandler(\n      "bridge-control:commit"');
    expect(mainSource).toContain("this.app.vault.process(file, update)");
    expect(mainSource).toContain("return rewriteFrontMatter(current, update)");
    expect(mainSource).toContain("this.app.vault.rename(file, destination)");
    expect(mainSource).toContain("this.app.fileManager.trashFile(file)");
    expect(mainSource).not.toContain("this.app.fileManager.processFrontMatter(");
    expect(mainSource).not.toContain("this.app.fileManager.renameFile(");
    expect(mainSource).not.toContain("this.app.vault.delete(");
    expect(mainSource).not.toContain("this.app.vault.adapter.write(");
  });

  it("re-reads shared management authority instead of trusting panel state", () => {
    expect(mainSource).toContain(
      "const current = await readVaultSettings(this.sharedPath, currentIdentity.id)",
    );
    expect(mainSource).toContain('current.accessMode !== "management"');
    expect(mainSource).toContain("current.managementPermissions[managementCapability(request.operation)]");
  });

  it("fails closed when the management CLI handler was not registered", () => {
    expect(mainSource).toContain(
      'normalized.accessMode === "management" &&\n      this.managementHandler === undefined',
    );
    expect(mainSource.indexOf("this.registerCliHandler(")).toBeLessThan(
      mainSource.indexOf("this.managementHandler = handler;"),
    );
    expect(mainSource).toContain("message: this.managementUnavailableReason");
  });
});
