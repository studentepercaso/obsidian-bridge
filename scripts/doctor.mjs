import { spawn } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const minimumNodeMajor = 20;
const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);

function run(executable, args, timeoutMs = 10_000) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`Timed out after ${timeoutMs} ms`));
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code === 0) {
        resolve(stdout.trim());
      } else {
        reject(new Error(stderr.trim() || `Exited with code ${code}`));
      }
    });
  });
}

async function findCli() {
  const configured = process.env.OBSIDIAN_CLI_PATH?.trim();
  if (configured && !path.isAbsolute(configured)) {
    throw new Error("OBSIDIAN_CLI_PATH must be an absolute path");
  }
  const windowsCandidates = [
    process.env.ProgramFiles
      ? `${process.env.ProgramFiles}\\Obsidian\\Obsidian.com`
      : undefined,
    process.env.LOCALAPPDATA
      ? `${process.env.LOCALAPPDATA}\\Programs\\Obsidian\\Obsidian.com`
      : undefined,
  ].filter((candidate) => typeof candidate === "string");
  const candidates = [...new Set(
    configured
      ? [configured]
      : process.platform === "win32"
        ? windowsCandidates
        : ["obsidian"],
  )];

  const failures = [];
  for (const candidate of candidates) {
    try {
      const version = await run(candidate, ["version"]);
      if (
        /^Command line interface is not enabled\.\s+Please turn it on in Settings\s*>\s*General\s*>\s*Advanced\.?$/iu.test(
          version,
        )
      ) {
        throw new Error(version);
      }
      return { executable: candidate, version };
    } catch (error) {
      failures.push(`${candidate}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(failures.join("\n"));
}

function defaultSettingsPath() {
  const configured = process.env.OBSIDIAN_BRIDGE_SETTINGS_PATH?.trim();
  if (configured) return path.resolve(configured);
  if (process.platform === "win32") {
    return path.join(
      process.env.LOCALAPPDATA || path.join(os.homedir(), "AppData", "Local"),
      "ObsidianBridge",
      "settings.json",
    );
  }
  if (process.platform === "darwin") {
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "ObsidianBridge",
      "settings.json",
    );
  }
  return path.join(
    process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"),
    "ObsidianBridge",
    "settings.json",
  );
}

async function inspectPanelSettings() {
  const settingsPath = defaultSettingsPath();
  try {
    const fileStat = await stat(settingsPath);
    if (!fileStat.isFile() || fileStat.size > 65_536) {
      throw new Error("settings file is not a regular file of at most 64 KiB");
    }
    const parsed = JSON.parse(await readFile(settingsPath, "utf8"));
    if (parsed?.version !== 2 || parsed.vaults === null || typeof parsed.vaults !== "object") {
      throw new Error("settings file does not match schema version 2");
    }
    const vaults = Object.entries(parsed.vaults);
    console.log(`Bridge Control settings: ${settingsPath}`);
    console.log(`Configured vaults: ${vaults.length}`);
    for (const [id, value] of vaults) {
      const entry = value && typeof value === "object" ? value : {};
      console.log(
        `- ${entry.vaultName || "unnamed"} (${id}): ${entry.enabled === true ? `read=${entry.readMode}` : "disabled"}, ` +
        `write=${entry.enabled === true && entry.writeEnabled === true ? "enabled" : "disabled"}`,
      );
    }
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") {
      console.error(`Bridge Control settings: MISSING (${settingsPath})`);
      console.error("Run INSTALLA-OBSIDIAN-BRIDGE.cmd or save the Bridge Control panel once.");
    } else {
      console.error(`Bridge Control settings: INVALID (${settingsPath})`);
      console.error(error instanceof Error ? error.message : String(error));
    }
    return false;
  }
}

console.log("Obsidian Bridge doctor\n");
console.log(`Node.js: ${process.versions.node}`);
if (nodeMajor < minimumNodeMajor) {
  console.error(`Node.js ${minimumNodeMajor}+ is required.`);
  process.exitCode = 1;
} else {
  console.log("Node.js check: OK");
}

const panelSettingsOk = await inspectPanelSettings();
const readScope = process.env.OBSIDIAN_BRIDGE_ALLOWED_FOLDERS?.trim();
const writableVaults = process.env.OBSIDIAN_BRIDGE_WRITABLE_VAULTS?.trim();
const writeScope = process.env.OBSIDIAN_BRIDGE_WRITABLE_FOLDERS?.trim();
console.log(`Legacy read scope: ${readScope || "not configured"}`);
console.log(`Writable vaults: ${writableVaults || "DENY ALL (safe default)"}`);
console.log(`Writable folders: ${writeScope || "DENY ALL (safe default)"}`);
if (!panelSettingsOk && process.env.OBSIDIAN_BRIDGE_ALLOWED_FOLDERS === undefined) {
  process.exitCode = 1;
}

try {
  const cli = await findCli();
  console.log(`Obsidian CLI: ${cli.executable}`);
  console.log(`Obsidian version: ${cli.version || "detected"}`);
  const vaults = await run(cli.executable, ["vaults"]);
  console.log("Known vaults:");
  console.log(vaults || "(none reported)");
  console.log("\nBridge prerequisites: OK");
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.error("Obsidian CLI check: FAILED");
  console.error(message);
  if (/unable to find obsidian|make sure obsidian is running/iu.test(message)) {
    console.error("Open Obsidian, keep it running, and retry the doctor.");
  }
  console.error("Also confirm Settings > General > Command line interface is enabled in Obsidian 1.12.7+.");
  process.exitCode = 1;
}
