import { readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CLI_IPC_FRAME_BYTES,
  ObsidianCliError,
  cliIpcFrameBytes,
  encodeCliContent,
  type ObsidianCliRunner,
} from "../src/cli.js";
import { commitLockPath } from "../src/commit-lock.js";
import {
  createPathPolicy,
  createWritablePathPolicy,
} from "../src/path-policy.js";
import type { VaultAccessResolver } from "../src/shared-settings.js";
import {
  FileChangeStorage,
  PreparedChangeStore,
  WriteToolInputSchemas,
  createWriteToolHandlers,
  hashDocumentState,
  splitCliWriteContent,
  type AuditEvent,
  type BackupInput,
  type ChangeStorage,
} from "../src/write-workflow.js";

function resultJson(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected one MCP text result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function parameter(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args.find((argument) => argument.startsWith(prefix))?.slice(prefix.length);
}

function decodeCliContent(value: string): string {
  return value.replace(/\\n/gu, "\n").replace(/\\t/gu, "\t");
}

function createMemoryRunner(
  notes: Record<string, string>,
  invocations: string[][],
  corruptNextWrite = false,
  throwAfterNextWrite = false,
  throwOnWriteNumber?: number,
): ObsidianCliRunner {
  let writeNumber = 0;
  return async (args) => {
    invocations.push([...args]);
    const command = args[1];
    const notePath = parameter(args, "path");
    if (notePath === undefined) throw new Error("path is required by memory runner");

    if (command === "read") {
      if (!(notePath in notes)) {
        throw new ObsidianCliError("NON_ZERO_EXIT", "Note not found", 2);
      }
      return { stdout: notes[notePath]!, stderr: "", exitCode: 0 };
    }

    const content = decodeCliContent(parameter(args, "content") ?? "");
    if (command === "create") {
      writeNumber += 1;
      if (notePath in notes && !args.includes("overwrite")) {
        throw new ObsidianCliError("NON_ZERO_EXIT", "Note already exists", 3);
      }
      notes[notePath] = corruptNextWrite ? `${content}CORRUPTED` : content;
      corruptNextWrite = false;
      if (throwAfterNextWrite || writeNumber === throwOnWriteNumber) {
        throwAfterNextWrite = false;
        throw new ObsidianCliError("NON_ZERO_EXIT", "error after side effect", 7);
      }
      return { stdout: notePath, stderr: "", exitCode: 0 };
    }
    if (command === "append") {
      writeNumber += 1;
      if (!(notePath in notes)) {
        throw new ObsidianCliError("NON_ZERO_EXIT", "Note not found", 2);
      }
      notes[notePath] = `${notes[notePath]}${content}${
        corruptNextWrite ? "CORRUPTED" : ""
      }`;
      corruptNextWrite = false;
      if (throwAfterNextWrite || writeNumber === throwOnWriteNumber) {
        throwAfterNextWrite = false;
        throw new ObsidianCliError("NON_ZERO_EXIT", "error after side effect", 7);
      }
      return { stdout: notePath, stderr: "", exitCode: 0 };
    }
    throw new Error(`unexpected command ${command}`);
  };
}

function fixedStore(now: () => number = () => 1_000): PreparedChangeStore {
  let next = 0;
  return new PreparedChangeStore({
    ttlMs: 60_000,
    now,
    createId: () => `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  });
}

function runtime(
  runner: ObsidianCliRunner,
  storage: ChangeStorage,
  store = fixedStore(),
  resolveAccess?: VaultAccessResolver,
  options: {
    authorizationMode?: "protected" | "autonomous";
    dataDirectory?: string;
  } = {},
) {
  return createWriteToolHandlers({
    runner,
    readPolicy: createPathPolicy({ allowedFolders: ["Projects"] }),
    writableVaults: ["Test Vault"],
    writablePolicy: createWritablePathPolicy({
      allowedFolders: ["Projects/Editable"],
    }),
    store,
    storage,
    ...(resolveAccess === undefined ? {} : { resolveAccess }),
    ...(options.authorizationMode === undefined
      ? {}
      : { authorizationMode: options.authorizationMode }),
    ...(options.dataDirectory === undefined
      ? {}
      : { dataDirectory: options.dataDirectory }),
    now: () => 1_000,
  });
}

describe("write workflow schemas and storage", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-write-unit-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("strictly validates operations, ambiguous CLI escapes, UUIDs, and UTF-8 bytes", () => {
    const base = {
      vault: "Test Vault",
      path: "Projects/Editable/Note.md",
      content: "ok",
    };
    expect(
      WriteToolInputSchemas.prepareChange.safeParse({
        ...base,
        operation: "create",
        start_line: 1,
      }).success,
    ).toBe(false);
    expect(
      WriteToolInputSchemas.prepareChange.safeParse({
        ...base,
        operation: "replace_lines",
      }).success,
    ).toBe(false);
    expect(
      WriteToolInputSchemas.prepareChange.safeParse({
        ...base,
        operation: "append",
        content: String.raw`C:\notes`,
      }).success,
    ).toBe(false);
    expect(
      WriteToolInputSchemas.prepareChange.safeParse({
        ...base,
        operation: "create",
        content: "é".repeat(4_097),
      }).success,
    ).toBe(false);
    expect(
      WriteToolInputSchemas.prepareChange.safeParse({
        ...base,
        operation: "create",
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      WriteToolInputSchemas.commitChange.safeParse({ change_id: "guessable" })
        .success,
    ).toBe(false);
  });

  it("splits long Unicode content into complete, IPC-safe code-point chunks", () => {
    const content = "Titolo 😀\nRiga con accenti èòà e tab\t".repeat(180);
    const chunks = splitCliWriteContent(
      "0123456789abcdef",
      "Projects/Editable/Long note.md",
      content,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join("")).toBe(content);
    for (let index = 0; index < chunks.length; index += 1) {
      const chunk = chunks[index]!;
      const args = [
        "vault=0123456789abcdef",
        "create",
        "path=Projects/Editable/Long note.md",
        `content=${encodeCliContent(chunk)}`,
        "overwrite",
      ];
      expect(cliIpcFrameBytes(args)).toBeLessThanOrEqual(
        MAX_CLI_IPC_FRAME_BYTES,
      );
      if (index < chunks.length - 1) {
        const last = chunk.charCodeAt(chunk.length - 1);
        const next = chunks[index + 1]!.charCodeAt(0);
        expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
        expect(next >= 0xdc00 && next <= 0xdfff).toBe(false);
      }
    }
  });

  it("expires IDs with an injected clock and consumes every ID once", () => {
    let now = 10_000;
    const store = fixedStore(() => now);
    const change = store.create({
      vault: "Test Vault",
      vaultLabel: "Test Vault",
      notePath: "Projects/Editable/Note.md",
      operation: "create",
      authorizationMode: "protected",
      lockCaseSensitive: true,
      before: { exists: false, sha256: hashDocumentState(false) },
      afterContent: "new",
      commandContent: "new",
      afterSha256: hashDocumentState(true, "new"),
      previewDiff: "+new",
      beforeLineCount: 0,
      afterLineCount: 1,
    });

    now += 60_000;
    expect(() => store.take(change.changeId)).toThrow(/expired|unknown|consumed/iu);
    expect(store.size).toBe(0);

    now += 1;
    const fresh = store.create({
      vault: "Test Vault",
      vaultLabel: "Test Vault",
      notePath: "Projects/Editable/Note.md",
      operation: "create",
      authorizationMode: "protected",
      lockCaseSensitive: true,
      before: { exists: false, sha256: hashDocumentState(false) },
      afterContent: "new",
      commandContent: "new",
      afterSha256: hashDocumentState(true, "new"),
      previewDiff: "+new",
      beforeLineCount: 0,
      afterLineCount: 1,
    });
    expect(store.take(fresh.changeId)).toBe(fresh);
    expect(() => store.take(fresh.changeId)).toThrow(/expired|unknown|consumed/iu);
  });

  it("rejects a diff whose preview would exceed the bounded MCP output", async () => {
    const notes: Record<string, string> = {};
    const invocations: string[][] = [];
    const storage: ChangeStorage = {
      async createBackup() {
        throw new Error("backup must not be reached during prepare");
      },
      async appendAudit() {},
    };
    const handlers = runtime(createMemoryRunner(notes, invocations), storage);

    await expect(
      handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/New.md",
          operation: "create",
          content: "\n".repeat(8_192),
        }),
      ),
    ).rejects.toThrow(/preview.*exceed/iu);
    expect(notes).toEqual({});
    expect(invocations.every((args) => args[1] === "read")).toBe(true);
  });

  it("treats the official zero-exit missing-file diagnostic as an absent note", async () => {
    const invocations: string[][] = [];
    const runner: ObsidianCliRunner = async (args) => {
      invocations.push([...args]);
      const notePath = parameter(args, "path") ?? "";
      throw new ObsidianCliError(
        "CLI_REPORTED_ERROR",
        `Error: File "${notePath}" not found.`,
      );
    };
    const storage: ChangeStorage = {
      async createBackup() {
        throw new Error("backup must not be reached during prepare");
      },
      async appendAudit() {},
    };
    const handlers = runtime(runner, storage);

    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/New.md",
          operation: "create",
          content: "preview only",
        }),
      ),
    );

    expect(prepared).toMatchObject({
      status: "prepared",
      operation: "create",
      path: "Projects/Editable/New.md",
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.[1]).toBe("read");
  });

  it("does not reinterpret other zero-exit CLI errors as a missing note", async () => {
    const runner: ObsidianCliRunner = async () => {
      throw new ObsidianCliError(
        "CLI_REPORTED_ERROR",
        "Error: Missing required parameter: query=<text>\nUsage: obsidian search query=<text>",
      );
    };
    const storage: ChangeStorage = {
      async createBackup() {
        throw new Error("backup must not be reached during prepare");
      },
      async appendAudit() {},
    };
    const handlers = runtime(runner, storage);

    await expect(
      handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/New.md",
          operation: "create",
          content: "must not prepare",
        }),
      ),
    ).rejects.toMatchObject({ code: "CLI_REPORTED_ERROR" });
  });

  it("creates a backup before append and records content-free audit metadata", async () => {
    const notes = { "Projects/Editable/Note.md": "SECRET-BEFORE\n" };
    const invocations: string[][] = [];
    const backups: BackupInput[] = [];
    const audits: AuditEvent[] = [];
    const storage: ChangeStorage = {
      async createBackup(input) {
        backups.push(input);
        return { backupId: "backup-1" };
      },
      async appendAudit(event) {
        audits.push(event);
      },
    };
    const handlers = runtime(createMemoryRunner(notes, invocations), storage);
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "SECRET-AFTER\n",
        }),
      ),
    );
    expect(notes["Projects/Editable/Note.md"]).toBe("SECRET-BEFORE\n");

    const committed = resultJson(
      await handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    );

    expect(backups).toHaveLength(1);
    expect(backups[0]?.content).toBe("SECRET-BEFORE\n");
    expect(notes["Projects/Editable/Note.md"]).toBe(
      "SECRET-BEFORE\nSECRET-AFTER\n",
    );
    expect(committed).toMatchObject({
      status: "committed",
      verified: true,
      backup_id: "backup-1",
      audit_recorded: true,
    });
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "committed", backup_id: "backup-1" });
    expect(JSON.stringify(audits)).not.toContain("SECRET-BEFORE");
    expect(JSON.stringify(audits)).not.toContain("SECRET-AFTER");
    const appendIndex = invocations.findIndex((args) => args[1] === "append");
    expect(appendIndex).toBeGreaterThan(1);
  });

  it("creates a long note through verified IPC-safe create and append chunks", async () => {
    const notes: Record<string, string> = {};
    const invocations: string[][] = [];
    const content = "Voce chunked 😀 con accenti è.\n".repeat(180);
    const handlers = runtime(createMemoryRunner(notes, invocations), {
      async createBackup() {
        throw new Error("create must not make a backup");
      },
      async appendAudit() {},
    });
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Long create.md",
          operation: "create",
          content,
        }),
      ),
    );

    const committed = resultJson(
      await handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    );
    const writes = invocations.filter(
      (args) => args[1] === "create" || args[1] === "append",
    );

    expect(committed).toMatchObject({ status: "committed", verified: true });
    expect(notes["Projects/Editable/Long create.md"]).toBe(content);
    expect(writes.filter((args) => args[1] === "create")).toHaveLength(1);
    expect(writes.filter((args) => args[1] === "append").length).toBeGreaterThan(0);
    expect(writes.every((args) => cliIpcFrameBytes(args) <= MAX_CLI_IPC_FRAME_BYTES)).toBe(true);
    expect(
      writes
        .filter((args) => args[1] === "append")
        .every((args) => args.includes("inline")),
    ).toBe(true);
  });

  it("appends long content in verified chunks while creating one backup", async () => {
    const notes = { "Projects/Editable/Long append.md": "original\n" };
    const invocations: string[][] = [];
    const backups: BackupInput[] = [];
    const content = "Aggiunta chunked 😀 con accenti è.\n".repeat(170);
    const handlers = runtime(createMemoryRunner(notes, invocations), {
      async createBackup(input) {
        backups.push(input);
        return { backupId: "long-backup" };
      },
      async appendAudit() {},
    });
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Long append.md",
          operation: "append",
          content,
        }),
      ),
    );

    const committed = resultJson(
      await handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    );
    const appends = invocations.filter((args) => args[1] === "append");

    expect(committed).toMatchObject({
      status: "committed",
      verified: true,
      backup_id: "long-backup",
    });
    expect(backups).toHaveLength(1);
    expect(notes["Projects/Editable/Long append.md"]).toBe(`original\n${content}`);
    expect(appends.length).toBeGreaterThan(1);
    expect(appends.every((args) => args.includes("inline"))).toBe(true);
    expect(appends.every((args) => cliIpcFrameBytes(args) <= MAX_CLI_IPC_FRAME_BYTES)).toBe(true);
  });

  it("recognizes a failed intermediate chunk and restores a small original", async () => {
    const notes = { "Projects/Editable/Chunk failure.md": "original\n" };
    const invocations: string[][] = [];
    const content = "Second-stage failure payload 😀.\n".repeat(180);
    const handlers = runtime(
      createMemoryRunner(notes, invocations, false, false, 2),
      {
        async createBackup() {
          return { backupId: "chunk-failure-backup" };
        },
        async appendAudit() {},
      },
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Chunk failure.md",
          operation: "append",
          content,
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "failed",
      error: "write_failed",
      rollback_attempted: true,
      rollback_succeeded: true,
      rollback_reason: "restored",
      backup_id: "chunk-failure-backup",
    });
    expect(notes["Projects/Editable/Chunk failure.md"]).toBe("original\n");
    expect(invocations.filter((args) => args[1] === "append").length).toBe(2);
  });

  it("reports a partial long create for manual review when deletion is disabled", async () => {
    const notes: Record<string, string> = {};
    const invocations: string[][] = [];
    const audits: AuditEvent[] = [];
    const content = "Creazione parziale controllata 😀.\n".repeat(180);
    const handlers = runtime(
      createMemoryRunner(notes, invocations, false, false, 2),
      {
        async createBackup() {
          throw new Error("create must not make a backup");
        },
        async appendAudit(event) {
          audits.push(event);
        },
      },
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Partial create.md",
          operation: "create",
          content,
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );

    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "failed",
      error: "write_failed",
      verified: false,
      rollback_attempted: false,
      rollback_succeeded: false,
      rollback_reason: "delete_disabled",
    });
    expect(notes["Projects/Editable/Partial create.md"]).toBeDefined();
    expect(notes["Projects/Editable/Partial create.md"]).not.toBe(content);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: "failed",
      error_code: "WRITE_FAILED_ROLLBACK_FAILED",
    });
  });

  it("does not mutate when creating the pre-write backup fails", async () => {
    const notes = { "Projects/Editable/Note.md": "original\n" };
    const invocations: string[][] = [];
    const audits: AuditEvent[] = [];
    const storage: ChangeStorage = {
      async createBackup() {
        throw new Error("backup disk unavailable");
      },
      async appendAudit(event) {
        audits.push(event);
      },
    };
    const handlers = runtime(createMemoryRunner(notes, invocations), storage);
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "must-not-land\n",
        }),
      ),
    );

    await expect(
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    ).rejects.toThrow("backup disk unavailable");
    expect(notes["Projects/Editable/Note.md"]).toBe("original\n");
    expect(invocations.some((args) => args[1] === "append")).toBe(false);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: "failed",
      error_code: "PRE_WRITE_FAILED",
    });
    expect(JSON.stringify(audits)).not.toContain("must-not-land");
    await expect(
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    ).rejects.toThrow(/expired|unknown|consumed/iu);
  });

  it("returns a structured failure and restores the backup after verification mismatch", async () => {
    const notes = { "Projects/Editable/Note.md": "original\n" };
    const invocations: string[][] = [];
    const audits: AuditEvent[] = [];
    const storage: ChangeStorage = {
      async createBackup() {
        return { backupId: "rollback-backup" };
      },
      async appendAudit(event) {
        audits.push(event);
      },
    };
    const handlers = runtime(
      createMemoryRunner(notes, invocations, false, true),
      storage,
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "proposed\n",
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "failed",
      error: "write_failed",
      verified: false,
      rollback_attempted: true,
      rollback_succeeded: true,
      rollback_reason: "restored",
      backup_id: "rollback-backup",
    });
    expect(notes["Projects/Editable/Note.md"]).toBe("original\n");
    expect(invocations.some((args) => args[1] === "append")).toBe(true);
    expect(
      invocations.some(
        (args) => args[1] === "create" && args.includes("overwrite"),
      ),
    ).toBe(true);
    expect(audits.at(-1)).toMatchObject({
      status: "failed",
      error_code: "WRITE_FAILED_ROLLBACK_SUCCEEDED",
    });
  });

  it.each([
    {
      label: "an original containing a literal CLI escape",
      original: `${String.raw`original \\n marker`}\n`,
      reason: "restore_unrepresentable",
    },
    {
      label: "an original containing CRLF line endings",
      original: "original\r\nline\r\n",
      reason: "restore_unrepresentable",
    },
    {
      label: "an original too large for one lossless overwrite",
      original: "a\n".repeat(5_000),
      reason: "restore_too_large",
    },
  ])("keeps the backup and avoids destructive multi-step rollback for $label", async ({
    original,
    reason,
  }) => {
    const notes = { "Projects/Editable/Note.md": original };
    const invocations: string[][] = [];
    const handlers = runtime(
      createMemoryRunner(notes, invocations, false, true),
      {
        async createBackup() {
          return { backupId: "manual-recovery-backup" };
        },
        async appendAudit() {},
      },
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "safe addition\n",
        }),
      ),
    );

    const result = resultJson(
      await handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    );
    expect(result).toMatchObject({
      status: "failed",
      rollback_attempted: false,
      rollback_succeeded: false,
      rollback_reason: reason,
      backup_id: "manual-recovery-backup",
    });
    expect(notes["Projects/Editable/Note.md"]).toBe(`${original}safe addition\n`);
    expect(
      invocations.some(
        (args) => args[1] === "create" && args.includes("overwrite"),
      ),
    ).toBe(false);
  });

  it("does not overwrite an unknown post-write state that may be a concurrent edit", async () => {
    const notes = { "Projects/Editable/Note.md": "original\n" };
    const invocations: string[][] = [];
    const storage: ChangeStorage = {
      async createBackup() {
        return { backupId: "concurrent-backup" };
      },
      async appendAudit() {},
    };
    const handlers = runtime(
      createMemoryRunner(notes, invocations, true),
      storage,
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "proposed\n",
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "failed",
      error: "post_write_verification_failed",
      rollback_attempted: false,
      rollback_succeeded: false,
      rollback_reason: "concurrent_change",
    });
    expect(notes["Projects/Editable/Note.md"]).toBe(
      "original\nproposed\nCORRUPTED",
    );
    expect(
      invocations.some(
        (args) => args[1] === "create" && args.includes("overwrite"),
      ),
    ).toBe(false);
  });

  it("serializes bridge commits per vault and path so one stale append conflicts", async () => {
    const notes = { "Projects/Editable/Note.md": "original\n" };
    const handlers = runtime(createMemoryRunner(notes, []), {
      async createBackup() {
        return { backupId: "serialized-backup" };
      },
      async appendAudit() {},
    });
    const first = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "first\n",
        }),
      ),
    );
    const second = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "second\n",
        }),
      ),
    );

    const outcomes = await Promise.allSettled([
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({ change_id: first.change_id }),
      ),
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({ change_id: second.change_id }),
      ),
    ]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(notes["Projects/Editable/Note.md"]).toBe("original\nfirst\n");
  });

  it("uses case-insensitive policy identity for the in-process commit lock", async () => {
    const canonicalPath = "Projects/Editable/Case.md";
    const notes = { [canonicalPath]: "original\n" };
    const invocations: string[][] = [];
    const memoryRunner = createMemoryRunner(notes, invocations);
    const runner: ObsidianCliRunner = async (args, options) =>
      await memoryRunner(
        args.map((argument) =>
          argument.startsWith("path=") &&
          argument.slice("path=".length).toLocaleLowerCase("en-US") ===
            canonicalPath.toLocaleLowerCase("en-US")
            ? `path=${canonicalPath}`
            : argument,
        ),
        options,
      );
    const readPolicy = createPathPolicy({
      allowedFolders: ["Projects"],
      caseSensitive: false,
    });
    const writePolicy = createWritablePathPolicy({
      allowedFolders: ["Projects/Editable"],
      caseSensitive: false,
    });
    const resolveAccess: VaultAccessResolver = async () => ({
      readPolicy,
      writablePolicy: writePolicy,
      writeEnabled: true,
      accessMode: "protected",
      vaultSelector: "Test Vault",
      vaultName: "Test Vault",
      source: "settings",
    });
    let releaseFirstBackup!: () => void;
    const firstBackupMayFinish = new Promise<void>((resolve) => {
      releaseFirstBackup = resolve;
    });
    let backupCalls = 0;
    const handlers = runtime(
      runner,
      {
        async createBackup() {
          backupCalls += 1;
          if (backupCalls === 1) await firstBackupMayFinish;
          return { backupId: `case-backup-${backupCalls}` };
        },
        async appendAudit() {},
      },
      fixedStore(),
      resolveAccess,
    );
    const first = resultJson(
      await handlers.prepareChange({
        vault: "Test Vault",
        path: canonicalPath,
        operation: "append",
        content: "first\n",
      }),
    );
    const second = resultJson(
      await handlers.prepareChange({
        vault: "Test Vault",
        path: "projects/editable/case.md",
        operation: "append",
        content: "second\n",
      }),
    );

    const firstCommit = handlers.commitChange({
      change_id: String(first.change_id),
    });
    while (backupCalls === 0) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    const secondCommit = handlers.commitChange({
      change_id: String(second.change_id),
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(backupCalls).toBe(1);
    releaseFirstBackup();

    const outcomes = await Promise.allSettled([firstCommit, secondCommit]);
    expect(outcomes.map((outcome) => outcome.status)).toEqual([
      "fulfilled",
      "rejected",
    ]);
    expect(notes[canonicalPath]).toBe("original\nfirst\n");
  });

  it("serializes independent writer runtimes through the shared filesystem lock", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { "Projects/Editable/Cross process.md": "original\n" };
    const runner = createMemoryRunner(notes, []);
    const storage: ChangeStorage = {
      async createBackup() {
        return { backupId: "cross-process-backup" };
      },
      async appendAudit() {},
    };
    const firstHandlers = runtime(
      runner,
      storage,
      fixedStore(),
      undefined,
      { dataDirectory },
    );
    const secondHandlers = runtime(
      runner,
      storage,
      fixedStore(),
      undefined,
      { dataDirectory },
    );
    const first = resultJson(
      await firstHandlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Cross process.md",
          operation: "append",
          content: "first\n",
        }),
      ),
    );
    const second = resultJson(
      await secondHandlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Cross process.md",
          operation: "append",
          content: "second\n",
        }),
      ),
    );

    const outcomes = await Promise.allSettled([
      firstHandlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({ change_id: first.change_id }),
      ),
      secondHandlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({ change_id: second.change_id }),
      ),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === "rejected")).toHaveLength(1);
    expect(notes["Projects/Editable/Cross process.md"]).toMatch(
      /^original\n(?:first|second)\n$/u,
    );
  });

  it("reports a verified commit without a contradictory failed audit when lock release fails", async () => {
    const dataDirectory = await temporaryDirectory();
    const notePath = "Projects/Editable/Release warning.md";
    const notes = { [notePath]: "original\n" };
    const invocations: string[][] = [];
    const memoryRunner = createMemoryRunner(notes, invocations);
    const caseSensitive = createWritablePathPolicy({
      allowedFolders: ["Projects/Editable"],
    }).caseSensitive;
    let ownerChanged = false;
    const runner: ObsidianCliRunner = async (args, options) => {
      const result = await memoryRunner(args, options);
      if (!ownerChanged && (args[1] === "create" || args[1] === "append")) {
        ownerChanged = true;
        const ownerPath = join(
          commitLockPath(
            dataDirectory,
            "Test Vault",
            notePath,
            caseSensitive,
          ),
          "owner.json",
        );
        const owner = JSON.parse(await readFile(ownerPath, "utf8")) as Record<
          string,
          unknown
        >;
        await writeFile(
          ownerPath,
          `${JSON.stringify({
            ...owner,
            token: "00000000-0000-4000-8000-000000000002",
          })}\n`,
          "utf8",
        );
      }
      return result;
    };
    const audits: AuditEvent[] = [];
    const handlers = runtime(
      runner,
      {
        async createBackup() {
          return { backupId: "release-warning-backup" };
        },
        async appendAudit(event) {
          audits.push(event);
        },
      },
      fixedStore(),
      undefined,
      { dataDirectory },
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: notePath,
          operation: "append",
          content: "added\n",
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );
    expect(result.isError).not.toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "committed",
      verified: true,
      lock_released: false,
      lock_release_error: "LOCK_OWNERSHIP_LOST",
    });
    expect(notes[notePath]).toBe("original\nadded\n");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ status: "committed" });
  });

  it("rechecks panel revocation immediately before the mutating CLI call", async () => {
    const notes = { "Projects/Editable/Note.md": "original\n" };
    const invocations: string[][] = [];
    let accessCalls = 0;
    const allowedRead = createPathPolicy({ allowedFolders: ["Projects"] });
    const allowedWrite = createWritablePathPolicy({
      allowedFolders: ["Projects/Editable"],
    });
    const deniedWrite = createWritablePathPolicy({ allowedFolders: [] });
    const resolveAccess: VaultAccessResolver = async () => {
      accessCalls += 1;
      const revoked = accessCalls >= 4;
      return {
        readPolicy: allowedRead,
        writablePolicy: revoked ? deniedWrite : allowedWrite,
        writeEnabled: !revoked,
        accessMode: "protected",
        vaultSelector: "Test Vault",
        vaultName: "Test Vault",
        source: "settings",
      };
    };
    const handlers = runtime(
      createMemoryRunner(notes, invocations),
      {
        async createBackup() {
          return { backupId: "revocation-backup" };
        },
        async appendAudit() {},
      },
      fixedStore(),
      resolveAccess,
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "blocked\n",
        }),
      ),
    );

    await expect(
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    ).rejects.toThrow(/disabled|shared settings/iu);
    expect(notes["Projects/Editable/Note.md"]).toBe("original\n");
    expect(invocations.some((args) => args[1] === "append")).toBe(false);
  });

  it("refuses rollback after full access is revoked between write chunks", async () => {
    const notePath = "Autonomous rollback.md";
    const notes = { [notePath]: "original\n" };
    const fullPolicy = createPathPolicy({ allowedFolders: null });
    const deniedPolicy = createWritablePathPolicy({ allowedFolders: [] });
    let accessCalls = 0;
    const resolveAccess: VaultAccessResolver = async () => {
      accessCalls += 1;
      const revoked = accessCalls >= 5;
      return {
        readPolicy: revoked ? deniedPolicy : fullPolicy,
        writablePolicy: revoked ? deniedPolicy : fullPolicy,
        writeEnabled: !revoked,
        accessMode: revoked ? "protected" : "full",
        vaultSelector: "0123456789abcdef",
        vaultName: "Test Vault",
        source: "settings",
      };
    };
    const audits: AuditEvent[] = [];
    const handlers = runtime(
      createMemoryRunner(notes, []),
      {
        async createBackup() {
          return { backupId: "revoked-recovery-backup" };
        },
        async appendAudit(event) {
          audits.push(event);
        },
      },
      fixedStore(),
      resolveAccess,
      { authorizationMode: "autonomous" },
    );
    const content = "x".repeat(7_000);
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: notePath,
          operation: "append",
          content,
        }),
      ),
    );

    const result = await handlers.commitChange(
      WriteToolInputSchemas.commitChange.parse({
        change_id: prepared.change_id,
      }),
    );
    expect(result.isError).toBe(true);
    expect(resultJson(result)).toMatchObject({
      status: "failed",
      rollback_attempted: false,
      rollback_succeeded: false,
      rollback_reason: "recovery_scope_changed",
      lock_released: true,
    });
    expect(notes[notePath]).toMatch(/^original\nx+/u);
    expect(notes[notePath]).not.toBe(`original\n${content}`);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      status: "failed",
      rollback_reason: "recovery_scope_changed",
    });
  });

  it("pauses one autonomous writer process after three consecutive failures", async () => {
    const notes = { "Autonomous note.md": "original\n" };
    const fullPolicy = createPathPolicy({
      allowedFolders: null,
      deniedFolders: [".obsidian", ".trash"],
    });
    const resolveAccess: VaultAccessResolver = async () => ({
      readPolicy: fullPolicy,
      writablePolicy: fullPolicy,
      writeEnabled: true,
      accessMode: "full",
      vaultSelector: "0123456789abcdef",
      vaultName: "Test Vault",
      source: "settings",
    });
    const handlers = runtime(
      createMemoryRunner(notes, []),
      {
        async createBackup() {
          throw new Error("simulated backup failure");
        },
        async appendAudit() {},
      },
      fixedStore(),
      resolveAccess,
      { authorizationMode: "autonomous" },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      const prepared = resultJson(
        await handlers.prepareChange(
          WriteToolInputSchemas.prepareChange.parse({
            vault: "Test Vault",
            path: "Autonomous note.md",
            operation: "append",
            content: `attempt ${attempt}\n`,
          }),
        ),
      );
      await expect(
        handlers.commitChange(
          WriteToolInputSchemas.commitChange.parse({
            change_id: prepared.change_id,
          }),
        ),
      ).rejects.toThrow("simulated backup failure");
    }

    await expect(
      handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Another autonomous note.md",
          operation: "create",
          content: "must be paused",
        }),
      ),
    ).rejects.toThrow(/paused.*three consecutive failures/iu);
    expect(notes["Autonomous note.md"]).toBe("original\n");
  });

  it("counts autonomous prepare failures toward the circuit breaker", async () => {
    const notes: Record<string, string> = {};
    const fullPolicy = createPathPolicy({ allowedFolders: null });
    const resolveAccess: VaultAccessResolver = async () => ({
      readPolicy: fullPolicy,
      writablePolicy: fullPolicy,
      writeEnabled: true,
      accessMode: "full",
      vaultSelector: "0123456789abcdef",
      vaultName: "Test Vault",
      source: "settings",
    });
    const handlers = runtime(
      createMemoryRunner(notes, []),
      {
        async createBackup() {
          return { backupId: "unused" };
        },
        async appendAudit() {},
      },
      fixedStore(),
      resolveAccess,
      { authorizationMode: "autonomous" },
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        handlers.prepareChange(
          WriteToolInputSchemas.prepareChange.parse({
            vault: "Test Vault",
            path: `Missing-${attempt}.md`,
            operation: "append",
            content: "cannot append",
          }),
        ),
      ).rejects.toThrow(/requires an existing note/iu);
    }
    await expect(
      handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Would otherwise work.md",
          operation: "create",
          content: "blocked by circuit",
        }),
      ),
    ).rejects.toThrow(/paused.*three consecutive failures/iu);
  });

  it("counts store and channel failures once before pausing autonomy", async () => {
    const notes: Record<string, string> = {};
    const store = fixedStore();
    const foreign = store.create({
      vault: "0123456789abcdef",
      vaultLabel: "Test Vault",
      notePath: "Foreign.md",
      operation: "create",
      authorizationMode: "protected",
      lockCaseSensitive: false,
      before: { exists: false, sha256: hashDocumentState(false) },
      afterContent: "foreign",
      commandContent: "foreign",
      afterSha256: hashDocumentState(true, "foreign"),
      previewDiff: "+foreign",
      beforeLineCount: 0,
      afterLineCount: 1,
    });
    const fullPolicy = createPathPolicy({ allowedFolders: null });
    const resolveAccess: VaultAccessResolver = async () => ({
      readPolicy: fullPolicy,
      writablePolicy: fullPolicy,
      writeEnabled: true,
      accessMode: "full",
      vaultSelector: "0123456789abcdef",
      vaultName: "Test Vault",
      source: "settings",
    });
    const handlers = runtime(
      createMemoryRunner(notes, []),
      {
        async createBackup() {
          return { backupId: "unused" };
        },
        async appendAudit() {},
      },
      store,
      resolveAccess,
      { authorizationMode: "autonomous" },
    );

    await expect(
      handlers.commitChange({ change_id: foreign.changeId }),
    ).rejects.toThrow(/different writer authorization channel/iu);
    await expect(
      handlers.commitChange({
        change_id: "00000000-0000-4000-8000-000000009998",
      }),
    ).rejects.toThrow(/unknown|expired|consumed/iu);

    const stillAllowed = await handlers.prepareChange(
      WriteToolInputSchemas.prepareChange.parse({
        vault: "Test Vault",
        path: "Still allowed after two.md",
        operation: "create",
        content: "prepared",
      }),
    );
    expect(stillAllowed.isError).not.toBe(true);

    await expect(
      handlers.commitChange({
        change_id: "00000000-0000-4000-8000-000000009999",
      }),
    ).rejects.toThrow(/unknown|expired|consumed/iu);
    await expect(
      handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Paused.md",
          operation: "create",
          content: "blocked",
        }),
      ),
    ).rejects.toThrow(/paused.*three consecutive failures/iu);
  });

  it("stores plaintext backups separately while audit NDJSON contains no note body", async () => {
    const directory = await temporaryDirectory();
    const storage = new FileChangeStorage(directory, 20);
    const distinctiveBody = "TOP-SECRET-NOTE-BODY";
    const { backupId } = await storage.createBackup({
      vault: "Test Vault",
      notePath: "Projects/Editable/Note.md",
      beforeSha256: hashDocumentState(true, distinctiveBody),
      content: distinctiveBody,
      createdAt: Date.UTC(2026, 6, 11),
    });
    await storage.appendAudit({
      timestamp: "2026-07-11T00:00:00.000Z",
      change_id: "00000000-0000-4000-8000-000000000001",
      vault: "Test Vault",
      path: "Projects/Editable/Note.md",
      operation: "append",
      status: "committed",
      authorization_mode: "protected",
      before_sha256: hashDocumentState(true, distinctiveBody),
      after_sha256: hashDocumentState(true, `${distinctiveBody}x`),
      backup_id: backupId,
    });

    const backupFiles = await readdir(join(directory, "backups"));
    expect(backupFiles).toHaveLength(1);
    expect(
      readFileSync(join(directory, "backups", backupFiles[0]!), "utf8"),
    ).toContain(distinctiveBody);
    const audit = readFileSync(join(directory, "audit.ndjson"), "utf8");
    expect(audit).toContain('"status":"committed"');
    expect(audit).not.toContain(distinctiveBody);
  });

  it("an actual FileChangeStorage backup error prevents mutation", async () => {
    const directory = await temporaryDirectory();
    writeFileSync(join(directory, "backups"), "not a directory", "utf8");
    const notes = { "Projects/Editable/Note.md": "still safe\n" };
    const invocations: string[][] = [];
    const handlers = runtime(
      createMemoryRunner(notes, invocations),
      new FileChangeStorage(directory),
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        WriteToolInputSchemas.prepareChange.parse({
          vault: "Test Vault",
          path: "Projects/Editable/Note.md",
          operation: "append",
          content: "unsafe append",
        }),
      ),
    );

    await expect(
      handlers.commitChange(
        WriteToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    ).rejects.toThrow();
    expect(notes["Projects/Editable/Note.md"]).toBe("still safe\n");
    expect(invocations.some((args) => args[1] === "append")).toBe(false);
  });
});
