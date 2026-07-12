import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { afterEach, describe, expect, it } from "vitest";

function inheritedEnvironment(
  additions: Record<string, string>,
): Record<string, string> {
  const inherited = Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
  delete inherited.OBSIDIAN_BRIDGE_WRITABLE_FOLDERS;
  delete inherited.OBSIDIAN_BRIDGE_SETTINGS_PATH;
  return { ...inherited, ...additions };
}

function parseTextPayload(result: unknown): Record<string, unknown> {
  if (result === null || typeof result !== "object") {
    throw new TypeError("MCP result is not an object");
  }
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) {
    throw new TypeError("MCP result has no content array");
  }
  const first = content[0] as { type?: unknown; text?: unknown } | undefined;
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new TypeError("MCP result has no text payload");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function readState(statePath: string): Record<string, string> {
  return JSON.parse(readFileSync(statePath, "utf8")) as Record<string, string>;
}

async function startClient(
  statePath: string,
  additions: Record<string, string> = {},
): Promise<{ client: Client; transport: StdioClientTransport }> {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const launcher = fileURLToPath(
    new URL("./fixtures/start-bundled-server.mjs", import.meta.url),
  );
  const fakeCli = fileURLToPath(
    new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
  );
  const client = new Client({
    name: "obsidian-write-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: projectRoot,
    env: inheritedEnvironment({
      OBSIDIAN_FAKE_SCRIPT: fakeCli,
      OBSIDIAN_FAKE_STATE_FILE: statePath,
      OBSIDIAN_FAKE_VAULT_PATH: dirname(statePath),
      OBSIDIAN_BRIDGE_MODE: "write",
      OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects",
      OBSIDIAN_BRIDGE_WRITABLE_VAULTS: "Test Vault",
      OBSIDIAN_BRIDGE_DATA_DIR: join(dirname(statePath), "bridge-data"),
      OBSIDIAN_BRIDGE_SETTINGS_PATH: join(dirname(statePath), "settings-not-configured.json"),
      ...additions,
    }),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

async function prepare(
  client: Client,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "obsidian_prepare_change",
    arguments: input,
  });
  expect(result.isError).not.toBe(true);
  return parseTextPayload(result);
}

async function commit(client: Client, changeId: string): Promise<unknown> {
  return await client.callTool({
    name: "obsidian_commit_change",
    arguments: { change_id: changeId },
  });
}

async function prepareAutonomous(
  client: Client,
  input: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await client.callTool({
    name: "obsidian_prepare_autonomous_change",
    arguments: input,
  });
  expect(result.isError).not.toBe(true);
  return parseTextPayload(result);
}

async function commitAutonomous(
  client: Client,
  changeId: string,
): Promise<unknown> {
  return await client.callTool({
    name: "obsidian_commit_autonomous_change",
    arguments: { change_id: changeId },
  });
}

describe("guarded MCP write workflow", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function stateFixture(
    state: Record<string, string>,
  ): Promise<{ directory: string; statePath: string }> {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-write-test-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "vault-state.json");
    writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    return { directory, statePath };
  }

  it("exposes only prepare and commit in write mode with honest annotations", async () => {
    const { statePath } = await stateFixture({});
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "obsidian_prepare_change",
        "obsidian_commit_change",
      ]);
      expect(listed.tools[0]?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        openWorldHint: false,
      });
      expect(listed.tools[1]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("exposes a separate honest autonomous writer and gates it to full access", async () => {
    const { directory, statePath } = await stateFixture({});
    const settingsPath = join(directory, "settings.json");
    const writeSettings = (accessMode: "protected" | "full") => {
      writeFileSync(
        settingsPath,
        `${JSON.stringify({
          version: 3,
          updatedAt: new Date().toISOString(),
          vaults: {
            "0123456789abcdef": {
              vaultName: "Test Vault",
              vaultPath: directory,
              enabled: true,
              readMode: "folders",
              readFolders: ["Projects"],
              writeEnabled: true,
              writeFolders: ["Projects"],
              accessMode,
            },
          },
        })}\n`,
        "utf8",
      );
    };
    writeSettings("full");
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_MODE: "autonomous",
      OBSIDIAN_BRIDGE_SETTINGS_PATH: settingsPath,
    });

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "obsidian_prepare_autonomous_change",
        "obsidian_commit_autonomous_change",
      ]);
      expect(listed.tools[0]?.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
      });
      expect(listed.tools[1]?.annotations).toMatchObject({
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
      });

      const preview = await prepareAutonomous(client, {
        vault: "Test Vault",
        path: "Root autonomous.md",
        operation: "create",
        content: "created autonomously\n",
      });
      expect(preview).toMatchObject({
        authorization_mode: "autonomous",
        approval_required: false,
        path: "Root autonomous.md",
      });
      const committed = await commitAutonomous(
        client,
        String(preview.change_id),
      );
      expect((committed as { isError?: boolean }).isError).not.toBe(true);
      expect(readState(statePath)["Root autonomous.md"]).toBe(
        "created autonomously\n",
      );

      writeSettings("protected");
      const denied = await client.callTool({
        name: "obsidian_prepare_autonomous_change",
        arguments: {
          vault: "Test Vault",
          path: "Denied autonomous.md",
          operation: "create",
          content: "must not land",
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toMatch(/Accesso completo/iu);
      expect(readState(statePath)["Denied autonomous.md"]).toBeUndefined();
    } finally {
      await client.close();
    }
  }, 20_000);

  it("revokes a prepared autonomous change before commit", async () => {
    const { directory, statePath } = await stateFixture({});
    const settingsPath = join(directory, "settings.json");
    const writeSettings = (accessMode: "protected" | "full") => {
      writeFileSync(
        settingsPath,
        `${JSON.stringify({
          version: 3,
          updatedAt: new Date().toISOString(),
          vaults: {
            "0123456789abcdef": {
              vaultName: "Test Vault",
              vaultPath: directory,
              enabled: true,
              readMode: "all",
              readFolders: [],
              writeEnabled: false,
              writeFolders: [],
              accessMode,
            },
          },
        })}\n`,
        "utf8",
      );
    };
    writeSettings("full");
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_MODE: "autonomous",
      OBSIDIAN_BRIDGE_SETTINGS_PATH: settingsPath,
    });

    try {
      const preview = await prepareAutonomous(client, {
        vault: "Test Vault",
        path: "Revoked autonomous.md",
        operation: "create",
        content: "preview only",
      });
      writeSettings("protected");
      const result = await commitAutonomous(client, String(preview.change_id));
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify((result as { content?: unknown }).content)).toMatch(
        /Accesso completo/iu,
      );
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("fails closed when no writable folder is configured", async () => {
    const { statePath } = await stateFixture({});
    const { client } = await startClient(statePath);

    try {
      const result = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/New.md",
          operation: "create",
          content: "must not be written",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(
        /writ|disabled|scope|outside.*allowed folders/iu,
      );
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("fails closed unless the exact target vault is explicitly writable", async () => {
    const { statePath } = await stateFixture({});
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_VAULTS: "Another Vault",
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const result = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/New.md",
          operation: "create",
          content: "must not be written",
        },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result.content)).toMatch(/vault.*outside|writable.*vault/iu);
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("uses a writable scope distinct from the broader read scope", async () => {
    const { statePath } = await stateFixture({});
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects",
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects/Editable",
    });

    try {
      const denied = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/ReadOnly.md",
          operation: "create",
          content: "blocked",
        },
      });
      expect(denied.isError).toBe(true);

      const allowed = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/Editable/Allowed.md",
        operation: "create",
        content: "preview only",
      });
      expect(allowed.path).toBe("Projects/Editable/Allowed.md");
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("rechecks panel grants at commit and honors revocation after preview", async () => {
    const { directory, statePath } = await stateFixture({});
    const settingsPath = join(directory, "settings.json");
    const writeSettings = (writeEnabled: boolean) => {
      writeFileSync(
        settingsPath,
        `${JSON.stringify({
          version: 2,
          updatedAt: new Date().toISOString(),
          vaults: {
            "0123456789abcdef": {
              vaultName: "Test Vault",
              vaultPath: directory,
              enabled: true,
              readMode: "folders",
              readFolders: ["Projects"],
              writeEnabled,
              writeFolders: writeEnabled ? ["Projects"] : [],
            },
          },
        })}\n`,
        "utf8",
      );
    };
    writeSettings(true);
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_SETTINGS_PATH: settingsPath,
      // These permissive legacy values must not bypass an existing panel entry.
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const preview = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/Revoked.md",
        operation: "create",
        content: "preview only",
      });
      expect(preview.vault).toBe("Test Vault");
      writeSettings(false);

      const result = await commit(client, String(preview.change_id));
      expect(
        (result as { isError?: boolean }).isError,
      ).toBe(true);
      expect(JSON.stringify((result as { content?: unknown }).content)).toMatch(
        /disabled|shared settings/iu,
      );
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("previews without mutation, commits once, and refuses replay", async () => {
    const { directory, statePath } = await stateFixture({});
    const logPath = join(directory, "argv.jsonl");
    const { client } = await startClient(statePath, {
      OBSIDIAN_FAKE_LOG: logPath,
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const preview = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/New.md",
        operation: "create",
        content: "first & still one argument\n\tsecond\\literal\n",
      });
      expect(preview).toMatchObject({
        vault: "Test Vault",
        path: "Projects/New.md",
        operation: "create",
      });
      expect(preview.change_id).toEqual(expect.any(String));
      expect(preview.expires_at).toEqual(expect.any(String));
      expect(JSON.stringify(preview)).toContain("first");
      expect(readState(statePath)).toEqual({});

      const committed = await commit(client, String(preview.change_id));
      expect((committed as { isError?: boolean }).isError).not.toBe(true);
      expect(readState(statePath)).toEqual({
        "Projects/New.md": "first & still one argument\n\tsecond\\literal\n",
      });
      const invocations = readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { argv: string[] });
      const writeInvocation = invocations.find(({ argv }) =>
        argv.includes("create"),
      );
      expect(writeInvocation?.argv.slice(0, 2)).toEqual([
        "vault=Test Vault",
        "create",
      ]);
      expect(
        writeInvocation?.argv.filter((argument) =>
          argument.startsWith("content="),
        ),
      ).toEqual(["content=first & still one argument\\n\\tsecond\\literal\\n"]);

      const replay = await commit(client, String(preview.change_id));
      expect((replay as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify((replay as { content?: unknown }).content)).toMatch(
        /used|unknown|expired|replay/iu,
      );
      expect(readState(statePath)).toEqual({
        "Projects/New.md": "first & still one argument\n\tsecond\\literal\n",
      });
    } finally {
      await client.close();
    }
  }, 20_000);

  it("supports append and rejects overwrite-style line replacement", async () => {
    const { statePath } = await stateFixture({
      "Projects/Existing.md": "one\ntwo\nthree\n",
    });
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const appendPreview = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/Existing.md",
        operation: "append",
        content: "four\n",
      });
      expect(appendPreview.before_sha256).toEqual(expect.any(String));
      expect(readState(statePath)["Projects/Existing.md"]).toBe(
        "one\ntwo\nthree\n",
      );
      expect(
        (await commit(client, String(appendPreview.change_id))) as {
          isError?: boolean;
        },
      ).not.toMatchObject({ isError: true });
      expect(readState(statePath)["Projects/Existing.md"]).toBe(
        "one\ntwo\nthree\nfour\n",
      );

      const unsupported = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/Existing.md",
          operation: "replace_lines",
          start_line: 2,
          end_line: 3,
          content: "TWO\nTHREE",
        },
      });
      expect(unsupported.isError).toBe(true);
      expect(readState(statePath)["Projects/Existing.md"]).toBe(
        "one\ntwo\nthree\nfour\n",
      );
    } finally {
      await client.close();
    }
  }, 20_000);

  it("makes a final-newline-only append visible in both diff and escaped content", async () => {
    const { statePath } = await stateFixture({
      "Projects/Existing.md": "one line",
    });
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const preview = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/Existing.md",
        operation: "append",
        content: "\n",
      });
      expect(preview.preview).toMatchObject({
        proposed_content: "\n",
        proposed_content_json: "\"\\n\"",
      });
      expect(JSON.stringify(preview.preview)).toContain("EOF newline changed");
      expect(readState(statePath)["Projects/Existing.md"]).toBe("one line");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("detects a source-hash conflict and does not overwrite the newer note", async () => {
    const { statePath } = await stateFixture({
      "Projects/Existing.md": "original\n",
    });
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const preview = await prepare(client, {
        vault: "Test Vault",
        path: "Projects/Existing.md",
        operation: "append",
        content: "proposed\n",
      });
      writeFileSync(
        statePath,
        `${JSON.stringify({ "Projects/Existing.md": "manual edit\n" })}\n`,
        "utf8",
      );

      const result = await commit(client, String(preview.change_id));
      expect((result as { isError?: boolean }).isError).toBe(true);
      expect(JSON.stringify((result as { content?: unknown }).content)).toMatch(
        /conflict|changed|hash/iu,
      );
      expect(readState(statePath)["Projects/Existing.md"]).toBe("manual edit\n");
    } finally {
      await client.close();
    }
  }, 20_000);

  it.each([
    "../Outside.md",
    "/absolute/Outside.md",
    ".obsidian/Config.md",
    "Projects/.hidden/Secret.md",
    "Elsewhere/Outside.md",
  ])("rejects unsafe or out-of-scope write target %j", async (notePath) => {
    const { statePath } = await stateFixture({});
    const { client } = await startClient(statePath, {
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const result = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: notePath,
          operation: "create",
          content: "blocked",
        },
      });
      expect(result.isError).toBe(true);
      expect(readState(statePath)).toEqual({});
    } finally {
      await client.close();
    }
  }, 20_000);

  it("rejects an oversized proposed change before invoking the CLI", async () => {
    const { directory, statePath } = await stateFixture({});
    const logPath = join(directory, "argv.jsonl");
    const { client } = await startClient(statePath, {
      OBSIDIAN_FAKE_LOG: logPath,
      OBSIDIAN_BRIDGE_WRITABLE_FOLDERS: "Projects",
    });

    try {
      const result = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/Huge.md",
          operation: "create",
          content: "é".repeat(4_097),
        },
      });
      expect(result.isError).toBe(true);
      expect(readState(statePath)).toEqual({});
      expect(() => readFileSync(logPath, "utf8")).toThrow();

      writeFileSync(
        statePath,
        `${JSON.stringify({ "Projects/Large.md": "a\n".repeat(8_000) })}\n`,
        "utf8",
      );
      const largeNoteAppend = await client.callTool({
        name: "obsidian_prepare_change",
        arguments: {
          vault: "Test Vault",
          path: "Projects/Large.md",
          operation: "append",
          content: "b".repeat(500),
        },
      });
      expect(largeNoteAppend.isError).not.toBe(true);
      expect(readState(statePath)["Projects/Large.md"]).toBe(
        "a\n".repeat(8_000),
      );
    } finally {
      await client.close();
    }
  }, 20_000);
});
