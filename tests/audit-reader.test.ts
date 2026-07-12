import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  AUDIT_LINE_MAX_BYTES,
  AUDIT_RESULT_MAX_RECORDS,
  AUDIT_TAIL_MAX_BYTES,
  AuditLogReadError,
  readAuditTail,
} from "../src/audit-reader.js";
import {
  createPathPolicy,
  createWritablePathPolicy,
} from "../src/path-policy.js";
import { ToolInputSchemas, createToolHandlers } from "../src/server.js";
import type { VaultAccessResolver } from "../src/shared-settings.js";

const VAULT_ID = "0123456789abcdef";
const DENIED_VAULT_ID = "fedcba9876543210";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function auditRecord(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: new Date(Date.UTC(2026, 6, 12, 8, 0, 0) + index * 1_000)
      .toISOString(),
    change_id: `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`,
    vault: VAULT_ID,
    path: `Projects/Note-${index}.md`,
    operation: "create",
    authorization_mode: "autonomous",
    status: "committed",
    before_sha256: HASH_A,
    after_sha256: HASH_B,
    ...overrides,
  };
}

function toolJson(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected a text tool result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

describe("bounded metadata-only audit reader", () => {
  let sandbox = "";
  let dataDirectory = "";
  let auditPath = "";

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "obsidian-audit-reader-"));
    dataDirectory = join(sandbox, "data");
    auditPath = join(dataDirectory, "audit.ndjson");
    await mkdir(dataDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("treats a missing audit as an empty normal result", async () => {
    await expect(readAuditTail(dataDirectory)).resolves.toEqual({
      events: [],
      truncated: false,
    });
  });

  it("returns newest metadata only and accepts legacy protected records", async () => {
    await writeFile(
      auditPath,
      `${[
        auditRecord(1, { authorization_mode: undefined }),
        auditRecord(2, {
          operation: "append",
          status: "failed",
          error_code: "WRITE_FAILED_ROLLBACK_FAILED",
          rollback_attempted: true,
          rollback_succeeded: false,
          rollback_reason: "restore_too_large",
          backup_id: "backup-2",
        }),
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const result = await readAuditTail(dataDirectory);

    expect(result.events).toHaveLength(2);
    expect(result.events[0]).toMatchObject({
      change_id: "00000000-0000-4000-8000-000000000002",
      authorization_mode: "autonomous",
      status: "failed",
      error_code: "WRITE_FAILED_ROLLBACK_FAILED",
      rollback_attempted: true,
      rollback_succeeded: false,
      rollback_reason: "restore_too_large",
      backup_id: "backup-2",
    });
    expect(result.events[1]).toMatchObject({
      authorization_mode: "protected",
      status: "committed",
    });
    expect(JSON.stringify(result)).not.toContain("before_sha256");
    expect(JSON.stringify(result)).not.toContain(HASH_A);
    expect(JSON.stringify(result)).not.toContain(HASH_B);
  });

  it("accepts management operations and exposes only a validated move target", async () => {
    await writeFile(
      auditPath,
      `${[
        auditRecord(10, {
          operation: "replace",
          authorization_mode: "management",
        }),
        auditRecord(11, {
          operation: "frontmatter",
          status: "failed",
          error_code: "MANAGEMENT_WRITE_FAILED",
          rollback_attempted: true,
          rollback_succeeded: true,
          rollback_reason: "backup_restored",
          backup_id: "management-backup-11",
        }),
        auditRecord(12, {
          operation: "move",
          target_path: "Archive/Renamed.md",
        }),
        auditRecord(13, { operation: "trash" }),
      ].map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const result = await readAuditTail(dataDirectory);
    expect(result.events.map((event) => event.operation)).toEqual([
      "trash",
      "move",
      "frontmatter",
      "replace",
    ]);
    expect(result.events[1]).toMatchObject({
      path: "Projects/Note-12.md",
      target_path: "Archive/Renamed.md",
      operation: "move",
    });
    expect(result.events[3]).toMatchObject({
      operation: "replace",
      authorization_mode: "management",
    });
    expect(result.events[2]).toMatchObject({
      operation: "frontmatter",
      status: "failed",
      rollback_attempted: true,
      rollback_succeeded: true,
      rollback_reason: "backup_restored",
    });
    expect(JSON.stringify(result)).not.toContain(HASH_A);
    expect(JSON.stringify(result)).not.toContain(HASH_B);
  });

  it.each([
    ["a move without its target", auditRecord(20, { operation: "move" })],
    [
      "a target attached to a non-move operation",
      auditRecord(21, {
        operation: "replace",
        target_path: "Archive/Unexpected.md",
      }),
    ],
    [
      "an unsafe move target",
      auditRecord(22, {
        operation: "move",
        target_path: "../Outside.md",
      }),
    ],
  ])("fails closed on %s", async (_label, record) => {
    await writeFile(auditPath, `${JSON.stringify(record)}\n`, "utf8");
    await expect(readAuditTail(dataDirectory)).rejects.toMatchObject({
      code: "AUDIT_MALFORMED",
    });
  });

  it("reads no more than 128 KiB and safely drops one partial first record", async () => {
    const lines = Array.from({ length: 900 }, (_, index) =>
      JSON.stringify(auditRecord(index + 1)),
    );
    expect(Buffer.byteLength(`${lines.join("\n")}\n`, "utf8"))
      .toBeGreaterThan(AUDIT_TAIL_MAX_BYTES);
    await writeFile(auditPath, `${lines.join("\n")}\n`, "utf8");

    const result = await readAuditTail(dataDirectory);

    expect(result.truncated).toBe(true);
    expect(result.events[0]?.path).toBe("Projects/Note-900.md");
    expect(result.events.length).toBeLessThan(900);
  });

  it.each([
    ["invalid JSON", "not-json\n", "AUDIT_MALFORMED"],
    [
      "an incomplete final record",
      JSON.stringify(auditRecord(1)),
      "AUDIT_MALFORMED",
    ],
    [
      "an oversized record",
      `${JSON.stringify(auditRecord(1, {
        rollback_reason: "x".repeat(AUDIT_LINE_MAX_BYTES),
      }))}\n`,
      "AUDIT_LINE_TOO_LARGE",
    ],
  ])("fails closed on %s", async (_label, content, expectedCode) => {
    await writeFile(auditPath, content, "utf8");

    await expect(readAuditTail(dataDirectory)).rejects.toMatchObject({
      code: expectedCode,
    });
  });

  it("fails closed on invalid UTF-8", async () => {
    await writeFile(auditPath, Buffer.from([0xff, 0x0a]));

    await expect(readAuditTail(dataDirectory)).rejects.toMatchObject({
      code: "AUDIT_INVALID_UTF8",
    });
  });

  it("refuses non-regular files and symbolic links", async () => {
    await rm(auditPath, { force: true });
    await mkdir(auditPath);
    await expect(readAuditTail(dataDirectory)).rejects.toMatchObject({
      code: "AUDIT_NOT_REGULAR",
    });

    await rm(auditPath, { recursive: true });
    const target = join(sandbox, "real-audit.ndjson");
    await writeFile(target, `${JSON.stringify(auditRecord(1))}\n`, "utf8");
    await mkdir(dirname(auditPath), { recursive: true });
    try {
      await symlink(target, auditPath, "file");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "EPERM" || code === "EACCES") return;
      throw error;
    }

    await expect(readAuditTail(dataDirectory)).rejects.toMatchObject({
      code: "AUDIT_UNSAFE_SYMLINK",
    });
  });

  it("rejects relative data directories before touching the filesystem", async () => {
    await expect(readAuditTail("relative-data")).rejects.toBeInstanceOf(
      AuditLogReadError,
    );
  });

  it("filters events through current vault and folder access and caps results", async () => {
    const records: Record<string, unknown>[] = [
      auditRecord(1, {
        status: "failed",
        error_code: "PRE_WRITE_FAILED",
      }),
      auditRecord(2, {
        path: "Private/Hidden.md",
        status: "failed",
        error_code: "PRE_WRITE_FAILED",
      }),
      auditRecord(3, {
        vault: DENIED_VAULT_ID,
        status: "failed",
        error_code: "PRE_WRITE_FAILED",
      }),
    ];
    for (let index = 4; index <= 30; index += 1) {
      records.push(auditRecord(index));
    }
    await writeFile(
      auditPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const resolveAccess: VaultAccessResolver = async (vault) => {
      const allowed = vault === VAULT_ID;
      const policy = allowed
        ? createWritablePathPolicy({ allowedFolders: ["Projects"] })
        : createWritablePathPolicy({ allowedFolders: [] });
      return {
        readPolicy: policy,
        writablePolicy: createWritablePathPolicy({ allowedFolders: [] }),
        writeEnabled: false,
        accessMode: "protected",
        managementPermissions: { edit: false, move: false, trash: false },
        vaultSelector: vault,
        vaultName: allowed ? "Study Vault" : "Revoked Vault",
        vaultPath: join(sandbox, vault),
        source: "settings",
      };
    };
    const handlers = createToolHandlers({
      runner: vi.fn(),
      policy: createPathPolicy({ allowedFolders: null }),
      resolveAccess,
      dataDirectory,
    });

    const failures = toolJson(
      await handlers.recentWriteEvents(
        ToolInputSchemas.recentWriteEvents.parse({}),
      ),
    );
    expect(failures).toMatchObject({
      failures_only: true,
      limit: 10,
      count: 1,
      audit_tail_truncated: false,
      results_truncated: false,
      truncated: false,
      events: [
        {
          vault: "Study Vault",
          vault_id: VAULT_ID,
          path: "Projects/Note-1.md",
          status: "failed",
          error_code: "PRE_WRITE_FAILED",
        },
      ],
    });

    const all = toolJson(
      await handlers.recentWriteEvents(
        ToolInputSchemas.recentWriteEvents.parse({
          failures_only: false,
          limit: 999,
        }),
      ),
    );
    expect(all).toMatchObject({
      failures_only: false,
      limit: AUDIT_RESULT_MAX_RECORDS,
      count: AUDIT_RESULT_MAX_RECORDS,
      audit_tail_truncated: false,
      results_truncated: true,
      truncated: true,
    });
    expect(JSON.stringify(all)).not.toContain("sha256");
    expect(JSON.stringify(all)).not.toContain("Private/Hidden.md");
    expect(JSON.stringify(all)).not.toContain("Revoked Vault");
  });

  it("rechecks the requested vault grant after reading before disclosing paths", async () => {
    await writeFile(
      auditPath,
      `${JSON.stringify(auditRecord(1, {
        status: "failed",
        error_code: "PRE_WRITE_FAILED",
      }))}\n`,
      "utf8",
    );
    let calls = 0;
    const resolveAccess: VaultAccessResolver = async (vault) => {
      calls += 1;
      return {
        readPolicy: createWritablePathPolicy({
          allowedFolders: calls === 1 ? ["Projects"] : [],
        }),
        writablePolicy: createWritablePathPolicy({ allowedFolders: [] }),
        writeEnabled: false,
        accessMode: "protected",
        managementPermissions: { edit: false, move: false, trash: false },
        vaultSelector: vault,
        vaultName: "Study Vault",
        vaultPath: join(sandbox, vault),
        source: "settings",
      };
    };
    const handlers = createToolHandlers({
      runner: vi.fn(),
      policy: createPathPolicy({ allowedFolders: null }),
      resolveAccess,
      dataDirectory,
    });

    await expect(
      handlers.recentWriteEvents(
        ToolInputSchemas.recentWriteEvents.parse({ vault: VAULT_ID }),
      ),
    ).rejects.toThrow("reading is disabled");
    expect(calls).toBe(2);
  });
});
