import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  MANAGEMENT_BACKUP_RETENTION,
  MANAGEMENT_BACKUP_VERSION,
  MISSING_DOCUMENT_SHA256,
  ManagementRequestHandler,
  type ManagementAuthorizationDecision,
  type ManagementAuthorizationPhase,
  type ManagementCommandResponse,
  type ManagementVaultApi,
} from "../src/management-handler.js";
import {
  managementRequestPath,
  hashPresentDocument,
  type ManagementRequest,
} from "../src/management-protocol.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CHANGE_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(64);
const VAULT_ID = "0123456789abcdef";
const NOW = Date.parse("2026-07-12T10:01:00.000Z");

class FakeVault implements ManagementVaultApi {
  readonly files = new Map<string, string>();
  readonly frontmatters = new Map<string, Record<string, unknown>>();
  processCalls = 0;
  frontmatterCalls = 0;
  renameCalls = 0;
  trashCalls = 0;
  corruptNextProcess = false;
  concurrentFrontmatterContent: string | undefined;
  concurrentFrontmatter: Record<string, unknown> | undefined;

  async readMarkdown(filePath: string): Promise<string | null> {
    return this.files.get(filePath) ?? null;
  }

  async processMarkdown(
    filePath: string,
    update: (content: string) => string,
  ): Promise<string> {
    this.processCalls += 1;
    const current = this.files.get(filePath);
    if (current === undefined) throw new Error("missing file");
    let written = update(current);
    if (this.corruptNextProcess) {
      this.corruptNextProcess = false;
      written += "\nCORRUPTED";
    }
    this.files.set(filePath, written);
    return written;
  }

  async rewriteFrontMatterMarkdown(
    filePath: string,
    beforeSha256: string,
    update: (frontmatter: Record<string, unknown>) => void,
  ): Promise<string> {
    this.frontmatterCalls += 1;
    if (this.concurrentFrontmatterContent !== undefined) {
      this.files.set(filePath, this.concurrentFrontmatterContent);
      this.concurrentFrontmatterContent = undefined;
    }
    if (this.concurrentFrontmatter !== undefined) {
      this.frontmatters.set(filePath, this.concurrentFrontmatter);
      this.concurrentFrontmatter = undefined;
    }
    const current = this.files.get(filePath);
    if (current === undefined) throw new Error("missing file");
    if (hashPresentDocument(current) !== beforeSha256) {
      throw Object.assign(new Error("frontmatter CAS conflict"), {
        code: "CHANGE_CONFLICT",
      });
    }
    const frontmatter = this.frontmatters.get(filePath) ?? {};
    update(frontmatter);
    this.frontmatters.set(filePath, frontmatter);
    const written = `${current}\n<!-- frontmatter-${this.frontmatterCalls} -->`;
    this.files.set(filePath, written);
    return written;
  }

  async readFrontMatter(filePath: string): Promise<Readonly<Record<string, unknown>>> {
    return { ...(this.frontmatters.get(filePath) ?? {}) };
  }

  async renameFile(filePath: string, destination: string): Promise<void> {
    this.renameCalls += 1;
    const content = this.files.get(filePath);
    if (content === undefined || this.files.has(destination)) throw new Error("rename failed");
    this.files.delete(filePath);
    this.files.set(destination, content);
    const frontmatter = this.frontmatters.get(filePath);
    if (frontmatter !== undefined) {
      this.frontmatters.delete(filePath);
      this.frontmatters.set(destination, frontmatter);
    }
  }

  async trashFile(filePath: string): Promise<void> {
    this.trashCalls += 1;
    if (!this.files.delete(filePath)) throw new Error("trash failed");
    this.frontmatters.delete(filePath);
  }
}

function baseRequest(
  operation: ManagementRequest["operation"],
  beforeContent: string,
  payload: unknown,
): Record<string, unknown> {
  return {
    version: 1,
    request_id: REQUEST_ID,
    token: TOKEN,
    change_id: CHANGE_ID,
    created_at: "2026-07-12T10:00:00.000Z",
    expires_at: "2026-07-12T10:05:00.000Z",
    vault_id: VAULT_ID,
    operation,
    path: "Scuola/Nota.md",
    before_sha256: hashPresentDocument(beforeContent),
    payload,
  };
}

describe("managed mutation companion handler", () => {
  let sandbox = "";
  let dataDirectory = "";
  let vault: FakeVault;
  let authorization: (
    request: ManagementRequest,
    phase: ManagementAuthorizationPhase,
  ) => Promise<ManagementAuthorizationDecision>;

  beforeEach(async () => {
    sandbox = await mkdtemp(path.join(tmpdir(), "bridge-management-"));
    dataDirectory = path.join(sandbox, "data");
    vault = new FakeVault();
    authorization = async () => ({ allowed: true, mode: "management" });
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  async function putRequest(value: unknown): Promise<string> {
    const file = managementRequestPath(dataDirectory, REQUEST_ID);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify(value), "utf8");
    return file;
  }

  function handler(): ManagementRequestHandler {
    let id = 0;
    return new ManagementRequestHandler({
      dataDirectory,
      vaultId: VAULT_ID,
      api: vault,
      authorize: authorization,
      now: () => NOW,
      createId: () => `test-${++id}`,
    });
  }

  async function readAudit(): Promise<Record<string, unknown>> {
    const line = (await readFile(path.join(dataDirectory, "audit.ndjson"), "utf8")).trim();
    return JSON.parse(line) as Record<string, unknown>;
  }

  it("commits and verifies an atomic replace with a private v2 backup", async () => {
    const before = "# Prima\ncontenuto riservato";
    const after = "# Dopo\ncontenuto nuovo";
    vault.files.set("Scuola/Nota.md", before);
    const request = baseRequest("replace", before, {
      content: after,
      after_sha256: hashPresentDocument(after),
    });
    const requestPath = await putRequest(request);

    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "committed",
      operation: "replace",
      verified: true,
      before_sha256: hashPresentDocument(before),
      after_sha256: hashPresentDocument(after),
      audit_recorded: true,
    });
    expect(vault.files.get("Scuola/Nota.md")).toBe(after);
    await expect(readFile(requestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(path.join(dataDirectory, "management", "processing"))).toEqual([]);

    const backupFiles = await readdir(path.join(dataDirectory, "backups"));
    expect(backupFiles).toHaveLength(1);
    const backupRaw = await readFile(
      path.join(dataDirectory, "backups", backupFiles[0]!),
      "utf8",
    );
    const backup = JSON.parse(backupRaw) as Record<string, unknown>;
    expect(backup).toMatchObject({
      version: MANAGEMENT_BACKUP_VERSION,
      change_id: CHANGE_ID,
      operation: "replace",
      before_sha256: hashPresentDocument(before),
      files: [{ path: "Scuola/Nota.md", content: before }],
    });
    expect(backupRaw).not.toContain(TOKEN);

    const auditRaw = await readFile(path.join(dataDirectory, "audit.ndjson"), "utf8");
    expect(JSON.parse(auditRaw)).toMatchObject({
      change_id: CHANGE_ID,
      operation: "replace",
      status: "committed",
    });
    expect(auditRaw).not.toContain(before);
    expect(auditRaw).not.toContain(after);
    expect(auditRaw).not.toContain(TOKEN);
  });

  it("retains the newest 20 shared JSON backups without touching other files or symlinks", async () => {
    const backupDirectory = path.join(dataDirectory, "backups");
    await mkdir(backupDirectory, { recursive: true });
    const seedNames = Array.from({ length: 22 }, (_, index) =>
      `2026-07-11T09-${String(index).padStart(2, "0")}-00.000Z-legacy-${String(index).padStart(2, "0")}.json`,
    );
    await Promise.all(
      seedNames.map(async (name, index) =>
        await writeFile(
          path.join(backupDirectory, name),
          JSON.stringify({ version: index % 2 === 0 ? 1 : 2 }),
          "utf8",
        ),
      ),
    );
    const unrelatedPath = path.join(backupDirectory, "keep-forever.txt");
    await writeFile(unrelatedPath, "not a backup bundle", "utf8");

    const symlinkTarget = path.join(sandbox, "linked-backup-target.json");
    const symlinkPath = path.join(
      backupDirectory,
      "2099-01-01T00-00-00.000Z-linked.json",
    );
    await writeFile(symlinkTarget, "outside backup directory", "utf8");
    let symlinkCreated = false;
    try {
      await symlink(symlinkTarget, symlinkPath, "file");
      symlinkCreated = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EPERM") throw error;
    }

    const before = "contenuto precedente";
    const after = "contenuto aggiornato";
    vault.files.set("Scuola/Nota.md", before);
    await putRequest(
      baseRequest("replace", before, {
        content: after,
        after_sha256: hashPresentDocument(after),
      }),
    );
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "committed",
      verified: true,
      backup_id: expect.any(String),
    });
    const entries = await readdir(backupDirectory, { withFileTypes: true });
    const retainedJson = entries
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => entry.name)
      .sort();
    const currentName = `${result.backup_id}.json`;
    const expected = [currentName, ...seedNames]
      .sort()
      .reverse()
      .slice(0, MANAGEMENT_BACKUP_RETENTION)
      .sort();
    expect(retainedJson).toHaveLength(MANAGEMENT_BACKUP_RETENTION);
    expect(retainedJson).toEqual(expected);
    expect(await readFile(unrelatedPath, "utf8")).toBe("not a backup bundle");
    if (symlinkCreated) {
      expect(
        entries.find((entry) => entry.name === path.basename(symlinkPath))
          ?.isSymbolicLink(),
      ).toBe(true);
      expect(await readFile(symlinkTarget, "utf8")).toBe(
        "outside backup directory",
      );
    }
  });

  it("applies and semantically verifies scalar frontmatter changes", async () => {
    const before = "---\nstato: vecchio\n---\nTesto";
    vault.files.set("Scuola/Nota.md", before);
    vault.frontmatters.set("Scuola/Nota.md", { stato: "vecchio", elimina: true });
    await putRequest(
      baseRequest("frontmatter", before, {
        set: { stato: "pronto", voto: 9, tags: ["scuola", "esame"] },
        remove: ["elimina"],
      }),
    );

    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;
    expect(result).toMatchObject({
      status: "committed",
      operation: "frontmatter",
      verified: true,
    });
    expect(vault.frontmatters.get("Scuola/Nota.md")).toEqual({
      stato: "pronto",
      voto: 9,
      tags: ["scuola", "esame"],
    });
    expect(result.after_sha256).toBe(
      hashPresentDocument(vault.files.get("Scuola/Nota.md")!),
    );
  });

  it("fails the atomic frontmatter CAS instead of overwriting a concurrent body and properties", async () => {
    const before = "---\nstato: vecchio\n---\nTesto";
    const concurrent = "---\nstato: concorrente\n---\nTesto aggiornato altrove";
    vault.files.set("Scuola/Nota.md", before);
    vault.frontmatters.set("Scuola/Nota.md", { stato: "vecchio" });
    vault.concurrentFrontmatterContent = concurrent;
    vault.concurrentFrontmatter = { stato: "concorrente" };
    await putRequest(
      baseRequest("frontmatter", before, {
        set: { stato: "pronto" },
        remove: [],
      }),
    );

    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "failed",
      error_code: "CHANGE_CONFLICT",
      verified: false,
      rollback_attempted: true,
      rollback_succeeded: false,
      rollback_reason: "recovery_scope_changed",
    });
    expect(vault.files.get("Scuola/Nota.md")).toBe(concurrent);
    expect(vault.frontmatters.get("Scuola/Nota.md")).toEqual({
      stato: "concorrente",
    });
  });

  it("moves through the rename API and verifies both source and target", async () => {
    const before = "nota da spostare";
    vault.files.set("Scuola/Nota.md", before);
    await putRequest(
      baseRequest("move", before, { destination: "Archivio/Nota.md" }),
    );
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "committed",
      target_path: "Archivio/Nota.md",
      verified: true,
    });
    expect(vault.renameCalls).toBe(1);
    expect(vault.files.has("Scuola/Nota.md")).toBe(false);
    expect(vault.files.get("Archivio/Nota.md")).toBe(before);
    expect(await readAudit()).toMatchObject({ target_path: "Archivio/Nota.md" });
  });

  it("uses only the trash abstraction and records the missing-state hash", async () => {
    const before = "nota da cestinare";
    vault.files.set("Scuola/Nota.md", before);
    await putRequest(baseRequest("trash", before, {}));
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "committed",
      operation: "trash",
      verified: true,
      after_sha256: MISSING_DOCUMENT_SHA256,
    });
    expect(vault.trashCalls).toBe(1);
    expect(vault.files.has("Scuola/Nota.md")).toBe(false);
  });

  it("fails CAS before backup and mutation when the note changed", async () => {
    const prepared = "prima";
    vault.files.set("Scuola/Nota.md", "modifica concorrente");
    await putRequest(baseRequest("trash", prepared, {}));
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "failed",
      error_code: "CHANGE_CONFLICT",
      verified: false,
    });
    expect(result).not.toHaveProperty("backup_id");
    expect(vault.trashCalls).toBe(0);
    await expect(readdir(path.join(dataDirectory, "backups"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rechecks authorization after backup and stops on revocation", async () => {
    const before = "immutata";
    vault.files.set("Scuola/Nota.md", before);
    authorization = async (_request, phase) =>
      phase === "initial"
        ? { allowed: true, mode: "management" }
        : {
            allowed: false,
            mode: "management",
            error_code: "AUTHORIZATION_REVOKED",
          };
    await putRequest(baseRequest("trash", before, {}));
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "failed",
      error_code: "AUTHORIZATION_REVOKED",
      verified: false,
      backup_id: expect.any(String),
    });
    expect(vault.files.get("Scuola/Nota.md")).toBe(before);
    expect(vault.trashCalls).toBe(0);
  });

  it("consumes a request but discloses no metadata when its token is wrong", async () => {
    const before = "segreto";
    vault.files.set("Scuola/Nota.md", before);
    const requestPath = await putRequest(baseRequest("trash", before, {}));
    const result = await handler().handleResult({
      request_id: REQUEST_ID,
      token: "c".repeat(64),
    });

    expect(result).toEqual({
      version: 1,
      request_id: REQUEST_ID,
      status: "failed",
      verified: false,
      audit_recorded: false,
      error_code: "REQUEST_TOKEN_MISMATCH",
    });
    expect(JSON.stringify(result)).not.toContain("Scuola");
    expect(vault.trashCalls).toBe(0);
    await expect(readFile(requestPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("binds the claimed filename ID to the request envelope and consumes a copied request", async () => {
    const alternateId = "33333333-3333-4333-8333-333333333333";
    const before = "non riutilizzare";
    vault.files.set("Scuola/Nota.md", before);
    const copiedPath = managementRequestPath(dataDirectory, alternateId);
    await mkdir(path.dirname(copiedPath), { recursive: true });
    await writeFile(
      copiedPath,
      JSON.stringify(baseRequest("trash", before, {})),
      "utf8",
    );

    const result = await handler().handleResult({
      request_id: alternateId,
      token: TOKEN,
    });

    expect(result).toEqual({
      version: 1,
      request_id: alternateId,
      status: "failed",
      verified: false,
      audit_recorded: false,
      error_code: "REQUEST_ID_MISMATCH",
    });
    expect(vault.files.get("Scuola/Nota.md")).toBe(before);
    expect(vault.trashCalls).toBe(0);
    await expect(readFile(copiedPath, "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("consumes an expired request without touching the vault", async () => {
    const before = "scaduta";
    vault.files.set("Scuola/Nota.md", before);
    await putRequest({
      ...baseRequest("trash", before, {}),
      created_at: "2026-07-12T09:59:00.000Z",
      expires_at: "2026-07-12T10:00:00.000Z",
    });
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "failed",
      error_code: "REQUEST_EXPIRED",
      verified: false,
    });
    expect(vault.trashCalls).toBe(0);
    expect(vault.files.get("Scuola/Nota.md")).toBe(before);
  });

  it("rolls back only a known bridge-written body after verification failure", async () => {
    const before = "prima";
    const after = "dopo";
    vault.files.set("Scuola/Nota.md", before);
    vault.corruptNextProcess = true;
    await putRequest(
      baseRequest("replace", before, {
        content: after,
        after_sha256: hashPresentDocument(after),
      }),
    );
    const result = (await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    })) as ManagementCommandResponse;

    expect(result).toMatchObject({
      status: "failed",
      error_code: "VERIFICATION_FAILED",
      verified: false,
      rollback_attempted: true,
      rollback_succeeded: true,
      rollback_reason: "backup_restored",
      after_sha256: hashPresentDocument(before),
    });
    expect(vault.files.get("Scuola/Nota.md")).toBe(before);
    expect(vault.processCalls).toBe(2);
    expect(await readAudit()).toMatchObject({
      rollback_succeeded: true,
      after_sha256: hashPresentDocument(before),
    });
  });

  it("rejects symlink request files without reading their target", async () => {
    const before = "non leggere il target";
    const target = path.join(sandbox, "target.json");
    const targetContents = JSON.stringify(baseRequest("trash", before, {}));
    await writeFile(target, targetContents, "utf8");
    const requestFile = managementRequestPath(dataDirectory, REQUEST_ID);
    await mkdir(path.dirname(requestFile), { recursive: true });
    try {
      await symlink(target, requestFile, "file");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EPERM") return;
      throw error;
    }

    const result = await handler().handleResult({
      request_id: REQUEST_ID,
      token: TOKEN,
    });
    expect(result).toMatchObject({
      status: "failed",
      error_code: "UNSAFE_REQUEST_FILE",
      audit_recorded: false,
    });
    expect(await readFile(target, "utf8")).toBe(targetContents);
  });

  it("allows exactly one commit attempt for a request under concurrency", async () => {
    const before = "una sola volta";
    vault.files.set("Scuola/Nota.md", before);
    await putRequest(baseRequest("trash", before, {}));
    const instance = handler();

    const results = await Promise.all([
      instance.handleResult({ request_id: REQUEST_ID, token: TOKEN }),
      instance.handleResult({ request_id: REQUEST_ID, token: TOKEN }),
    ]);
    expect(results.map((result) => result.status)).toEqual(["committed", "failed"]);
    expect(results[1]).toMatchObject({ error_code: "REQUEST_NOT_FOUND" });
    expect(vault.trashCalls).toBe(1);
  });
});
