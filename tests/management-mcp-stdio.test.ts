import { readFileSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
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
  delete inherited.OBSIDIAN_BRIDGE_WRITABLE_VAULTS;
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

async function startManagementClient(options: {
  readonly statePath: string;
  readonly settingsPath: string;
  readonly dataDirectory: string;
  readonly logPath: string;
}): Promise<{ client: Client; transport: StdioClientTransport }> {
  const projectRoot = fileURLToPath(new URL("../", import.meta.url));
  const launcher = fileURLToPath(
    new URL("./fixtures/start-bundled-server.mjs", import.meta.url),
  );
  const fakeCli = fileURLToPath(
    new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
  );
  const client = new Client({
    name: "obsidian-management-test",
    version: "1.0.0",
  });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [launcher],
    cwd: projectRoot,
    env: inheritedEnvironment({
      OBSIDIAN_FAKE_SCRIPT: fakeCli,
      OBSIDIAN_FAKE_STATE_FILE: options.statePath,
      OBSIDIAN_FAKE_VAULT_PATH: dirname(options.statePath),
      OBSIDIAN_FAKE_LOG: options.logPath,
      OBSIDIAN_BRIDGE_MODE: "management",
      OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects",
      OBSIDIAN_BRIDGE_DATA_DIR: options.dataDirectory,
      OBSIDIAN_BRIDGE_SETTINGS_PATH: options.settingsPath,
    }),
    stderr: "pipe",
  });
  await client.connect(transport);
  return { client, transport };
}

describe("managed MCP stdio server", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it("exposes only managed tools and completes an opaque replace_text round trip", async () => {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-management-mcp-"));
    temporaryDirectories.push(directory);
    const statePath = join(directory, "vault-state.json");
    const settingsPath = join(directory, "settings.json");
    const dataDirectory = join(directory, "bridge-data");
    const logPath = join(directory, "argv.jsonl");
    const notePath = "Projects/Managed.md";
    writeFileSync(
      statePath,
      `${JSON.stringify({ [notePath]: "before value\n" }, null, 2)}\n`,
      "utf8",
    );
    await mkdir(join(directory, "Projects"), { recursive: true });
    await writeFile(join(directory, notePath), "before value\n", "utf8");
    writeFileSync(
      settingsPath,
      `${JSON.stringify({
        version: 4,
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
            accessMode: "management",
            managementPermissions: {
              edit: true,
              move: false,
              trash: false,
            },
          },
        },
      })}\n`,
      "utf8",
    );
    const { client } = await startManagementClient({
      statePath,
      settingsPath,
      dataDirectory,
      logPath,
    });

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "obsidian_prepare_managed_change",
        "obsidian_commit_managed_change",
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

      const preparedResult = await client.callTool({
        name: "obsidian_prepare_managed_change",
        arguments: {
          vault: "Test Vault",
          path: notePath,
          operation: "replace_text",
          find: "before",
          replacement: "after",
        },
      });
      expect(preparedResult.isError).not.toBe(true);
      const prepared = parseTextPayload(preparedResult);
      expect(prepared).toMatchObject({
        status: "prepared",
        path: notePath,
        operation: "replace_text",
        authorization_mode: "management",
        approval_required: false,
        preview: { exact_match_count: 1 },
      });
      expect(readState(statePath)[notePath]).toBe("before value\n");

      const committedResult = await client.callTool({
        name: "obsidian_commit_managed_change",
        arguments: { change_id: prepared.change_id },
      });
      expect(committedResult.isError).not.toBe(true);
      expect(parseTextPayload(committedResult)).toMatchObject({
        status: "committed",
        operation: "replace",
        verified: true,
        audit_recorded: true,
        authorization_mode: "management",
      });
      expect(readState(statePath)[notePath]).toBe("after value\n");

      const invocations = readFileSync(logPath, "utf8")
        .trim()
        .split(/\r?\n/u)
        .map((line) => JSON.parse(line) as { argv: string[] });
      const managementInvocation = invocations.find(({ argv }) =>
        argv.includes("bridge-control:commit"),
      );
      expect(managementInvocation?.argv.slice(0, 2)).toEqual([
        "vault=0123456789abcdef",
        "bridge-control:commit",
      ]);
      expect(
        managementInvocation?.argv.find((argument) =>
          argument.startsWith("request="),
        ),
      ).toMatch(/^request=[0-9a-f-]{36}$/u);
      expect(
        managementInvocation?.argv.find((argument) =>
          argument.startsWith("token="),
        ),
      ).toMatch(/^token=[0-9a-f]{64}$/u);
      expect(
        await readdir(join(dataDirectory, "management", "requests")),
      ).toEqual([]);

      const replay = await client.callTool({
        name: "obsidian_commit_managed_change",
        arguments: { change_id: prepared.change_id },
      });
      expect(replay.isError).toBe(true);
      expect(JSON.stringify(replay.content)).toMatch(
        /unknown|expired|consumed/iu,
      );
      expect(readState(statePath)[notePath]).toBe("after value\n");
    } finally {
      await client.close();
    }
  }, 20_000);
});
