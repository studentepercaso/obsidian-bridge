import {
  link,
  mkdtemp,
  mkdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { readExactVaultDocument } from "../src/exact-vault-document.js";
import { hashDocumentState } from "../src/write-workflow.js";

describe("exact physical vault document reader", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function temporaryDirectory(prefix: string): Promise<string> {
    const directory = await mkdtemp(path.join(tmpdir(), prefix));
    temporaryDirectories.push(directory);
    return directory;
  }

  it.each([
    ["when empty", Buffer.alloc(0)],
    ["without a final newline", Buffer.from("last line", "utf8")],
    ["with a final LF", Buffer.from("last line\n", "utf8")],
    ["with CRLF", Buffer.from("first\r\nlast\r\n", "utf8")],
    [
      "with a UTF-8 BOM",
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from("heading\n", "utf8"),
      ]),
    ],
    ["with decomposed Unicode", Buffer.from("Cafe\u0301\n", "utf8")],
  ])("preserves %s byte-for-byte", async (_label, expectedBytes) => {
    const vault = await temporaryDirectory("exact-vault-document-");
    const notePath = "Folder/Note.md";
    await mkdir(path.join(vault, "Folder"));
    await writeFile(path.join(vault, ...notePath.split("/")), expectedBytes);

    const result = await readExactVaultDocument(vault, notePath, {
      allowMissing: false,
      maxBytes: 1_048_576,
    });

    expect(result.exists).toBe(true);
    if (!result.exists) throw new Error("expected an existing document");
    expect(Buffer.from(result.content, "utf8")).toEqual(expectedBytes);
    expect(hashDocumentState(true, result.content)).toBe(
      hashDocumentState(true, expectedBytes.toString("utf8")),
    );
    if (_label === "with a UTF-8 BOM") {
      expect(result.content.codePointAt(0)).toBe(0xfeff);
    }
    if (_label === "with decomposed Unicode") {
      expect(result.content).toContain("e\u0301");
      expect(result.content).not.toContain("\u00e9");
    }
  });

  it("returns a stable absent state only when missing targets are allowed", async () => {
    const vault = await temporaryDirectory("exact-vault-missing-");

    await expect(
      readExactVaultDocument(vault, "Missing/Note.md", {
        allowMissing: true,
        maxBytes: 100,
      }),
    ).resolves.toEqual({ exists: false });
    await expect(
      readExactVaultDocument(vault, "Missing/Note.md", {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/does not exist|path does not exist/iu);
  });

  it("rejects a file larger than the configured document bound", async () => {
    const vault = await temporaryDirectory("exact-vault-large-");
    await writeFile(path.join(vault, "Large.md"), Buffer.alloc(9, 0x61));

    await expect(
      readExactVaultDocument(vault, "Large.md", {
        allowMissing: false,
        maxBytes: 8,
      }),
    ).rejects.toThrow(/must not exceed 8/iu);
  });

  it("rejects malformed UTF-8 instead of replacing invalid bytes", async () => {
    const vault = await temporaryDirectory("exact-vault-utf8-");
    await writeFile(
      path.join(vault, "Invalid.md"),
      Buffer.from([0x66, 0x6f, 0x80, 0x6f]),
    );

    await expect(
      readExactVaultDocument(vault, "Invalid.md", {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/not valid UTF-8/iu);
  });

  it("preserves a pre-aborted signal reason", async () => {
    const vault = await temporaryDirectory("exact-vault-abort-");
    await writeFile(path.join(vault, "Note.md"), "content", "utf8");
    const controller = new AbortController();
    const reason = new Error("test cancellation");
    controller.abort(reason);

    await expect(
      readExactVaultDocument(vault, "Note.md", {
        allowMissing: false,
        maxBytes: 100,
        signal: controller.signal,
      }),
    ).rejects.toBe(reason);
  });

  it("rejects a path crossing a directory symlink or Windows junction", async () => {
    const vault = await temporaryDirectory("exact-vault-link-");
    const outside = await temporaryDirectory("exact-vault-outside-");
    await writeFile(path.join(outside, "Outside.md"), "secret\n", "utf8");
    await symlink(
      outside,
      path.join(vault, "Linked"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      readExactVaultDocument(vault, "Linked/Outside.md", {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/symbolic link|junction/iu);
  });

  it("rejects a multiply-linked leaf file", async () => {
    const vault = await temporaryDirectory("exact-vault-hardlink-");
    const outside = await temporaryDirectory("exact-vault-hardlink-outside-");
    const source = path.join(outside, "Source.md");
    await writeFile(source, "shared content\n", "utf8");
    await link(source, path.join(vault, "Alias.md"));

    await expect(
      readExactVaultDocument(vault, "Alias.md", {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/multiply-linked|multiple filesystem links/iu);
  });

  it.skipIf(process.platform === "win32")(
    "rejects a symbolic-link leaf even when it points inside the vault",
    async () => {
      const vault = await temporaryDirectory("exact-vault-leaf-link-");
      await writeFile(path.join(vault, "Real.md"), "content\n", "utf8");
      await symlink("Real.md", path.join(vault, "Alias.md"), "file");

      await expect(
        readExactVaultDocument(vault, "Alias.md", {
          allowMissing: false,
          maxBytes: 100,
        }),
      ).rejects.toThrow(/symbolic link|junction/iu);
    },
  );

  it("rejects traversal before any file is opened", async () => {
    const vault = await temporaryDirectory("exact-vault-contained-");

    await expect(
      readExactVaultDocument(vault, "../Outside.md", {
        allowMissing: true,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/traversal|outside/iu);
  });
});
