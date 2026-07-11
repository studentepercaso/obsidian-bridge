import { execFile } from "node:child_process";
import { constants } from "node:fs";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rm,
  rename,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize } from "node:path";
import { randomUUID } from "node:crypto";
import { cliReportsDisabled, cliReportsVersion } from "./cli-status";

export type DesktopPlatform = "windows" | "macos" | "linux";
export type ReadMode = "off" | "all" | "folders";

export interface VaultBridgeSettings {
  enabled: boolean;
  readMode: ReadMode;
  readFolders: string[];
  writeEnabled: boolean;
  writeFolders: string[];
}

export interface SharedSettingsFile {
  version: 2;
  updatedAt: string;
  vaults: Record<string, SharedVaultSettings>;
}

export interface SharedVaultSettings extends VaultBridgeSettings {
  vaultName: string;
  vaultPath: string;
}

export interface VaultIdentity {
  id: string;
  name: string;
  path: string;
}

export interface FolderListResult {
  folders: string[];
  errors: string[];
}

export interface CliCandidate {
  path: string;
  source: string;
  exists: boolean;
}

export interface CliDiagnostic {
  state: "ready" | "missing" | "error";
  checkedAt: string;
  executable?: string;
  version?: string;
  detail: string;
  candidates: CliCandidate[];
}

const SHARED_SETTINGS_MAX_BYTES = 64 * 1024;
const LOCK_WAIT_MS = 3_000;
const LOCK_STALE_MS = 30_000;
const VAULT_ID = /^[0-9a-f]{16}$/u;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === "string" ? error.code : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function sharedSettingsPath(
  platform: DesktopPlatform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): string {
  const override = env.OBSIDIAN_BRIDGE_SETTINGS_PATH?.trim();
  if (override) {
    if (!isAbsolute(override) || /[\u0000-\u001f\u007f]/u.test(override)) {
      throw new Error("OBSIDIAN_BRIDGE_SETTINGS_PATH deve essere un percorso assoluto valido.");
    }
    return normalize(override);
  }
  if (platform === "windows") {
    const localAppData = env.LOCALAPPDATA?.trim() || join(home, "AppData", "Local");
    return join(localAppData, "ObsidianBridge", "settings.json");
  }

  if (platform === "macos") {
    return join(home, "Library", "Application Support", "ObsidianBridge", "settings.json");
  }

  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configRoot, "ObsidianBridge", "settings.json");
}

export function normalizeVaultFolder(input: string): string {
  const normalized = input.trim().replace(/\\/g, "/").normalize("NFC");

  if (!normalized) {
    throw new Error("La cartella non può essere vuota.");
  }
  if (/^[a-zA-Z]:/.test(normalized) || normalized.startsWith("/")) {
    throw new Error("Usa un percorso relativo alla radice del vault.");
  }
  if (/[\u0000-\u001f\u007f]/u.test(normalized)) {
    throw new Error("Il percorso contiene caratteri di controllo non validi.");
  }

  const segments = normalized.split("/").filter((segment) => segment.length > 0);
  if (segments.length === 0) {
    throw new Error("La cartella non può essere vuota.");
  }

  for (const segment of segments) {
    if (segment === "." || segment === "..") {
      throw new Error("I segmenti . e .. non sono consentiti.");
    }
    if (segment.startsWith(".")) {
      throw new Error("Le cartelle nascoste, inclusi .obsidian e .trash, non sono consentite.");
    }
  }

  return segments.join("/");
}

export function parseFolderList(value: string): FolderListResult {
  const folders: string[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();

  for (const rawItem of value.split(/\r?\n/u)) {
    if (!rawItem.trim()) continue;
    try {
      const folder = normalizeVaultFolder(rawItem);
      if (!seen.has(folder)) {
        seen.add(folder);
        folders.push(folder);
      }
    } catch (error) {
      errors.push(`“${rawItem.trim()}”: ${errorMessage(error)}`);
    }
  }

  return { folders, errors };
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateFolders(value: unknown): string[] | undefined {
  if (!Array.isArray(value) || value.length > 256) return undefined;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || item.length > 1_024) return undefined;
    try {
      const normalizedFolder = normalizeVaultFolder(item);
      if (normalizedFolder !== item || seen.has(normalizedFolder)) return undefined;
      seen.add(normalizedFolder);
      result.push(normalizedFolder);
    } catch {
      return undefined;
    }
  }
  return result;
}

function validateVaultEntry(value: unknown): SharedVaultSettings | undefined {
  if (!isRecord(value)) return undefined;
  if (!hasExactKeys(value, [
    "vaultName",
    "vaultPath",
    "enabled",
    "readMode",
    "readFolders",
    "writeEnabled",
    "writeFolders",
  ])) return undefined;
  if (
    typeof value.vaultName !== "string" ||
    value.vaultName.length === 0 ||
    value.vaultName.length > 256 ||
    value.vaultName !== value.vaultName.trim().normalize("NFC") ||
    /[\u0000-\u001f\u007f]/u.test(value.vaultName)
  ) return undefined;
  if (
    typeof value.vaultPath !== "string" ||
    value.vaultPath.length > 4_096 ||
    !isAbsolute(value.vaultPath) ||
    /[\u0000-\u001f\u007f]/u.test(value.vaultPath)
  ) return undefined;
  if (typeof value.enabled !== "boolean") return undefined;
  if (value.readMode !== "off" && value.readMode !== "all" && value.readMode !== "folders") {
    return undefined;
  }
  const readFolders = validateFolders(value.readFolders);
  const writeFolders = validateFolders(value.writeFolders);
  if (readFolders === undefined || writeFolders === undefined) return undefined;
  if (typeof value.writeEnabled !== "boolean") return undefined;

  return {
    vaultName: value.vaultName,
    vaultPath: normalize(value.vaultPath),
    enabled: value.enabled,
    readMode: value.readMode,
    readFolders,
    writeEnabled: value.writeEnabled,
    writeFolders,
  };
}

async function readSharedRoot(filePath: string): Promise<SharedSettingsFile | undefined> {
  let handle;
  try {
    const linkStat = await lstat(filePath);
    if (linkStat.isSymbolicLink()) {
      throw new Error("Il file condiviso non può essere un collegamento simbolico.");
    }
    handle = await open(
      filePath,
      process.platform === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }

  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile()) throw new Error("Il percorso condiviso non è un file regolare.");
    if (fileStat.size > SHARED_SETTINGS_MAX_BYTES) {
      throw new Error("Il file condiviso supera il limite di 64 KiB.");
    }
    const text = await handle.readFile("utf8");
    if (Buffer.byteLength(text, "utf8") > SHARED_SETTINGS_MAX_BYTES) {
      throw new Error("Il file condiviso supera il limite di 64 KiB.");
    }
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed) || !hasExactKeys(parsed, ["version", "updatedAt", "vaults"])) {
      throw new Error("Il file condiviso non rispetta lo schema previsto.");
    }
    if (parsed.version !== 2) {
      throw new Error(`Versione del file condiviso non supportata: ${String(parsed.version)}.`);
    }
    if (
      typeof parsed.updatedAt !== "string" ||
      parsed.updatedAt.length === 0 ||
      parsed.updatedAt.length > 64 ||
      !Number.isFinite(Date.parse(parsed.updatedAt))
    ) throw new Error("La data del file condiviso non è valida.");
    if (!isRecord(parsed.vaults) || Object.keys(parsed.vaults).length > 256) {
      throw new Error("La sezione vaults del file condiviso non è valida.");
    }

    const vaults: Record<string, SharedVaultSettings> = {};
    for (const [vaultId, rawEntry] of Object.entries(parsed.vaults)) {
      if (!VAULT_ID.test(vaultId)) throw new Error("Il file contiene un ID vault non valido.");
      const entry = validateVaultEntry(rawEntry);
      if (entry === undefined) throw new Error(`Configurazione non valida per il vault ${vaultId}.`);
      vaults[vaultId] = entry;
    }
    return { version: 2, updatedAt: parsed.updatedAt, vaults };
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Il file condiviso contiene JSON non valido; non è stato sovrascritto.");
    }
    throw error;
  } finally {
    await handle.close();
  }
}

async function acquireLock(lockPath: string): Promise<() => Promise<void>> {
  const startedAt = Date.now();
  const token = randomUUID();
  const ownerPath = join(lockPath, "owner.json");

  while (Date.now() - startedAt < LOCK_WAIT_MS) {
    try {
      await mkdir(lockPath, { mode: 0o700 });
      try {
        const owner = await open(ownerPath, "wx", 0o600);
        try {
          await owner.writeFile(
            JSON.stringify({ token, pid: process.pid, createdAt: new Date().toISOString() }),
            "utf8",
          );
          await owner.sync();
        } finally {
          await owner.close();
        }
      } catch (error) {
        await rm(lockPath, { recursive: true, force: true }).catch(() => undefined);
        throw error;
      }
      return async () => {
        try {
          const owner = JSON.parse(await readFile(ownerPath, "utf8")) as { token?: unknown };
          if (owner.token !== token) return;
          const releasePath = `${lockPath}.release-${token}`;
          await rename(lockPath, releasePath);
          await rm(releasePath, { recursive: true, force: true });
        } catch (error) {
          if (errorCode(error) !== "ENOENT") throw error;
        }
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      try {
        const lockStat = await lstat(lockPath);
        if (lockStat.isSymbolicLink() || !lockStat.isDirectory()) {
          throw new Error("Il lock della configurazione non è una directory sicura.");
        }
        if (Date.now() - lockStat.mtimeMs > LOCK_STALE_MS) {
          const stalePath = `${lockPath}.stale-${randomUUID()}`;
          await rename(lockPath, stalePath);
          await rm(stalePath, { recursive: true, force: true });
          continue;
        }
      } catch (lockError) {
        if (errorCode(lockError) !== "ENOENT") throw lockError;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  throw new Error("Configurazione occupata da un altro processo. Riprova tra qualche secondo.");
}

async function writeJsonAtomically(filePath: string, value: SharedSettingsFile): Promise<void> {
  const directory = dirname(filePath);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > SHARED_SETTINGS_MAX_BYTES) {
    throw new Error("La configurazione risultante supera il limite di 64 KiB; il file esistente non è stato modificato.");
  }
  const temporaryPath = join(
    directory,
    `.settings.${process.pid}.${Date.now()}.${randomUUID()}.tmp`,
  );
  let temporaryCreated = false;

  try {
    const handle = await open(temporaryPath, "wx", 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(serialized, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, filePath);
    temporaryCreated = false;
  } finally {
    if (temporaryCreated) await unlink(temporaryPath).catch(() => undefined);
  }
}

export async function mergeVaultSettings(
  filePath: string,
  vaultId: string,
  vaultName: string,
  vaultPath: string,
  settings: VaultBridgeSettings,
): Promise<void> {
  if (!VAULT_ID.test(vaultId)) throw new Error("L'ID stabile del vault non è disponibile.");
  const normalizedName = vaultName.trim().normalize("NFC");
  if (!normalizedName) throw new Error("Il nome del vault non è disponibile.");
  const physicalVaultPath = await realpath(vaultPath);
  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 });
  const release = await acquireLock(`${filePath}.lock`);

  try {
    const existing = await readSharedRoot(filePath);
    const merged: SharedSettingsFile = {
      version: 2,
      updatedAt: new Date().toISOString(),
      vaults: {
        ...(existing?.vaults ?? {}),
        [vaultId]: {
          vaultName: normalizedName,
          vaultPath: physicalVaultPath,
          enabled: settings.enabled,
          readMode: settings.readMode,
          readFolders: [...settings.readFolders],
          writeEnabled: settings.writeEnabled,
          writeFolders: [...settings.writeFolders],
        },
      },
    };
    await writeJsonAtomically(filePath, merged);
  } finally {
    await release();
  }
}

export async function readVaultSettings(
  filePath: string,
  vaultId: string,
): Promise<VaultBridgeSettings | undefined> {
  const root = await readSharedRoot(filePath);
  const entry = root?.vaults[vaultId];
  if (entry === undefined) return undefined;
  return {
    enabled: entry.enabled,
    readMode: entry.readMode,
    readFolders: [...entry.readFolders],
    writeEnabled: entry.writeEnabled,
    writeFolders: [...entry.writeFolders],
  };
}

function registryPath(platform: DesktopPlatform, env: NodeJS.ProcessEnv, home: string): string {
  if (platform === "windows") {
    const appData = env.APPDATA?.trim() || join(home, "AppData", "Roaming");
    return join(appData, "obsidian", "obsidian.json");
  }
  if (platform === "macos") {
    return join(home, "Library", "Application Support", "obsidian", "obsidian.json");
  }
  const configRoot = env.XDG_CONFIG_HOME?.trim() || join(home, ".config");
  return join(configRoot, "obsidian", "obsidian.json");
}

function pathKey(value: string, platform: DesktopPlatform): string {
  const normalizedPath = normalize(value).replace(/[\\/]+$/u, "");
  return platform === "windows" ? normalizedPath.toLowerCase() : normalizedPath;
}

export async function resolveVaultIdentity(
  platform: DesktopPlatform,
  vaultName: string,
  vaultPath: string,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<VaultIdentity> {
  const physicalPath = await realpath(vaultPath);
  const registry = registryPath(platform, env, home);
  let registryHandle;
  try {
    const linkStat = await lstat(registry);
    if (linkStat.isSymbolicLink()) {
      throw new Error("Il registro dei vault Obsidian non può essere un collegamento simbolico.");
    }
    registryHandle = await open(
      registry,
      process.platform === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    throw new Error(
      `Il registro dei vault Obsidian non può essere aperto: ${errorMessage(error)}`,
    );
  }
  let raw: string;
  try {
    const registryStat = await registryHandle.stat();
    if (!registryStat.isFile()) {
      throw new Error("Il registro dei vault Obsidian non è un file regolare.");
    }
    if (registryStat.size > 1_048_576) {
      throw new Error("Il registro dei vault Obsidian è troppo grande.");
    }
    const registryBuffer = Buffer.alloc(1_048_577);
    const { bytesRead } = await registryHandle.read(
      registryBuffer,
      0,
      registryBuffer.byteLength,
      0,
    );
    if (bytesRead > 1_048_576) {
      throw new Error("Il registro dei vault Obsidian è troppo grande.");
    }
    raw = registryBuffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await registryHandle.close();
  }
  const parsed: unknown = JSON.parse(raw);
  if (!isRecord(parsed) || !isRecord(parsed.vaults)) {
    throw new Error("Il registro dei vault Obsidian non è valido.");
  }
  const wanted = pathKey(physicalPath, platform);
  for (const [id, rawEntry] of Object.entries(parsed.vaults)) {
    if (!VAULT_ID.test(id) || !isRecord(rawEntry) || typeof rawEntry.path !== "string") continue;
    const candidates = [rawEntry.path];
    try {
      const decoded = decodeURIComponent(rawEntry.path);
      if (decoded !== rawEntry.path) candidates.push(decoded);
    } catch {
      // Ignore malformed percent escapes and try the literal registry path.
    }
    for (const candidate of candidates) {
      try {
        const candidateReal = await realpath(candidate);
        if (pathKey(candidateReal, platform) === wanted) {
          return {
            id,
            name: vaultName.trim().normalize("NFC"),
            path: physicalPath,
          };
        }
      } catch {
        // Skip stale registry entries.
      }
    }
  }
  throw new Error("Vault non registrato: aprilo in Obsidian e riprova.");
}

function addCandidate(
  target: Array<Omit<CliCandidate, "exists">>,
  candidatePath: string | undefined,
  source: string,
): void {
  const trimmed = candidatePath?.trim().replace(/^"|"$/g, "");
  if (!trimmed || !isAbsolute(trimmed) || /[\u0000-\u001f\u007f]/u.test(trimmed)) return;
  target.push({ path: trimmed, source });
}

function possibleCliPaths(
  platform: DesktopPlatform,
  env: NodeJS.ProcessEnv,
  home: string,
): Array<Omit<CliCandidate, "exists">> {
  const candidates: Array<Omit<CliCandidate, "exists">> = [];
  addCandidate(candidates, env.OBSIDIAN_CLI_PATH, "OBSIDIAN_CLI_PATH");

  if (platform === "windows") {
    for (const root of [env.ProgramFiles, env.ProgramW6432, env["ProgramFiles(x86)"]]) {
      if (root) addCandidate(candidates, join(root, "Obsidian", "Obsidian.com"), "Program Files");
    }
    if (env.LOCALAPPDATA) {
      addCandidate(
        candidates,
        join(env.LOCALAPPDATA, "Programs", "Obsidian", "Obsidian.com"),
        "LocalAppData",
      );
      addCandidate(
        candidates,
        join(env.LOCALAPPDATA, "Obsidian", "Obsidian.com"),
        "LocalAppData",
      );
    }
  } else if (platform === "macos") {
    addCandidate(candidates, "/usr/local/bin/obsidian", "registrazione CLI macOS");
    addCandidate(candidates, "/opt/homebrew/bin/obsidian", "Homebrew PATH");
    addCandidate(
      candidates,
      "/Applications/Obsidian.app/Contents/MacOS/obsidian-cli",
      "bundle applicazione",
    );
  } else {
    addCandidate(candidates, join(home, ".local", "bin", "obsidian"), "registrazione CLI Linux");
    addCandidate(candidates, "/usr/local/bin/obsidian", "percorso di sistema");
    addCandidate(candidates, "/usr/bin/obsidian", "percorso di sistema");
  }

  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    const key = platform === "windows" ? candidate.path.toLocaleLowerCase() : candidate.path;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function runVersion(executable: string): Promise<{ ok: boolean; missing: boolean; output: string }> {
  return new Promise((resolve) => {
    execFile(
      executable,
      ["version"],
      { timeout: 6_000, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout, stderr) => {
        const output = `${stdout}\n${stderr}`.trim().slice(0, 500);
        resolve({
          ok: error === null && !cliReportsDisabled(output) && cliReportsVersion(output),
          missing: errorCode(error) === "ENOENT",
          output: output || (error ? error.message : "Versione non riportata"),
        });
      },
    );
  });
}

export async function diagnoseCli(
  platform: DesktopPlatform,
  env: NodeJS.ProcessEnv = process.env,
  home: string = homedir(),
): Promise<CliDiagnostic> {
  const possible = possibleCliPaths(platform, env, home);
  const candidates: CliCandidate[] = [];
  const failures: string[] = [];
  let firstExisting: string | undefined;
  for (const candidate of possible) {
    let regularFile = false;
    try {
      regularFile = (await stat(candidate.path)).isFile();
    } catch {
      regularFile = false;
    }
    if (!regularFile) {
      candidates.push({ ...candidate, exists: false });
      continue;
    }
    const result = await runVersion(candidate.path);
    candidates.push({ ...candidate, exists: true });
    if (firstExisting === undefined) firstExisting = candidate.path;
    if (result.ok) {
      return {
        state: "ready",
        checkedAt: new Date().toISOString(),
        executable: candidate.path,
        version: result.output,
        detail: "Un candidato CLI ha risposto con un formato di versione Obsidian riconosciuto.",
        candidates,
      };
    }
    if (!result.missing) failures.push(`${candidate.path}: ${result.output}`);
  }

  if (firstExisting === undefined) {
    return {
      state: "missing",
      checkedAt: new Date().toISOString(),
      detail: "CLI non trovata. Abilitala in Impostazioni → Generale → Interfaccia a riga di comando.",
      candidates,
    };
  }

  return {
    state: "error",
    checkedAt: new Date().toISOString(),
    executable: firstExisting,
    detail:
      "Eseguibile trovato, ma il comando version non ha risposto. Lascia Obsidian aperto e riabilita la CLI dalle impostazioni generali. " +
      failures.join(" | "),
    candidates,
  };
}
