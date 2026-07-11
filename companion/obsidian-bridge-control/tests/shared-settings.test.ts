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
      enabled: true,
      readMode: "folders",
      readFolders: ["Projects"],
      writeEnabled: true,
      writeFolders: ["Projects"],
    });
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
