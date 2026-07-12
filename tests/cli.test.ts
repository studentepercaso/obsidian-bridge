import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  MAX_CLI_IPC_FRAME_BYTES,
  assertReadOnlyCliArgs,
  assertWriteEnabledCliArgs,
  buildVaultArgs,
  buildWriteVaultArgs,
  cliIpcFrameBytes,
  createObsidianCliRunner,
  encodeCliContent,
  type SpawnImplementation,
} from "../src/cli.js";
import type { BridgeConfig } from "../src/config.js";

const fakeCliPath = fileURLToPath(
  new URL("./fixtures/fake-obsidian-cli.mjs", import.meta.url),
);

function config(overrides: Partial<BridgeConfig> = {}): BridgeConfig {
  return {
    executable: "fake-obsidian",
    timeoutMs: 2_000,
    maxOutputBytes: 64 * 1_024,
    allowedFolders: null,
    deniedFolders: [".obsidian", ".trash"],
    ...overrides,
  };
}

function createControlledChild(): {
  readonly child: ChildProcess;
  readonly stdout: PassThrough;
  readonly kill: ReturnType<typeof vi.fn>;
  readonly close: () => void;
} {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const kill = vi.fn(() => true);
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    exitCode: null as number | null,
    kill,
  });

  return {
    child: child as unknown as ChildProcess,
    stdout,
    kill,
    close: () => {
      child.emit("close", null, "SIGTERM");
    },
  };
}

async function expectTerminationAfterClose(
  invocation: Promise<unknown>,
  child: ReturnType<typeof createControlledChild>,
  expectedCode: "ABORTED" | "OUTPUT_LIMIT" | "TIMEOUT",
): Promise<void> {
  let outcome: "pending" | "resolved" | "rejected" = "pending";
  void invocation.then(
    () => {
      outcome = "resolved";
    },
    () => {
      outcome = "rejected";
    },
  );

  await vi.waitFor(() => expect(child.kill).toHaveBeenCalledTimes(1));
  await new Promise<void>((resolve) => setImmediate(resolve));
  expect(outcome).toBe("pending");

  child.close();
  await expect(invocation).rejects.toMatchObject({ code: expectedCode });
  expect(outcome).toBe("rejected");
}

describe("read-only Obsidian CLI runner", () => {
  let temporaryDirectory: string;

  beforeEach(async () => {
    temporaryDirectory = await mkdtemp(join(tmpdir(), "obsidian-bridge-test-"));
  });

  afterEach(async () => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    await rm(temporaryDirectory, { recursive: true, force: true });
  });

  it("puts vault first, passes each parameter as one argv item, and disables the shell", async () => {
    const logPath = join(temporaryDirectory, "argv.jsonl");
    const injectedPath = join(temporaryDirectory, "shell-was-used.txt");
    const query = `query=alpha & echo injected > "${injectedPath}"`;
    vi.stubEnv("OBSIDIAN_FAKE_LOG", logPath);

    const realSpawnThroughNode: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const spawnSpy = vi.fn(realSpawnThroughNode);
    const runner = createObsidianCliRunner(config(), spawnSpy);
    const argv = buildVaultArgs("Test Vault", "search", [
      query,
      "limit=5",
      "format=json",
    ]);

    await expect(runner(argv)).resolves.toMatchObject({ exitCode: 0 });

    expect(argv).toEqual([
      "vault=Test Vault",
      "search",
      query,
      "limit=5",
      "format=json",
    ]);
    expect(spawnSpy).toHaveBeenCalledTimes(1);
    const [executable, spawnedArgs, options] = spawnSpy.mock.calls[0]!;
    expect(executable).toBe("fake-obsidian");
    expect(spawnedArgs).toEqual(argv);
    expect((options as SpawnOptions).shell).toBe(false);
    expect((options as SpawnOptions).windowsHide).toBe(true);

    const invocation = JSON.parse(
      readFileSync(logPath, "utf8").trim(),
    ) as { argv: string[] };
    expect(invocation.argv).toEqual(argv);
    expect(existsSync(injectedPath)).toBe(false);
  });

  it.each([
    [[], "INVALID_ARGUMENTS"],
    [["search", "vault=Test Vault", "query=alpha"], "INVALID_ARGUMENTS"],
    [["vault=Test Vault", "delete", "path=Alpha.md"], "INVALID_ARGUMENTS"],
    [["vault=Test Vault", "read", "path=Alpha.md", "force"], "INVALID_ARGUMENTS"],
    [["vaults", "query=alpha"], "INVALID_ARGUMENTS"],
  ] as const)("rejects unsafe argv %j", (argv, code) => {
    expect(() => assertReadOnlyCliArgs(argv)).toThrowError(
      expect.objectContaining({ code }),
    );
  });

  it("rejects controls in vault names and parameters", () => {
    expect(() => buildVaultArgs("Bad\nVault", "read", ["path=Alpha.md"])).toThrow();
    expect(() =>
      assertReadOnlyCliArgs([
        "vault=Test Vault",
        "search",
        "query=alpha\nverbose",
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
  });

  it("keeps write commands off the read runner and narrowly allowlists writer argv", () => {
    const createArgs = buildWriteVaultArgs("Test Vault", "create", [
      "path=Projects/New.md",
      "content=one\\ntwo",
    ]);
    expect(createArgs).toEqual([
      "vault=Test Vault",
      "create",
      "path=Projects/New.md",
      "content=one\\ntwo",
    ]);
    expect(() => assertReadOnlyCliArgs(createArgs)).toThrowError(
      expect.objectContaining({ code: "INVALID_ARGUMENTS" }),
    );
    expect(() => assertWriteEnabledCliArgs(createArgs)).not.toThrow();
    expect(() =>
      assertWriteEnabledCliArgs([
        "vault=Test Vault",
        "delete",
        "path=Projects/New.md",
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
    expect(() =>
      assertWriteEnabledCliArgs([
        "vault=Test Vault",
        "create",
        "path=Projects/New.md",
        "content=ok",
        "silent",
      ]),
    ).toThrowError(expect.objectContaining({ code: "INVALID_ARGUMENTS" }));
  });

  it("measures the complete Obsidian IPC frame including cwd and framing metadata", () => {
    const args = [
      "vault=Test Vault",
      "create",
      "path=Projects/New.md",
      'content=quoted "value" and é',
    ];
    const cwd = "C:\\Bridge Test";
    expect(cliIpcFrameBytes(args, cwd)).toBe(
      Buffer.byteLength(
        `${JSON.stringify({ argv: args, tty: false, cwd })}\n`,
        "utf8",
      ),
    );
  });

  it("rejects an oversized IPC frame before spawning the Obsidian CLI", async () => {
    const spawnSpy = vi.fn<SpawnImplementation>();
    const runner = createObsidianCliRunner(config(), spawnSpy, {
      allowWrites: true,
    });
    const args = [
      "vault=Test Vault",
      "create",
      "path=Projects/New.md",
      `content=${"x".repeat(MAX_CLI_IPC_FRAME_BYTES)}`,
    ];

    expect(cliIpcFrameBytes(args)).toBeGreaterThan(MAX_CLI_IPC_FRAME_BYTES);
    await expect(runner(args)).rejects.toMatchObject({
      code: "INVALID_ARGUMENTS",
      message: expect.stringMatching(/IPC frame/iu),
    });
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("encodes newline, tab, and carriage returns while preserving ordinary backslashes", () => {
    expect(encodeCliContent("one\r\ntwo\tC:\\Users\\docs\rthree\\end")).toBe(
      "one\\ntwo\\tC:\\Users\\docs\\nthree\\end",
    );
  });

  it("rejects literal backslash-n and backslash-t sequences the official CLI cannot preserve", () => {
    expect(() => encodeCliContent(String.raw`C:\notes`)).toThrow(
      /cannot represent losslessly/iu,
    );
    expect(() => encodeCliContent(String.raw`\\text{value}`)).toThrow(
      /cannot represent losslessly/iu,
    );
  });

  it("round-trips escaped write content as one argv item through the fake CLI", async () => {
    const statePath = join(temporaryDirectory, "state.json");
    writeFileSync(statePath, "{}\n", "utf8");
    vi.stubEnv("OBSIDIAN_FAKE_STATE_FILE", statePath);
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(
      config(),
      spawnImplementation,
      { allowWrites: true },
    );
    const content = "line one\n\tC:\\Users\\literal\\alpha\n";

    await runner(
      buildWriteVaultArgs("Test Vault", "create", [
        "path=Projects/New.md",
        `content=${encodeCliContent(content)}`,
      ]),
    );

    expect(
      (JSON.parse(readFileSync(statePath, "utf8")) as Record<string, string>)[
        "Projects/New.md"
      ],
    ).toBe(content);
  });

  it("kills the child and fails when combined stdout and stderr exceed the limit", async () => {
    vi.stubEnv("OBSIDIAN_FAKE_BYTES", "4096");
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(
      config({ maxOutputBytes: 128 }),
      spawnImplementation,
    );

    await expect(
      runner(buildVaultArgs("Test Vault", "read", ["path=Projects/Alpha.md"])),
    ).rejects.toMatchObject({ code: "OUTPUT_LIMIT" });
  });

  it("times out a hung CLI process", async () => {
    vi.stubEnv("OBSIDIAN_FAKE_DELAY_MS", "500");
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(
      config({ timeoutMs: 30 }),
      spawnImplementation,
    );

    await expect(
      runner(buildVaultArgs("Test Vault", "read", ["path=Projects/Alpha.md"])),
    ).rejects.toMatchObject({ code: "TIMEOUT" });
  });

  it("waits for process close before rejecting an output-limit failure", async () => {
    const controlled = createControlledChild();
    const runner = createObsidianCliRunner(
      config({ maxOutputBytes: 8 }),
      () => controlled.child,
    );
    const invocation = runner(["vaults", "verbose"]);

    controlled.stdout.write(Buffer.alloc(9));

    await expectTerminationAfterClose(invocation, controlled, "OUTPUT_LIMIT");
  });

  it("waits for process close before rejecting an aborted invocation", async () => {
    const controlled = createControlledChild();
    const controller = new AbortController();
    const runner = createObsidianCliRunner(config(), () => controlled.child);
    const invocation = runner(["vaults", "verbose"], {
      signal: controller.signal,
    });

    controller.abort();

    await expectTerminationAfterClose(invocation, controlled, "ABORTED");
  });

  it("waits for process close before rejecting a timeout", async () => {
    const controlled = createControlledChild();
    const runner = createObsidianCliRunner(
      config({ timeoutMs: 5 }),
      () => controlled.child,
    );
    const invocation = runner(["vaults", "verbose"]);

    await expectTerminationAfterClose(invocation, controlled, "TIMEOUT");
  });

  it("surfaces a bounded non-zero CLI failure without stdout confusion", async () => {
    vi.stubEnv("OBSIDIAN_FAKE_STDERR", "Obsidian is unavailable");
    vi.stubEnv("OBSIDIAN_FAKE_EXIT_CODE", "7");
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(runner(["vaults", "verbose"])).rejects.toMatchObject({
      code: "NON_ZERO_EXIT",
      exitCode: 7,
      message: "Obsidian is unavailable",
    });
  });

  it("fails when Obsidian reports a disabled CLI with exit code zero", async () => {
    vi.stubEnv(
      "OBSIDIAN_FAKE_STDOUT",
      "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.",
    );
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(runner(["vaults", "verbose"])).rejects.toMatchObject({
      code: "CLI_NOT_ENABLED",
      message:
        "Command line interface is not enabled. Please turn it on in Settings > General > Advanced.",
    });
  });

  it("fails closed when Obsidian prints an Error line but exits zero", async () => {
    vi.stubEnv(
      "OBSIDIAN_FAKE_STDOUT",
      'Error: File "Projects/Missing.md" not found.',
    );
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(
      runner(buildVaultArgs("Test Vault", "read", ["path=Projects/Missing.md"])),
    ).rejects.toMatchObject({
      code: "CLI_REPORTED_ERROR",
      message: 'Error: File "Projects/Missing.md" not found.',
    });
  });

  it("fails closed on a multiline Error and Usage diagnostic", async () => {
    vi.stubEnv(
      "OBSIDIAN_FAKE_STDOUT",
      "Error: Missing required parameter: query=<text>\nUsage: obsidian search query=<text>\n",
    );
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(runner(["vaults", "verbose"])).rejects.toMatchObject({
      code: "CLI_REPORTED_ERROR",
      message:
        "Error: Missing required parameter: query=<text>\nUsage: obsidian search query=<text>",
    });
  });

  it("fails closed on Obsidian's zero-exit missing-vault diagnostic", async () => {
    vi.stubEnv("OBSIDIAN_FAKE_STDOUT", "Vault not found.\n");
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(
      runner(buildVaultArgs("Missing Vault", "read", ["path=Projects/Note.md"])),
    ).rejects.toMatchObject({
      code: "CLI_REPORTED_ERROR",
      message: "Vault not found.",
    });
  });

  it("does not reject ordinary successful output containing the word Error", async () => {
    vi.stubEnv("OBSIDIAN_FAKE_STDOUT", "Heading\nError: explanatory note text\n");
    const spawnImplementation: SpawnImplementation = (
      _executable,
      args,
      options,
    ) => spawn(process.execPath, [fakeCliPath, ...args], options);
    const runner = createObsidianCliRunner(config(), spawnImplementation);

    await expect(
      runner(buildVaultArgs("Test Vault", "read", ["path=Projects/Alpha.md"])),
    ).resolves.toMatchObject({
      stdout: "Heading\nError: explanatory note text\n",
      exitCode: 0,
    });
  });
});
