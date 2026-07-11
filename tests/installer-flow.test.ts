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
          enabled: boolean;
          readMode: string;
          readFolders: string[];
          writeEnabled: boolean;
          writeFolders: string[];
        };
        preserved: {
          vaultName: string;
          vaultPath: string;
          enabled: boolean;
          readMode: string;
          readFolders: string[];
          writeEnabled: boolean;
          writeFolders: string[];
        };
        arraysAreIndependent: boolean;
      };

      expect(report).toMatchObject({
        selfTest: true,
        fresh: {
          enabled: true,
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        },
        preserved: {
          vaultName: "Vault aggiornato",
          vaultPath: "C:\\Vault aggiornato",
          enabled: true,
          readMode: "folders",
          readFolders: ["Studio"],
          writeEnabled: true,
          writeFolders: ["Studio/Appunti"],
        },
        arraysAreIndependent: true,
      });
    },
  );
});
