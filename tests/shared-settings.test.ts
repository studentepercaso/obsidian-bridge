import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { isPathAllowed } from "../src/path-policy.js";
import {
  MAX_SETTINGS_BYTES,
  SharedSettingsError,
  createVaultAccessResolver,
  readSharedSettings,
  type VaultSettings,
} from "../src/shared-settings.js";

function document(vaults: Record<string, VaultSettings>): string {
  return `${JSON.stringify({
    version: 5,
    updatedAt: "2026-07-11T10:00:00.000Z",
    vaults,
  })}\n`;
}

function entry(overrides: Partial<VaultSettings> = {}): VaultSettings {
  return {
    vaultName: "Test Vault",
    vaultPath: join(tmpdir(), "Test Vault"),
    enabled: true,
    readMode: "folders",
    readFolders: ["Panel Read"],
    writeEnabled: true,
    writeFolders: ["Panel Write"],
    accessMode: "protected",
    managementPermissions: { edit: false, move: false, trash: false },
    configDir: ".obsidian",
    ...overrides,
  };
}

describe("shared GUI settings", () => {
  const TEST_VAULT_ID = "0123456789abcdef";
  const OTHER_VAULT_ID = "fedcba9876543210";
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function fixture(): Promise<{
    directory: string;
    settingsPath: string;
  }> {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-settings-test-"));
    temporaryDirectories.push(directory);
    return { directory, settingsPath: join(directory, "settings.json") };
  }

  function resolver(settingsPath: string) {
    return createVaultAccessResolver({
      settingsPath,
      allowedFolders: ["Environment Read"],
      environmentReadConfigured: true,
      deniedFolders: [".obsidian", ".trash", "Always Denied"],
      writableVaults: ["Test Vault"],
      writableFolders: ["Environment Write"],
    });
  }

  it("uses the environment policy when the settings file is absent", async () => {
    const { settingsPath } = await fixture();
    await expect(readSharedSettings(settingsPath)).resolves.toEqual({
      status: "absent",
    });

    const access = await resolver(settingsPath)("Test Vault");
    expect(access.source).toBe("environment");
    expect(isPathAllowed("Environment Read/A.md", access.readPolicy)).toBe(
      true,
    );
    expect(isPathAllowed("Panel Read/A.md", access.readPolicy)).toBe(false);
    expect(access.writeEnabled).toBe(true);
    expect(isPathAllowed("Environment Write/A.md", access.writablePolicy)).toBe(
      true,
    );
    expect(access.accessMode).toBe("protected");
    expect(access.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
  });

  it("migrates strict version-2 settings to protected access in memory", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 2,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          [TEST_VAULT_ID]: {
            vaultName: "Test Vault",
            vaultPath: join(tmpdir(), "Test Vault"),
            enabled: true,
            readMode: "folders",
            readFolders: ["Panel Read"],
            writeEnabled: true,
            writeFolders: ["Panel Write"],
          },
        },
      })}\n`,
      "utf8",
    );

    const snapshot = await readSharedSettings(settingsPath);
    expect(snapshot).toMatchObject({
      status: "loaded",
      settings: {
        version: 5,
        vaults: {
          [TEST_VAULT_ID]: {
            accessMode: "protected",
            managementPermissions: { edit: false, move: false, trash: false },
            configDir: null,
          },
        },
      },
    });
    const access = await resolver(settingsPath)("Test Vault");
    expect(access.accessMode).toBe("protected");
    expect(access.writeEnabled).toBe(false);
    expect(isPathAllowed("Panel Read/A.md", access.readPolicy)).toBe(false);
  });

  it("migrates version-3 full access without inventing management grants", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 3,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          [TEST_VAULT_ID]: {
            vaultName: "Test Vault",
            vaultPath: join(tmpdir(), "Test Vault"),
            enabled: true,
            readMode: "off",
            readFolders: [],
            writeEnabled: false,
            writeFolders: [],
            accessMode: "full",
          },
        },
      })}\n`,
      "utf8",
    );

    const snapshot = await readSharedSettings(settingsPath);
    expect(snapshot).toMatchObject({
      status: "loaded",
      settings: {
        version: 5,
        vaults: {
          [TEST_VAULT_ID]: {
            accessMode: "full",
            managementPermissions: { edit: false, move: false, trash: false },
            configDir: null,
          },
        },
      },
    });
    const access = await resolver(settingsPath)("Test Vault");
    expect(access.accessMode).toBe("protected");
    expect(access.writeEnabled).toBe(false);
    expect(access.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
    expect(isPathAllowed("Anywhere/A.md", access.readPolicy)).toBe(false);
    expect(isPathAllowed("Anywhere/A.md", access.writablePolicy)).toBe(false);
  });

  it("loads version-4 management grants as deny-all until configDir is persisted", async () => {
    const { settingsPath } = await fixture();
    const legacyEntry = entry({
      accessMode: "management",
      managementPermissions: { edit: true, move: true, trash: false },
    });
    const { configDir: _configDir, ...version4Entry } = legacyEntry;
    await writeFile(
      settingsPath,
      `${JSON.stringify({
        version: 4,
        updatedAt: "2026-07-12T10:00:00.000Z",
        vaults: { [TEST_VAULT_ID]: version4Entry },
      })}\n`,
      "utf8",
    );

    const snapshot = await readSharedSettings(settingsPath);
    expect(snapshot).toMatchObject({
      status: "loaded",
      settings: {
        version: 5,
        vaults: {
          [TEST_VAULT_ID]: {
            accessMode: "management",
            managementPermissions: { edit: true, move: true, trash: false },
            configDir: null,
          },
        },
      },
    });
    const access = await resolver(settingsPath)("Test Vault");
    expect(access.accessMode).toBe("protected");
    expect(access.writeEnabled).toBe(false);
    expect(access.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
    expect(isPathAllowed("Panel Read/A.md", access.readPolicy)).toBe(false);
  });

  it("denies the real custom configDir in full and management policies", async () => {
    const { settingsPath } = await fixture();
    for (const accessMode of ["full", "management"] as const) {
      await writeFile(
        settingsPath,
        document({
          [TEST_VAULT_ID]: entry({
            accessMode,
            configDir: "Workspace/Config",
            managementPermissions:
              accessMode === "management"
                ? { edit: true, move: false, trash: false }
                : { edit: false, move: false, trash: false },
            readMode: "off",
            readFolders: [],
            writeEnabled: false,
            writeFolders: [],
          }),
        }),
        "utf8",
      );
      const access = await resolver(settingsPath)("Test Vault");
      expect(isPathAllowed("Anywhere/A.md", access.readPolicy)).toBe(true);
      expect(
        isPathAllowed("Workspace/Config/plugins/x.md", access.readPolicy),
      ).toBe(false);
      expect(
        isPathAllowed("Workspace/Config/plugins/x.md", access.writablePolicy),
      ).toBe(false);
      expect(
        isPathAllowed("workspace/config/plugins/x.md", access.readPolicy),
      ).toBe(false);
      expect(
        isPathAllowed("workspace/config/plugins/x.md", access.writablePolicy),
      ).toBe(false);
    }
  });

  it("grants full visible-vault read and write only from an enabled full entry", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({
          accessMode: "full",
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        }),
      }),
      "utf8",
    );

    const access = await resolver(settingsPath)("Test Vault");
    expect(access.accessMode).toBe("full");
    expect(access.writeEnabled).toBe(true);
    expect(access.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
    expect(isPathAllowed("Root note.md", access.readPolicy)).toBe(true);
    expect(isPathAllowed("Root note.md", access.writablePolicy)).toBe(true);
    expect(isPathAllowed("Any/Nested note.md", access.writablePolicy)).toBe(
      true,
    );
    expect(
      isPathAllowed(".obsidian/plugins/unsafe.md", access.writablePolicy),
    ).toBe(false);
    expect(
      isPathAllowed("Always Denied/unsafe.md", access.writablePolicy),
    ).toBe(false);

    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({
          accessMode: "full",
          enabled: false,
          readMode: "all",
        }),
      }),
      "utf8",
    );
    const disabled = await resolver(settingsPath)("Test Vault");
    expect(disabled.accessMode).toBe("protected");
    expect(disabled.writeEnabled).toBe(false);
    expect(disabled.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
    expect(isPathAllowed("Root note.md", disabled.readPolicy)).toBe(false);
  });

  it("exposes management grants only from an enabled management entry", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({
          accessMode: "management",
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
          managementPermissions: { edit: true, move: false, trash: true },
        }),
      }),
      "utf8",
    );

    const access = await resolver(settingsPath)("Test Vault");
    expect(access.accessMode).toBe("management");
    expect(access.writeEnabled).toBe(true);
    expect(isPathAllowed("Root note.md", access.readPolicy)).toBe(true);
    expect(isPathAllowed("Nested/Note.md", access.writablePolicy)).toBe(true);
    expect(access.managementPermissions).toEqual({
      edit: true,
      move: false,
      trash: true,
    });

    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({
          enabled: false,
          accessMode: "management",
          readMode: "all",
          writeEnabled: true,
          managementPermissions: { edit: true, move: true, trash: true },
        }),
      }),
      "utf8",
    );
    const disabled = await resolver(settingsPath)("Test Vault");
    expect(disabled.accessMode).toBe("protected");
    expect(disabled.writeEnabled).toBe(false);
    expect(isPathAllowed("Root note.md", disabled.readPolicy)).toBe(false);
    expect(disabled.managementPermissions).toEqual({
      edit: false,
      move: false,
      trash: false,
    });
  });

  it("rejects stored management grants outside management mode", async () => {
    const { settingsPath } = await fixture();
    const resolveAccess = resolver(settingsPath);
    for (const accessMode of ["full", "protected"] as const) {
      await writeFile(
        settingsPath,
        document({
          [TEST_VAULT_ID]: entry({
            accessMode,
            managementPermissions: { edit: true, move: true, trash: true },
          }),
        }),
        "utf8",
      );
      await expect(resolveAccess("Test Vault")).rejects.toThrow(
        "shared settings do not match schema",
      );
    }
  });

  it("denies legacy read access when no GUI file or read environment exists", async () => {
    const { settingsPath } = await fixture();
    const access = await createVaultAccessResolver({
      settingsPath,
      allowedFolders: null,
      deniedFolders: [".obsidian", ".trash"],
      writableVaults: [],
      writableFolders: [],
    })("Test Vault");

    expect(access.source).toBe("environment");
    expect(isPathAllowed("Anywhere/A.md", access.readPolicy)).toBe(false);
    expect(access.writeEnabled).toBe(false);
  });

  it.each([
    {
      mode: "all" as const,
      folders: [] as string[],
      allowed: "Anywhere/A.md",
      expected: true,
    },
    {
      mode: "folders" as const,
      folders: ["Scoped"] as string[],
      allowed: "Scoped/A.md",
      expected: true,
    },
    {
      mode: "off" as const,
      folders: [] as string[],
      allowed: "Anywhere/A.md",
      expected: false,
    },
  ])(
    "enforces panel read mode $mode",
    async ({ mode, folders, allowed, expected }) => {
      const { settingsPath } = await fixture();
      await writeFile(
        settingsPath,
        document({
          [TEST_VAULT_ID]: entry({ readMode: mode, readFolders: folders }),
        }),
        "utf8",
      );

      const access = await resolver(settingsPath)("Test Vault");
      expect(access.source).toBe("settings");
      expect(isPathAllowed(allowed, access.readPolicy)).toBe(expected);
      expect(isPathAllowed("Environment Read/A.md", access.readPolicy)).toBe(
        mode === "all",
      );
      expect(isPathAllowed("Always Denied/A.md", access.readPolicy)).toBe(
        false,
      );
    },
  );

  it("honors both the global vault toggle and the write toggle", async () => {
    const { settingsPath } = await fixture();
    const resolveAccess = resolver(settingsPath);

    await writeFile(
      settingsPath,
      document({ [TEST_VAULT_ID]: entry({ writeEnabled: false }) }),
      "utf8",
    );
    const writeOff = await resolveAccess("Test Vault");
    expect(writeOff.writeEnabled).toBe(false);
    expect(isPathAllowed("Panel Write/A.md", writeOff.writablePolicy)).toBe(
      false,
    );

    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({ enabled: false, writeEnabled: true }),
      }),
      "utf8",
    );
    const vaultOff = await resolveAccess("Test Vault");
    expect(vaultOff.writeEnabled).toBe(false);
    expect(isPathAllowed("Panel Read/A.md", vaultOff.readPolicy)).toBe(false);
  });

  it("fails closed for malformed, extra-field, invalid-folder, and oversized files", async () => {
    const { settingsPath } = await fixture();
    const resolveAccess = resolver(settingsPath);
    const missingManagementPermissions: Partial<VaultSettings> = { ...entry() };
    delete missingManagementPermissions.managementPermissions;

    for (const invalid of [
      "{not-json",
      JSON.stringify({
        version: 2,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: { [TEST_VAULT_ID]: { ...entry(), unexpected: true } },
      }),
      document({ [TEST_VAULT_ID]: entry({ readFolders: ["../Outside"] }) }),
      document({
        [TEST_VAULT_ID]: entry({
          configDir: "Workspace/Config",
          readFolders: ["workspace"],
        }),
      }),
      JSON.stringify({
        version: 5,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: { [TEST_VAULT_ID]: missingManagementPermissions },
      }),
      JSON.stringify({
        version: 5,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          [TEST_VAULT_ID]: {
            ...entry(),
            managementPermissions: {
              edit: true,
              move: true,
              trash: true,
              unexpected: true,
            },
          },
        },
      }),
      JSON.stringify({
        version: 3,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          [TEST_VAULT_ID]: { ...entry(), accessMode: "unrestricted" },
        },
      }),
      "x".repeat(MAX_SETTINGS_BYTES + 1),
    ]) {
      await writeFile(settingsPath, invalid, "utf8");
      await expect(resolveAccess("Test Vault")).rejects.toBeInstanceOf(
        SharedSettingsError,
      );
    }
  });

  it("reloads on every resolution and applies revocation immediately", async () => {
    const { settingsPath } = await fixture();
    const resolveAccess = resolver(settingsPath);
    await writeFile(
      settingsPath,
      document({ [TEST_VAULT_ID]: entry({ readFolders: ["First"] }) }),
      "utf8",
    );
    const first = await resolveAccess("Test Vault");
    expect(isPathAllowed("First/A.md", first.readPolicy)).toBe(true);

    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry({
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        }),
      }),
      "utf8",
    );
    const revoked = await resolveAccess("Test Vault");
    expect(isPathAllowed("First/A.md", revoked.readPolicy)).toBe(false);
    expect(revoked.writeEnabled).toBe(false);
  });

  it("matches vault keys exactly and denies unconfigured vaults when the file exists", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({ [TEST_VAULT_ID]: entry({ readMode: "off" }) }),
      "utf8",
    );
    const resolveAccess = resolver(settingsPath);

    const exact = await resolveAccess("Test Vault");
    expect(exact.source).toBe("settings");
    expect(isPathAllowed("Environment Read/A.md", exact.readPolicy)).toBe(
      false,
    );

    const differentCase = await resolveAccess("test vault");
    expect(differentCase.source).toBe("settings");
    expect(
      isPathAllowed("Environment Read/A.md", differentCase.readPolicy),
    ).toBe(false);
    expect(differentCase.writeEnabled).toBe(false);
  });

  it("uses stable IDs and rejects an ambiguous display name", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry(),
        [OTHER_VAULT_ID]: entry({
          vaultPath: join(tmpdir(), "Other Test Vault"),
        }),
      }),
      "utf8",
    );
    const resolveAccess = resolver(settingsPath);

    await expect(resolveAccess("Test Vault")).rejects.toThrow(/ambiguous/iu);
    const exact = await resolveAccess(TEST_VAULT_ID.toUpperCase());
    expect(exact.vaultSelector).toBe(TEST_VAULT_ID);
    expect(exact.vaultName).toBe("Test Vault");
  });

  it("does not inherit environment read-all for a vault missing from a loaded file", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({
        [OTHER_VAULT_ID]: entry({
          vaultName: "Configured Vault",
          readMode: "all",
        }),
      }),
      "utf8",
    );
    const resolveAccess = createVaultAccessResolver({
      settingsPath,
      allowedFolders: null,
      deniedFolders: [".obsidian", ".trash"],
      writableVaults: ["Other Vault"],
      writableFolders: ["Anywhere"],
    });

    const missing = await resolveAccess("Other Vault");
    expect(missing.source).toBe("settings");
    expect(isPathAllowed("Anywhere/A.md", missing.readPolicy)).toBe(false);
    expect(isPathAllowed("Anywhere/A.md", missing.writablePolicy)).toBe(false);
    expect(missing.writeEnabled).toBe(false);
  });
});
