import { describe, expect, it } from "vitest";

import {
  PathPolicyError,
  assertFolderAllowed,
  assertPathAllowed,
  createPathPolicy,
  createWritablePathPolicy,
  filterAllowedPaths,
  isFolderAllowed,
  isPathAllowed,
  normalizeMarkdownPath,
  normalizeRelativeFolder,
} from "../src/path-policy.js";

describe("vault path policy", () => {
  it("normalizes backslashes but keeps paths vault-relative", () => {
    expect(normalizeMarkdownPath(" Projects\\Alpha.md ")).toBe(
      "Projects/Alpha.md",
    );
    expect(normalizeRelativeFolder(" Projects\\Active ")).toBe(
      "Projects/Active",
    );
  });

  it.each([
    "../Secret.md",
    "Projects/../../Secret.md",
    "Projects/./Alpha.md",
    "/etc/passwd.md",
    "C:\\Users\\Ada\\Secret.md",
    "C:Secret.md",
    "\\\\server\\share\\Secret.md",
    "Projects//Alpha.md",
    "Projects/Alpha.txt",
    "Projects/Alpha.md\u0000ignored",
  ])("rejects traversal, absolute, malformed, and non-Markdown path %j", (value) => {
    expect(() => normalizeMarkdownPath(value)).toThrow(PathPolicyError);
  });

  it.each([
    ".obsidian/workspace.md",
    ".trash/Deleted.md",
    "Projects/.private/Secret.md",
  ])("rejects every hidden path segment: %j", (value) => {
    const policy = createPathPolicy();
    expect(isPathAllowed(value, policy)).toBe(false);
    expect(() => assertPathAllowed(value, policy)).toThrow(PathPolicyError);
  });

  it("treats an empty allowlist as all non-denied folders", () => {
    const policy = createPathPolicy({ allowedFolders: [] });

    expect(policy.allowedFolders).toBeNull();
    expect(isPathAllowed("Projects/Alpha.md", policy)).toBe(true);
    expect(isPathAllowed("Journal/Today.md", policy)).toBe(true);
    expect(isPathAllowed(".obsidian/Config.md", policy)).toBe(false);
  });

  it("treats an empty writable allowlist as deny-all", () => {
    const policy = createWritablePathPolicy({ allowedFolders: [] });

    expect(policy.allowedFolders).toEqual([]);
    expect(isPathAllowed("Projects/Alpha.md", policy)).toBe(false);
    expect(() => assertPathAllowed("Projects/Alpha.md", policy)).toThrow(
      "outside the configured allowed folders",
    );
  });

  it("keeps writable scope narrower than an independent read scope", () => {
    const readPolicy = createPathPolicy({ allowedFolders: ["Projects"] });
    const writePolicy = createWritablePathPolicy({
      allowedFolders: ["Projects/Editable"],
    });

    expect(isPathAllowed("Projects/ReadOnly.md", readPolicy)).toBe(true);
    expect(isPathAllowed("Projects/ReadOnly.md", writePolicy)).toBe(false);
    expect(isPathAllowed("Projects/Editable/Allowed.md", writePolicy)).toBe(
      true,
    );
  });

  it("matches allowlist folder boundaries instead of string prefixes", () => {
    const policy = createPathPolicy({ allowedFolders: ["Projects"] });

    expect(isPathAllowed("Projects/Alpha.md", policy)).toBe(true);
    expect(isPathAllowed("Projects.md", policy)).toBe(false);
    expect(isPathAllowed("Projects-archive/Alpha.md", policy)).toBe(false);
  });

  it("gives the denylist precedence over a broader allowlist", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects"],
      deniedFolders: ["Projects/Private"],
    });

    expect(assertPathAllowed("Projects/Public.md", policy)).toBe(
      "Projects/Public.md",
    );
    expect(isPathAllowed("Projects/Private/Secret.md", policy)).toBe(false);
    expect(() =>
      assertPathAllowed("Projects/Private/Secret.md", policy),
    ).toThrow("denied folder");
  });

  it("applies deny rules case-insensitively when configured", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects"],
      deniedFolders: ["Projects/Private"],
      caseSensitive: false,
    });

    expect(isPathAllowed("PROJECTS/Public.md", policy)).toBe(true);
    expect(isPathAllowed("projects/private/Secret.md", policy)).toBe(false);
  });

  it("matches canonically equivalent Unicode folder names", () => {
    const composed = "Caf\u00e9";
    const decomposed = "Cafe\u0301";
    const policy = createPathPolicy({
      allowedFolders: [`Projects/${composed}`],
      deniedFolders: [`Projects/${composed}/Private`],
      caseSensitive: false,
    });

    expect(isPathAllowed(`Projects/${decomposed}/Note.md`, policy)).toBe(true);
    expect(
      isPathAllowed(`Projects/${decomposed}/Private/Secret.md`, policy),
    ).toBe(false);
  });

  it("allows a parent folder only when it intersects the allowlist", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects/Active"],
      deniedFolders: ["Projects/Active/Private"],
    });

    expect(assertFolderAllowed("", policy)).toBe("");
    expect(isFolderAllowed("Projects", policy)).toBe(true);
    expect(isFolderAllowed("Projects/Active", policy)).toBe(true);
    expect(isFolderAllowed("Projects/Other", policy)).toBe(false);
    expect(isFolderAllowed("Projects/Active/Private", policy)).toBe(false);
  });

  it("filters malformed, duplicate, hidden, denied, and non-allowlisted CLI paths", () => {
    const policy = createPathPolicy({
      allowedFolders: ["Projects"],
      deniedFolders: ["Projects/Private"],
    });

    expect(
      filterAllowedPaths(
        [
          "Projects\\Alpha.md",
          "Projects/Alpha.md",
          "Projects/Private/Secret.md",
          "Elsewhere/Note.md",
          ".obsidian/Config.md",
          "../Outside.md",
        ],
        policy,
      ),
    ).toEqual(["Projects/Alpha.md"]);
  });
});
