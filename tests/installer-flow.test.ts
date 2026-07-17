import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const installerPath = fileURLToPath(
  new URL("../installer/Install-ObsidianBridge.ps1", import.meta.url),
);
const installer = readFileSync(installerPath, "utf8");
const launcherPath = fileURLToPath(
  new URL("../INSTALLA-OBSIDIAN-BRIDGE.cmd", import.meta.url),
);
const launcher = readFileSync(launcherPath, "utf8");

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

  it("renders natively at high DPI and keeps installation errors in the page", () => {
    expect(installer).toContain("SetProcessDpiAwarenessContext");
    expect(installer).toContain("SetThreadDpiAwarenessContext");
    expect(installer).toContain(
      "$form.AutoScaleMode = [System.Windows.Forms.AutoScaleMode]::Dpi",
    );
    expect(installer).toContain(
      "[System.Windows.Forms.Application]::SetCompatibleTextRenderingDefault($false)",
    );
    expect(installer).toContain("$content.AutoScroll = $true");
    expect(installer).toContain(
      "$messageLabel = New-Object System.Windows.Forms.TextBox",
    );
    expect(installer).toContain(
      "$messageLabel.ScrollBars = [System.Windows.Forms.ScrollBars]::Vertical",
    );
    expect(installer).toContain(
      '$messageLabel.Text = "Installazione non completata: $($_.Exception.Message)"',
    );
    expect(installer).not.toContain(
      "[void][System.Windows.Forms.MessageBox]::Show($form, $_.Exception.Message, 'Installazione non completata'",
    );
  });

  it("prefers the packaged installer when source and packaged layouts overlap", () => {
    const packaged =
      'set "OB_SCRIPT=%~dp0plugins\\obsidian-bridge\\installer\\Install-ObsidianBridge.ps1"';
    const source =
      'set "OB_SCRIPT=%~dp0installer\\Install-ObsidianBridge.ps1"';
    expect(launcher.indexOf(packaged)).toBeGreaterThanOrEqual(0);
    expect(launcher.indexOf(source)).toBeGreaterThan(launcher.indexOf(packaged));
  });

  it("requires an explicit CLI install mode and a separate consent switch", () => {
    expect(installer).toContain("[switch]$Install");
    expect(installer).toContain("[switch]$AcceptInstallation");
    expect(installer).toContain(
      "Invoke-CommandLineInstallation -SelectedVaultPath $VaultPath -Consent $AcceptInstallation.IsPresent",
    );
    expect(installer).toContain(
      "La modalita -Install richiede -VaultPath",
    );
    expect(installer).toContain(
      "-AcceptInstallation puo essere usato soltanto insieme a -Install.",
    );
    expect(installer).toContain(
      "Write-InstallerCommandLineError -Message $_.Exception.Message",
    );
  });

  it.skipIf(process.platform !== "win32")(
    "refuses an unattended install without explicit consent and emits JSON",
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
          "-Install",
          "-VaultPath",
          "C:\\vault-that-must-not-be-read",
        ],
        {
          encoding: "utf8",
          env: { ...process.env, OBSIDIAN_BRIDGE_SETTINGS_PATH: "" },
          timeout: 10_000,
        },
      );

      expect(result.status).toBe(1);
      expect(result.stdout).toBe("");
      const report = JSON.parse(result.stderr) as {
        success: boolean;
        mode: string;
        error: { message: string };
      };
      expect(report).toMatchObject({
        success: false,
        mode: "install",
      });
      expect(report.error.message).toContain("Installazione non autorizzata");
    },
    15_000,
  );

  it.skipIf(process.platform !== "win32")(
    "installs into an isolated registered vault and returns a JSON report",
    () => {
      const root = mkdtempSync(join(tmpdir(), "obsidian-bridge-cli-install-"));
      const vaultPath = join(root, "Vault CLI");
      const appData = join(root, "AppData");
      const localAppData = join(root, "LocalAppData");
      const registryDirectory = join(appData, "obsidian");
      const vaultId = "0123456789abcdef";
      mkdirSync(join(vaultPath, ".obsidian"), { recursive: true });
      mkdirSync(registryDirectory, { recursive: true });
      mkdirSync(localAppData, { recursive: true });
      writeFileSync(
        join(registryDirectory, "obsidian.json"),
        JSON.stringify({ vaults: { [vaultId]: { path: vaultPath } } }),
        "utf8",
      );

      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installerPath,
            "-Install",
            "-AcceptInstallation",
            "-VaultPath",
            vaultPath,
          ],
          {
            encoding: "utf8",
            env: {
              ...process.env,
              APPDATA: appData,
              LOCALAPPDATA: localAppData,
              OBSIDIAN_BRIDGE_SETTINGS_PATH: "",
            },
            timeout: 20_000,
          },
        );

        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as {
          success: boolean;
          mode: string;
          vaultId: string;
          vaultPath: string;
          pluginPath: string;
          sharedSettingsPath: string;
          marketplaceJson: string;
        };
        expect(report).toMatchObject({
          success: true,
          mode: "install",
          vaultId,
        });
        expect(realpathSync.native(report.vaultPath).toLowerCase()).toBe(
          realpathSync.native(vaultPath).toLowerCase(),
        );
        expect(existsSync(join(report.pluginPath, "manifest.json"))).toBe(true);
        expect(existsSync(join(report.pluginPath, "main.js"))).toBe(true);
        expect(existsSync(report.sharedSettingsPath)).toBe(true);
        expect(existsSync(report.marketplaceJson)).toBe(true);
        const settings = JSON.parse(
          readFileSync(report.sharedSettingsPath, "utf8"),
        ) as {
          vaults: Record<
            string,
            { accessMode: string; readMode: string; writeEnabled: boolean }
          >;
        };
        expect(settings.vaults[vaultId]).toMatchObject({
          accessMode: "protected",
          readMode: "off",
          writeEnabled: false,
        });
        expect(
          JSON.parse(
            readFileSync(
              join(vaultPath, ".obsidian", "community-plugins.json"),
              "utf8",
            ),
          ),
        ).toContain("bridge-control");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );

  it("supports v5 while migrating v2-v4 without inventing privileges", () => {
    expect(installer).toContain("@([int]2, [int]3, [int]4, [int]5)");
    expect(installer).toContain("$Existing['version'] -eq 3");
    expect(installer).toContain(
      "$legacyEntry.Add('managementPermissions', (New-DisabledManagementPermissions))",
    );
    expect(installer).toContain("$Existing['version'] = 4");
    expect(installer).toContain("$Existing['version'] -eq 4");
    expect(installer).toContain("$legacyEntry.Add('configDir', $null)");
    expect(installer).toContain("$Existing['version'] = 5");
    expect(installer).toContain("Test-VaultFoldersIntersect");
    expect(installer).toContain("$entry.Add('configDir', $null)");
    expect(installer).not.toContain("$entry.Add('configDir', '.obsidian')");
  });

  it.skipIf(process.platform !== "win32")(
    "builds a verified local marketplace directly from the source plugin payload",
    () => {
      const isolatedLocalAppData = mkdtempSync(
        join(tmpdir(), "obsidian-bridge-marketplace-"),
      );
      try {
        const result = spawnSync(
          "powershell.exe",
          [
            "-NoLogo",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            installerPath,
            "-MarketplaceSelfTest",
          ],
          {
            encoding: "utf8",
            env: { ...process.env, LOCALAPPDATA: isolatedLocalAppData },
            timeout: 10_000,
          },
        );

        expect(result.status, result.stderr).toBe(0);
        const report = JSON.parse(result.stdout) as {
          marketplaceSelfTest: boolean;
          stableRoot: string;
          relationshipVerified: boolean;
          updateVerified: boolean;
          marketplaceName: string;
          sourceType: string;
          sourcePath: string;
          requiredFiles: Record<string, boolean>;
        };
        expect(report).toMatchObject({
          marketplaceSelfTest: true,
          relationshipVerified: true,
          updateVerified: true,
          marketplaceName: "obsidian-bridge-local",
          sourceType: "local",
          sourcePath: "./plugins/obsidian-bridge",
          requiredFiles: {
            manifest: true,
            mcp: true,
            server: true,
            skill: true,
          },
        });
        expect(
          existsSync(
            join(
              report.stableRoot,
              ".agents",
              "plugins",
              "marketplace.json",
            ),
          ),
        ).toBe(true);
      } finally {
        rmSync(isolatedLocalAppData, { recursive: true, force: true });
      }
    },
    15_000,
  );

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
        { encoding: "utf8", timeout: 10_000 },
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
          invalidConfigDirRejected: boolean;
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
        migratedVersion: 5,
        migratedAccessMode: "protected",
        migratedManagementPermissions: { edit: false, move: false, trash: false },
        preservedFull: {
          version: 5,
          accessMode: "full",
          managementPermissions: { edit: false, move: false, trash: false },
          vaultName: "Vault completo aggiornato",
          vaultPath: "C:\\Vault completo aggiornato",
        },
        preservedManagement: {
          version: 5,
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
          invalidConfigDirRejected: true,
        },
        reviewedAuditChangeIds: {
          count: 100,
          first: "00000000-0000-4000-8000-000000000003",
          last: "00000000-0000-4000-8000-000000000102",
          invalidRejected: true,
        },
      });
    },
    15_000,
  );
});
