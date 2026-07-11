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
    version: 2,
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

  async function fixture(): Promise<{ directory: string; settingsPath: string }> {
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
    expect(isPathAllowed("Environment Read/A.md", access.readPolicy)).toBe(true);
    expect(isPathAllowed("Panel Read/A.md", access.readPolicy)).toBe(false);
    expect(access.writeEnabled).toBe(true);
    expect(isPathAllowed("Environment Write/A.md", access.writablePolicy)).toBe(
      true,
    );
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
  ])("enforces panel read mode $mode", async ({ mode, folders, allowed, expected }) => {
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
    expect(isPathAllowed("Always Denied/A.md", access.readPolicy)).toBe(false);
  });

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
    expect(isPathAllowed("Panel Write/A.md", writeOff.writablePolicy)).toBe(false);

    await writeFile(
      settingsPath,
      document({ [TEST_VAULT_ID]: entry({ enabled: false, writeEnabled: true }) }),
      "utf8",
    );
    const vaultOff = await resolveAccess("Test Vault");
    expect(vaultOff.writeEnabled).toBe(false);
    expect(isPathAllowed("Panel Read/A.md", vaultOff.readPolicy)).toBe(false);
  });

  it("fails closed for malformed, extra-field, invalid-folder, and oversized files", async () => {
    const { settingsPath } = await fixture();
    const resolveAccess = resolver(settingsPath);

    for (const invalid of [
      "{not-json",
      JSON.stringify({
        version: 2,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: { [TEST_VAULT_ID]: { ...entry(), unexpected: true } },
      }),
      document({ [TEST_VAULT_ID]: entry({ readFolders: ["../Outside"] }) }),
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
    expect(isPathAllowed("Environment Read/A.md", exact.readPolicy)).toBe(false);

    const differentCase = await resolveAccess("test vault");
    expect(differentCase.source).toBe("settings");
    expect(isPathAllowed("Environment Read/A.md", differentCase.readPolicy)).toBe(
      false,
    );
    expect(differentCase.writeEnabled).toBe(false);
  });

  it("uses stable IDs and rejects an ambiguous display name", async () => {
    const { settingsPath } = await fixture();
    await writeFile(
      settingsPath,
      document({
        [TEST_VAULT_ID]: entry(),
        [OTHER_VAULT_ID]: entry({ vaultPath: join(tmpdir(), "Other Test Vault") }),
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
