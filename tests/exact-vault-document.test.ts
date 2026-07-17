import {
  link,
  mkdtemp,
  mkdir,
  open,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
  type FileHandle,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { afterEach, describe, expect, it, vi } from "vitest";

import { readExactVaultDocument } from "../src/exact-vault-document.js";
import { hashDocumentState } from "../src/write-workflow.js";

describe("exact physical vault document reader", () => {
  const temporaryDirectories: string[] = [];

  type PositionalRead = (
    this: FileHandle,
    buffer: Buffer,
    offset: number,
    length: number,
    position: number,
  ) => Promise<{ bytesRead: number; buffer: Buffer }>;

  afterEach(async () => {
    vi.restoreAllMocks();
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

  async function injectAfterPass(
    filePath: string,
    expectedBytes: number,
    targetPass: number | "every",
    action: (completedPass: number) => Promise<void>,
  ): Promise<() => boolean> {
    const probe = await open(filePath, "r");
    const prototype = Object.getPrototypeOf(probe) as {
      read: PositionalRead;
    };
    const originalRead = prototype.read;
    await probe.close();

    let injected = false;
    let completedPasses = 0;
    vi.spyOn(prototype, "read").mockImplementation(async function (
      this: FileHandle,
      buffer: Buffer,
      offset: number,
      length: number,
      position: number,
    ) {
      const result = await originalRead.call(
        this,
        buffer,
        offset,
        length,
        position,
      );
      if (
        position === expectedBytes &&
        length === 1 &&
        result.bytesRead === 0
      ) {
        completedPasses += 1;
        if (targetPass === "every" || completedPasses === targetPass) {
          injected = true;
          await action(completedPasses);
        }
      }
      return result;
    });
    return () => injected;
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

  it("accepts ctime-only metadata churn when both byte reads agree", async () => {
    const vault = await temporaryDirectory("exact-vault-ctime-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const content = Buffer.from("stable content\n", "utf8");
    await writeFile(filePath, content);
    const fixedMtime = new Date("2026-01-02T03:04:05.000Z");
    const firstAtime = new Date("2026-01-02T03:04:06.000Z");
    await utimes(filePath, firstAtime, fixedMtime);
    const before = await stat(filePath, { bigint: true });

    const wasInjected = await injectAfterPass(
      filePath,
      content.byteLength,
      1,
      async () => {
        await utimes(
          filePath,
          new Date("2026-01-02T03:04:07.000Z"),
          fixedMtime,
        );
      },
    );

    const result = await readExactVaultDocument(vault, notePath, {
      allowMissing: false,
      maxBytes: 100,
    });
    const after = await stat(filePath, { bigint: true });

    expect(wasInjected()).toBe(true);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    expect(after.ctimeNs).not.toBe(before.ctimeNs);
    expect(result).toEqual({ exists: true, content: content.toString("utf8") });
  });

  it("settles ctime-only churn on the second read with a third pass", async () => {
    const vault = await temporaryDirectory("exact-vault-late-ctime-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const content = Buffer.from("stable content\n", "utf8");
    const fixedMtime = new Date("2026-01-03T03:04:05.000Z");
    await writeFile(filePath, content);
    await utimes(
      filePath,
      new Date("2026-01-03T03:04:06.000Z"),
      fixedMtime,
    );

    const wasInjected = await injectAfterPass(
      filePath,
      content.byteLength,
      2,
      async () => {
        await utimes(
          filePath,
          new Date("2026-01-03T03:04:07.000Z"),
          fixedMtime,
        );
      },
    );

    await expect(
      readExactVaultDocument(vault, notePath, {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).resolves.toEqual({
      exists: true,
      content: content.toString("utf8"),
    });
    expect(wasInjected()).toBe(true);
  });

  it("fails closed when ctime-only metadata churn never settles", async () => {
    const vault = await temporaryDirectory("exact-vault-continuous-ctime-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const content = Buffer.from("stable content\n", "utf8");
    const fixedMtime = new Date("2026-01-04T03:04:05.000Z");
    const atimeBase = Date.parse("2026-01-04T03:04:06.000Z");
    await writeFile(filePath, content);
    await utimes(filePath, new Date(atimeBase), fixedMtime);

    const wasInjected = await injectAfterPass(
      filePath,
      content.byteLength,
      "every",
      async (completedPass) => {
        const before = await stat(filePath, { bigint: true });
        for (let attempt = 0; attempt < 5; attempt += 1) {
          await delay(2);
          await utimes(
            filePath,
            new Date(
              atimeBase + completedPass * 10_000 + attempt * 1_000,
            ),
            fixedMtime,
          );
          const after = await stat(filePath, { bigint: true });
          if (after.ctimeNs !== before.ctimeNs) return;
        }
        throw new Error("test could not produce ctime-only churn");
      },
    );

    await expect(
      readExactVaultDocument(vault, notePath, {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/metadata did not settle during bounded verification/iu);
    expect(wasInjected()).toBe(true);
  });

  it("rejects same-size byte changes even when mtime is restored", async () => {
    const vault = await temporaryDirectory("exact-vault-byte-change-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const beforeContent = Buffer.from("alpha\n", "utf8");
    const afterContent = Buffer.from("omega\n", "utf8");
    const fixedMtime = new Date("2026-02-03T04:05:06.000Z");
    const fixedAtime = new Date("2026-02-03T04:05:07.000Z");
    await writeFile(filePath, beforeContent);
    await utimes(filePath, fixedAtime, fixedMtime);

    const wasInjected = await injectAfterPass(
      filePath,
      beforeContent.byteLength,
      1,
      async () => {
        await writeFile(filePath, afterContent);
        await utimes(filePath, fixedAtime, fixedMtime);
      },
    );

    await expect(
      readExactVaultDocument(vault, notePath, {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/bytes changed between verification reads/iu);
    expect(wasInjected()).toBe(true);
  });

  it("rejects a same-size byte change after the second verification read", async () => {
    const vault = await temporaryDirectory("exact-vault-late-byte-change-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const beforeContent = Buffer.from("alpha\n", "utf8");
    const afterContent = Buffer.from("omega\n", "utf8");
    const fixedMtime = new Date("2026-02-04T04:05:06.000Z");
    const fixedAtime = new Date("2026-02-04T04:05:07.000Z");
    await writeFile(filePath, beforeContent);
    await utimes(filePath, fixedAtime, fixedMtime);

    const wasInjected = await injectAfterPass(
      filePath,
      beforeContent.byteLength,
      2,
      async () => {
        await writeFile(filePath, afterContent);
        await utimes(filePath, fixedAtime, fixedMtime);
      },
    );

    await expect(
      readExactVaultDocument(vault, notePath, {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/bytes changed between verification reads/iu);
    expect(wasInjected()).toBe(true);
  });

  it("continues to reject modification-time churn", async () => {
    const vault = await temporaryDirectory("exact-vault-mtime-");
    const notePath = "Note.md";
    const filePath = path.join(vault, notePath);
    const content = Buffer.from("stable content\n", "utf8");
    const initialMtime = new Date("2026-03-04T05:06:07.000Z");
    await writeFile(filePath, content);
    await utimes(filePath, initialMtime, initialMtime);

    const wasInjected = await injectAfterPass(
      filePath,
      content.byteLength,
      1,
      async () => {
        const changedMtime = new Date("2026-03-04T05:06:08.000Z");
        await utimes(filePath, changedMtime, changedMtime);
      },
    );

    await expect(
      readExactVaultDocument(vault, notePath, {
        allowMissing: false,
        maxBytes: 100,
      }),
    ).rejects.toThrow(/modification time changed while it was being read/iu);
    expect(wasInjected()).toBe(true);
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
