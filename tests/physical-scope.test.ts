import {
  link,
  mkdtemp,
  mkdir,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  PhysicalScopeError,
  assertPhysicalVaultPath,
} from "../src/physical-scope.js";

describe("physical vault scope", () => {
  let sandbox = "";
  let vaultRoot = "";

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "obsidian-physical-scope-"));
    vaultRoot = path.join(sandbox, "vault");
    await mkdir(path.join(vaultRoot, "Projects"), { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("returns the physical path for a normal existing target", async () => {
    const notePath = path.join(vaultRoot, "Projects", "Alpha.md");
    await writeFile(notePath, "# Alpha\n", "utf8");

    await expect(
      assertPhysicalVaultPath(vaultRoot, "Projects/Alpha.md"),
    ).resolves.toBe(await realpath(notePath));
  });

  it("rejects a symbolic link or junction that escapes the vault", async () => {
    const outside = path.join(sandbox, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, "Secret.md"), "secret\n", "utf8");
    await symlink(
      outside,
      path.join(vaultRoot, "Projects", "Linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      assertPhysicalVaultPath(vaultRoot, "Projects/Linked/Secret.md"),
    ).rejects.toThrow("symbolic link or filesystem junction");
  });

  it("rejects a hard-linked note whose inode is shared outside the vault", async () => {
    const outsideNote = path.join(sandbox, "outside-secret.md");
    const alias = path.join(vaultRoot, "Projects", "Alias.md");
    await writeFile(outsideNote, "secret\n", "utf8");
    await link(outsideNote, alias);

    await expect(
      assertPhysicalVaultPath(vaultRoot, "Projects/Alias.md"),
    ).rejects.toThrow("multiply-linked file");
  });

  it.each([
    "../Secret.md",
    "Projects/../../Secret.md",
    "Projects/./Alpha.md",
    "/etc/passwd",
    "C:\\Users\\Ada\\Secret.md",
    "C:Secret.md",
    "\\\\server\\share\\Secret.md",
    "Projects//Alpha.md",
    "Projects/Alpha.md\u0000ignored",
  ])("rejects an unsafe lexical path: %j", async (relativePath) => {
    await expect(
      assertPhysicalVaultPath(vaultRoot, relativePath, {
        allowMissingLeaf: true,
      }),
    ).rejects.toBeInstanceOf(PhysicalScopeError);
  });

  it("allows a missing leaf only when explicitly requested", async () => {
    const expected = path.join(
      await realpath(vaultRoot),
      "Projects",
      "New.md",
    );

    await expect(
      assertPhysicalVaultPath(vaultRoot, "Projects/New.md"),
    ).rejects.toThrow("path does not exist");
    await expect(
      assertPhysicalVaultPath(vaultRoot, "Projects/New.md", {
        allowMissingLeaf: true,
      }),
    ).resolves.toBe(expected);
  });

  it("allows missing ancestors for a contained create target", async () => {
    const expected = path.join(
      await realpath(vaultRoot),
      "New",
      "Nested",
      "Note.md",
    );

    await expect(
      assertPhysicalVaultPath(vaultRoot, "New/Nested/Note.md", {
        allowMissingLeaf: true,
      }),
    ).resolves.toBe(expected);
  });

  it("requires an absolute directory as the vault root", async () => {
    await expect(
      assertPhysicalVaultPath("relative/vault", "Projects/Alpha.md"),
    ).rejects.toThrow("vault root must be an absolute path");

    const fileRoot = path.join(sandbox, "not-a-directory");
    await writeFile(fileRoot, "not a vault", "utf8");
    await expect(
      assertPhysicalVaultPath(fileRoot, "Projects/Alpha.md"),
    ).rejects.toThrow("vault root must be a directory");
  });
});
