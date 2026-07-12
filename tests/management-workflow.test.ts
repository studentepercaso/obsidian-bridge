import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ObsidianCliError,
  type ObsidianCliRunner,
} from "../src/cli.js";
import type {
  ManagementRequest,
  ManagementResponse,
} from "../src/management-protocol.js";
import {
  ManagementToolInputSchemas,
  PreparedManagementStore,
  createManagementToolHandlers,
} from "../src/management-workflow.js";
import {
  createPathPolicy,
  createWritablePathPolicy,
} from "../src/path-policy.js";
import type {
  ManagementPermissions,
  VaultAccess,
  VaultAccessResolver,
} from "../src/shared-settings.js";
import { hashDocumentState } from "../src/write-workflow.js";

const VAULT_ID = "0123456789abcdef";
const VAULT_NAME = "Test Vault";
const NOTE_PATH = "Projects/Managed.md";

function parameter(args: readonly string[], name: string): string | undefined {
  const prefix = `${name}=`;
  return args
    .find((argument) => argument.startsWith(prefix))
    ?.slice(prefix.length);
}

function resultJson(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const first = result.content[0];
  if (first?.type !== "text" || typeof first.text !== "string") {
    throw new Error("expected one MCP text result");
  }
  return JSON.parse(first.text) as Record<string, unknown>;
}

function fixedStore(
  now: () => number = () => 1_000,
  ttlMs = 60_000,
): PreparedManagementStore {
  let next = 0;
  return new PreparedManagementStore({
    ttlMs,
    now,
    createId: () =>
      `00000000-0000-4000-8000-${String(++next).padStart(12, "0")}`,
  });
}

function managementAccess(
  permissions: ManagementPermissions = {
    edit: true,
    move: true,
    trash: true,
  },
): VaultAccess {
  const readPolicy = createPathPolicy({
    allowedFolders: null,
    deniedFolders: [".obsidian", ".trash"],
  });
  return {
    readPolicy,
    writablePolicy: readPolicy,
    writeEnabled: true,
    accessMode: "management",
    managementPermissions: permissions,
    vaultSelector: VAULT_ID,
    vaultName: VAULT_NAME,
    source: "settings",
  };
}

interface MemoryRunnerOptions {
  readonly transformResponse?: (
    response: ManagementResponse,
    request: ManagementRequest,
  ) => unknown;
}

function createMemoryRunner(
  notes: Record<string, string>,
  dataDirectory: string,
  invocations: string[][],
  capturedRequests: Array<{
    request: ManagementRequest;
    requestPath: string;
    tokenArgument: string;
  }>,
  options: MemoryRunnerOptions = {},
): ObsidianCliRunner {
  return async (args) => {
    invocations.push([...args]);
    const command = args[1];
    if (command === "read") {
      const notePath = parameter(args, "path");
      if (notePath === undefined || !(notePath in notes)) {
        throw new ObsidianCliError(
          "NON_ZERO_EXIT",
          `Note not found: ${notePath ?? ""}`,
          2,
        );
      }
      return { stdout: notes[notePath]!, stderr: "", exitCode: 0 };
    }

    if (command !== "bridge-control:commit") {
      throw new Error(`unexpected command: ${command ?? "missing"}`);
    }
    const requestId = parameter(args, "request");
    const tokenArgument = parameter(args, "token");
    if (requestId === undefined || tokenArgument === undefined) {
      throw new Error("management request and token are required");
    }
    const requestPath = join(
      dataDirectory,
      "management",
      "requests",
      `${requestId}.json`,
    );
    const request = JSON.parse(
      await readFile(requestPath, "utf8"),
    ) as ManagementRequest;
    if (request.token !== tokenArgument) {
      throw new Error("management token mismatch in test runner");
    }
    capturedRequests.push({ request, requestPath, tokenArgument });

    let afterSha256: string;
    let targetPath: string | undefined;
    if (request.operation === "replace") {
      notes[request.path] = request.payload.content;
      afterSha256 = hashDocumentState(true, request.payload.content);
    } else if (request.operation === "move") {
      targetPath = request.payload.destination;
      notes[targetPath] = notes[request.path]!;
      delete notes[request.path];
      afterSha256 = hashDocumentState(true, notes[targetPath]!);
    } else if (request.operation === "trash") {
      delete notes[request.path];
      afterSha256 = hashDocumentState(false);
    } else {
      afterSha256 = hashDocumentState(true, notes[request.path]!);
    }

    const response: ManagementResponse = {
      version: 1,
      request_id: request.request_id,
      change_id: request.change_id,
      status: "committed",
      operation: request.operation,
      path: request.path,
      ...(targetPath === undefined ? {} : { target_path: targetPath }),
      before_sha256: request.before_sha256,
      after_sha256: afterSha256,
      verified: true,
      backup_id: `backup-${request.request_id}`,
      audit_recorded: true,
    };
    return {
      stdout: JSON.stringify(
        options.transformResponse?.(response, request) ?? response,
      ),
      stderr: "",
      exitCode: 0,
    };
  };
}

function runtime(
  runner: ObsidianCliRunner,
  dataDirectory: string,
  store: PreparedManagementStore = fixedStore(),
  resolveAccess: VaultAccessResolver = async () => managementAccess(),
  now: () => number = () => 1_000,
) {
  const readPolicy = createPathPolicy({ allowedFolders: null });
  const writablePolicy = createWritablePathPolicy({
    allowedFolders: null,
    caseSensitive: readPolicy.caseSensitive,
  });
  return createManagementToolHandlers({
    runner,
    readPolicy,
    writablePolicy,
    store,
    resolveAccess,
    dataDirectory,
    now,
  });
}

describe("managed vault workflow", () => {
  const temporaryDirectories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      temporaryDirectories.splice(0).map(async (directory) => {
        await rm(directory, { recursive: true, force: true });
      }),
    );
  });

  async function temporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), "obsidian-management-test-"));
    temporaryDirectories.push(directory);
    return directory;
  }

  it("strictly validates the public operation schemas", () => {
    expect(
      ManagementToolInputSchemas.prepareChange.parse({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "replace_text",
        find: "old",
        replacement: "new",
      }),
    ).toMatchObject({ expected_occurrences: 1 });
    expect(
      ManagementToolInputSchemas.prepareChange.safeParse({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "frontmatter",
        set: {},
        remove: [],
      }).success,
    ).toBe(false);
    expect(
      ManagementToolInputSchemas.prepareChange.safeParse({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "frontmatter",
        set: { owner: "Ada" },
        remove: ["owner"],
      }).success,
    ).toBe(false);
    expect(
      ManagementToolInputSchemas.prepareChange.safeParse({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "trash",
        permanent: true,
      }).success,
    ).toBe(false);
    expect(
      ManagementToolInputSchemas.commitChange.safeParse({
        change_id: "replayable-name",
      }).success,
    ).toBe(false);
  });

  it("previews an exact replace_text without modifying the note", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { [NOTE_PATH]: "alpha beta beta\n" };
    const invocations: string[][] = [];
    const captured: Array<{
      request: ManagementRequest;
      requestPath: string;
      tokenArgument: string;
    }> = [];
    const handlers = runtime(
      createMemoryRunner(notes, dataDirectory, invocations, captured),
      dataDirectory,
    );

    const prepared = resultJson(
      await handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "replace_text",
          find: "beta",
          replacement: "omega",
          expected_occurrences: 2,
        }),
      ),
    );

    expect(prepared).toMatchObject({
      status: "prepared",
      operation: "replace_text",
      path: NOTE_PATH,
      authorization_mode: "management",
      approval_required: false,
      preview: {
        exact_match_count: 2,
        before_sha256: hashDocumentState(true, "alpha beta beta\n"),
        after_sha256: hashDocumentState(true, "alpha omega omega\n"),
      },
    });
    expect(JSON.stringify(prepared.preview)).toContain("-alpha beta beta");
    expect(JSON.stringify(prepared.preview)).toContain("+alpha omega omega");
    expect(notes[NOTE_PATH]).toBe("alpha beta beta\n");
    expect(invocations.map((args) => args[1])).toEqual(["read"]);
  });

  it("rejects a replace_text when its exact occurrence count changed", async () => {
    const dataDirectory = await temporaryDirectory();
    const handlers = runtime(
      createMemoryRunner(
        { [NOTE_PATH]: "old old\n" },
        dataDirectory,
        [],
        [],
      ),
      dataDirectory,
    );

    await expect(
      handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "replace_text",
          find: "old",
          replacement: "new",
          expected_occurrences: 1,
        }),
      ),
    ).rejects.toThrow(/expected 1 exact occurrence.*found 2/iu);
  });

  it("previews a bounded frontmatter set/remove request", async () => {
    const dataDirectory = await temporaryDirectory();
    const handlers = runtime(
      createMemoryRunner(
        { [NOTE_PATH]: "---\nold: true\n---\nBody\n" },
        dataDirectory,
        [],
        [],
      ),
      dataDirectory,
    );

    const prepared = resultJson(
      await handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "frontmatter",
          set: { owner: "Ada", tags: ["managed", "safe"], reviewed: true },
          remove: ["old", "old"],
        }),
      ),
    );

    expect(prepared).toMatchObject({
      operation: "frontmatter",
      preview: {
        set: { owner: "Ada", tags: ["managed", "safe"], reviewed: true },
        remove: ["old"],
        before_sha256: hashDocumentState(
          true,
          "---\nold: true\n---\nBody\n",
        ),
      },
    });
  });

  it("fails before preparation when a move destination already exists", async () => {
    const dataDirectory = await temporaryDirectory();
    const destination = "Archive/Managed.md";
    const handlers = runtime(
      createMemoryRunner(
        { [NOTE_PATH]: "source\n", [destination]: "occupied\n" },
        dataDirectory,
        [],
        [],
      ),
      dataDirectory,
    );

    await expect(
      handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "move",
          destination_path: destination,
        }),
      ),
    ).rejects.toThrow(/destination already exists/iu);
  });

  it("requires the separate trash permission and never invokes the CLI when denied", async () => {
    const dataDirectory = await temporaryDirectory();
    const invocations: string[][] = [];
    const resolveAccess: VaultAccessResolver = async () =>
      managementAccess({ edit: true, move: true, trash: false });
    const handlers = runtime(
      createMemoryRunner(
        { [NOTE_PATH]: "safe\n" },
        dataDirectory,
        invocations,
        [],
      ),
      dataDirectory,
      fixedStore(),
      resolveAccess,
    );

    await expect(
      handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "trash",
        }),
      ),
    ).rejects.toThrow(/permission trash is disabled/iu);
    expect(invocations).toEqual([]);
  });

  it("commits only through the custom CLI transport and removes its one-time request", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { [NOTE_PATH]: "before value\n" };
    const invocations: string[][] = [];
    const captured: Array<{
      request: ManagementRequest;
      requestPath: string;
      tokenArgument: string;
    }> = [];
    const handlers = runtime(
      createMemoryRunner(notes, dataDirectory, invocations, captured),
      dataDirectory,
    );
    const prepared = resultJson(
      await handlers.prepareChange(
        ManagementToolInputSchemas.prepareChange.parse({
          vault: VAULT_NAME,
          path: NOTE_PATH,
          operation: "replace_text",
          find: "before",
          replacement: "after",
        }),
      ),
    );

    const committed = resultJson(
      await handlers.commitChange(
        ManagementToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    );

    expect(committed).toMatchObject({
      status: "committed",
      operation: "replace",
      path: NOTE_PATH,
      verified: true,
      audit_recorded: true,
      authorization_mode: "management",
      locks_released: true,
    });
    expect(notes[NOTE_PATH]).toBe("after value\n");
    expect(captured).toHaveLength(1);
    expect(captured[0]?.request).toMatchObject({
      version: 1,
      vault_id: VAULT_ID,
      change_id: prepared.change_id,
      operation: "replace",
      path: NOTE_PATH,
      before_sha256: hashDocumentState(true, "before value\n"),
      payload: {
        content: "after value\n",
        after_sha256: hashDocumentState(true, "after value\n"),
      },
    });
    expect(captured[0]?.request.token).toMatch(/^[0-9a-f]{64}$/u);
    expect(captured[0]?.tokenArgument).toBe(captured[0]?.request.token);
    expect(invocations.map((args) => args[1])).toEqual([
      "read",
      "read",
      "bridge-control:commit",
    ]);
    const managementInvocation = invocations.at(-1)!;
    expect(managementInvocation).toEqual([
      `vault=${VAULT_ID}`,
      "bridge-control:commit",
      `request=${captured[0]!.request.request_id}`,
      `token=${captured[0]!.request.token}`,
    ]);
    await expect(access(captured[0]!.requestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await expect(
      handlers.commitChange(
        ManagementToolInputSchemas.commitChange.parse({
          change_id: prepared.change_id,
        }),
      ),
    ).rejects.toThrow(/unknown|expired|consumed/iu);
    expect(invocations.filter((args) => args[1] === "bridge-control:commit"))
      .toHaveLength(1);
  });

  it("rechecks management permission revocation after preview", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { [NOTE_PATH]: "before\n" };
    const invocations: string[][] = [];
    let editEnabled = true;
    const resolveAccess: VaultAccessResolver = async () =>
      managementAccess({ edit: editEnabled, move: true, trash: true });
    const handlers = runtime(
      createMemoryRunner(notes, dataDirectory, invocations, []),
      dataDirectory,
      fixedStore(),
      resolveAccess,
    );
    const prepared = resultJson(
      await handlers.prepareChange({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "replace",
        content: "after\n",
      }),
    );
    editEnabled = false;

    await expect(
      handlers.commitChange({ change_id: String(prepared.change_id) }),
    ).rejects.toThrow(/permission edit is disabled/iu);
    expect(notes[NOTE_PATH]).toBe("before\n");
    expect(invocations.some((args) => args[1] === "bridge-control:commit"))
      .toBe(false);
  });

  it("rejects a mismatched Bridge Control response and still removes the request file", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { [NOTE_PATH]: "before\n" };
    const captured: Array<{
      request: ManagementRequest;
      requestPath: string;
      tokenArgument: string;
    }> = [];
    const runner = createMemoryRunner(notes, dataDirectory, [], captured, {
      transformResponse: (response) => ({
        ...response,
        request_id: "00000000-0000-4000-8000-999999999999",
      }),
    });
    const handlers = runtime(runner, dataDirectory);
    const prepared = resultJson(
      await handlers.prepareChange({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "replace",
        content: "after\n",
      }),
    );

    await expect(
      handlers.commitChange({ change_id: String(prepared.change_id) }),
    ).rejects.toThrow(/response does not match the request/iu);
    expect(captured).toHaveLength(1);
    await expect(access(captured[0]!.requestPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("expires and consumes a prepared management change before any custom CLI call", async () => {
    const dataDirectory = await temporaryDirectory();
    const notes = { [NOTE_PATH]: "before\n" };
    const invocations: string[][] = [];
    let now = 1_000;
    const store = fixedStore(() => now, 100);
    const handlers = runtime(
      createMemoryRunner(notes, dataDirectory, invocations, []),
      dataDirectory,
      store,
      async () => managementAccess(),
      () => now,
    );
    const prepared = resultJson(
      await handlers.prepareChange({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "replace",
        content: "after\n",
      }),
    );
    now = 1_100;

    await expect(
      handlers.commitChange({ change_id: String(prepared.change_id) }),
    ).rejects.toThrow(/unknown|expired|consumed/iu);
    expect(invocations.filter((args) => args[1] === "bridge-control:commit"))
      .toHaveLength(0);
  });

  it("pauses managed operations after three consecutive failures", async () => {
    const dataDirectory = await temporaryDirectory();
    const invocations: string[][] = [];
    const handlers = runtime(
      createMemoryRunner(
        { [NOTE_PATH]: "would otherwise work\n" },
        dataDirectory,
        invocations,
        [],
      ),
      dataDirectory,
    );

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(
        handlers.prepareChange({
          vault: VAULT_NAME,
          path: `Projects/Missing-${attempt}.md`,
          operation: "replace",
          content: "not written",
        }),
      ).rejects.toThrow(/requires an existing note/iu);
    }
    const invocationsBeforePauseCheck = invocations.length;
    await expect(
      handlers.prepareChange({
        vault: VAULT_NAME,
        path: NOTE_PATH,
        operation: "replace",
        content: "blocked by circuit",
      }),
    ).rejects.toThrow(/paused after three consecutive failures/iu);
    expect(invocations).toHaveLength(invocationsBeforePauseCheck);
  });
});
