import os from "node:os";
import path from "node:path";
import { statSync } from "node:fs";

export const DEFAULT_DENIED_FOLDERS = [".obsidian", ".trash"] as const;
export const DEFAULT_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;
export const DEFAULT_CHANGE_TTL_MS = 300_000;

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 60_000;
const MIN_OUTPUT_BYTES = 4_096;
const MAX_OUTPUT_BYTES = 10_485_760;
const MIN_CHANGE_TTL_MS = 60_000;
const MAX_CHANGE_TTL_MS = 1_800_000;

export interface BridgeConfig {
  readonly executable: string;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly allowedFolders: readonly string[] | null;
  /** True only when the legacy read allowlist variable was explicitly set. */
  readonly readEnvironmentConfigured?: boolean;
  readonly deniedFolders: readonly string[];
  /** Empty is intentional: no vault is writable until explicitly configured. */
  readonly writableVaults?: readonly string[];
  /** Empty is intentional: write access is denied until explicitly configured. */
  readonly writableFolders?: readonly string[];
  readonly changeTtlMs?: number;
  readonly dataDirectory?: string;
  /** Shared GUI configuration read afresh for every vault-scoped tool call. */
  readonly settingsPath?: string;
}

/** Parse the documented comma-separated vault-relative folder list. */
export function parseFolderList(value: string | undefined): string[] {
  if (value === undefined || value.trim() === "") {
    return [];
  }

  return value
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
}

export function parseBoundedInteger(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
  variableName: string,
): number {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  if (!/^\d+$/.test(value.trim())) {
    throw new Error(`${variableName} must be an integer`);
  }

  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${variableName} must be between ${minimum} and ${maximum}`);
  }

  return parsed;
}

export function validateVault(value: string): string {
  if (typeof value !== "string") {
    throw new TypeError("vault must be a string");
  }

  const vault = value.trim().normalize("NFC");
  if (vault.length === 0 || vault.length > 256) {
    throw new Error("vault must contain between 1 and 256 characters");
  }
  if (/[\u0000-\u001f\u007f]/u.test(vault)) {
    throw new Error("vault must not contain control characters");
  }

  return vault;
}

function defaultDataDirectory(env: NodeJS.ProcessEnv): string {
  const pluginData = env.PLUGIN_DATA?.trim();
  if (pluginData !== undefined && pluginData.length > 0) {
    if (!path.isAbsolute(pluginData)) {
      throw new Error("PLUGIN_DATA must be an absolute path");
    }
    return path.join(pluginData, "obsidian-bridge");
  }

  if (process.platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    if (localAppData !== undefined && localAppData.length > 0) {
      return path.join(localAppData, "obsidian-bridge");
    }
  }

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "obsidian-bridge");
  }

  const xdgDataHome = env.XDG_DATA_HOME?.trim();
  return path.join(
    xdgDataHome !== undefined && xdgDataHome.length > 0
      ? xdgDataHome
      : path.join(os.homedir(), ".local", "share"),
    "obsidian-bridge",
  );
}

function resolveDataDirectory(env: NodeJS.ProcessEnv): string {
  const override = env.OBSIDIAN_BRIDGE_DATA_DIR?.trim();
  const value =
    override !== undefined && override.length > 0
      ? override
      : defaultDataDirectory(env);
  if (!path.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("OBSIDIAN_BRIDGE_DATA_DIR must be an absolute path");
  }
  return path.resolve(value);
}

export function defaultSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;

  if (platform === "win32") {
    const localAppData = env.LOCALAPPDATA?.trim();
    return pathApi.join(
      localAppData !== undefined && localAppData.length > 0
        ? localAppData
        : pathApi.join(homeDirectory, "AppData", "Local"),
      "ObsidianBridge",
      "settings.json",
    );
  }

  if (platform === "darwin") {
    return pathApi.join(
      homeDirectory,
      "Library",
      "Application Support",
      "ObsidianBridge",
      "settings.json",
    );
  }

  const xdgConfigHome = env.XDG_CONFIG_HOME?.trim();
  return pathApi.join(
    xdgConfigHome !== undefined && xdgConfigHome.length > 0
      ? xdgConfigHome
      : pathApi.join(homeDirectory, ".config"),
    "ObsidianBridge",
    "settings.json",
  );
}

export function resolveSettingsPath(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  homeDirectory: string = os.homedir(),
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const override = env.OBSIDIAN_BRIDGE_SETTINGS_PATH?.trim();
  const value =
    override !== undefined && override.length > 0
      ? override
      : defaultSettingsPath(env, platform, homeDirectory);
  if (!pathApi.isAbsolute(value) || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new Error("OBSIDIAN_BRIDGE_SETTINGS_PATH must be an absolute path");
  }
  return pathApi.resolve(value);
}

export function detectObsidianExecutable(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
  isRegularFile: (candidate: string) => boolean = (candidate) => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
): string {
  const pathApi = platform === "win32" ? path.win32 : path.posix;
  const configured = env.OBSIDIAN_CLI_PATH?.trim();
  if (configured !== undefined && configured.length > 0) {
    if (
      !pathApi.isAbsolute(configured) ||
      /[\u0000-\u001f\u007f]/u.test(configured)
    ) {
      throw new Error("OBSIDIAN_CLI_PATH must be an absolute path");
    }

    const normalized = pathApi.normalize(configured);
    if (!isRegularFile(normalized)) {
      throw new Error("OBSIDIAN_CLI_PATH must point to a regular file");
    }
    return normalized;
  }

  if (platform === "win32") {
    const candidates: string[] = [];
    for (const base of [env.ProgramFiles, env["ProgramFiles(x86)"]]) {
      const trimmed = base?.trim();
      if (
        trimmed !== undefined &&
        trimmed.length > 0 &&
        path.win32.isAbsolute(trimmed) &&
        !/[\u0000-\u001f\u007f]/u.test(trimmed)
      ) {
        candidates.push(
          path.win32.join(trimmed, "Obsidian", "Obsidian.com"),
        );
      }
    }
    const localAppData = env.LOCALAPPDATA?.trim();
    if (
      localAppData !== undefined &&
      localAppData.length > 0 &&
      path.win32.isAbsolute(localAppData) &&
      !/[\u0000-\u001f\u007f]/u.test(localAppData)
    ) {
      candidates.push(
        path.win32.join(
          localAppData,
          "Programs",
          "Obsidian",
          "Obsidian.com",
        ),
        path.win32.join(localAppData, "Obsidian", "Obsidian.com"),
      );
    }

    const detected = candidates.find((candidate) => isRegularFile(candidate));
    if (detected !== undefined) return detected;

    throw new Error(
      "Obsidian CLI executable not found; install/enable the official CLI or set OBSIDIAN_CLI_PATH to its absolute path",
    );
  }

  const homeDirectory = env.HOME?.trim();
  const candidates =
    platform === "darwin"
      ? [
          "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli",
          ...(homeDirectory !== undefined &&
          homeDirectory.length > 0 &&
          path.posix.isAbsolute(homeDirectory)
            ? [
                path.posix.join(
                  homeDirectory,
                  "Applications",
                  "Obsidian.app",
                  "Contents",
                  "MacOS",
                  "obsidian-cli",
                ),
              ]
            : []),
        ]
      : [
          "/usr/local/bin/obsidian",
          "/usr/bin/obsidian",
          "/opt/Obsidian/obsidian",
        ];
  const detected = candidates.find((candidate) => isRegularFile(candidate));
  if (detected !== undefined) return detected;

  // Preserve the conventional PATH-based CLI on POSIX systems, where package
  // managers commonly install an `obsidian` launcher or symlink.
  return "obsidian";
}

export function loadBridgeConfig(
  env: NodeJS.ProcessEnv = process.env,
): BridgeConfig {
  const executable = detectObsidianExecutable(env).trim();
  if (executable.length === 0 || /[\u0000-\u001f\u007f]/u.test(executable)) {
    throw new Error("OBSIDIAN_CLI_PATH is invalid");
  }

  const legacyReadValue = env.OBSIDIAN_BRIDGE_ALLOWED_FOLDERS?.trim();
  const legacyReadAll = legacyReadValue === "*";
  const allowed = legacyReadAll
    ? []
    : parseFolderList(env.OBSIDIAN_BRIDGE_ALLOWED_FOLDERS);
  const additionalDenied = parseFolderList(env.OBSIDIAN_BRIDGE_DENIED_FOLDERS);
  const writableVaults = parseFolderList(
    env.OBSIDIAN_BRIDGE_WRITABLE_VAULTS,
  ).map(validateVault);
  const writable = parseFolderList(env.OBSIDIAN_BRIDGE_WRITABLE_FOLDERS);

  return Object.freeze({
    executable,
    timeoutMs: parseBoundedInteger(
      env.OBSIDIAN_BRIDGE_TIMEOUT_MS,
      DEFAULT_TIMEOUT_MS,
      MIN_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
      "OBSIDIAN_BRIDGE_TIMEOUT_MS",
    ),
    maxOutputBytes: parseBoundedInteger(
      env.OBSIDIAN_BRIDGE_MAX_OUTPUT_BYTES,
      DEFAULT_MAX_OUTPUT_BYTES,
      MIN_OUTPUT_BYTES,
      MAX_OUTPUT_BYTES,
      "OBSIDIAN_BRIDGE_MAX_OUTPUT_BYTES",
    ),
    allowedFolders:
      legacyReadAll || allowed.length === 0 ? null : Object.freeze(allowed),
    readEnvironmentConfigured: legacyReadAll || allowed.length > 0,
    deniedFolders: Object.freeze([
      ...DEFAULT_DENIED_FOLDERS,
      ...additionalDenied,
    ]),
    writableVaults: Object.freeze([...new Set(writableVaults)]),
    writableFolders: Object.freeze(writable),
    changeTtlMs: parseBoundedInteger(
      env.OBSIDIAN_BRIDGE_CHANGE_TTL_MS,
      DEFAULT_CHANGE_TTL_MS,
      MIN_CHANGE_TTL_MS,
      MAX_CHANGE_TTL_MS,
      "OBSIDIAN_BRIDGE_CHANGE_TTL_MS",
    ),
    dataDirectory: resolveDataDirectory(env),
    settingsPath: resolveSettingsPath(env),
  });
}
