import { readFile } from "node:fs/promises";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  mergeVaultSettings,
  readVaultSettings,
  resolveVaultIdentity,
  sharedSettingsPath,
} from "../src/shared-settings.js";

describe("shared settings security", () => {
  const noManagement = { edit: false, move: false, trash: false } as const;
  let sandbox = "";
  let vault = "";
  let configRoot = "";

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "bridge-control-"));
    vault = join(sandbox, "vault");
    configRoot = join(sandbox, "config");
    await mkdir(vault, { recursive: true });
    await mkdir(join(configRoot, "obsidian"), { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("resolves a stable vault identity from the bounded Obsidian registry", async () => {
    await writeFile(
      join(configRoot, "obsidian", "obsidian.json"),
      JSON.stringify({
        vaults: {
          "0123456789abcdef": {
            path: vault,
          },
        },
      }),
      "utf8",
    );

    await expect(
      resolveVaultIdentity(
        "linux",
        "Synthetic vault",
        vault,
        { XDG_CONFIG_HOME: configRoot },
        sandbox,
      ),
    ).resolves.toMatchObject({
      id: "0123456789abcdef",
      name: "Synthetic vault",
    });
  });

  it("rejects an oversized Obsidian registry before parsing", async () => {
    await writeFile(
      join(configRoot, "obsidian", "obsidian.json"),
      "x".repeat(1_048_577),
      "utf8",
    );

    await expect(
      resolveVaultIdentity(
        "linux",
        "Synthetic vault",
        vault,
        { XDG_CONFIG_HOME: configRoot },
        sandbox,
      ),
    ).rejects.toThrow("troppo grande");
  });

  it("atomically writes and reads only the requested vault entry", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      {
        accessMode: "protected",
        managementPermissions: noManagement,
        enabled: true,
        readMode: "folders",
        readFolders: ["Projects"],
        writeEnabled: true,
        writeFolders: ["Projects"],
      },
    );

    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toEqual({
      accessMode: "protected",
      managementPermissions: noManagement,
      enabled: true,
      readMode: "folders",
      readFolders: ["Projects"],
      writeEnabled: true,
      writeFolders: ["Projects"],
    });
    expect(JSON.parse(await readFile(settingsFile, "utf8"))).toMatchObject({
      version: 4,
      vaults: {
        "0123456789abcdef": { accessMode: "protected" },
      },
    });
  });

  it("migrates every version-2 vault to protected mode before saving version 4", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    await mkdir(join(configRoot, "ObsidianBridge"), { recursive: true });
    await writeFile(
      settingsFile,
      `${JSON.stringify({
        version: 2,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          fedcba9876543210: {
            vaultName: "Existing vault",
            vaultPath: vault,
            enabled: true,
            readMode: "folders",
            readFolders: ["Archive"],
            writeEnabled: false,
            writeFolders: [],
          },
        },
      })}\n`,
      "utf8",
    );

    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      {
        accessMode: "full",
        managementPermissions: noManagement,
        enabled: true,
        readMode: "off",
        readFolders: [],
        writeEnabled: false,
        writeFolders: [],
      },
      { fullAccessConfirmed: true },
    );

    const stored = JSON.parse(await readFile(settingsFile, "utf8")) as {
      version: number;
      vaults: Record<string, { accessMode: string }>;
    };
    expect(stored.version).toBe(4);
    expect(stored.vaults.fedcba9876543210?.accessMode).toBe("protected");
    expect(stored.vaults["0123456789abcdef"]?.accessMode).toBe("full");
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({ accessMode: "full" });
  });

  it("migrates version-3 full access without granting management permissions", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    await mkdir(join(configRoot, "ObsidianBridge"), { recursive: true });
    await writeFile(
      settingsFile,
      `${JSON.stringify({
        version: 3,
        updatedAt: "2026-07-11T10:00:00.000Z",
        vaults: {
          "0123456789abcdef": {
            vaultName: "Synthetic vault",
            vaultPath: vault,
            accessMode: "full",
            enabled: true,
            readMode: "off",
            readFolders: [],
            writeEnabled: false,
            writeFolders: [],
          },
        },
      })}\n`,
      "utf8",
    );

    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({
      accessMode: "full",
      managementPermissions: noManagement,
    });

    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      {
        accessMode: "full",
        managementPermissions: noManagement,
        enabled: true,
        readMode: "off",
        readFolders: [],
        writeEnabled: false,
        writeFolders: [],
      },
    );
    const stored = JSON.parse(await readFile(settingsFile, "utf8")) as {
      version: number;
      vaults: Record<string, { managementPermissions: unknown }>;
    };
    expect(stored.version).toBe(4);
    expect(stored.vaults["0123456789abcdef"]?.managementPermissions).toEqual(
      noManagement,
    );
  });

  it("requires an exact acknowledgement for management activation and permission increases", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const protectedSettings = {
      accessMode: "protected" as const,
      managementPermissions: noManagement,
      enabled: true,
      readMode: "folders" as const,
      readFolders: ["Projects"],
      writeEnabled: true,
      writeFolders: ["Projects"],
    };
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      protectedSettings,
    );
    const editOnly = {
      ...protectedSettings,
      accessMode: "management" as const,
      managementPermissions: { edit: true, move: false, trash: false },
    };

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        editOnly,
      ),
    ).rejects.toThrow("Gestione completa");
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        editOnly,
        {
          managementPermissionsConfirmed: {
            edit: true,
            move: true,
            trash: false,
          },
        },
      ),
    ).rejects.toThrow("stessi permessi");

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        editOnly,
        { managementPermissionsConfirmed: editOnly.managementPermissions },
      ),
    ).resolves.toMatchObject({ settings: editOnly });

    const editAndMove = {
      ...editOnly,
      managementPermissions: { edit: true, move: true, trash: false },
    };
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        editAndMove,
      ),
    ).rejects.toThrow("Gestione completa");
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        editAndMove,
        { managementPermissionsConfirmed: editAndMove.managementPermissions },
      ),
    ).resolves.toMatchObject({
      settings: { accessMode: "management", managementPermissions: editAndMove.managementPermissions },
    });

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        {
          ...editAndMove,
          accessMode: "full",
          managementPermissions: noManagement,
        },
      ),
    ).resolves.toMatchObject({
      settings: { accessMode: "full", managementPermissions: noManagement },
    });
  });

  it("never restores a revoked management permission after verification fails", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const managementSettings = {
      accessMode: "management" as const,
      managementPermissions: { edit: true, move: true, trash: false },
      enabled: true,
      readMode: "off" as const,
      readFolders: [],
      writeEnabled: false,
      writeFolders: [],
    };
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      managementSettings,
      { managementPermissionsConfirmed: managementSettings.managementPermissions },
    );

    const reduced = {
      ...managementSettings,
      managementPermissions: { edit: false, move: true, trash: false },
    };
    const result = await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      reduced,
      {
        testAfterWrite: async (attempt) => {
          if (attempt === "primary") await writeFile(settingsFile, "not json", "utf8");
        },
      },
    );
    expect(result.warning).toContain("revoca/riduzione");
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({ managementPermissions: reduced.managementPermissions });

    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      { ...reduced, enabled: false },
    );
    const dormantRevocation = await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      {
        ...reduced,
        accessMode: "full",
        managementPermissions: noManagement,
        enabled: false,
      },
      {
        testAfterWrite: async (attempt) => {
          if (attempt === "primary") await writeFile(settingsFile, "not json", "utf8");
        },
      },
    );
    expect(dormantRevocation.warning).toContain("revoca/riduzione");
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({
      accessMode: "full",
      managementPermissions: noManagement,
      enabled: false,
    });
  });

  it("rejects dormant or empty management permission combinations in version 4", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    await mkdir(join(configRoot, "ObsidianBridge"), { recursive: true });
    const base = {
      vaultName: "Synthetic vault",
      vaultPath: vault,
      enabled: true,
      readMode: "off",
      readFolders: [],
      writeEnabled: false,
      writeFolders: [],
    };
    for (const invalidEntry of [
      {
        ...base,
        accessMode: "full",
        managementPermissions: { edit: true, move: false, trash: false },
      },
      {
        ...base,
        accessMode: "management",
        managementPermissions: noManagement,
      },
    ]) {
      await writeFile(
        settingsFile,
        `${JSON.stringify({
          version: 4,
          updatedAt: "2026-07-12T10:00:00.000Z",
          vaults: { "0123456789abcdef": invalidEntry },
        })}\n`,
        "utf8",
      );
      await expect(
        readVaultSettings(settingsFile, "0123456789abcdef"),
      ).rejects.toThrow("Configurazione non valida");
    }
  });

  it("checks protected-to-full transitions against current shared state under lock", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const protectedSettings = {
      accessMode: "protected" as const,
      managementPermissions: noManagement,
      enabled: true,
      readMode: "folders" as const,
      readFolders: ["Projects"],
      writeEnabled: true,
      writeFolders: ["Projects"],
    };
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      protectedSettings,
    );

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        { ...protectedSettings, accessMode: "full" },
      ),
    ).rejects.toThrow("finestra di conferma dedicata");
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({ accessMode: "protected" });

    const activated = await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      { ...protectedSettings, accessMode: "full" },
      { fullAccessConfirmed: true },
    );
    expect(activated).toMatchObject({
      settings: { accessMode: "full" },
      lockReleased: true,
    });

    // Once the authoritative shared policy is full, ordinary panel saves may
    // update its enabled state without repeating the one-time warning.
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        { ...protectedSettings, accessMode: "full", enabled: false },
      ),
    ).resolves.toMatchObject({ settings: { accessMode: "full", enabled: false } });
  });

  it("never restores a more permissive full policy after revocation verification fails", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const fullSettings = {
      accessMode: "full" as const,
      managementPermissions: noManagement,
      enabled: true,
      readMode: "off" as const,
      readFolders: [],
      writeEnabled: false,
      writeFolders: [],
    };
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      fullSettings,
      { fullAccessConfirmed: true },
    );

    const result = await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      { ...fullSettings, accessMode: "protected" },
      {
        testAfterWrite: async (attempt) => {
          if (attempt === "primary") await writeFile(settingsFile, "not json", "utf8");
        },
      },
    );
    expect(result.warning).toContain("revoca/riduzione");
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({ accessMode: "protected", enabled: true });

    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      fullSettings,
      { fullAccessConfirmed: true },
    );
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        { ...fullSettings, enabled: false },
        {
          testAfterWrite: async (attempt) => {
            if (attempt === "primary") {
              await writeFile(settingsFile, "not json", "utf8");
            }
          },
        },
      ),
    ).resolves.toMatchObject({ settings: { accessMode: "full", enabled: false } });
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toMatchObject({ accessMode: "full", enabled: false });
  });

  it("restores the prior protected policy when a full activation cannot be verified", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const protectedSettings = {
      accessMode: "protected" as const,
      managementPermissions: noManagement,
      enabled: true,
      readMode: "folders" as const,
      readFolders: ["Projects"],
      writeEnabled: false,
      writeFolders: [],
    };
    await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      protectedSettings,
    );

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        { ...protectedSettings, accessMode: "full" },
        {
          fullAccessConfirmed: true,
          testAfterWrite: async () => {
            await writeFile(settingsFile, "not json", "utf8");
          },
        },
      ),
    ).rejects.toThrow();
    await expect(
      readVaultSettings(settingsFile, "0123456789abcdef"),
    ).resolves.toEqual(protectedSettings);
  });

  it("does not reclaim an existing lock and reports lost ownership on release", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    const lockPath = `${settingsFile}.lock`;
    await mkdir(lockPath, { recursive: true });
    const existingOwner = {
      token: "00000000-0000-4000-8000-000000000001",
      pid: 999,
      createdAt: "2026-07-12T08:00:00.000Z",
    };
    await writeFile(join(lockPath, "owner.json"), JSON.stringify(existingOwner), "utf8");
    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        {
          accessMode: "protected",
          managementPermissions: noManagement,
          enabled: false,
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        },
        { testLockWaitMs: 100 },
      ),
    ).rejects.toThrow("Configurazione occupata");
    await expect(readFile(join(lockPath, "owner.json"), "utf8")).resolves.toBe(
      JSON.stringify(existingOwner),
    );

    await rm(lockPath, { recursive: true, force: true });
    const released = await mergeVaultSettings(
      settingsFile,
      "0123456789abcdef",
      "Synthetic vault",
      vault,
      {
        accessMode: "protected",
        managementPermissions: noManagement,
        enabled: false,
        readMode: "off",
        readFolders: [],
        writeEnabled: false,
        writeFolders: [],
      },
      {
        testBeforeRelease: async () => {
          await writeFile(
            join(lockPath, "owner.json"),
            JSON.stringify({
              token: "00000000-0000-4000-8000-000000000002",
              pid: 999,
              createdAt: "2026-07-12T08:00:00.000Z",
            }),
            "utf8",
          );
        },
      },
    );
    expect(released).toMatchObject({ lockReleased: false });
    expect(released.warning).toContain("lock locale non è stato rilasciato");
  });

  it("does not overwrite malformed existing shared settings", async () => {
    const settingsFile = join(configRoot, "ObsidianBridge", "settings.json");
    await mkdir(join(configRoot, "ObsidianBridge"), { recursive: true });
    await writeFile(settingsFile, "not json", "utf8");

    await expect(
      mergeVaultSettings(
        settingsFile,
        "0123456789abcdef",
        "Synthetic vault",
        vault,
        {
          accessMode: "protected",
          managementPermissions: noManagement,
          enabled: true,
          readMode: "off",
          readFolders: [],
          writeEnabled: false,
          writeFolders: [],
        },
      ),
    ).rejects.toThrow("JSON non valido");
    await expect(readFile(settingsFile, "utf8")).resolves.toBe("not json");
  });

  it("accepts only an explicit absolute environment override", () => {
    const absolute = join(sandbox, "admin", "settings.json");
    expect(
      sharedSettingsPath(
        "linux",
        { OBSIDIAN_BRIDGE_SETTINGS_PATH: absolute },
        sandbox,
      ),
    ).toBe(absolute);
    expect(() =>
      sharedSettingsPath(
        "linux",
        { OBSIDIAN_BRIDGE_SETTINGS_PATH: "relative.json" },
        sandbox,
      ),
    ).toThrow("percorso assoluto");
  });
});
