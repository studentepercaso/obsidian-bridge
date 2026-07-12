import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const renameFault = vi.hoisted(
  (): {
    code: "EPERM" | "EBUSY" | "EACCES";
    remaining: number;
    attempts: number;
    onFailure: (() => Promise<void>) | null;
  } => ({
    code: "EPERM",
    remaining: 0,
    attempts: 0,
    onFailure: null,
  }),
);

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    rename: async (
      oldPath: Parameters<typeof actual.rename>[0],
      newPath: Parameters<typeof actual.rename>[1],
    ): Promise<void> => {
      const isReleaseRename =
        String(oldPath).endsWith(".lock") &&
        String(newPath).includes(".lock.release-");
      if (!isReleaseRename) {
        await actual.rename(oldPath, newPath);
        return;
      }

      renameFault.attempts += 1;
      if (renameFault.remaining > 0) {
        renameFault.remaining -= 1;
        const onFailure = renameFault.onFailure;
        renameFault.onFailure = null;
        await onFailure?.();
        throw Object.assign(new Error("injected rename failure"), {
          code: renameFault.code,
        });
      }
      await actual.rename(oldPath, newPath);
    },
  };
});

import {
  CommitLockReleaseAfterOperationError,
  acquireCommitLock,
  commitLockPath,
  deriveCommitLockKey,
  withCommitLock,
} from "../src/commit-lock.js";

describe("cross-process commit lock", () => {
  let sandbox = "";

  beforeEach(async () => {
    renameFault.code = "EPERM";
    renameFault.remaining = 0;
    renameFault.attempts = 0;
    renameFault.onFailure = null;
    sandbox = await mkdtemp(path.join(tmpdir(), "obsidian-commit-lock-"));
  });

  afterEach(async () => {
    await rm(sandbox, { recursive: true, force: true });
  });

  function options(notePath = "Projects/Alpha.md") {
    return {
      dataDirectory: sandbox,
      vault: "0123456789abcdef",
      notePath,
      timeoutMs: 1_000,
      retryDelayMs: 5,
      staleAfterMs: 60_000,
    } as const;
  }

  it("serializes contenders for the same vault and note", async () => {
    const events: string[] = [];
    let allowFirstToFinish: (() => void) | undefined;
    const firstMayFinish = new Promise<void>((resolve) => {
      allowFirstToFinish = resolve;
    });

    const first = withCommitLock(options(), async () => {
      events.push("first-enter");
      await firstMayFinish;
      events.push("first-exit");
    });
    while (!events.includes("first-enter")) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }

    const second = withCommitLock(options(), async () => {
      events.push("second-enter");
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(events).toEqual(["first-enter"]);

    allowFirstToFinish?.();
    await Promise.all([first, second]);
    expect(events).toEqual(["first-enter", "first-exit", "second-enter"]);
  });

  it("writes a private owner record and removes the lock on release", async () => {
    const lock = await acquireCommitLock(options());
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    const owner = JSON.parse(
      await readFile(path.join(lockDirectory, "owner.json"), "utf8"),
    ) as Record<string, unknown>;

    expect(owner).toEqual({
      token: expect.stringMatching(/^[0-9a-f-]{36}$/iu),
      pid: process.pid,
      createdAt: expect.any(String),
    });
    await lock.release();
    await lock.release();
    await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it.each(["EPERM", "EBUSY"] as const)(
    "retries transient %s failures while releasing a lock",
    async (code) => {
      const lock = await acquireCommitLock(options());
      const lockDirectory = commitLockPath(
        sandbox,
        options().vault,
        options().notePath,
      );
      renameFault.code = code;
      renameFault.remaining = 2;

      await lock.release();

      expect(renameFault.attempts).toBe(3);
      await expect(stat(lockDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("does not retry a non-transient release error", async () => {
    const lock = await acquireCommitLock(options());
    renameFault.code = "EACCES";
    renameFault.remaining = 3;

    await expect(lock.release()).rejects.toMatchObject({
      code: "LOCK_IO_ERROR",
    });
    expect(renameFault.attempts).toBe(1);

    renameFault.remaining = 0;
    await lock.release();
  });

  it("stops after the bounded transient retry budget", async () => {
    const lock = await acquireCommitLock(options());
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    renameFault.remaining = 5;

    await expect(lock.release()).rejects.toMatchObject({
      code: "LOCK_IO_ERROR",
    });
    expect(renameFault.attempts).toBe(4);
    await expect(stat(lockDirectory)).resolves.toMatchObject({});

    renameFault.remaining = 0;
    await lock.release();
  });

  it("stops retrying when the lock owner changes", async () => {
    const lock = await acquireCommitLock(options());
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    const ownerPath = path.join(lockDirectory, "owner.json");
    renameFault.remaining = 1;
    renameFault.onFailure = async () => {
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
    };

    await expect(lock.release()).rejects.toMatchObject({
      code: "LOCK_OWNERSHIP_LOST",
    });
    expect(renameFault.attempts).toBe(1);
    await expect(stat(lockDirectory)).resolves.toMatchObject({});
  });

  it("fails closed instead of releasing a lock with a different owner token", async () => {
    const lock = await acquireCommitLock(options());
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    const ownerPath = path.join(lockDirectory, "owner.json");
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

    await expect(lock.release()).rejects.toMatchObject({
      code: "LOCK_OWNERSHIP_LOST",
    });
    await expect(stat(lockDirectory)).resolves.toMatchObject({});
  });

  it("atomically reclaims a stale lock left by a dead process", async () => {
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    await mkdir(lockDirectory, { recursive: true });
    const staleToken = "00000000-0000-4000-8000-000000000001";
    await writeFile(
      path.join(lockDirectory, "owner.json"),
      `${JSON.stringify({
        token: staleToken,
        pid: 2_147_483_647,
        createdAt: new Date(Date.now() - 60_000).toISOString(),
      })}\n`,
      "utf8",
    );

    const lock = await acquireCommitLock({
      ...options(),
      staleAfterMs: 10,
    });
    const owner = JSON.parse(
      await readFile(path.join(lockDirectory, "owner.json"), "utf8"),
    ) as { readonly token: string };
    expect(owner.token).not.toBe(staleToken);
    const siblings = await readdir(path.dirname(lockDirectory));
    expect(siblings).toEqual([path.basename(lockDirectory)]);
    await lock.release();
  });

  it("supports aborting a waiter", async () => {
    const first = await acquireCommitLock(options());
    const controller = new AbortController();
    const waiting = acquireCommitLock({
      ...options(),
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error("test abort")), 20);

    await expect(waiting).rejects.toMatchObject({
      code: "LOCK_ABORTED",
    });
    await first.release();
  });

  it("times out after the configured bounded wait", async () => {
    const first = await acquireCommitLock(options());
    const startedAt = Date.now();

    await expect(
      acquireCommitLock({
        ...options(),
        timeoutMs: 30,
        retryDelayMs: 5,
      }),
    ).rejects.toMatchObject({ code: "LOCK_TIMEOUT" });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
    await first.release();
  });

  it("uses distinct opaque keys for different vault/path pairs", async () => {
    const alpha = deriveCommitLockKey("vault-a", "Projects/Alpha.md");
    const beta = deriveCommitLockKey("vault-a", "Projects/Beta.md");
    const otherVault = deriveCommitLockKey("vault-b", "Projects/Alpha.md");

    expect(alpha).toMatch(/^[0-9a-f]{64}$/u);
    expect(new Set([alpha, beta, otherVault]).size).toBe(3);
    expect(alpha).not.toContain("Projects");

    const first = await acquireCommitLock(options("Projects/Alpha.md"));
    const second = await acquireCommitLock(options("Projects/Beta.md"));
    await Promise.all([first.release(), second.release()]);
  });

  it("uses the authorizing policy's case sensitivity for lock identity", () => {
    const mixedCase = deriveCommitLockKey(
      "vault-a",
      "Projects/Alpha.md",
      false,
    );
    const lowerCase = deriveCommitLockKey(
      "vault-a",
      "projects/alpha.md",
      false,
    );
    expect(mixedCase).toBe(lowerCase);
    expect(
      deriveCommitLockKey("vault-a", "Projects/Alpha.md", true),
    ).not.toBe(deriveCommitLockKey("vault-a", "projects/alpha.md", true));
    expect(
      commitLockPath(
        sandbox,
        "vault-a",
        "Projects/Alpha.md",
        false,
      ),
    ).toBe(
      commitLockPath(
        sandbox,
        "vault-a",
        "projects/alpha.md",
        false,
      ),
    );
  });

  it("preserves a completed operation result when lock release fails", async () => {
    const lockDirectory = commitLockPath(
      sandbox,
      options().vault,
      options().notePath,
    );
    const completed = { status: "committed", verified: true };
    const operation = withCommitLock(options(), async () => {
      const ownerPath = path.join(lockDirectory, "owner.json");
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
      return completed;
    });

    await expect(operation).rejects.toMatchObject({
      name: "CommitLockReleaseAfterOperationError",
      operationResult: completed,
      releaseError: { code: "LOCK_OWNERSHIP_LOST" },
    });
    await expect(operation).rejects.toBeInstanceOf(
      CommitLockReleaseAfterOperationError,
    );
  });

  it("rejects relative data directories", async () => {
    await expect(
      acquireCommitLock({
        dataDirectory: "relative/data",
        vault: "vault",
        notePath: "Note.md",
      }),
    ).rejects.toMatchObject({
      code: "INVALID_LOCK_OPTIONS",
    });
  });
});
