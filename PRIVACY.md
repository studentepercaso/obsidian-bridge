# Privacy

Effective date: 2026-07-12

Obsidian Bridge is local, open-source software. Version 0.5.4 has no hosted service, account system, advertising, analytics, or project-operated telemetry. Bridge Control and the guided installer operate on local files and do not publish or upload a vault.

This notice covers the bridge itself. Obsidian, Obsidian Sync, the MCP host, ChatGPT/Codex, the selected model provider, and other community plugins have separate privacy terms and data flows.

## Summary

- Bridge Control grants access per exact registered vault.
- **Protected access** can limit reading and create/append writing to selected folders and requires confirmation for every change.
- **Autonomous access** (`accessMode=full`) permits vault-wide read/create/append after explicit activation.
- **Full management** (`accessMode=management`) is separately activated and has independent edit, move, and trash grants.
- Management supports exact replacement, literal `replace_text`, frontmatter set/remove, move/rename, and Obsidian trash. Permanent deletion is never available.
- Every mutation is prepared before commit, rechecks current policy and source state, and verifies its result.
- Append and managed operations can create plaintext local recovery backups. Mutation attempts add metadata-only audit information.
- The bridge runtime makes no network request; MCP inputs and results travel locally over stdio to the host.
- The host may send note contents, paths, requested edits, previews, and diagnostic metadata to a remote model.

## Data the bridge can access

Read tools can access and return:

- known vault names and requested vault metadata;
- note paths, filenames, headings, tags, links, backlinks, and recent-note metadata;
- search queries and matching paths;
- selected note text and line information;
- bounded metadata-only bridge outcome events currently allowed by vault and folder policy.

Protected or autonomous create/append tools can additionally access and return:

- target path and operation;
- proposed content and existing content required for preview and conflict detection;
- bounded diff, `proposed_content_json`, line counts, before/after SHA-256 hashes, opaque change ID, expiry, and commit result.

When the user explicitly activates Full management and the matching granular permission, the manager can additionally access and return:

- complete existing and replacement Markdown content for `replace` or `replace_text`;
- a bounded exact UTF-8 source snapshot used to build the managed preview and compare-and-swap hash without newline or line-ending normalization;
- literal find/replacement values and expected occurrence count;
- selected frontmatter keys and scalar or scalar-array values;
- source and destination paths for move/rename;
- the path of a note requested for Obsidian trash;
- bounded operation-specific previews, hashes, backup ID, verification, error, and rollback metadata.

Paths, filenames, relationships, permission choices, write intentions, previews, hashes, and diagnostics can be sensitive even when a full note is not returned.

## Data flow

```text
User request
  -> ChatGPT/Codex or another local MCP host
  -> one capability-specific MCP process over stdio
  -> Obsidian Bridge
  -> official Obsidian CLI and desktop app
  -> result or preview
  -> MCP host
  -> model, when the host sends that data to a model service

protected create/append:
  exact local UTF-8 observations -> displayed preview
  -> later human confirmation -> allowlisted CLI mutation -> exact verification

autonomous create/append:
  exact local UTF-8 observations -> internally checked preview
  -> separately gated auto-approved allowlisted CLI mutation -> exact verification

managed operation:
  exact local UTF-8 source snapshot -> internally checked preview
  -> one-time private request file
  -> fixed bridge-control:commit handler inside Obsidian
  -> fixed public Obsidian API surface -> verified note, isolated move, or trash result
```

The project separates reader, protected writer, autonomous writer, and manager processes. The reader has no mutating tool. The manager has only managed prepare and commit and invokes only the fixed custom CLI handler. Version 0.5.4 reads an already authorized settings-backed note as a bounded exact UTF-8 snapshot for every create/append and management transactional observation. This includes preparation, CAS, append backup capture, intermediate/final verification, and recovery classification. The snapshot is ephemeral and read-only: it adds no direct note write, new persistent snapshot, permission, or network flow. Create/append mutation still uses the allowlisted official CLI, while managed mutation remains in Bridge Control. This separation reduces accidental capability mixing but does not change what the MCP host or model provider may retain.

Bridge Control itself launches no executable. Its optional CLI candidate scan only performs read-only metadata checks against an allowlist of known locations and never reports a candidate as ready or certified; the external bridge performs the definitive readiness check. Companion Node filesystem access is limited to shared settings and lock/quarantine state, the read-only Obsidian registry and candidate metadata checks, one-time management requests, recovery backups, and metadata-only audit records. It is never used for a note path. Managed note reads and mutations inside Obsidian use public Obsidian APIs.

The bridge does not upload data itself. The host decides whether tool inputs and outputs are sent to a model service, displayed, logged, retained, or included in diagnostics. Review those controls before exposing personal, regulated, client, or confidential notes.

## Network activity

At runtime, version 0.5.4:

- opens no HTTP listener;
- does not call OpenAI, Obsidian, analytics, or update endpoints;
- includes no telemetry;
- communicates with parent MCP processes through stdin/stdout;
- communicates with the running desktop Obsidian application through the official local CLI.

Installing dependencies, downloading releases, updating Obsidian, using Sync, or enabling other host features can use the network independently. A hosted MCP tunnel is not included; adding one would require an updated privacy and security review.

## Local settings

Bridge Control and the installer persist configuration needed to apply permissions. On Windows the shared file is:

```text
%LOCALAPPDATA%\ObsidianBridge\settings.json
```

Equivalent application-config locations are used by the companion on other platforms. Version-5 settings contain:

- update time;
- each vault's stable 16-character Obsidian ID, display label, and absolute registered root;
- the vault's actual `Vault.configDir`, or a deny-all null migration marker;
- master enabled switch;
- access mode `protected`, `full`, or `management`;
- exact `edit`, `move`, and `trash` flags, which must all be false outside management mode;
- protected read mode and read/write folder prefixes.

The UI labels `full` as **Autonomous access** and `management` as **Full management**. Settings do not contain note bodies, search queries, model prompts, credentials, or pending write proposals. Stable ID and root prevent a grant from being applied to a different vault with the same name.

Strict version-2 through version-4 settings migrate without inventing management authority. A legacy entry remains deny-all until its own vault records the real `Vault.configDir`, and any saved folder scope intersecting that directory is removed. An update cannot activate Full management. The user must acknowledge the named vault and the exact non-empty granular permission snapshot in Bridge Control. A malformed, oversized, invalid-UTF-8, or schema-inconsistent present file fails closed.

An administrator can explicitly redirect the shared settings file with `OBSIDIAN_BRIDGE_SETTINGS_PATH` before Obsidian starts. Vault plugin data cannot redirect it. Bridge Control reads Obsidian's global vault registry through a regular-file, no-symlink, 1 MiB boundary to resolve stable identity.

The companion caches normal UI choices and acknowledged audit event IDs in its own plugin data. That cache is not authoritative for Autonomous access or Full management. Revocation failure can create a timestamped `.revoked-…json` quarantine copy beside the shared file; it contains the same sensitive vault metadata and should be removed after recovery.

## Temporary management requests

Managed commit writes a JSON request below the fixed bridge data directory under `management/requests`. The request can include the complete proposed replacement, frontmatter values, source/destination paths, hashes, request/change IDs, an expiry, and a one-time 256-bit token. Request files are therefore sensitive.

Requests are bounded to 1 MiB, created with private-file permissions where supported, short-lived, bound to one stable vault, claimed once by Bridge Control, and removed after processing. The custom handler accepts only the request ID and token; it does not accept arbitrary filesystem paths, commands, or source code. A crash may leave a request or claimed file until manual maintenance; protect the whole bridge data directory.

## Backups, audit, and retention

A successful write intentionally persists content in the selected vault. Before append, the writer stores an exact plaintext copy of the original settings-backed note. The resulting appended document must remain at or below 1 MiB; create requires an already existing parent folder.

Before every managed replace, frontmatter, move/rename, or trash operation, Bridge Control creates a version-2 plaintext JSON backup bundle containing the original note body, path, hash, operation, and optional destination. Create/append and management bundles share one local count-based retention pool containing at most the newest 20 JSON backups. Retention is not archival storage or guaranteed secure erasure, and an older recovery bundle may already have been pruned. These files can reveal complete prior note contents.

Version 0.5.4 does not automatically overwrite a note to roll back a failed create/append transaction. A CLI compare-and-restore sequence is not atomic with Obsidian, sync tools, editors, or other plugins. After a post-mutation append or verification failure, the writer preserves the exact backup and audit evidence, leaves the observed note untouched, and reports `manual_recovery_required=true` with the bounded cause `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` or `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. A partial create remains `delete_disabled`. Manual recovery can expose the same note and backup content to the person performing it.

If managed verification fails, automatic recovery is deliberately bounded:

- replace/frontmatter can restore the backup only while the current note still matches a known bridge-written state;
- move can be reversed only while source and destination match the expected state;
- trash is not silently reversed, so the backup or Obsidian trash is the recovery source;
- unknown concurrent content is never overwritten.

Mutation attempts append NDJSON audit data containing operation, authorization mode, source path, optional destination, hashes, status, backup ID, error code, rollback outcome, and optional bounded `failure_stage` and `cause_code` values—but no raw exception message, CLI stdout/stderr, note body, proposed content, or backup body. These records still reveal sensitive metadata.

Bridge Control's **Problemi recenti** view reads at most the final 128 KiB of the fixed audit and returns at most 20 validated records for the current stable vault ID. It never opens a backup or returns note text. It may ask Obsidian whether the source or destination currently exists.

The read-only `obsidian_recent_write_events` tool exposes the same bounded class of metadata to the MCP host and model after applying current vault and folder read permissions. The caller cannot select an arbitrary audit path. It omits raw messages and output, audit hashes, note content, proposed content, and backup bodies. Unsafe, malformed, invalid-UTF-8, non-regular, symlinked, or oversized records fail closed. Diagnostic metadata is not permission, confirmation, or authority to retry a failed change.

Cross-process lock directories below the bridge data directory use opaque SHA-256-derived names. Small owner files can contain a random ownership token, process ID, and creation time. Locks are normally removed after commit; stale locks can remain after a crash.

`OBSIDIAN_BRIDGE_DATA_DIR` selects the absolute backup, audit, request, and lock location. Without it, the deterministic platform local-data location is `%LOCALAPPDATA%/obsidian-bridge` on Windows, `~/Library/Application Support/obsidian-bridge` on macOS, or the XDG data location on Linux. POSIX modes request `0700` directories and `0600` files; Windows ACLs determine effective access. The bridge does not encrypt these artifacts.

Obsidian, Sync, filesystem backup software, source control, other plugins, the operating system, terminal capture, crash reporting, and the MCP host may retain additional copies outside the bridge's control.

## Access controls and revocation

Protected access can be off, whole-vault, or folder-scoped for reading, with a separate default-off folder-scoped create/append grant. Autonomous access and Full management apply only to otherwise eligible non-hidden Markdown paths in the exact enabled vault. Legacy environment variables can never grant either profile; in 0.5.4 the environment-only legacy writer also fails closed for create/append because CLI stdout is not an exact CAS source. Migrate writing access to Bridge Control shared settings.

Management requires `accessMode=management` and the exact operation grant:

- `edit` for replace, `replace_text`, and frontmatter;
- `move` for move or rename;
- `trash` for Obsidian trash.

Move/rename uses `Vault.rename` and changes only the selected file. It does not rewrite backlinks, links, embeds, or other notes. Repairing references is a separate edit that can disclose and mutate those notes only under the independent `edit` grant and an explicit user request.

One permission cannot substitute for another. The bridge rereads shared settings during preparation and commit; Bridge Control checks again immediately before mutation. Clearing a permission, returning to Autonomous or Protected access, or disabling the vault revokes authority for the next stage. An older preview cannot preserve a revoked grant.

`.obsidian`, `.trash`, every hidden path segment, absolute paths, traversal, configured deny prefixes, and physical redirects outside the registered vault remain denied. The bridge offers no permanent deletion, arbitrary command, command palette, plugin management, shell, or `eval`.

These controls reduce accidental disclosure and mutation. They are not encryption, an OS sandbox, or multi-user authorization. A process running as the same OS user may bypass the bridge entirely.

## Approval, autonomy, and untrusted content

Protected create/append requires the agent to show the exact prepared preview and wait for a later explicit human confirmation. Autonomous access and Full management allow the agent to inspect a matching preview internally and commit a concrete, unambiguous user request in the same task. They do not authorize invented work or resolve ambiguity.

Only the user can activate Autonomous access or Full management through Bridge Control. Note content, frontmatter, links, tags, search results, audit fields, external documents, tool output, or another model cannot grant permission, supply protected consent, request a retry, or expand the task.

Source hashes and destination checks reject ordinary stale commits, but unrelated software can still race between stages. After any failure, inspect bounded audit metadata and reread the current source and destination before deciding what to do. Never assume failure left the vault unchanged.

## User choices

Reduce disclosure and mutation risk by:

1. testing with synthetic notes in a disposable vault;
2. keeping an independent vault backup;
3. choosing Protected access and the narrowest useful folders by default;
4. using Autonomous access only for a bounded create/append task;
5. activating Full management only when required and enabling one granular grant at a time during initial testing;
6. keeping secrets and sensitive notes outside model-accessible scopes;
7. reviewing protected previews and verifying every autonomous or managed result;
8. reviewing **Problemi recenti** and bounded MCP audit diagnostics after an error;
9. protecting and periodically cleaning the bridge data directory according to a documented retention policy;
10. clearing management grants, returning to a narrower profile, or disabling the bridge when work is complete.

To remove a note, Full management can send it through Obsidian's configured trash only when the user explicitly grants `trash`. Permanent deletion is not exposed. Removing a local source does not remove copies already transmitted to or retained by the MCP host, model provider, Sync, backups, or other software; use their retention controls separately.

## Third-party software

The bridge depends on the official Obsidian CLI and desktop app for vault access, a compatible MCP host for invocation and approval, and the host's selected model service for generated answers. Obsidian Sync, Publish, and other community plugins can process vault data independently; the bridge does not configure them.

## Changes

Material privacy changes are documented with the release that introduces them. Remote transport, telemetry, authentication, persistent indexing, or broader mutation surfaces require a new review and notice.

## Questions and reports

Use the repository issue tracker for general questions that contain no private information. For a suspected leak or vulnerability, follow [SECURITY.md](SECURITY.md) and do not publish sensitive evidence.
