import {
  mkdir,
  mkdtemp,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  AUDIT_RESULT_MAX_RECORDS,
  AUDIT_TAIL_MAX_BYTES,
  bridgeDataDirectory,
  readAuditDiagnostics,
} from "../src/audit-diagnostics.js";
import type { DesktopPlatform } from "../src/shared-settings.js";

const VAULT_ID = "0123456789abcdef";
const OTHER_VAULT_ID = "fedcba9876543210";
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function runtimePlatform(): DesktopPlatform {
  if (process.platform === "win32") return "windows";
  if (process.platform === "darwin") return "macos";
  return "linux";
}

function auditRecord(
  index: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    timestamp: new Date(Date.UTC(2026, 6, 12, 8, 0, index)).toISOString(),
    change_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    vault: VAULT_ID,
    path: `Projects/Note-${index}.md`,
    operation: "create",
    status: "committed",
    before_sha256: HASH_A,
    after_sha256: HASH_B,
    ...overrides,
  };
}

describe("bounded companion audit diagnostics", () => {
  let sandbox = "";
  let dataDirectory = "";
  let auditPath = "";
  let env: NodeJS.ProcessEnv;

  beforeEach(async () => {
    sandbox = await mkdtemp(join(tmpdir(), "bridge-audit-"));
    dataDirectory = join(sandbox, "private-data");
    auditPath = join(dataDirectory, "audit.ndjson");
    env = { OBSIDIAN_BRIDGE_DATA_DIR: dataDirectory };
    await mkdir(dataDirectory, { recursive: true });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  it("derives platform data paths and honors only absolute overrides", () => {
    expect(
      bridgeDataDirectory("windows", {
        LOCALAPPDATA: "C:\\Users\\Ada\\AppData\\Local",
      }, "C:\\Users\\Ada"),
    ).toBe("C:\\Users\\Ada\\AppData\\Local\\obsidian-bridge");
    expect(
      bridgeDataDirectory("macos", {}, "/Users/ada"),
    ).toBe("/Users/ada/Library/Application Support/obsidian-bridge");
    expect(
      bridgeDataDirectory("linux", { XDG_DATA_HOME: "/data/ada" }, "/home/ada"),
    ).toBe("/data/ada/obsidian-bridge");
    expect(
      bridgeDataDirectory("linux", { PLUGIN_DATA: "/plugin-data" }, "/home/ada"),
    ).toBe("/home/ada/.local/share/obsidian-bridge");
    expect(
      bridgeDataDirectory(
        "linux",
        {
          OBSIDIAN_BRIDGE_DATA_DIR: "/override",
          PLUGIN_DATA: "/plugin-data",
        },
        "/home/ada",
      ),
    ).toBe("/override");
    expect(() =>
      bridgeDataDirectory("linux", { OBSIDIAN_BRIDGE_DATA_DIR: "relative" }, "/home/ada"),
    ).toThrow("percorso assoluto");
  });

  it("tolerates a missing audit file", async () => {
    await expect(
      readAuditDiagnostics(VAULT_ID, {
        platform: runtimePlatform(),
        env,
        homeDirectory: homedir(),
      }),
    ).resolves.toMatchObject({
      state: "missing",
      records: [],
      failedRecords: [],
      malformedLines: 0,
    });
  });

  it("filters by stable vault id and classifies recovery metadata without bodies", async () => {
    const records = [
      auditRecord(1, { content: "THIS MUST NEVER LEAVE THE AUDIT PARSER" }),
      auditRecord(2, { vault: OTHER_VAULT_ID }),
      auditRecord(3),
      auditRecord(4, {
        operation: "append",
        status: "failed",
        error_code: "WRITE_FAILED_ROLLBACK_SUCCEEDED",
      }),
      auditRecord(5, {
        status: "failed",
        error_code: "WRITE_FAILED_ROLLBACK_FAILED",
        rollback_attempted: true,
        rollback_succeeded: false,
        rollback_reason: "restore_too_large",
      }),
      auditRecord(6, {
        status: "failed",
        error_code: "PRE_WRITE_FAILED",
      }),
      auditRecord(7, {
        status: "failed",
        error_code: "CHANGE_CONFLICT",
      }),
    ];
    await writeFile(
      auditPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
      limit: 20,
    });

    expect(result.state).toBe("ready");
    expect(result.malformedLines).toBe(1);
    expect(result.records.map((record) => record.changeId)).toEqual([
      "00000000-0000-4000-8000-000000000007",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000004",
      "00000000-0000-4000-8000-000000000003",
    ]);
    expect(result.records[0]).toMatchObject({
      severity: "warning",
      recovery: "not-applied",
      rollbackAttempted: false,
    });
    expect(result.records[1]).toMatchObject({
      severity: "warning",
      recovery: "not-applied",
      rollbackAttempted: false,
    });
    expect(result.records[2]).toMatchObject({
      severity: "error",
      recovery: "manual-review",
      rollbackAttempted: true,
      rollbackSucceeded: false,
      rollbackReason: "restore_too_large",
    });
    expect(result.records[3]).toMatchObject({
      severity: "warning",
      recovery: "restored",
      rollbackAttempted: true,
      rollbackSucceeded: true,
    });
    expect(result.failedRecords.map((record) => record.changeId)).toEqual([
      "00000000-0000-4000-8000-000000000007",
      "00000000-0000-4000-8000-000000000006",
      "00000000-0000-4000-8000-000000000005",
      "00000000-0000-4000-8000-000000000004",
    ]);
    expect(JSON.stringify(result)).not.toContain("THIS MUST NEVER LEAVE");
  });

  it("retains failures independently when newer successes fill the normal window", async () => {
    const records: Record<string, unknown>[] = [
      auditRecord(1, {
        status: "failed",
        error_code: "COMMIT_LOCK_TIMEOUT",
      }),
    ];
    for (let index = 2; index <= 18; index += 1) {
      records.push(auditRecord(index));
    }
    await writeFile(
      auditPath,
      `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      "utf8",
    );

    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
      limit: 10,
    });

    expect(result.records).toHaveLength(10);
    expect(result.records.every((record) => record.status === "committed")).toBe(true);
    expect(result.failedRecords).toHaveLength(1);
    expect(result.failedRecords[0]).toMatchObject({
      errorCode: "COMMIT_LOCK_TIMEOUT",
      severity: "warning",
      recovery: "not-applied",
    });
  });

  it("counts malformed lines without crashing and keeps only twenty newest records", async () => {
    const lines: string[] = ["not-json", "", JSON.stringify({ status: "failed" })];
    for (let index = 1; index <= 25; index += 1) {
      lines.push(JSON.stringify(auditRecord(index)));
    }
    await writeFile(auditPath, `${lines.join("\n")}\n`, "utf8");

    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
      limit: 999,
    });

    expect(result.malformedLines).toBe(3);
    expect(result.records).toHaveLength(AUDIT_RESULT_MAX_RECORDS);
    expect(result.records[0]?.path).toBe("Projects/Note-25.md");
    expect(result.records[result.records.length - 1]?.path).toBe("Projects/Note-6.md");
  });

  it("reads only the bounded tail and drops a partial first line", async () => {
    const oldRecord = JSON.stringify(auditRecord(1));
    const padding = "x".repeat(AUDIT_TAIL_MAX_BYTES + 4_096);
    const recentRecord = JSON.stringify(auditRecord(2));
    await writeFile(
      auditPath,
      `${oldRecord}\n${padding}\n${recentRecord}\n`,
      "utf8",
    );

    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
    });

    expect(result.truncated).toBe(true);
    expect(result.malformedLines).toBe(0);
    expect(result.records).toHaveLength(1);
    expect(result.records[0]?.path).toBe("Projects/Note-2.md");
  });

  it("reports non-regular audit paths as unsafe", async () => {
    await mkdir(auditPath);
    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
    });
    expect(result).toMatchObject({
      state: "unsafe",
      errorCode: "NOT_REGULAR_FILE",
      records: [],
    });
  });

  it("refuses symbolic-link audit files when the platform permits creating one", async () => {
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

    const result = await readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
    });
    expect(result).toMatchObject({
      state: "unsafe",
      errorCode: "SYMLINK",
      records: [],
    });
  });

  it("rejects invalid vault ids and limits", async () => {
    await expect(readAuditDiagnostics("vault-name", {
      platform: runtimePlatform(),
      env,
    })).rejects.toThrow("identificatore stabile");
    await expect(readAuditDiagnostics(VAULT_ID, {
      platform: runtimePlatform(),
      env,
      limit: 0,
    })).rejects.toThrow("intero positivo");
  });
});
