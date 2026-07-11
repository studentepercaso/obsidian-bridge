#!/usr/bin/env node

import { build } from "esbuild";
import { unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve, join } from "node:path";
import { pathToFileURL } from "node:url";

const outputFile = join(
  tmpdir(),
  `obsidian-bridge-mcp-test-${process.pid}-${Date.now()}.mjs`,
);

process.once("exit", () => {
  try {
    unlinkSync(outputFile);
  } catch {
    // The temporary bundle may already have been removed by the test runner.
  }
});

await build({
  entryPoints: [
    resolve(process.cwd(), "tests/fixtures/stdio-test-server.ts"),
  ],
  outfile: outputFile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  logLevel: "silent",
});

await import(pathToFileURL(outputFile).href);
