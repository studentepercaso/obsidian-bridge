import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { scanCliCandidates } from "../src/shared-settings.js";

describe("non-executing CLI candidate detection", () => {
  const sandboxes: string[] = [];

  afterEach(async () => {
    await Promise.all(
      sandboxes.splice(0).map(async (sandbox) => {
        await rm(sandbox, { recursive: true, force: true });
      }),
    );
  });

  it("reports a known filesystem candidate without claiming readiness", async () => {
    const sandbox = await mkdtemp(join(tmpdir(), "bridge-cli-candidate-"));
    sandboxes.push(sandbox);
    const executable = join(sandbox, "Obsidian", "Obsidian.com");
    await mkdir(join(sandbox, "Obsidian"), { recursive: true });
    await writeFile(executable, "not executable and never launched", "utf8");

    const result = await scanCliCandidates(
      "windows",
      { ProgramFiles: sandbox },
      sandbox,
    );

    expect(result.candidate).toBe(executable);
    expect(result.candidates).toContainEqual({
      path: executable,
      source: "Program Files",
      exists: true,
    });
    expect(result).not.toHaveProperty("state");
    expect(result).not.toHaveProperty("version");
  });
});
