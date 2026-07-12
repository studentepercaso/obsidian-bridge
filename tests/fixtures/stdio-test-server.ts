import { spawn } from "node:child_process";

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import {
  createObsidianCliRunner,
  type SpawnImplementation,
} from "../../src/cli.js";
import { loadBridgeConfig } from "../../src/config.js";
import { createObsidianServer } from "../../src/server.js";
import type { ServerMode } from "../../src/server.js";

const fakeCliPath = process.env.OBSIDIAN_FAKE_SCRIPT;
if (fakeCliPath === undefined || fakeCliPath.length === 0) {
  throw new Error("OBSIDIAN_FAKE_SCRIPT is required by the test server");
}

const config = loadBridgeConfig({
  ...process.env,
  OBSIDIAN_CLI_PATH: process.execPath,
});
const requestedMode = process.env.OBSIDIAN_BRIDGE_MODE ?? "read";
if (
  requestedMode !== "read" &&
  requestedMode !== "write" &&
  requestedMode !== "autonomous" &&
  requestedMode !== "management"
) {
  throw new Error("invalid OBSIDIAN_BRIDGE_MODE in test fixture");
}
const mode: ServerMode = requestedMode;
const spawnImplementation: SpawnImplementation = (
  _executable,
  args,
  options,
) => spawn(process.execPath, [fakeCliPath, ...args], options);
const runner = createObsidianCliRunner(
  config,
  spawnImplementation,
  mode === "management"
    ? { allowManagement: true }
    : mode === "write" || mode === "autonomous"
      ? { allowWrites: true }
      : {},
);
const server = createObsidianServer({ config, runner, mode });

await server.connect(new StdioServerTransport());
