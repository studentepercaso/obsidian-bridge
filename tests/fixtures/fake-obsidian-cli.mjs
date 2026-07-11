#!/usr/bin/env node

import {
  appendFileSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";

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
          state[notePath] = `${state[notePath]}${decodeCliContent(parameter("content") ?? "")}`;
          writeState(state);
          process.stdout.write(notePath);
        }
      } else {
        process.stdout.write(JSON.stringify({ ok: true, argv }));
      }
      break;
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
