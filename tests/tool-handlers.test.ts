import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  createObsidianCliRunner,
  type ObsidianCliRunner,
  type SpawnImplementation,
} from "../src/cli.js";
import type { BridgeConfig } from "../src/config.js";
import { createPathPolicy } from "../src/path-policy.js";
import {
  ToolInputSchemas,
  createToolHandlers,
  parseServerMode,
} from "../src/server.js";

const fakeCliPath = fileURLToPath(
  new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
);

function resultJson(result: Awaited<ReturnType<ObsidianCliRunner>> | {
  content: Array<{ type: string; text?: string }>;
}): unknown {
  if (!("content" in result)) throw new Error("expected an MCP tool result");
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected one text result");
  }
  return JSON.parse(first.text) as unknown;
}

function runnerConfig(): BridgeConfig {
  return {
    executable: "fake-obsidian",
    timeoutMs: 2_000,
    maxOutputBytes: 64 * 1_024,
    allowedFolders: ["Projects"],
    deniedFolders: [".obsidian", ".trash", "Projects/Private"],
  };
}

describe("tool schemas and handlers", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "obsidian-tools-test-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("keeps every public server mode in one authorization domain", () => {
    expect(parseServerMode([])).toBe("read");
    expect(parseServerMode(["--mode=read"])).toBe("read");
    expect(parseServerMode(["--mode=write"])).toBe("write");
    expect(parseServerMode(["--mode=autonomous"])).toBe("autonomous");
    expect(parseServerMode(["--mode=management"])).toBe("management");
    expect(() => parseServerMode(["--mode=all"])).toThrow(
      "--mode must be read, write, autonomous, or management",
    );
  });

  it("bounds search queries and result limits", () => {
    const validBase = { vault: "Test Vault", query: "x" };

    expect(
      ToolInputSchemas.searchNotes.safeParse({
        ...validBase,
        query: "x".repeat(2_000),
        limit: 100,
      }).success,
    ).toBe(true);
    expect(
      ToolInputSchemas.searchNotes.safeParse({
        ...validBase,
        query: "x".repeat(2_001),
      }).success,
    ).toBe(false);
    expect(
      ToolInputSchemas.searchNotes.safeParse({ ...validBase, limit: 0 }).success,
    ).toBe(false);
    expect(
      ToolInputSchemas.searchNotes.safeParse({ ...validBase, limit: 101 }).success,
    ).toBe(false);
    expect(
      ToolInputSchemas.searchNotes.safeParse({ ...validBase, limit: 1.5 })
        .success,
    ).toBe(false);
  });

  it("defaults a read to 200 lines and caps an explicit range at 400", () => {
    expect(
      ToolInputSchemas.readNote.parse({
        vault: "Test Vault",
        path: "Projects/Alpha.md",
      }),
    ).toMatchObject({ start_line: 1 });
    expect(
      ToolInputSchemas.readNote.safeParse({
        vault: "Test Vault",
        path: "Projects/Alpha.md",
        start_line: 10,
        end_line: 409,
      }).success,
    ).toBe(true);
    expect(
      ToolInputSchemas.readNote.safeParse({
        vault: "Test Vault",
        path: "Projects/Alpha.md",
        start_line: 10,
        end_line: 410,
      }).success,
    ).toBe(false);
    expect(
      ToolInputSchemas.readNote.safeParse({
        vault: "Test Vault",
        path: "Projects/Alpha.md",
        start_line: 10,
        end_line: 9,
      }).success,
    ).toBe(false);
  });

  it("runs a search through the fake CLI, scopes it to the allowlist, and filters output", async () => {
    const logPath = join(temporaryDirectory, "search-argv.jsonl");
    vi.stubEnv("OBSIDIAN_FAKE_LOG", logPath);
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const config = runnerConfig();
    const handlers = createToolHandlers({
      runner: createObsidianCliRunner(config, spawnImplementation),
      policy: createPathPolicy({
        allowedFolders: config.allowedFolders,
        deniedFolders: config.deniedFolders,
      }),
    });
    const input = ToolInputSchemas.searchNotes.parse({
      vault: "Test Vault",
      query: "alpha & still one argument",
      limit: 10,
    });

    const result = await handlers.searchNotes(input);

    expect(resultJson(result)).toEqual({
      vault: "Test Vault",
      query: "alpha & still one argument",
      count: 1,
      notes: ["Projects/Alpha.md"],
    });
    const invocation = JSON.parse(
      readFileSync(logPath, "utf8").trim(),
    ) as { argv: string[] };
    expect(invocation.argv).toEqual([
      "vault=Test Vault",
      "search",
      "query=alpha & still one argument",
      "limit=10",
      "format=text",
      "path=Projects",
    ]);
  });

  it("returns an inclusive, numbered read slice through the fake CLI", async () => {
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const config = runnerConfig();
    const handlers = createToolHandlers({
      runner: createObsidianCliRunner(config, spawnImplementation),
      policy: createPathPolicy({
        allowedFolders: config.allowedFolders,
        deniedFolders: config.deniedFolders,
      }),
    });
    const input = ToolInputSchemas.readNote.parse({
      vault: "Test Vault",
      path: "Projects/Alpha.md",
      start_line: 2,
      end_line: 4,
    });

    expect(resultJson(await handlers.readNote(input))).toEqual({
      vault: "Test Vault",
      path: "Projects/Alpha.md",
      startLine: 2,
      endLine: 4,
      totalLines: 5,
      excerpt: "2: two\n3: three\n4: four",
    });
  });

  it("enforces the 200-line default at the handler boundary", async () => {
    const output = Array.from({ length: 500 }, (_, index) => `line ${index + 1}`).join(
      "\n",
    );
    const runner = vi.fn<ObsidianCliRunner>(async () => ({
      stdout: output,
      stderr: "",
      exitCode: 0,
    }));
    const handlers = createToolHandlers({
      runner,
      policy: createPathPolicy({ allowedFolders: ["Projects"] }),
    });
    const input = ToolInputSchemas.readNote.parse({
      vault: "Test Vault",
      path: "Projects/Alpha.md",
    });

    expect(resultJson(await handlers.readNote(input))).toMatchObject({
      startLine: 1,
      endLine: 200,
      totalLines: 500,
      excerpt: expect.stringContaining("200: line 200"),
    });
    const parsed = resultJson(await handlers.readNote(input)) as {
      excerpt: string;
    };
    expect(parsed.excerpt).not.toContain("201: line 201");
  });

  it("does not expose vault-wide metadata under a folder-only read grant", async () => {
    const runner = vi.fn<ObsidianCliRunner>();
    const handlers = createToolHandlers({
      runner,
      policy: createPathPolicy({ allowedFolders: ["Projects"] }),
    });

    await expect(
      handlers.vaultInfo({ vault: "Test Vault" }),
    ).rejects.toThrow(/full-vault read access/iu);
    expect(runner).not.toHaveBeenCalled();
  });

  it.each([
    "../Outside.md",
    "/absolute/Outside.md",
    ".obsidian/Config.md",
    "Projects/.hidden/Secret.md",
    "Projects/Private/Secret.md",
    "Elsewhere/Outside.md",
  ])("blocks %j before invoking the CLI", async (notePath) => {
    const runner = vi.fn<ObsidianCliRunner>();
    const handlers = createToolHandlers({
      runner,
      policy: createPathPolicy({
        allowedFolders: ["Projects"],
        deniedFolders: ["Projects/Private"],
      }),
    });
    const input = {
      vault: "Test Vault",
      path: notePath,
      start_line: 1,
    };

    await expect(handlers.readNote(input)).rejects.toThrow();
    expect(runner).not.toHaveBeenCalled();
  });
});
