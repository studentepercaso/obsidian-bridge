import path from "node:path";
import { fileURLToPath } from "node:url";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import {
  buildVaultArgs,
  createObsidianCliRunner,
  type CliInvocationOptions,
  type ObsidianCliRunner,
} from "./cli.js";
import {
  AUDIT_RESULT_MAX_RECORDS,
  readAuditTail,
} from "./audit-reader.js";
import { loadBridgeConfig, type BridgeConfig } from "./config.js";
import {
  createManagementToolHandlers,
  ManagementToolInputSchemas,
  PreparedManagementStore,
} from "./management-workflow.js";
import {
  assertPathAllowed,
  constrainSearchFolders,
  createPathPolicy,
  createWritablePathPolicy,
  filterAllowedPaths,
  type PathPolicy,
} from "./path-policy.js";
import { assertPhysicalVaultPath } from "./physical-scope.js";
import {
  createConfigAccessResolver,
  type VaultAccess,
  type VaultAccessResolver,
} from "./shared-settings.js";
import { assertVaultIdentity } from "./vault-identity.js";
import {
  errorResult,
  extractAllowedNotePaths,
  jsonResult,
  numberLineSelection,
  parseJsonOrLines,
  parseKeyValueLines,
  parseVaultList,
  selectLineRange,
} from "./tool-helpers.js";
import {
  createWriteToolHandlers,
  FileChangeStorage,
  PreparedChangeStore,
  WriteToolInputSchemas,
  type ChangeStorage,
  type WriteAuthorizationMode,
} from "./write-workflow.js";

export const SERVER_NAME = "obsidian-bridge";
export const SERVER_VERSION = "0.5.6";

export type ServerMode = "read" | "write" | "autonomous" | "management";

export const READ_ONLY_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
});

export const PREPARE_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
});

export const COMMIT_TOOL_ANNOTATIONS: ToolAnnotations = Object.freeze({
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: false,
});

const VaultName = z
  .string()
  .trim()
  .min(1)
  .max(256)
  .describe("Obsidian vault name or vault ID");
const MarkdownPath = z
  .string()
  .min(4)
  .max(1_024)
  .regex(/\.md$/iu)
  .describe("Vault-relative Markdown path ending in .md");
const FolderPath = z
  .string()
  .max(1_024)
  .describe("Optional vault-relative folder path");

export const ToolInputSchemas = Object.freeze({
  listVaults: z.object({}).strict(),
  vaultInfo: z.object({ vault: VaultName }).strict(),
  searchNotes: z
    .object({
      vault: VaultName,
      query: z.string().min(1).max(2_000),
      folder: FolderPath.optional(),
      limit: z.number().int().min(1).max(100).default(20),
      case_sensitive: z.boolean().default(false),
    })
    .strict(),
  readNote: z
    .object({
      vault: VaultName,
      path: MarkdownPath,
      start_line: z.number().int().min(1).default(1),
      end_line: z.number().int().min(1).optional(),
    })
    .strict()
    .superRefine((value, context) => {
      if (
        value.end_line !== undefined &&
        value.end_line < value.start_line
      ) {
        context.addIssue({
          code: "custom",
          path: ["end_line"],
          message: "end_line must be greater than or equal to start_line",
        });
      }
      if (
        value.end_line !== undefined &&
        value.end_line - value.start_line + 1 > 400
      ) {
        context.addIssue({
          code: "custom",
          path: ["end_line"],
          message: "a read can contain at most 400 lines",
        });
      }
    }),
  noteOutline: z.object({ vault: VaultName, path: MarkdownPath }).strict(),
  noteLinks: z
    .object({
      vault: VaultName,
      path: MarkdownPath,
      direction: z
        .enum(["incoming", "outgoing", "both"])
        .default("both"),
    })
    .strict(),
  noteTags: z.object({ vault: VaultName, path: MarkdownPath }).strict(),
  recentNotes: z
    .object({
      vault: VaultName,
      limit: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  recentWriteEvents: z
    .object({
      vault: VaultName.optional().describe(
        "Optional configured vault name or stable vault ID. Omit to inspect every currently readable configured vault.",
      ),
      failures_only: z.boolean().default(true),
      limit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe("Maximum results; values above 20 are capped to 20."),
    })
    .strict(),
  prepareChange: WriteToolInputSchemas.prepareChange,
  commitChange: WriteToolInputSchemas.commitChange,
  prepareManagedChange: ManagementToolInputSchemas.prepareChange,
  commitManagedChange: ManagementToolInputSchemas.commitChange,
});

export type ListVaultsInput = z.infer<typeof ToolInputSchemas.listVaults>;
export type VaultInfoInput = z.infer<typeof ToolInputSchemas.vaultInfo>;
export type SearchNotesInput = z.infer<typeof ToolInputSchemas.searchNotes>;
export type ReadNoteInput = z.infer<typeof ToolInputSchemas.readNote>;
export type NoteOutlineInput = z.infer<typeof ToolInputSchemas.noteOutline>;
export type NoteLinksInput = z.infer<typeof ToolInputSchemas.noteLinks>;
export type NoteTagsInput = z.infer<typeof ToolInputSchemas.noteTags>;
export type RecentNotesInput = z.infer<typeof ToolInputSchemas.recentNotes>;
export type RecentWriteEventsInput = z.infer<
  typeof ToolInputSchemas.recentWriteEvents
>;
export type PrepareChangeInput = z.infer<typeof ToolInputSchemas.prepareChange>;
export type CommitChangeInput = z.infer<typeof ToolInputSchemas.commitChange>;

export interface ToolRuntime {
  readonly runner: ObsidianCliRunner;
  readonly policy: PathPolicy;
  readonly resolveAccess?: VaultAccessResolver;
  /** Fixed local directory containing the metadata-only audit. */
  readonly dataDirectory?: string;
}

async function stdout(
  runner: ObsidianCliRunner,
  args: readonly string[],
  options: CliInvocationOptions,
): Promise<string> {
  return (await runner(args, options)).stdout;
}

export function createToolHandlers(runtime: ToolRuntime) {
  const { runner } = runtime;

  async function readAccess(vault: string): Promise<VaultAccess> {
    return runtime.resolveAccess === undefined
      ? {
          readPolicy: runtime.policy,
          writablePolicy: createWritablePathPolicy({ allowedFolders: [] }),
          writeEnabled: false,
          accessMode: "protected",
          managementPermissions: { edit: false, move: false, trash: false },
          vaultSelector: vault,
          vaultName: vault,
          source: "environment",
        }
      : await runtime.resolveAccess(vault);
  }

  function assertSameVault(
    original: VaultAccess,
    current: VaultAccess,
  ): void {
    if (
      original.vaultSelector !== current.vaultSelector ||
      original.vaultPath !== current.vaultPath
    ) {
      throw new Error("vault identity changed while the operation was running");
    }
  }

  async function assertPhysicalPath(
    access: VaultAccess,
    relativePath: string,
    allowMissingLeaf = false,
  ): Promise<void> {
    if (access.source !== "settings" || access.vaultPath === undefined) return;
    await assertPhysicalVaultPath(access.vaultPath, relativePath, {
      allowMissingLeaf,
    });
  }

  async function filterPhysicalPaths(
    access: VaultAccess,
    paths: readonly string[],
  ): Promise<string[]> {
    const allowed: string[] = [];
    for (const candidate of paths) {
      try {
        await assertPhysicalPath(access, candidate);
        allowed.push(candidate);
      } catch {
        // Never return a path that crosses a filesystem link/reparse point.
      }
    }
    return allowed;
  }

  function assertReadEnabled(policy: PathPolicy): void {
    if (
      policy.allowedFolders !== null &&
      policy.allowedFolders.length === 0
    ) {
      throw new Error(
        "reading is disabled for this vault; configure it in Bridge Control",
      );
    }
  }

  return {
    async listVaults(
      _input: ListVaultsInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const output = await stdout(runner, ["vaults"], options);
      const discovered = parseVaultList(output).map(({ name }) => ({ name }));
      const vaults: Array<{
        readonly name: string;
        readonly id?: string;
        readonly access_mode: "protected" | "full" | "management";
        readonly management_permissions?: {
          readonly edit: boolean;
          readonly move: boolean;
          readonly trash: boolean;
        };
      }> = [];
      for (const vault of discovered) {
        const access = await readAccess(vault.name);
        const policy = access.readPolicy;
        if (
          policy.allowedFolders === null ||
          policy.allowedFolders.length > 0
        ) {
          await assertVaultIdentity(runner, access, options);
          vaults.push(
            access.source === "settings"
              ? {
                  name: access.vaultName,
                  id: access.vaultSelector,
                  access_mode: access.accessMode,
                  management_permissions: access.managementPermissions,
                }
              : { ...vault, access_mode: "protected" },
          );
        }
      }
      return jsonResult({ vaults });
    },

    async vaultInfo(
      input: VaultInfoInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      assertReadEnabled(policy);
      if (policy.allowedFolders !== null) {
        throw new Error(
          "vault-wide metadata requires full-vault read access in Bridge Control",
        );
      }
      await assertVaultIdentity(runner, access, options);
      const output = await stdout(
        runner,
        buildVaultArgs(access.vaultSelector, "vault"),
        options,
      );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      const currentPolicy = currentAccess.readPolicy;
      assertReadEnabled(currentPolicy);
      if (currentPolicy.allowedFolders !== null) {
        throw new Error(
          "vault-wide metadata requires full-vault read access in Bridge Control",
        );
      }
      return jsonResult({ vault: input.vault, info: parseKeyValueLines(output) });
    },

    async searchNotes(
      input: SearchNotesInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      const folders = constrainSearchFolders(input.folder, policy);
      const found: string[] = [];
      await assertVaultIdentity(runner, access, options);

      for (const folder of folders) {
        if (folder !== undefined && folder !== "") {
          await assertPhysicalPath(access, folder);
        }
        const commandArgs = [
          `query=${input.query}`,
          `limit=${input.limit}`,
          "format=text",
        ];
        if (folder !== undefined && folder !== "") {
          commandArgs.push(`path=${folder}`);
        }
        if (input.case_sensitive) commandArgs.push("case");

        const output = await stdout(
          runner,
          buildVaultArgs(access.vaultSelector, "search", commandArgs),
          options,
        );
        found.push(...extractAllowedNotePaths(output, policy));
      }

      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      const currentPolicy = currentAccess.readPolicy;
      const policyFiltered = filterAllowedPaths(
        [...new Set(found)],
        currentPolicy,
      );
      const notes = (await filterPhysicalPaths(currentAccess, policyFiltered)).slice(
        0,
        input.limit,
      );
      return jsonResult({
        vault: input.vault,
        query: input.query,
        count: notes.length,
        notes,
      });
    },

    async readNote(
      input: ReadNoteInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      const notePath = assertPathAllowed(input.path, policy);
      await assertVaultIdentity(runner, access, options);
      await assertPhysicalPath(access, notePath);
      const output = await stdout(
        runner,
        buildVaultArgs(access.vaultSelector, "read", [`path=${notePath}`]),
        options,
      );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      assertPathAllowed(notePath, currentAccess.readPolicy);
      await assertPhysicalPath(currentAccess, notePath);
      const selection = selectLineRange(
        output,
        input.start_line,
        input.end_line ?? input.start_line + 199,
      );
      return jsonResult({
        vault: input.vault,
        path: notePath,
        startLine: selection.startLine,
        endLine: selection.endLine,
        totalLines: selection.totalLines,
        excerpt: numberLineSelection(selection),
      });
    },

    async noteOutline(
      input: NoteOutlineInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      const notePath = assertPathAllowed(input.path, policy);
      await assertVaultIdentity(runner, access, options);
      await assertPhysicalPath(access, notePath);
      const output = await stdout(
        runner,
        buildVaultArgs(access.vaultSelector, "outline", [
          `path=${notePath}`,
          "format=json",
        ]),
        options,
      );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      assertPathAllowed(notePath, currentAccess.readPolicy);
      await assertPhysicalPath(currentAccess, notePath);
      return jsonResult({
        vault: input.vault,
        path: notePath,
        outline: parseJsonOrLines(output),
      });
    },

    async noteLinks(
      input: NoteLinksInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      const notePath = assertPathAllowed(input.path, policy);
      await assertVaultIdentity(runner, access, options);
      await assertPhysicalPath(access, notePath);
      const outgoingOutput =
        input.direction === "incoming"
          ? undefined
          : await stdout(
              runner,
              buildVaultArgs(access.vaultSelector, "links", [`path=${notePath}`]),
              options,
            );
      const incomingOutput =
        input.direction === "outgoing"
          ? undefined
          : await stdout(
              runner,
              buildVaultArgs(access.vaultSelector, "backlinks", [
                `path=${notePath}`,
                "format=json",
              ]),
              options,
            );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      const currentPolicy = currentAccess.readPolicy;
      assertPathAllowed(notePath, currentPolicy);
      await assertPhysicalPath(currentAccess, notePath);
      const result: Record<string, unknown> = {
        vault: input.vault,
        path: notePath,
        direction: input.direction,
      };
      if (outgoingOutput !== undefined) {
        result.outgoing = await filterPhysicalPaths(
          currentAccess,
          extractAllowedNotePaths(outgoingOutput, currentPolicy),
        );
      }
      if (incomingOutput !== undefined) {
        result.incoming = await filterPhysicalPaths(
          currentAccess,
          extractAllowedNotePaths(incomingOutput, currentPolicy),
        );
      }
      return jsonResult(result);
    },

    async noteTags(
      input: NoteTagsInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      const notePath = assertPathAllowed(input.path, policy);
      await assertVaultIdentity(runner, access, options);
      await assertPhysicalPath(access, notePath);
      const output = await stdout(
        runner,
        buildVaultArgs(access.vaultSelector, "tags", [
          `path=${notePath}`,
          "format=json",
        ]),
        options,
      );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      assertPathAllowed(notePath, currentAccess.readPolicy);
      await assertPhysicalPath(currentAccess, notePath);
      return jsonResult({
        vault: input.vault,
        path: notePath,
        tags: parseJsonOrLines(output),
      });
    },

    async recentNotes(
      input: RecentNotesInput,
      options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      const access = await readAccess(input.vault);
      const policy = access.readPolicy;
      if (policy.allowedFolders !== null) {
        return jsonResult({ vault: input.vault, count: 0, notes: [] });
      }
      await assertVaultIdentity(runner, access, options);
      const output = await stdout(
        runner,
        buildVaultArgs(access.vaultSelector, "recents"),
        options,
      );
      const currentAccess = await readAccess(input.vault);
      assertSameVault(access, currentAccess);
      await assertVaultIdentity(runner, currentAccess, options);
      const currentPolicy = currentAccess.readPolicy;
      if (currentPolicy.allowedFolders !== null) {
        return jsonResult({ vault: input.vault, count: 0, notes: [] });
      }
      const notes = (
        await filterPhysicalPaths(
          currentAccess,
          extractAllowedNotePaths(output, currentPolicy),
        )
      ).slice(0, input.limit);
      return jsonResult({ vault: input.vault, count: notes.length, notes });
    },

    async recentWriteEvents(
      input: RecentWriteEventsInput,
      _options: CliInvocationOptions = {},
    ): Promise<CallToolResult> {
      if (runtime.dataDirectory === undefined) {
        throw new Error("audit data directory is not configured");
      }

      const initialRequestedAccess =
        input.vault === undefined ? undefined : await readAccess(input.vault);
      if (initialRequestedAccess !== undefined) {
        assertReadEnabled(initialRequestedAccess.readPolicy);
      }

      const audit = await readAuditTail(runtime.dataDirectory);
      const limit = Math.min(input.limit, AUDIT_RESULT_MAX_RECORDS);
      const events: Array<Record<string, unknown>> = [];
      const initialAccesses = new Map<string, VaultAccess>();

      if (initialRequestedAccess !== undefined) {
        initialAccesses.set(
          initialRequestedAccess.vaultSelector,
          initialRequestedAccess,
        );
      } else {
        for (const event of audit.events) {
          if (input.failures_only && event.status !== "failed") continue;
          if (initialAccesses.has(event.vault)) continue;
          const access = await readAccess(event.vault);
          if (
            access.readPolicy.allowedFolders !== null &&
            access.readPolicy.allowedFolders.length === 0
          ) {
            continue;
          }
          if (
            access.source === "settings" &&
            event.vault !== access.vaultSelector
          ) {
            continue;
          }
          initialAccesses.set(event.vault, access);
        }
      }

      // Re-read every relevant grant after the bounded audit read. No path is
      // disclosed using a permission snapshot that may have been revoked while
      // the file was being inspected.
      const currentAccesses = new Map<string, VaultAccess>();
      for (const [auditVault, initialAccess] of initialAccesses) {
        const lookup = input.vault ?? auditVault;
        const currentAccess = await readAccess(lookup);
        try {
          assertSameVault(initialAccess, currentAccess);
          assertReadEnabled(currentAccess.readPolicy);
        } catch (error) {
          if (input.vault !== undefined) throw error;
          continue;
        }
        if (
          currentAccess.source === "settings" &&
          auditVault !== currentAccess.vaultSelector
        ) {
          continue;
        }
        currentAccesses.set(auditVault, currentAccess);
      }

      let eligibleCount = 0;

      for (const event of audit.events) {
        if (input.failures_only && event.status !== "failed") continue;

        if (
          initialRequestedAccess !== undefined &&
          event.vault !== initialRequestedAccess.vaultSelector
        ) continue;
        const access = currentAccesses.get(event.vault);
        if (access === undefined) continue;

        let notePath: string;
        try {
          notePath = assertPathAllowed(event.path, access.readPolicy);
        } catch {
          // Revoked folders and denied paths must not remain visible through
          // audit metadata after their read grant is removed.
          continue;
        }
        let targetPath: string | undefined;
        if (event.target_path !== undefined) {
          try {
            targetPath = assertPathAllowed(
              event.target_path,
              access.readPolicy,
            );
          } catch {
            // A move event can reveal both endpoints, so disclose neither when
            // either endpoint is outside the current read grant.
            continue;
          }
        }

        eligibleCount += 1;
        if (events.length < limit) {
          events.push({
            timestamp: event.timestamp,
            change_id: event.change_id,
            vault: access.vaultName,
            ...(access.source === "settings"
              ? { vault_id: access.vaultSelector }
              : {}),
            path: notePath,
            ...(targetPath === undefined ? {} : { target_path: targetPath }),
            operation: event.operation,
            authorization_mode: event.authorization_mode,
            status: event.status,
            ...(event.error_code === undefined
              ? {}
              : { error_code: event.error_code }),
            ...(event.failure_stage === undefined
              ? {}
              : { failure_stage: event.failure_stage }),
            ...(event.cause_code === undefined
              ? {}
              : { cause_code: event.cause_code }),
            ...(event.rollback_attempted === undefined
              ? {}
              : { rollback_attempted: event.rollback_attempted }),
            ...(event.rollback_succeeded === undefined
              ? {}
              : { rollback_succeeded: event.rollback_succeeded }),
            ...(event.rollback_reason === undefined
              ? {}
              : { rollback_reason: event.rollback_reason }),
            ...(event.rollback_reason === "manual_recovery_required" ||
            event.error_code === "WRITE_FAILED_MANUAL_RECOVERY_REQUIRED" ||
            event.error_code ===
              "VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED"
              ? { manual_recovery_required: true }
              : {}),
            ...(event.backup_id === undefined
              ? {}
              : { backup_id: event.backup_id }),
          });
        }
      }

      const resultsTruncated = eligibleCount > events.length;
      return jsonResult({
        failures_only: input.failures_only,
        limit,
        count: events.length,
        audit_tail_truncated: audit.truncated,
        results_truncated: resultsTruncated,
        truncated: audit.truncated || resultsTruncated,
        events,
      });
    },
  };
}

export type ObsidianToolHandlers = ReturnType<typeof createToolHandlers>;

async function safelyInvoke(
  operation: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await operation();
  } catch (error) {
    return errorResult(error);
  }
}

export function registerObsidianTools(
  server: McpServer,
  runtime: ToolRuntime,
): void {
  const handlers = createToolHandlers(runtime);
  const annotations = READ_ONLY_TOOL_ANNOTATIONS;

  server.registerTool(
    "obsidian_list_vaults",
    {
      title: "List Obsidian vaults",
      description: "List vaults known to the local Obsidian application.",
      inputSchema: ToolInputSchemas.listVaults,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.listVaults(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_vault_info",
    {
      title: "Get Obsidian vault information",
      description: "Return read-only metadata for one local Obsidian vault.",
      inputSchema: ToolInputSchemas.vaultInfo,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.vaultInfo(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_search_notes",
    {
      title: "Search Obsidian notes",
      description:
        "Search Markdown notes in the folders permitted by the bridge policy.",
      inputSchema: ToolInputSchemas.searchNotes,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.searchNotes(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_read_note",
    {
      title: "Read an Obsidian note",
      description:
        "Read a bounded, one-based inclusive line range from an allowed Markdown note.",
      inputSchema: ToolInputSchemas.readNote,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.readNote(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_note_outline",
    {
      title: "Get an Obsidian note outline",
      description: "Return the heading outline of an allowed Markdown note.",
      inputSchema: ToolInputSchemas.noteOutline,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.noteOutline(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_note_links",
    {
      title: "Get Obsidian note links",
      description:
        "Return incoming links, outgoing links, or both for an allowed Markdown note.",
      inputSchema: ToolInputSchemas.noteLinks,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.noteLinks(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_note_tags",
    {
      title: "Get Obsidian note tags",
      description: "Return tags attached to an allowed Markdown note.",
      inputSchema: ToolInputSchemas.noteTags,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.noteTags(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_recent_notes",
    {
      title: "List recent Obsidian notes",
      description:
        "List recently opened Markdown notes that pass the bridge path policy.",
      inputSchema: ToolInputSchemas.recentNotes,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() => handlers.recentNotes(input, { signal: extra.signal })),
  );

  server.registerTool(
    "obsidian_recent_write_events",
    {
      title: "Read recent Obsidian write events",
      description:
        "Read a bounded metadata-only tail of recent bridge write failures and outcomes for currently readable configured vaults. Never returns note or backup bodies.",
      inputSchema: ToolInputSchemas.recentWriteEvents,
      annotations,
    },
    async (input, extra) =>
      await safelyInvoke(() =>
        handlers.recentWriteEvents(input, { signal: extra.signal }),
      ),
  );
}

export interface WriteToolRegistrationRuntime extends ToolRuntime {
  readonly writablePolicy: PathPolicy;
  readonly writableVaults: readonly string[];
  readonly store: PreparedChangeStore;
  readonly storage: ChangeStorage;
  readonly now?: () => number;
  readonly authorizationMode?: WriteAuthorizationMode;
  readonly dataDirectory?: string;
}

export function registerObsidianWriteTools(
  server: McpServer,
  runtime: WriteToolRegistrationRuntime,
): void {
  const handlers = createWriteToolHandlers({
    runner: runtime.runner,
    readPolicy: runtime.policy,
    writablePolicy: runtime.writablePolicy,
    writableVaults: runtime.writableVaults,
    ...(runtime.resolveAccess === undefined
      ? {}
      : { resolveAccess: runtime.resolveAccess }),
    store: runtime.store,
    storage: runtime.storage,
    authorizationMode: runtime.authorizationMode ?? "protected",
    ...(runtime.dataDirectory === undefined
      ? {}
      : { dataDirectory: runtime.dataDirectory }),
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });

  const autonomous = runtime.authorizationMode === "autonomous";
  const prepareToolName = autonomous
    ? "obsidian_prepare_autonomous_change"
    : "obsidian_prepare_change";
  const commitToolName = autonomous
    ? "obsidian_commit_autonomous_change"
    : "obsidian_commit_change";

  server.registerTool(
    prepareToolName,
    {
      title: autonomous
        ? "Prepare an autonomous Obsidian note change"
        : "Prepare an Obsidian note change",
      description:
        autonomous
          ? "Prepare a bounded create or append only for a vault explicitly set to Accesso autonomo or Gestione completa. Returns an internally reviewable preview and single-use change_id without modifying the vault."
          : "Prepare a bounded create or append in an explicitly writable protected vault and folder. Returns the exact proposed content, a diff, and a short-lived single-use change_id without modifying the vault.",
      inputSchema: ToolInputSchemas.prepareChange,
      annotations: PREPARE_TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      await safelyInvoke(() =>
        handlers.prepareChange(input, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    commitToolName,
    {
      title: autonomous
        ? "Commit an autonomous Obsidian note change"
        : "Commit an Obsidian note change",
      description:
        autonomous
          ? "Consume one autonomous change_id only while Accesso autonomo or Gestione completa remains active, reject conflicts, back up existing content, write through the allowlisted Obsidian CLI, and verify the result."
          : "Consume one protected change_id after user confirmation, reject conflicts, back up existing content, modify through the allowlisted Obsidian CLI, and verify the result.",
      inputSchema: ToolInputSchemas.commitChange,
      annotations: COMMIT_TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      await safelyInvoke(() =>
        handlers.commitChange(input, { signal: extra.signal }),
      ),
  );
}

export interface ManagementToolRegistrationRuntime {
  readonly runner: ObsidianCliRunner;
  readonly policy: PathPolicy;
  readonly writablePolicy: PathPolicy;
  readonly store: PreparedManagementStore;
  readonly resolveAccess: VaultAccessResolver;
  readonly dataDirectory: string;
  readonly now?: () => number;
}

export function registerObsidianManagementTools(
  server: McpServer,
  runtime: ManagementToolRegistrationRuntime,
): void {
  const handlers = createManagementToolHandlers({
    runner: runtime.runner,
    readPolicy: runtime.policy,
    writablePolicy: runtime.writablePolicy,
    store: runtime.store,
    resolveAccess: runtime.resolveAccess,
    dataDirectory: runtime.dataDirectory,
    ...(runtime.now === undefined ? {} : { now: runtime.now }),
  });

  server.registerTool(
    "obsidian_prepare_managed_change",
    {
      title: "Prepare a managed Obsidian note change",
      description:
        "Prepare an exact in-place replacement, literal text edit, frontmatter change, move/rename, or move to Obsidian trash. Requires the matching Gestione completa permission and returns a bounded preview without changing the vault.",
      inputSchema: ToolInputSchemas.prepareManagedChange,
      annotations: PREPARE_TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      await safelyInvoke(() =>
        handlers.prepareChange(input, { signal: extra.signal }),
      ),
  );

  server.registerTool(
    "obsidian_commit_managed_change",
    {
      title: "Commit a managed Obsidian note change",
      description:
        "Consume one prepared management change while its permission remains active, recheck conflicts, execute through Bridge Control inside Obsidian, create a recovery backup, audit the outcome, and verify the result. Permanent deletion is never available.",
      inputSchema: ToolInputSchemas.commitManagedChange,
      annotations: COMMIT_TOOL_ANNOTATIONS,
    },
    async (input, extra) =>
      await safelyInvoke(() =>
        handlers.commitChange(input, { signal: extra.signal }),
      ),
  );
}

export interface CreateServerOptions {
  readonly config?: BridgeConfig;
  readonly policy?: PathPolicy;
  readonly writablePolicy?: PathPolicy;
  readonly writableVaults?: readonly string[];
  readonly runner?: ObsidianCliRunner;
  readonly mode?: ServerMode;
  readonly changeStore?: PreparedChangeStore;
  readonly managementStore?: PreparedManagementStore;
  readonly storage?: ChangeStorage;
  readonly now?: () => number;
  readonly resolveAccess?: VaultAccessResolver;
}

export function createObsidianServer(
  options: CreateServerOptions = {},
): McpServer {
  const config = options.config ?? loadBridgeConfig();
  const mode = options.mode ?? "read";
  const policy =
    options.policy ??
    createPathPolicy({
      allowedFolders: config.allowedFolders,
      deniedFolders: config.deniedFolders,
    });
  const resolveAccess =
    options.resolveAccess ??
    (config.settingsPath === undefined
      ? undefined
      : createConfigAccessResolver(config));
  const runner =
    options.runner ??
    createObsidianCliRunner(
      config,
      undefined,
      mode === "management"
        ? { allowManagement: true }
        : mode === "write" || mode === "autonomous"
          ? { allowWrites: true }
          : {},
    );
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    {
      instructions:
        mode === "read"
          ? "Read-only access to local Obsidian vaults. Check obsidian_recent_write_events before an autonomous write sequence and after any write error so recovery state can be understood without asking for screenshots. Cite note paths and the line numbers returned by obsidian_read_note. Never claim that a note was changed."
          : mode === "autonomous"
            ? "Autonomous create and append changes are allowed only for a vault explicitly set to Accesso autonomo or Gestione completa. Use obsidian_prepare_autonomous_change, inspect its exact preview internally, then use obsidian_commit_autonomous_change in the same task. Stop on any ambiguity, conflict, revocation, or failure; never reuse a change_id or claim success unless verified=true."
            : mode === "management"
              ? "Managed Obsidian changes require Gestione completa and the matching edit, move, or trash permission. Use obsidian_prepare_managed_change and obsidian_commit_managed_change in the same task. Inspect the bounded preview internally, stop on conflicts or revocation, never reuse a change_id, never request permanent deletion, and claim success only when verified=true and audit_recorded=true."
              : "Protected Obsidian changes require obsidian_prepare_change followed by explicit user approval and obsidian_commit_change. Never skip the diff, reuse a change_id, or claim success unless commit returns verified=true.",
    },
  );
  if (mode === "read") {
    registerObsidianTools(server, {
      runner,
      policy,
      ...(config.dataDirectory === undefined
        ? {}
        : { dataDirectory: config.dataDirectory }),
      ...(resolveAccess === undefined ? {} : { resolveAccess }),
    });
  }
  if (mode === "write" || mode === "autonomous") {
    const writablePolicy =
      options.writablePolicy ??
      createWritablePathPolicy({
        allowedFolders: config.writableFolders ?? [],
        deniedFolders: config.deniedFolders,
        caseSensitive: policy.caseSensitive,
      });
    const store =
      options.changeStore ??
      new PreparedChangeStore({
        ttlMs: config.changeTtlMs ?? 300_000,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    const dataDirectory = config.dataDirectory;
    if (options.storage === undefined && dataDirectory === undefined) {
      throw new Error(
        "write mode requires BridgeConfig.dataDirectory or an injected storage",
      );
    }
    const storage =
      options.storage ?? new FileChangeStorage(dataDirectory!);
    registerObsidianWriteTools(server, {
      runner,
      policy,
      writablePolicy,
      writableVaults:
        options.writableVaults ?? config.writableVaults ?? [],
      store,
      storage,
      authorizationMode: mode === "autonomous" ? "autonomous" : "protected",
      ...(dataDirectory === undefined ? {} : { dataDirectory }),
      ...(resolveAccess === undefined ? {} : { resolveAccess }),
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  if (mode === "management") {
    const dataDirectory = config.dataDirectory;
    if (dataDirectory === undefined) {
      throw new Error("management mode requires BridgeConfig.dataDirectory");
    }
    if (resolveAccess === undefined) {
      throw new Error(
        "management mode requires shared Bridge Control settings",
      );
    }
    const writablePolicy =
      options.writablePolicy ??
      createWritablePathPolicy({
        allowedFolders: config.writableFolders ?? [],
        deniedFolders: config.deniedFolders,
        caseSensitive: policy.caseSensitive,
      });
    const store =
      options.managementStore ??
      new PreparedManagementStore({
        ttlMs: config.changeTtlMs ?? 300_000,
        ...(options.now === undefined ? {} : { now: options.now }),
      });
    registerObsidianManagementTools(server, {
      runner,
      policy,
      writablePolicy,
      store,
      resolveAccess,
      dataDirectory,
      ...(options.now === undefined ? {} : { now: options.now }),
    });
  }
  return server;
}

export function parseServerMode(args: readonly string[]): ServerMode {
  let mode: ServerMode = "read";
  for (const argument of args) {
    if (!argument.startsWith("--mode=")) {
      throw new Error(`unknown argument: ${argument}`);
    }
    const value = argument.slice("--mode=".length);
    if (
      value !== "read" &&
      value !== "write" &&
      value !== "autonomous" &&
      value !== "management"
    ) {
      throw new Error(
        "--mode must be read, write, autonomous, or management",
      );
    }
    mode = value;
  }
  return mode;
}

export async function main(): Promise<void> {
  const server = createObsidianServer({
    mode: parseServerMode(process.argv.slice(2)),
  });
  await server.connect(new StdioServerTransport());
}

export function isMainModule(
  moduleUrl: string = import.meta.url,
  entryPoint: string | undefined = process.argv[1],
): boolean {
  return (
    entryPoint !== undefined &&
    fileURLToPath(moduleUrl) === path.resolve(entryPoint)
  );
}

if (isMainModule()) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`obsidian-bridge: ${message}\n`);
    process.exitCode = 1;
  });
}
