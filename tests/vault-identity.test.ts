import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createPathPolicy, createWritablePathPolicy } from "../src/path-policy.js";
import type { VaultAccess } from "../src/shared-settings.js";
import { assertVaultIdentity } from "../src/vault-identity.js";

function access(vaultPath: string): VaultAccess {
  return {
    readPolicy: createPathPolicy({ allowedFolders: null }),
    writablePolicy: createWritablePathPolicy({ allowedFolders: ["Bridge Test"] }),
    writeEnabled: true,
    accessMode: "protected",
    managementPermissions: { edit: false, move: false, trash: false },
    vaultSelector: "0123456789abcdef",
    vaultName: "Test Vault",
    vaultPath,
    source: "settings",
  };
}

describe("stable vault identity", () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  });

  async function directory(): Promise<string> {
    const result = await mkdtemp(join(tmpdir(), "obsidian-vault-identity-"));
    directories.push(result);
    return result;
  }

  it("targets the stable ID and accepts the registered physical root", async () => {
    const root = await directory();
    const runner = vi.fn(async (args: readonly string[]) => ({
      stdout: root,
      stderr: "",
      exitCode: 0 as const,
    }));

    await expect(assertVaultIdentity(runner, access(root))).resolves.toBeUndefined();
    expect(runner).toHaveBeenCalledWith(
      ["vault=0123456789abcdef", "vault", "info=path"],
      {},
    );
  });

  it("fails closed if the ID resolves to a different folder", async () => {
    const expected = await directory();
    const actual = await directory();
    const runner = vi.fn(async () => ({
      stdout: actual,
      stderr: "",
      exitCode: 0 as const,
    }));

    await expect(assertVaultIdentity(runner, access(expected))).rejects.toThrow(
      /identity mismatch/iu,
    );
  });

  it("does not invent a physical identity for legacy environment grants", async () => {
    const runner = vi.fn();
    const { vaultPath: _vaultPath, ...base } = access(await directory());
    const legacy: VaultAccess = {
      ...base,
      vaultSelector: "Test Vault",
      vaultName: "Test Vault",
      source: "environment",
    };
    await expect(assertVaultIdentity(runner, legacy)).resolves.toBeUndefined();
    expect(runner).not.toHaveBeenCalled();
  });
});
