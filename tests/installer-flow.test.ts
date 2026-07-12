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
      "managementPermissions",
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
    expect(installer).toContain(
      "edit = [bool]$context.VaultSettingsEntry['managementPermissions']['edit']",
    );
  });

  it("supports v4 while migrating v2 and v3 without management privileges", () => {
    expect(installer).toContain("@([int]2, [int]3, [int]4)");
    expect(installer).toContain("$Existing['version'] -eq 3");
    expect(installer).toContain(
      "$legacyEntry.Add('managementPermissions', (New-DisabledManagementPermissions))",
    );
    expect(installer).toContain("$Existing['version'] = 4");
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
          managementPermissions: { edit: boolean; move: boolean; trash: boolean };
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
          managementPermissions: { edit: boolean; move: boolean; trash: boolean };
          enabled: boolean;
          readMode: string;
          readFolders: string[];
          writeEnabled: boolean;
          writeFolders: string[];
        };
        arraysAreIndependent: boolean;
        migratedVersion: number;
        migratedAccessMode: string;
        migratedManagementPermissions: { edit: boolean; move: boolean; trash: boolean };
        preservedFull: {
          version: number;
          accessMode: string;
          managementPermissions: { edit: boolean; move: boolean; trash: boolean };
          vaultName: string;
          vaultPath: string;
        };
        preservedManagement: {
          version: number;
          accessMode: string;
          managementPermissions: { edit: boolean; move: boolean; trash: boolean };
          objectsAreIndependent: boolean;
          vaultName: string;
          vaultPath: string;
        };
        pluginData: {
          version: number;
          managementPermissions: { edit: boolean; move: boolean; trash: boolean };
        };
        schemaGuardrails: {
          dormantPermissionsRejected: boolean;
          emptyManagementRejected: boolean;
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
          managementPermissions: { edit: false, move: false, trash: false },
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
          managementPermissions: { edit: false, move: false, trash: false },
          enabled: true,
          readMode: "folders",
          readFolders: ["Studio"],
          writeEnabled: true,
          writeFolders: ["Studio/Appunti"],
        },
        arraysAreIndependent: true,
        migratedVersion: 4,
        migratedAccessMode: "protected",
        migratedManagementPermissions: { edit: false, move: false, trash: false },
        preservedFull: {
          version: 4,
          accessMode: "full",
          managementPermissions: { edit: false, move: false, trash: false },
          vaultName: "Vault completo aggiornato",
          vaultPath: "C:\\Vault completo aggiornato",
        },
        preservedManagement: {
          version: 4,
          accessMode: "management",
          managementPermissions: { edit: true, move: true, trash: false },
          objectsAreIndependent: true,
          vaultName: "Vault gestione aggiornato",
          vaultPath: "C:\\Vault gestione aggiornato",
        },
        pluginData: {
          version: 4,
          managementPermissions: { edit: false, move: false, trash: false },
        },
        schemaGuardrails: {
          dormantPermissionsRejected: true,
          emptyManagementRejected: true,
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
