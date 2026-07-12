import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const installerPath = fileURLToPath(
  new URL("../installer/Install-ObsidianBridge.ps1", import.meta.url),
);
const installer = readFileSync(installerPath, "utf8");

describe("guided installer permission flow", () => {
  it("does not ask for manual read or write folders", () => {
    expect(installer).not.toContain("$readText");
    expect(installer).not.toContain("$writeText");
    expect(installer).not.toContain("$writeCheck");
    expect(installer).toContain(
      "$context = Get-InstallContext -SelectedVaultPath $script:selectedVaultPath",
    );
  });

  it("creates a deny-by-default entry for a new vault", () => {
    expect(installer).toContain(
      "return New-VaultSettingsEntry -VaultName $VaultName -VaultPath $VaultPath -ReadFolders @() -WriteEnabled $false -WriteFolders @()",
    );
  });

  it("preserves saved permission fields when reinstalling", () => {
    for (const field of [
      "enabled",
      "accessMode",
      "readMode",
      "readFolders",
      "writeEnabled",
      "writeFolders",
    ]) {
      expect(installer).toContain(`$existing['${field}']`);
    }
    expect(installer).toContain(
      "$vaultSettingsEntry = New-InstallerVaultSettingsEntry -ExistingSharedSettings $existingSharedSettings",
    );
  });

  it("does not persist an externally writable settings path in vault plugin data", () => {
    expect(installer).not.toContain("$result.Add('sharedSettingsPath'");
  });

  it("preserves only bounded valid reviewed audit change IDs", () => {
    expect(installer).toContain(
      "$Existing.ContainsKey('reviewedAuditChangeIds')",
    );
    expect(installer).toContain("$reviewedValues.Count -gt 100");
    expect(installer).toContain(
      "$result.Add('reviewedAuditChangeIds', $reviewedValues)",
    );
  });

  it("reports the retained access mode during a dry run", () => {
    expect(installer).toContain(
      "accessMode = $context.VaultSettingsEntry['accessMode']",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "executes deny-by-default and permission-preservation behavior",
    () => {
      const result = spawnSync(
        "powershell.exe",
        [
          "-NoLogo",
          "-NoProfile",
          "-ExecutionPolicy",
          "Bypass",
          "-File",
          installerPath,
          "-SelfTest",
        ],
        { encoding: "utf8" },
      );

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(result.stdout) as {
        selfTest: boolean;
        fresh: {
          accessMode: string;
          enabled: boolean;
          readMode: string;
          readFolders: string[];
          writeEnabled: boolean;
          writeFolders: string[];
        };
        preserved: {
          vaultName: string;
          vaultPath: string;
          accessMode: string;
          enabled: boolean;
          readMode: string;
          readFolders: string[];
          writeEnabled: boolean;
          writeFolders: string[];
        };
        arraysAreIndependent: boolean;
        migratedVersion: number;
        migratedAccessMode: string;
        preservedFull: {
          version: number;
          accessMode: string;
          vaultName: string;
          vaultPath: string;
        };
        reviewedAuditChangeIds: {
          count: number;
          first: string;
          last: string;
          invalidRejected: boolean;
        };
      };

      expect(report).toMatchObject({
        selfTest: true,
        fresh: {
          accessMode: "protected",
          enabled: true,
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        },
        preserved: {
          vaultName: "Vault aggiornato",
          vaultPath: "C:\\Vault aggiornato",
          accessMode: "protected",
          enabled: true,
          readMode: "folders",
          readFolders: ["Studio"],
          writeEnabled: true,
          writeFolders: ["Studio/Appunti"],
        },
        arraysAreIndependent: true,
        migratedVersion: 3,
        migratedAccessMode: "protected",
        preservedFull: {
          version: 3,
          accessMode: "full",
          vaultName: "Vault completo aggiornato",
          vaultPath: "C:\\Vault completo aggiornato",
        },
        reviewedAuditChangeIds: {
          count: 100,
          first: "00000000-0000-4000-8000-000000000003",
          last: "00000000-0000-4000-8000-000000000102",
          invalidRejected: true,
        },
      });
    },
  );
});
