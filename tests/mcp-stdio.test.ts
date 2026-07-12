import { fileURLToPath } from "node:url";
import { writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  delete inherited.OBSIDIAN_BRIDGE_SETTINGS_PATH;
  return { ...inherited, ...additions };
}

function parseTextPayload(result: unknown): unknown {
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
  return JSON.parse(first.text) as unknown;
}

describe("MCP stdio integration", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  it("negotiates, exposes only read-only tools, and enforces path policy", async () => {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-read-legacy-test-"));
    temporaryDirectories.push(directory);
    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const launcher = fileURLToPath(
      new URL("./fixtures/start-bundled-server.mjs", import.meta.url),
    );
    const fakeCli = fileURLToPath(
      new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
    );
    const client = new Client({ name: "obsidian-bridge-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [launcher],
      cwd: projectRoot,
      env: inheritedEnvironment({
        OBSIDIAN_FAKE_SCRIPT: fakeCli,
        OBSIDIAN_BRIDGE_MODE: "read",
        OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "Projects",
        OBSIDIAN_BRIDGE_DENIED_FOLDERS: "Projects/Private",
        OBSIDIAN_BRIDGE_SETTINGS_PATH: join(directory, "settings-not-configured.json"),
        OBSIDIAN_BRIDGE_DATA_DIR: join(directory, "bridge-data"),
      }),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);

      expect(client.getServerVersion()).toMatchObject({
        name: "obsidian-bridge",
        version: "0.5.1",
      });
      expect(client.getInstructions()).toContain("Read-only access");

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toEqual([
        "obsidian_list_vaults",
        "obsidian_vault_info",
        "obsidian_search_notes",
        "obsidian_read_note",
        "obsidian_note_outline",
        "obsidian_note_links",
        "obsidian_note_tags",
        "obsidian_recent_notes",
        "obsidian_recent_write_events",
      ]);
      for (const tool of listed.tools) {
        expect(tool.annotations).toMatchObject({
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        });
      }

      const vaults = await client.callTool({
        name: "obsidian_list_vaults",
        arguments: {},
      });
      expect(parseTextPayload(vaults)).toEqual({
        vaults: [{ name: "Test Vault", access_mode: "protected" }],
      });

      const writeEvents = await client.callTool({
        name: "obsidian_recent_write_events",
        arguments: { vault: "Test Vault" },
      });
      expect(parseTextPayload(writeEvents)).toEqual({
        failures_only: true,
        limit: 10,
        count: 0,
        audit_tail_truncated: false,
        results_truncated: false,
        truncated: false,
        events: [],
      });

      const search = await client.callTool({
        name: "obsidian_search_notes",
        arguments: { vault: "Test Vault", query: "alpha" },
      });
      expect(parseTextPayload(search)).toEqual({
        vault: "Test Vault",
        query: "alpha",
        count: 1,
        notes: ["Projects/Alpha.md"],
      });

      const read = await client.callTool({
        name: "obsidian_read_note",
        arguments: {
          vault: "Test Vault",
          path: "Projects/Alpha.md",
          start_line: 2,
          end_line: 3,
        },
      });
      expect(parseTextPayload(read)).toMatchObject({
        vault: "Test Vault",
        path: "Projects/Alpha.md",
        startLine: 2,
        endLine: 3,
        excerpt: "2: two\n3: three",
      });

      const denied = await client.callTool({
        name: "obsidian_read_note",
        arguments: {
          vault: "Test Vault",
          path: "Projects/Private/Secret.md",
        },
      });
      expect(denied.isError).toBe(true);
      expect(JSON.stringify(denied.content)).toContain("denied folder");

      const traversal = await client.callTool({
        name: "obsidian_read_note",
        arguments: { vault: "Test Vault", path: "../Outside.md" },
      });
      expect(traversal.isError).toBe(true);
      expect(JSON.stringify(traversal.content)).toContain("traversal");
    } finally {
      await client.close();
    }
  }, 20_000);

  it("reloads panel read access live and fails closed after revocation or corruption", async () => {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-read-panel-test-"));
    temporaryDirectories.push(directory);
    const settingsPath = join(directory, "settings.json");
    await mkdir(join(directory, "Projects"));
    await writeFile(join(directory, "Projects", "Alpha.md"), "fixture\n", "utf8");
    const writeSettings = (readMode: "off" | "folders") => {
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
              readMode,
              readFolders: readMode === "folders" ? ["Projects"] : [],
              writeEnabled: false,
              writeFolders: [],
            },
          },
        })}\n`,
        "utf8",
      );
    };
    writeSettings("folders");

    const projectRoot = fileURLToPath(new URL("../", import.meta.url));
    const launcher = fileURLToPath(
      new URL("./fixtures/start-bundled-server.mjs", import.meta.url),
    );
    const fakeCli = fileURLToPath(
      new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
    );
    const client = new Client({ name: "obsidian-panel-test", version: "1.0.0" });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [launcher],
      cwd: projectRoot,
      env: inheritedEnvironment({
        OBSIDIAN_FAKE_SCRIPT: fakeCli,
        OBSIDIAN_BRIDGE_MODE: "read",
        OBSIDIAN_BRIDGE_ALLOWED_FOLDERS: "EnvironmentOnly",
        OBSIDIAN_BRIDGE_SETTINGS_PATH: settingsPath,
        OBSIDIAN_FAKE_VAULT_PATH: directory,
      }),
      stderr: "pipe",
    });

    try {
      await client.connect(transport);
      const configuredVaults = await client.callTool({
        name: "obsidian_list_vaults",
        arguments: {},
      });
      expect(parseTextPayload(configuredVaults)).toEqual({
        vaults: [
          {
            name: "Test Vault",
            id: "0123456789abcdef",
            access_mode: "protected",
            management_permissions: {
              edit: false,
              move: false,
              trash: false,
            },
          },
        ],
      });
      const allowed = await client.callTool({
        name: "obsidian_read_note",
        arguments: { vault: "Test Vault", path: "Projects/Alpha.md" },
      });
      expect(allowed.isError).not.toBe(true);

      writeSettings("off");
      const revoked = await client.callTool({
        name: "obsidian_read_note",
        arguments: { vault: "Test Vault", path: "Projects/Alpha.md" },
      });
      expect(revoked.isError).toBe(true);

      const hiddenVaults = await client.callTool({
        name: "obsidian_list_vaults",
        arguments: {},
      });
      expect(hiddenVaults.isError).not.toBe(true);
      expect(parseTextPayload(hiddenVaults)).toEqual({ vaults: [] });
      const revokedInfo = await client.callTool({
        name: "obsidian_vault_info",
        arguments: { vault: "Test Vault" },
      });
      expect(revokedInfo.isError).toBe(true);

      writeFileSync(settingsPath, "{broken", "utf8");
      const malformed = await client.callTool({
        name: "obsidian_read_note",
        arguments: { vault: "Test Vault", path: "EnvironmentOnly/A.md" },
      });
      expect(malformed.isError).toBe(true);
      expect(JSON.stringify(malformed.content)).toContain("shared settings");

      const vaults = await client.callTool({
        name: "obsidian_list_vaults",
        arguments: {},
      });
      expect(vaults.isError).toBe(true);
      const info = await client.callTool({
        name: "obsidian_vault_info",
        arguments: { vault: "Test Vault" },
      });
      expect(info.isError).toBe(true);
    } finally {
      await client.close();
    }
  }, 20_000);
});
