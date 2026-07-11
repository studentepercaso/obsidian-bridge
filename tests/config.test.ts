import { describe, expect, it } from "vitest";
import { resolve } from "node:path";

import {
  DEFAULT_CHANGE_TTL_MS,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  loadBridgeConfig as loadBridgeConfigRaw,
  defaultSettingsPath,
  detectObsidianExecutable,
  parseBoundedInteger,
  parseFolderList,
  validateVault,
} from "../src/config.js";

function loadBridgeConfig(env: NodeJS.ProcessEnv = {}) {
  return loadBridgeConfigRaw({ OBSIDIAN_CLI_PATH: process.execPath, ...env });
}

describe("bridge configuration", () => {
  it("parses comma-separated allowlists and denylists without inventing entries", () => {
    expect(parseFolderList(" Projects , Journal/Daily ,, ")).toEqual([
      "Projects",
      "Journal/Daily",
    ]);

    const config = loadBridgeConfig({
      OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects,Journal/Daily",
      OBSIDIAN_BRIDGE_DENIED_FOLDERS: "Projects/Private,Journal/Templates",
    });
    expect(config.allowedFolders).toEqual(["Projects", "Journal/Daily"]);
    expect(config.deniedFolders).toEqual([
      ".obsidian",
      ".trash",
      "Projects/Private",
      "Journal/Templates",
    ]);
  });

  it("requires an explicit legacy read scope and uses star for full-vault access", () => {
    const absent = loadBridgeConfig({});
    const empty = loadBridgeConfig({ OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "" });
    const all = loadBridgeConfig({ OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "*" });

    expect(absent.readEnvironmentConfigured).toBe(false);
    expect(empty.readEnvironmentConfigured).toBe(false);
    expect(all.readEnvironmentConfigured).toBe(true);
    expect(all.allowedFolders).toBeNull();
  });

  it("keeps write scope disabled by default and separate when configured", () => {
    const disabled = loadBridgeConfig({
      OBSIDIAN_BRIDGE_DATA_DIR: resolve("test-data"),
    });
    expect(disabled.writableVaults).toEqual([]);
    expect(disabled.writableFolders).toEqual([]);

    const configured = loadBridgeConfig({
      OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects",
      OBSIDIAN_BRIDGE_WRITABLE_VAULTS: "Test Vault,vault-id-2,Test Vault",
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects/Editable",
      OBSIDIAN_BRIDGE_DATA_DIR: resolve("test-data"),
    });
    expect(configured.allowedFolders).toEqual(["Projects"]);
    expect(configured.writableVaults).toEqual(["Test Vault", "vault-id-2"]);
    expect(configured.writableFolders).toEqual(["Projects/Editable"]);
  });

  it("bounds change TTL and requires an absolute data directory", () => {
    const config = loadBridgeConfig({
      OBSIDIAN_BRIDGE_DATA_DIR: resolve("test-data"),
    });
    expect(config.changeTtlMs).toBe(DEFAULT_CHANGE_TTL_MS);

    expect(() =>
      loadBridgeConfig({
        OBSIDIAN_BRIDGE_CHANGE_TTL_MS: "59999",
        OBSIDIAN_BRIDGE_DATA_DIR: resolve("test-data"),
      }),
    ).toThrow("between");
    expect(() =>
      loadBridgeConfig({
        OBSIDIAN_BRIDGE_CHANGE_TTL_MS: "1800001",
        OBSIDIAN_BRIDGE_DATA_DIR: resolve("test-data"),
      }),
    ).toThrow("between");
    expect(() =>
      loadBridgeConfig({ OBSIDIAN_BRIDGE_DATA_DIR: "relative/data" }),
    ).toThrow("absolute path");
  });

  it("uses bounded timeout and output defaults", () => {
    const config = loadBridgeConfig({});
    expect(config.timeoutMs).toBe(DEFAULT_TIMEOUT_MS);
    expect(config.maxOutputBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);

    expect(() =>
      loadBridgeConfig({ OBSIDIAN_BRIDGE_TIMEOUT_MS: "999" }),
    ).toThrow("between");
    expect(() =>
      loadBridgeConfig({ OBSIDIAN_BRIDGE_MAX_OUTPUT_BYTES: "10485761" }),
    ).toThrow("between");
    expect(() =>
      parseBoundedInteger("1.5", 10, 1, 20, "TEST_LIMIT"),
    ).toThrow("integer");
  });

  it("rejects empty/control-character vaults but permits shell metacharacters as data", () => {
    expect(() => validateVault("  ")).toThrow();
    expect(() => validateVault("bad\nvault")).toThrow();
    expect(() => validateVault("x".repeat(257))).toThrow();
    expect(validateVault("Research & Development; 2026")).toBe(
      "Research & Development; 2026",
    );
  });

  it("resolves the shared settings path on each supported platform", () => {
    expect(
      defaultSettingsPath(
        { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        "win32",
        "C:\\Users\\Ada",
      ),
    ).toBe(
      resolve(
        "C:\\Users\\Ada\\AppData\\Local",
        "ObsidianBridge",
        "settings.json",
      ),
    );
    expect(
      defaultSettingsPath({}, "darwin", "/Users/ada").replaceAll("\\", "/"),
    ).toBe(
      "/Users/ada/Library/Application Support/ObsidianBridge/settings.json",
    );
    expect(
      defaultSettingsPath(
        { XDG_CONFIG_HOME: "/custom/config" },
        "linux",
        "/home/ada",
      ).replaceAll("\\", "/"),
    ).toBe("/custom/config/ObsidianBridge/settings.json");

    const override = resolve("custom-settings.json");
    expect(
      loadBridgeConfig({ OBSIDIAN_BRIDGE_SETTINGS_PATH: override }).settingsPath,
    ).toBe(override);
    expect(() =>
      loadBridgeConfig({ OBSIDIAN_BRIDGE_SETTINGS_PATH: "relative.json" }),
    ).toThrow("absolute path");
  });

  it("accepts only an absolute regular-file CLI override", () => {
    const explicit =
      process.platform === "win32"
        ? "C:\\Tools\\Obsidian.com"
        : "/opt/obsidian/obsidian";

    expect(
      detectObsidianExecutable(
        { OBSIDIAN_CLI_PATH: explicit },
        process.platform,
        (candidate) => candidate === explicit,
      ),
    ).toBe(explicit);
    expect(() =>
      detectObsidianExecutable(
        { OBSIDIAN_CLI_PATH: "explicit-cli" },
        process.platform,
        () => true,
      ),
    ).toThrow("absolute path");
    expect(() =>
      detectObsidianExecutable(
        { OBSIDIAN_CLI_PATH: explicit },
        process.platform,
        () => false,
      ),
    ).toThrow("regular file");
  });

  it("auto-detects only regular Windows Obsidian.com files", () => {
    const programFilesCandidate = "C:\\Program Files\\Obsidian\\Obsidian.com";
    const localCandidate =
      "C:\\Users\\Ada\\AppData\\Local\\Programs\\Obsidian\\Obsidian.com";
    expect(
      detectObsidianExecutable(
        {
          ProgramFiles: "C:\\Program Files",
          LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        },
        "win32",
        (candidate) => candidate === programFilesCandidate,
      ),
    ).toBe(programFilesCandidate);
    expect(
      detectObsidianExecutable(
        { LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local" },
        "win32",
        (candidate) => candidate === localCandidate,
      ),
    ).toBe(localCandidate);
    expect(() =>
      detectObsidianExecutable(
        {
          ProgramFiles: "C:\\Program Files",
          LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
        },
        "win32",
        () => false,
      ),
    ).toThrow("executable not found");
    expect(() =>
      detectObsidianExecutable(
        { ProgramFiles: "relative-program-files" },
        "win32",
        () => true,
      ),
    ).toThrow("executable not found");
  });

  it("prefers a validated absolute POSIX candidate while retaining PATH compatibility", () => {
    expect(
      detectObsidianExecutable(
        {},
        "linux",
        (candidate) => candidate === "/usr/local/bin/obsidian",
      ),
    ).toBe("/usr/local/bin/obsidian");
    expect(detectObsidianExecutable({}, "linux", () => false)).toBe(
      "obsidian",
    );
  });
});
