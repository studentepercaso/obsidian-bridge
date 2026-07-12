#!/usr/bin/env node

import { createHash } from "node:crypto";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

const argv = process.argv.slice(2);
const logPath = process.env.OBSIDIAN_FAKE_LOG;
const statePath = process.env.OBSIDIAN_FAKE_STATE_FILE;

function parameter(name) {
  const prefix = `${name}=`;
  const value = argv.find((argument) => argument.startsWith(prefix));
  return value?.slice(prefix.length);
}

function decodeCliContent(value) {
  return value.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
}

function readState() {
  if (!statePath || !existsSync(statePath)) return {};
  return JSON.parse(readFileSync(statePath, "utf8"));
}

function writeState(state) {
  if (!statePath) throw new Error("OBSIDIAN_FAKE_STATE_FILE is required");
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function physicalNotePath(notePath) {
  const vaultPath = process.env.OBSIDIAN_FAKE_VAULT_PATH;
  return vaultPath ? join(vaultPath, ...notePath.split("/")) : undefined;
}

function hashDocumentState(exists, content = "") {
  const hash = createHash("sha256");
  hash.update(exists ? "present\0" : "missing\0", "utf8");
  if (exists) hash.update(content, "utf8");
  return hash.digest("hex");
}

const delayMs = Number.parseInt(process.env.OBSIDIAN_FAKE_DELAY_MS ?? "0", 10);
if (Number.isFinite(delayMs) && delayMs > 0) {
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

if (logPath) {
  appendFileSync(
    logPath,
    `${JSON.stringify({ argv, cwd: process.cwd() })}\n`,
    "utf8",
  );
}

if (process.env.OBSIDIAN_FAKE_STDERR) {
  process.stderr.write(process.env.OBSIDIAN_FAKE_STDERR);
}

const byteCount = Number.parseInt(process.env.OBSIDIAN_FAKE_BYTES ?? "0", 10);
if (Number.isFinite(byteCount) && byteCount > 0) {
  process.stdout.write("x".repeat(byteCount));
} else if (process.env.OBSIDIAN_FAKE_STDOUT !== undefined) {
  process.stdout.write(process.env.OBSIDIAN_FAKE_STDOUT);
} else {
  const command = argv.find((arg) => !arg.startsWith("vault="));
  const notePath = parameter("path");
  const state = statePath ? readState() : undefined;

  switch (command) {
    case "vault":
      if (parameter("info") === "path") {
        process.stdout.write(process.env.OBSIDIAN_FAKE_VAULT_PATH ?? process.cwd());
      } else {
        process.stdout.write(`name\tTest Vault\npath\t${process.env.OBSIDIAN_FAKE_VAULT_PATH ?? process.cwd()}`);
      }
      break;
    case "search":
      process.stdout.write(state
        ? JSON.stringify(Object.keys(state).map((path) => ({ path, score: 1 })))
        : JSON.stringify([
            { path: "Projects/Alpha.md", score: 1 },
            { path: "Private/Hidden.md", score: 0.5 },
          ]));
      break;
    case "files":
      process.stdout.write(
        [
          "Projects/Alpha.md",
          "Projects/Private/Secret.md",
          ".obsidian/workspace.json",
        ].join("\n"),
      );
      break;
    case "read":
      if (state && notePath) {
        if (!(notePath in state)) {
          process.stderr.write(`Note not found: ${notePath}`);
          process.exitCode = 2;
        } else {
          process.stdout.write(String(state[notePath]));
        }
      } else {
        process.stdout.write("one\ntwo\nthree\nfour\nfive\n");
      }
      break;
    case "create":
      if (state && notePath) {
        const overwrite = argv.includes("overwrite");
        if (notePath in state && !overwrite) {
          process.stderr.write(`Note already exists: ${notePath}`);
          process.exitCode = 3;
        } else {
          state[notePath] = decodeCliContent(parameter("content") ?? "");
          const physicalPath = physicalNotePath(notePath);
          if (physicalPath) {
            mkdirSync(dirname(physicalPath), { recursive: true });
            writeFileSync(physicalPath, state[notePath], "utf8");
          }
          writeState(state);
          process.stdout.write(notePath);
        }
      } else {
        process.stdout.write(JSON.stringify({ ok: true, argv }));
      }
      break;
    case "append":
      if (state && notePath) {
        if (!(notePath in state)) {
          process.stderr.write(`Note not found: ${notePath}`);
          process.exitCode = 2;
        } else {
          const addition = decodeCliContent(parameter("content") ?? "");
          state[notePath] = `${state[notePath]}${addition}`;
          const physicalPath = physicalNotePath(notePath);
          if (physicalPath) appendFileSync(physicalPath, addition, "utf8");
          writeState(state);
          process.stdout.write(notePath);
        }
      } else {
        process.stdout.write(JSON.stringify({ ok: true, argv }));
      }
      break;
    case "bridge-control:commit": {
      const requestId = parameter("request");
      const token = parameter("token");
      const dataDirectory = process.env.OBSIDIAN_BRIDGE_DATA_DIR;
      if (!state || !requestId || !token || !dataDirectory) {
        throw new Error("fake management handler is missing its request context");
      }
      const requestPath = join(
        dataDirectory,
        "management",
        "requests",
        `${requestId}.json`,
      );
      const request = JSON.parse(readFileSync(requestPath, "utf8"));
      if (request.request_id !== requestId || request.token !== token) {
        throw new Error("fake management request authentication failed");
      }
      let targetPath;
      let afterSha256;
      if (request.operation === "replace") {
        state[request.path] = request.payload.content;
        afterSha256 = hashDocumentState(true, state[request.path]);
      } else if (request.operation === "move") {
        targetPath = request.payload.destination;
        state[targetPath] = state[request.path];
        delete state[request.path];
        afterSha256 = hashDocumentState(true, state[targetPath]);
      } else if (request.operation === "trash") {
        delete state[request.path];
        afterSha256 = hashDocumentState(false);
      } else {
        throw new Error("fake management handler does not emulate frontmatter");
      }
      writeState(state);
      process.stdout.write(
        JSON.stringify({
          version: 1,
          request_id: request.request_id,
          change_id: request.change_id,
          status: "committed",
          operation: request.operation,
          path: request.path,
          ...(targetPath === undefined ? {} : { target_path: targetPath }),
          before_sha256: request.before_sha256,
          after_sha256: afterSha256,
          verified: true,
          backup_id: `fake-backup-${request.request_id}`,
          audit_recorded: true,
        }),
      );
      break;
    }
    case "backlinks":
    case "links":
      process.stdout.write(
        JSON.stringify([
          { path: "Projects/Related.md" },
          { path: "Projects/Private/Secret.md" },
        ]),
      );
      break;
    case "tags":
      process.stdout.write(JSON.stringify(["project", "alpha"]));
      break;
    case "properties":
      process.stdout.write(JSON.stringify({ owner: "Ada", status: "active" }));
      break;
    case "tasks":
      process.stdout.write(
        "Projects/Alpha.md:3: [ ] Allowed task\n" +
          "Projects/Private/Secret.md:1: [ ] Private task\n",
      );
      break;
    case "recents":
      process.stdout.write(
        "Projects/Alpha.md\nProjects/Private/Secret.md\n",
      );
      break;
    case "vaults":
      process.stdout.write(JSON.stringify([{ name: "Test Vault" }]));
      break;
    default:
      process.stdout.write(JSON.stringify({ ok: true, argv }));
  }
}

if (process.env.OBSIDIAN_FAKE_EXIT_CODE !== undefined) {
  const exitCode = Number.parseInt(process.env.OBSIDIAN_FAKE_EXIT_CODE, 10);
  process.exitCode = Number.isFinite(exitCode) ? exitCode : 1;
} else if (process.exitCode === undefined) {
  process.exitCode = 0;
}
