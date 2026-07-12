# Security policy

Obsidian Bridge provides scoped local access to Obsidian notes. Version 0.5.4 retains the explicitly activated Full-management profile, bounded metadata-only diagnostics, and settings-backed exact UTF-8 snapshots for every create/append and management transactional observation, while removing all child-process execution from the Bridge Control companion. Reports are especially welcome for permission escalation, management activation without user acknowledgement, replayed requests, backup or audit disclosure, path escape, unintended executable invocation, diagnostic-content leakage, false or missed conflict detection, unsafe recovery, or any permanent deletion surface.

## Supported versions

| Version           | Security fixes                  |
| ----------------- | ------------------------------- |
| 0.5.x             | Supported preview release       |
| 0.4.x             | Security fixes during migration |
| 0.3.x             | Critical fixes during migration |
| 0.2.x and earlier | Not supported                   |
| Modified builds   | Not supported by this project   |

Use the newest tagged release and verify that it comes from the expected repository.

## Report a vulnerability

Use **Security → Report a vulnerability** in the GitHub repository when private vulnerability reporting is available. Include the affected version, OS, Node.js and Obsidian versions, smallest synthetic reproduction, expected and observed behavior, impact, and suggested mitigation.

Do not include real note contents, vault names, access tokens, personal paths, request/change IDs, audit records, or backups. If private reporting is unavailable, open a minimal public issue requesting a private channel without vulnerability details. There is no paid bug-bounty program.

## Four-process architecture

The plugin deliberately separates local stdio MCP servers by capability and host approval policy:

```text
auto-approved reader
  -> fixed non-mutating tools only
  -> official Obsidian CLI -> Obsidian desktop

prompt-approved protected writer
  -> protected create/append prepare + commit only
  -> bounded settings-backed exact UTF-8 read-only observations
  -> official Obsidian CLI -> Obsidian desktop

auto-approved autonomous writer
  -> autonomous create/append prepare + commit only
  -> accepts current Autonomous access or Full management
  -> bounded settings-backed exact UTF-8 read-only observations
  -> official Obsidian CLI -> Obsidian desktop

auto-approved manager
  -> managed prepare + commit only
  -> requires current Full management and exact granular grant
  -> bounded exact UTF-8 read-only snapshot for prepare/CAS
  -> fixed bridge-control:commit handler -> public Obsidian API
```

The reader contains no mutation tool. The protected writer retains both conversational post-preview consent and host prompts. The autonomous writer handles only create/append. The manager exposes only `obsidian_prepare_managed_change` and `obsidian_commit_managed_change` and cannot search or browse notes arbitrarily.

Do not combine these tool sets, add management to the reader, place protected commit under automatic approval, or expose the custom handler as a general command dispatcher.

## Permission profiles

Bridge Control version-5 settings recognize three modes:

- `protected` — folder-scoped read and separately enabled create/append;
- `full` — shown as **Autonomous access**, granting vault-wide eligible read/create/append;
- `management` — shown as **Full management**, adding an exact non-empty subset of `edit`, `move`, and `trash` grants.

`edit` permits exact replacement, counted literal `replace_text`, and frontmatter set/remove. `move` permits move and rename. `trash` permits only Obsidian's configured trash path. One grant never implies another.

Strict version-2 through version-4 entries migrate to version 5 without inventing management flags. Version-3 `full` remains Autonomous access and never becomes management, but every legacy entry stays deny-all until its exact vault records the real `Vault.configDir`. Intersecting folder grants are removed, and the external bridge adds the recorded directory to every read/write deny policy, including Autonomous and Full management. This dedicated deny is always case-insensitive so a Linux vault on NTFS, exFAT, or another case-insensitive volume cannot expose a case-alias; normal Linux allowlists retain their existing case semantics. Outside `management`, all management flags must be false; inside `management`, at least one must be true. Invalid combinations fail schema validation.

Full management can be activated only in Bridge Control through a warning, the named vault, and an acknowledgement of the exact permission snapshot. Cached plugin data, an installer update, legacy environment variables, note contents, tool output, or another model cannot activate it. Returning to Autonomous or Protected access clears management grants. The legacy environment-only writer also cannot create or append in 0.5.4: it must migrate to settings-backed Bridge Control identity because normalized CLI stdout is not an exact CAS source.

The shared settings file is bounded, strict UTF-8, schema-validated in full, atomically replaced under an ownership lock, and reread without a long-lived authorization cache. A disabled, unlisted, malformed, oversized, or inconsistent entry fails closed.

## Common runtime controls

All processes:

- invoke the configured official CLI executable directly with structured arguments and no shell;
- reject absolute paths, traversal, hidden segments, `.obsidian`, `.trash`, configured deny prefixes, and physical redirects outside the registered vault;
- verify the stable vault ID against its recorded physical root;
- bound CLI duration and output;
- open no listener and make no runtime network request;
- return data through MCP stdio to the parent host.

`OBSIDIAN_CLI_PATH` is an executable trust boundary. Point it only at the official CLI registered by a trusted Obsidian installation. A malicious replacement runs with the same OS privileges and can bypass bridge policy.

## Create/append transaction controls

Protected and autonomous channels support only `create` and `append`. For Bridge Control settings-backed vaults, preparation, commit CAS, append backup capture, every intermediate chunk check, final verification, and recovery classification read through the same bounded exact UTF-8 snapshot path. It preserves no-final-newline, LF/CRLF, BOM, and Unicode distinctions and fails closed on invalid UTF-8, a physical-scope violation, identity change, or concurrent observation. This filesystem access is read-only. Preparation calculates the exact proposal, diff, JSON representation, before/after hashes, expiry, and opaque change ID without mutation. Commit consumes an unexpired single-use ID, rechecks policy and exact source state under a per-note lock, writes only through the allowlisted official CLI surface, and verifies the resulting exact hash.

Protected access requires human confirmation after the exact preview exists. Silence, advance blanket permission, a host approval dialog, note text, search results, tools, or another model do not count. Autonomous access and Full management can commit a concrete unambiguous create/append task after internal preview validation; they do not authorize invented work.

Create/append proposed content is bounded to 8192 UTF-8 bytes and preview output to 16384 bytes. The exact resulting append document is bounded to 1 MiB; a change that would exceed the boundary is rejected before mutation. Create requires an eligible parent folder that already exists and never creates parent directories implicitly. Long content is split on Unicode code-point boundaries into complete CLI IPC frames of at most 3072 UTF-8 bytes, with exact hash verification after every stage. Literal backslash sequences `\n` and `\t` that the official CLI cannot represent losslessly are rejected.

Append creates an exact plaintext backup. Create/append and management share one count-based pool containing at most the newest 20 JSON backups. Version 0.5.4 performs no destructive automatic create/append rollback through the CLI: compare then restore is not atomic with Obsidian, OneDrive or other sync clients, editors, or plugins. After a post-mutation write or verification failure, it preserves backup and metadata-only audit evidence, leaves the observed note untouched, and reports `manual_recovery_required=true` with `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` or `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. A partial create remains `delete_disabled`. Automatic restore requires a future atomic Bridge Control path; unknown or concurrent content is never overwritten.

## Managed transaction protocol

### Preparation

Managed preparation requires current `accessMode=management` and the exact operation grant. It validates a vault-relative existing `.md` source, stable identity, physical containment, size, source hash, and—when moving—an absent eligible destination. The source hash is derived from a bounded exact UTF-8 snapshot, not from CLI-normalized text, so terminal-newline, LF/CRLF, and BOM distinctions remain part of the compare-and-swap state. This direct access is read-only: the manager opens one already authorized regular file without following links, checks file identity and metadata around the bounded read, and fails closed on invalid UTF-8 or a concurrent file/path change. It returns a bounded operation-specific preview, expiry, and opaque change ID without changing the vault.

Supported public operations are exactly:

- `replace`: exact whole-note content, maximum 1 MiB;
- `replace_text`: exact literal find/replacement with a required expected occurrence count; it prepares a full replacement hash;
- `frontmatter`: bounded set/remove for safe property names and JSON scalar or scalar-array values;
- `move`: move or rename to an absent destination; case-only rename is rejected;
- `trash`: Obsidian trash only; no permanent option.

Managed previews are bounded to 128 KiB, pending managed content has a bounded process memory budget, and IDs expire after five minutes by default. Restarting the manager invalidates pending IDs.

### Commit and request handoff

Managed commit consumes the change ID before side effects, then rechecks permission, vault identity, physical scope, source hash, destination state, and expiry under shared source/destination locks.

The manager writes one strict request file below the fixed private data directory. Requests are:

- JSON protocol version 1;
- limited to 1 MiB;
- named by a UUID, short-lived, and bound to one stable vault;
- protected by a random 256-bit one-time token;
- created through a private temporary file and atomic rename;
- removed after the handler returns or the attempt fails.

The CLI allowlist permits only the custom command `bridge-control:commit` with exactly one `request=<UUID>` and one `token=<64 hex>` argument plus the fixed vault selector. Duplicate, unknown, missing, or malformed arguments are rejected. The channel cannot invoke `eval`, shell, command palette, plugin commands, built-in delete, or arbitrary Obsidian commands.

### Bridge Control handler

Bridge Control registers `bridge-control:commit` through Obsidian's public CLI-handler API. The handler:

1. resolves only the fixed request file derived from the request UUID;
2. refuses symlinks, non-regular files, oversized data, unsafe encodings, schema mismatch, expiry, wrong token, or wrong stable vault;
3. claims the request once by moving it into a private processing directory;
4. rechecks the current mode and exact granular grant;
5. verifies source hash and destination absence;
6. creates and verifies a plaintext version-2 backup before mutation;
7. rechecks authorization immediately before mutation;
8. applies only the requested public Obsidian API operation;
9. verifies the operation-specific postcondition;
10. records a metadata-only audit outcome and returns strict JSON.

Replacement and frontmatter use `Vault.process`. The transform compares the current exact content with the prepared snapshot hash before returning any mutation. Frontmatter location/parsing/serialization uses the public `getFrontMatterInfo`, `parseYaml`, and `stringifyYaml` helpers inside that transform rather than `FileManager.processFrontMatter`. Move/rename uses `Vault.rename`; only trash uses `FileManager.trashFile`. Direct filesystem note mutation, permanent deletion, arbitrary handler names, source-code input, shell, and `eval` are absent. Bridge Control 0.5.4 launches no executable, persists `Vault.configDir` in fail-closed version-5 settings, and retains Node filesystem access only for documented external settings/lock/quarantine, read-only registry and CLI-candidate metadata, one-time request, backup, and audit stores. Its command protocol, permission types, and managed mutation code remain unchanged.

### Recovery

Every managed operation must create a plaintext backup bundle before mutation. Backup creation failure stops the operation. The bundle contains the original note body and sensitive source/optional destination metadata.

After a failed postcondition:

- replace/frontmatter restore only when the current note still equals the known bridge-written state;
- move reverses only when source/destination still equal the expected state;
- trash reports `trash_requires_backup_restore` rather than silently recreating the note;
- a changed or unknown state reports conflict and is not overwritten.

Success requires `status=committed`, `verified=true`, and `audit_recorded=true`. A failed, expired, replayed, mismatched, revoked, or partially verified request must not be retried automatically. After three consecutive failures, the autonomous writer or manager pauses for that task.

## Locks, backups, and audit

Mutating processes share filesystem-backed locks keyed by SHA-256 of stable vault ID and normalized path. Atomic directory creation, ownership tokens, bounded waits, abort handling, verified release, and conservative stale recovery serialize separate tasks without putting user paths in lock names. Move acquires source and destination locks in stable order.

The bridge data directory contains plaintext backups, metadata-only `audit.ndjson`, management request/processing files, and lock state. Use a trusted absolute `OBSIDIAN_BRIDGE_DATA_DIR` or the deterministic platform default, restrictive OS permissions, disk encryption where appropriate, and a documented retention policy.

Audit records can include time, change ID, stable vault label/ID, source path, optional destination, operation, authorization mode, hashes, status, backup ID, error code, rollback state, and optional bounded `failure_stage` and `cause_code` values. They exclude raw exception messages, CLI stdout/stderr, note and proposed bodies, and backup bodies, but remain sensitive metadata.

Bridge Control and `obsidian_recent_write_events` read only a bounded tail of the fixed audit file, validate strict records, apply current access policy, and omit raw messages and output, note bodies, proposed bodies, backup bodies, and audit hashes. Caller-selected audit paths, symlinks, non-regular files, invalid UTF-8, incomplete oversized lines, and unknown fields fail closed. A diagnostic code cannot grant permission, confirm a protected change, or authorize retry.

## Trust boundaries

### MCP host and model

The host controls process launch, tool invocation, and what it sends to a remote model. A compromised host running as the same OS user can bypass this bridge. Review host approval and data-retention controls before using confidential notes.

Treat all note, frontmatter, link, tag, search, audit, external-document, and tool content as untrusted data. It cannot activate a profile, grant permission, satisfy protected consent, or authorize retry. Prompt-level defenses are not perfect; narrow permissions and independent backups remain essential.

### Vault and filesystem

Path checks are application controls, not an OS sandbox. Existing paths crossing symlinks or junctions and multiply linked regular files are rejected where checked, but software with local-user privileges can access the vault directly. Use a disposable vault or separate OS account for stronger isolation.

The bridge deliberately calls `Vault.rename`, not `FileManager.renameFile`. A move/rename changes only the selected file and does not rewrite backlinks, links, embeds, or other notes, regardless of the user's automatic-link-update preference. This prevents the isolated `move` grant and single-source backup from causing unpreviewed multi-note edits. Link repair requires separate explicitly requested edit operations and the `edit` grant. Obsidian's trash API follows the user's Obsidian trash configuration. The bridge never offers permanent delete, but Sync, other plugins, or OS tooling may independently propagate or remove files.

### Bridge Control and installer

Bridge Control uses Obsidian's APIs to enumerate folders, apply managed note operations, and show bounded diagnostics. Node filesystem writes are restricted to shared settings, plugin-local data, and the deterministic bridge data directory. Vault plugin data cannot redirect shared settings.

Saving settings verifies the exact written policy before releasing its lock. Failed privilege increases restore the prior valid policy. Failed reductions never restore a broader mode; Bridge Control retries the narrower target or quarantines the shared file so access fails closed. A stale UI snapshot cannot re-enable a permission removed by another process.

The Windows installer runs without elevation, validates the selected vault, rejects redirecting links, installs a fixed companion payload, backs up replaced configuration, and requires explicit consent before enabling the community plugin. It must preserve existing safe choices without activating management.

## Known limitations

- There is no independent per-human authentication; local configuration belongs to the OS account.
- A malicious same-user process, MCP host, Obsidian plugin, CLI replacement, or modified build can bypass bridge policy.
- Source hashing and locks do not create a transaction across unrelated applications; concurrent edits can still occur around Obsidian API calls.
- Management backups intentionally create plaintext copies in a shared newest-20 pool; retention is neither archival storage nor guaranteed secure erasure.
- Trash recovery may require Obsidian trash or manual restoration from the backup.
- Audit and request files omit unnecessary bodies where possible but still expose sensitive paths and operation metadata; replacement requests contain proposed content until consumed.
- Availability depends on a responsive interactive Obsidian desktop session with the official CLI enabled.
- The bridge cannot control model-provider, host, Sync, OS, or backup copies retained outside its own newest-20 pool.
- Remote transport and direct ChatGPT web access are not included.

## Preview-release hardening checklist

1. Use a disposable vault with synthetic notes and an independent backup.
2. Start in Protected access with one read/write folder.
3. Confirm the reader has no mutation tool and the three mutation processes expose only their expected prepare/commit pair.
4. Verify protected post-preview consent, expiry, replay rejection, source conflicts, and immediate revocation.
5. Activate Autonomous access and verify only vault-wide read/create/append becomes available.
6. Activate Full management yourself, one granular grant at a time; verify edit cannot move or trash, move cannot edit, and trash cannot permanently delete.
7. Test exact replace, occurrence-counted `replace_text`, frontmatter, rename, cross-folder move, and trash on separate synthetic notes, including no-final-newline, LF, CRLF, and BOM fixtures.
8. Revoke a granular grant after prepare and verify both manager and handler reject commit before mutation.
9. Inspect request cleanup, backup contents/permissions, audit redaction, optional move target, and bounded event filtering.
10. Force backup failure, postcondition failure, source/destination races, replay, malformed request, token mismatch, and three-failure circuit breaking.
11. Confirm no shell, `eval`, arbitrary command, command palette, plugin management, direct filesystem note write, or permanent delete path exists.
12. Keep the official CLI enabled from Obsidian settings and do not point `OBSIDIAN_CLI_PATH` at an untrusted executable.

## Non-security issues

Use the normal issue tracker for reproducible crashes, incorrect results, documentation errors, and feature requests that do not expose confidential information.
