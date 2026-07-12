import {
  spawn,
  type ChildProcess,
  type SpawnOptions,
} from "node:child_process";

import {
  loadBridgeConfig,
  validateVault,
  type BridgeConfig,
} from "./config.js";

export const READ_ONLY_CLI_COMMANDS = Object.freeze([
  "vaults",
  "vault",
  "search",
  "search:context",
  "read",
  "outline",
  "backlinks",
  "links",
  "tags",
  "recents",
] as const);

export const WRITE_CLI_COMMANDS = Object.freeze([
  "create",
  "append",
] as const);

export const MANAGEMENT_CLI_COMMANDS = Object.freeze([
  "bridge-control:commit",
] as const);

// Obsidian 1.12.7 on Windows can hand JSON.parse an incomplete named-pipe
// chunk when the CLI IPC frame approaches 4 KiB. Keep a full KiB of headroom
// and split write content before it reaches this defense-in-depth guard.
export const MAX_CLI_IPC_FRAME_BYTES = 3_072;

export function cliIpcFrameBytes(
  args: readonly string[],
  cwd: string = process.cwd(),
): number {
  return Buffer.byteLength(
    `${JSON.stringify({ argv: args, tty: false, cwd })}\n`,
    "utf8",
  );
}

type ReadOnlyCliCommand = (typeof READ_ONLY_CLI_COMMANDS)[number];
type WriteCliCommand = (typeof WRITE_CLI_COMMANDS)[number];
type ManagementCliCommand = (typeof MANAGEMENT_CLI_COMMANDS)[number];
type AllowedCliCommand =
  | ReadOnlyCliCommand
  | WriteCliCommand
  | ManagementCliCommand;

interface CliCapabilities {
  readonly allowWrites?: boolean;
  readonly allowManagement?: boolean;
}

const COMMAND_ARGUMENTS: Readonly<
  Record<
    AllowedCliCommand,
    { readonly parameters: readonly string[]; readonly flags: readonly string[] }
  >
> = Object.freeze({
  vaults: { parameters: [], flags: ["verbose"] },
  vault: { parameters: ["info"], flags: [] },
  search: {
    parameters: ["query", "path", "limit", "format"],
    flags: ["case"],
  },
  "search:context": {
    parameters: ["query", "path", "limit", "format"],
    flags: ["case"],
  },
  read: { parameters: ["path"], flags: [] },
  outline: { parameters: ["path", "format"], flags: [] },
  backlinks: {
    parameters: ["path", "format"],
    flags: ["counts"],
  },
  links: { parameters: ["path"], flags: [] },
  tags: { parameters: ["path", "format"], flags: [] },
  recents: { parameters: [], flags: [] },
  create: {
    parameters: ["path", "content"],
    flags: ["overwrite"],
  },
  append: {
    parameters: ["path", "content"],
    flags: ["inline"],
  },
  "bridge-control:commit": {
    parameters: ["request", "token"],
    flags: [],
  },
});

export type ObsidianCliErrorCode =
  | "INVALID_ARGUMENTS"
  | "SPAWN_FAILED"
  | "TIMEOUT"
  | "OUTPUT_LIMIT"
  | "ABORTED"
  | "CLI_NOT_ENABLED"
  | "CLI_REPORTED_ERROR"
  | "NON_ZERO_EXIT";

export class ObsidianCliError extends Error {
  constructor(
    readonly code: ObsidianCliErrorCode,
    message: string,
    readonly exitCode: number | null = null,
  ) {
    super(message);
    this.name = "ObsidianCliError";
  }
}

export interface CliResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: 0;
}

export interface CliInvocationOptions {
  readonly signal?: AbortSignal;
}

export type ObsidianCliRunner = (
  args: readonly string[],
  options?: CliInvocationOptions,
) => Promise<CliResult>;

export type SpawnImplementation = (
  executable: string,
  args: readonly string[],
  options: SpawnOptions,
) => ChildProcess;

function commandFromArgs(
  args: readonly string[],
  capabilities: CliCapabilities,
): {
  command: AllowedCliCommand;
  commandIndex: number;
} {
  if (args.length === 0) {
    throw new ObsidianCliError("INVALID_ARGUMENTS", "CLI arguments are empty");
  }

  const hasVaultPrefix = args[0]?.startsWith("vault=") ?? false;
  const commandIndex = hasVaultPrefix ? 1 : 0;
  const command = args[commandIndex];

  const isReadCommand =
    command !== undefined &&
    (READ_ONLY_CLI_COMMANDS as readonly string[]).includes(command);
  const isWriteCommand =
    command !== undefined &&
    (WRITE_CLI_COMMANDS as readonly string[]).includes(command);
  const isManagementCommand =
    command !== undefined &&
    (MANAGEMENT_CLI_COMMANDS as readonly string[]).includes(command);
  if (
    !isReadCommand &&
    !(capabilities.allowWrites === true && isWriteCommand) &&
    !(capabilities.allowManagement === true && isManagementCommand)
  ) {
    throw new ObsidianCliError(
      "INVALID_ARGUMENTS",
      "CLI command is not on the enabled bridge allowlist",
    );
  }

  if (command === "vaults") {
    if (hasVaultPrefix) {
      throw new ObsidianCliError(
        "INVALID_ARGUMENTS",
        "vaults must not have a vault prefix",
      );
    }
  } else if (!hasVaultPrefix) {
    throw new ObsidianCliError(
      "INVALID_ARGUMENTS",
      "the vault prefix must be the first CLI argument",
    );
  }

  if (hasVaultPrefix) {
    validateVault(args[0]!.slice("vault=".length));
  }

  return { command: command as AllowedCliCommand, commandIndex };
}

/** Defense in depth: only documented arguments for the read-only commands pass. */
export function assertReadOnlyCliArgs(args: readonly string[]): void {
  assertCliArgs(args, {});
}

/** Defense in depth for the writer: reads plus create/append only. */
export function assertWriteEnabledCliArgs(args: readonly string[]): void {
  assertCliArgs(args, { allowWrites: true });
}

/** Defense in depth for the management transport: reads plus one custom handler. */
export function assertManagementCliArgs(args: readonly string[]): void {
  assertCliArgs(args, { allowManagement: true });
}

function assertCliArgs(
  args: readonly string[],
  capabilities: CliCapabilities,
): void {
  const { command, commandIndex } = commandFromArgs(args, capabilities);
  const allowed = COMMAND_ARGUMENTS[command];
  const seenParameters = new Set<string>();
  const seenFlags = new Set<string>();

  for (const argument of args.slice(commandIndex + 1)) {
    if (argument.length === 0 || argument.includes("\u0000")) {
      throw new ObsidianCliError("INVALID_ARGUMENTS", "invalid CLI argument");
    }

    const equalsIndex = argument.indexOf("=");
    if (equalsIndex === -1) {
      if (!allowed.flags.includes(argument) || seenFlags.has(argument)) {
        throw new ObsidianCliError(
          "INVALID_ARGUMENTS",
          `flag is not allowed for ${command}`,
        );
      }
      seenFlags.add(argument);
      continue;
    }

    const key = argument.slice(0, equalsIndex);
    if (!allowed.parameters.includes(key) || seenParameters.has(key)) {
      throw new ObsidianCliError(
        "INVALID_ARGUMENTS",
        `parameter is not allowed for ${command}`,
      );
    }
    seenParameters.add(key);
    if (
      key !== "content" &&
      /[\u0001-\u001f\u007f]/u.test(argument)
    ) {
      throw new ObsidianCliError("INVALID_ARGUMENTS", "invalid CLI argument");
    }
  }

  if (
    command === "bridge-control:commit" &&
    (!seenParameters.has("request") ||
      !seenParameters.has("token") ||
      seenParameters.size !== 2)
  ) {
    throw new ObsidianCliError(
      "INVALID_ARGUMENTS",
      "bridge-control:commit requires exactly request and token",
    );
  }

  const frameBytes = cliIpcFrameBytes(args);
  if (frameBytes > MAX_CLI_IPC_FRAME_BYTES) {
    throw new ObsidianCliError(
      "INVALID_ARGUMENTS",
      `CLI IPC frame must not exceed ${MAX_CLI_IPC_FRAME_BYTES} UTF-8 bytes; split long content into smaller commands`,
    );
  }
}

export function buildVaultArgs(
  vault: string,
  command: Exclude<ReadOnlyCliCommand, "vaults">,
  args: readonly string[] = [],
): string[] {
  const result = [`vault=${validateVault(vault)}`, command, ...args];
  assertReadOnlyCliArgs(result);
  return result;
}

export function buildWriteVaultArgs(
  vault: string,
  command: WriteCliCommand,
  args: readonly string[] = [],
): string[] {
  const result = [`vault=${validateVault(vault)}`, command, ...args];
  assertWriteEnabledCliArgs(result);
  return result;
}

export function buildManagementVaultArgs(
  vault: string,
  command: ManagementCliCommand,
  args: readonly string[] = [],
): string[] {
  const result = [`vault=${validateVault(vault)}`, command, ...args];
  assertManagementCliArgs(result);
  return result;
}

/**
 * The official CLI decodes only the two documented escape sequences, `\\n`
 * and `\\t`. It does not define a separate escape for a literal backslash.
 * Consequently, literal backslash-n and backslash-t sequences cannot be sent
 * losslessly through the `content=` parameter and must be rejected.
 */
export function isCliContentRepresentable(content: string): boolean {
  return !/\\[nt]/u.test(content);
}

export function assertCliContentRepresentable(content: string): void {
  if (!isCliContentRepresentable(content)) {
    throw new ObsidianCliError(
      "INVALID_ARGUMENTS",
      "content contains a literal \\n or \\t sequence that the Obsidian CLI cannot represent losslessly",
    );
  }
}

/** Encode only the newline and tab escapes documented by the Obsidian CLI. */
export function encodeCliContent(content: string): string {
  assertCliContentRepresentable(content);
  return content
    .replaceAll("\r\n", "\n")
    .replaceAll("\r", "\n")
    .replaceAll("\n", "\\n")
    .replaceAll("\t", "\\t");
}

function safeProcessMessage(stderr: string, stdout: string): string {
  const message = stderr.trim() || stdout.trim() || "Obsidian CLI failed";
  return message.slice(0, 2_000);
}

function reportsDisabledCli(stderr: string, stdout: string): boolean {
  const message = `${stderr}\n${stdout}`.trim();
  return /^Command line interface is not enabled\.\s+Please turn it on in Settings\s*>\s*General\s*>\s*Advanced\.?$/iu.test(
    message,
  );
}

function reportedCliError(stderr: string, stdout: string): string | undefined {
  for (const stream of [stderr, stdout]) {
    const message = stream.trim();
    if (/^Error:\s+/u.test(message) || /^Vault not found\.?$/iu.test(message)) {
      return message.slice(0, 2_000);
    }
  }
  return undefined;
}

export function createObsidianCliRunner(
  config: BridgeConfig = loadBridgeConfig(),
  spawnImplementation: SpawnImplementation = spawn,
  capabilities: CliCapabilities = {},
): ObsidianCliRunner {
  return async (
    args: readonly string[],
    invocation: CliInvocationOptions = {},
  ): Promise<CliResult> => {
    assertCliArgs(args, capabilities);

    if (invocation.signal?.aborted === true) {
      throw new ObsidianCliError("ABORTED", "Obsidian CLI call was aborted");
    }

    return await new Promise<CliResult>((resolve, reject) => {
      let child: ChildProcess;
      try {
        child = spawnImplementation(config.executable, [...args], {
          shell: false,
          windowsHide: true,
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (error) {
        reject(
          new ObsidianCliError(
            "SPAWN_FAILED",
            `Unable to start Obsidian CLI: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
        return;
      }

      const stdoutChunks: Buffer[] = [];
      const stderrChunks: Buffer[] = [];
      let outputBytes = 0;
      let settled = false;
      let terminationError: ObsidianCliError | undefined;

      const cleanup = (): void => {
        clearTimeout(timer);
        invocation.signal?.removeEventListener("abort", onAbort);
      };

      const fail = (error: ObsidianCliError, kill = false): void => {
        if (settled || terminationError !== undefined) return;
        cleanup();
        if (kill) {
          // A caller may start rollback as soon as this promise rejects. Keep the
          // failure pending until `close` confirms the CLI and its stdio are done.
          terminationError = error;
          if (child.exitCode === null) {
            child.kill();
          }
          return;
        }
        settled = true;
        reject(error);
      };

      const collect = (target: Buffer[], chunk: unknown): void => {
        if (settled || terminationError !== undefined) return;
        const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        outputBytes += buffer.byteLength;
        if (outputBytes > config.maxOutputBytes) {
          fail(
            new ObsidianCliError(
              "OUTPUT_LIMIT",
              `Obsidian CLI output exceeded ${config.maxOutputBytes} bytes`,
            ),
            true,
          );
          return;
        }
        target.push(buffer);
      };

      const onAbort = (): void => {
        fail(new ObsidianCliError("ABORTED", "Obsidian CLI call was aborted"), true);
      };

      const timer = setTimeout(() => {
        fail(
          new ObsidianCliError(
            "TIMEOUT",
            `Obsidian CLI timed out after ${config.timeoutMs} ms`,
          ),
          true,
        );
      }, config.timeoutMs);
      timer.unref();

      invocation.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.on("data", (chunk: unknown) => collect(stdoutChunks, chunk));
      child.stderr?.on("data", (chunk: unknown) => collect(stderrChunks, chunk));

      child.once("error", (error) => {
        fail(
          new ObsidianCliError(
            "SPAWN_FAILED",
            `Unable to start Obsidian CLI: ${error.message}`,
          ),
        );
      });

      child.once("close", (code) => {
        if (settled) return;
        settled = true;
        cleanup();

        if (terminationError !== undefined) {
          reject(terminationError);
          return;
        }

        const stdout = Buffer.concat(stdoutChunks).toString("utf8");
        const stderr = Buffer.concat(stderrChunks).toString("utf8");
        if (code !== 0) {
          reject(
            new ObsidianCliError(
              "NON_ZERO_EXIT",
              safeProcessMessage(stderr, stdout),
              code,
            ),
          );
          return;
        }

        // Obsidian 1.12.7 reports a disabled CLI on stdout while still exiting 0.
        // Treat the documented diagnostic sentence as failure instead of parsing it
        // as a vault name or note result.
        if (reportsDisabledCli(stderr, stdout)) {
          reject(
            new ObsidianCliError(
              "CLI_NOT_ENABLED",
              safeProcessMessage(stderr, stdout),
            ),
          );
          return;
        }

        // Obsidian currently prints operational failures (sometimes followed
        // by Usage lines) while still exiting 0. Fail closed so diagnostics
        // cannot be mistaken for note content. This intentionally rejects the
        // ambiguous case of a note whose first output line itself starts Error:.
        const cliError = reportedCliError(stderr, stdout);
        if (cliError !== undefined) {
          reject(new ObsidianCliError("CLI_REPORTED_ERROR", cliError));
          return;
        }

        resolve({ stdout, stderr, exitCode: 0 });
      });
    });
  };
}

export async function runObsidianCli(
  args: readonly string[],
  options: CliInvocationOptions = {},
): Promise<CliResult> {
  return await createObsidianCliRunner()(args, options);
}

export function parseCliJson<T = unknown>(output: string): T {
  try {
    return JSON.parse(output) as T;
  } catch (error) {
    throw new ObsidianCliError(
      "NON_ZERO_EXIT",
      `Obsidian CLI returned invalid JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
