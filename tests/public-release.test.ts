import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

function readJson(relativePath: string): Record<string, unknown> {
  return JSON.parse(
    readFileSync(new URL(`../${relativePath}`, import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

describe("public release metadata", () => {
  it("keeps package, Codex and companion versions aligned", () => {
    const packageJson = readJson("package.json");
    const plugin = readJson(".codex-plugin/plugin.json");
    const companion = readJson(
      "companion/obsidian-bridge-control/manifest.json",
    );

    expect(packageJson.version).toBe("0.4.1");
    expect(plugin.version).toBe("0.4.1");
    expect(companion.version).toBe("0.4.1");
  });

  it("publishes a pinned Git-backed Codex marketplace entry", () => {
    const marketplace = readJson(".agents/plugins/marketplace.json") as {
      name: string;
      plugins: Array<{
        name: string;
        source: Record<string, string>;
        policy: Record<string, string>;
        category: string;
      }>;
    };

    expect(marketplace.name).toBe("obsidian-bridge-community");
    expect(marketplace.plugins).toEqual([
      {
        name: "obsidian-bridge",
        source: {
          source: "url",
          url: "https://github.com/studentepercaso/obsidian-bridge.git",
          ref: "0.4.1",
        },
        policy: {
          installation: "AVAILABLE",
          authentication: "ON_INSTALL",
        },
        category: "Productivity",
      },
    ]);
  });

  it("contains English and Italian entry documentation", () => {
    expect(readFileSync(new URL("../README.md", import.meta.url), "utf8")).toContain(
      "[Italiano](README.it.md)",
    );
    expect(
      readFileSync(new URL("../README.it.md", import.meta.url), "utf8"),
    ).toContain("[English](README.md)");
  });

  it("keeps protected and autonomous writers in separate approval domains", () => {
    const mcp = readJson(".mcp.json") as {
      mcpServers: Record<
        string,
        {
          args: string[];
          default_tools_approval_mode: string;
          env_vars: string[];
        }
      >;
    };

    expect(Object.keys(mcp.mcpServers)).toEqual([
      "obsidian",
      "obsidian-writer",
      "obsidian-autonomous-writer",
    ]);
    expect(mcp.mcpServers.obsidian).toMatchObject({
      args: ["./dist/server.mjs", "--mode=read"],
      default_tools_approval_mode: "auto",
    });
    expect(mcp.mcpServers.obsidian?.env_vars).toContain(
      "OBSIDIAN_BRIDGE_DATA_DIR",
    );
    expect(mcp.mcpServers["obsidian-writer"]).toMatchObject({
      args: ["./dist/server.mjs", "--mode=write"],
      default_tools_approval_mode: "prompt",
    });
    expect(mcp.mcpServers["obsidian-autonomous-writer"]).toMatchObject({
      args: ["./dist/server.mjs", "--mode=autonomous"],
      default_tools_approval_mode: "auto",
    });
  });
});
