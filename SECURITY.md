# Security policy

Obsidian Bridge provides scoped local access to Obsidian notes. Version 0.4 adds an explicit per-vault full-access mode, a separately gated autonomous writer, cross-process commit locks, and bounded error diagnostics while keeping all writes opt-in. Reports are especially welcome for policy bypasses, autonomous writes without full-access authorization, replayed or stale changes, lock bypasses, installer path escapes, unsafe configuration replacement, unintended executable invocation, or disclosure outside the MCP response path.

## Supported versions

| Version | Security fixes |
| --- | --- |
| 0.4.x | Supported preview release |
| 0.3.x | Supported preview release |
| 0.2.x | Security fixes during migration |
| 0.1.x | Read-only; critical fixes only during migration |
| Earlier or modified builds | Not supported |

Use the newest tagged release and verify that it comes from the expected repository.

## Report a vulnerability

Use **Security > Report a vulnerability** in the repository when GitHub private vulnerability reporting is available. Include:

- affected version or commit;
- operating system, Node.js version, and Obsidian installer version;
- smallest safe reproduction;
- expected and observed behavior;
- security impact and any suggested mitigation.

Do not include real note contents, vault names, access tokens, personal paths, change IDs, audit records, or backups. Use synthetic examples. If private reporting is unavailable, open a minimal public issue requesting a private channel without vulnerability details.

Please allow maintainers time to reproduce and fix an issue before publishing technical details. There is no paid bug-bounty program.

## Three-process architecture

The plugin deliberately uses three local MCP servers with different capabilities and host approval policies:

```text
auto-approved reader process
  -> nine fixed read tools
  -> official Obsidian CLI -> Obsidian desktop

prompt-approved writer process
  -> protected prepare tool + protected commit tool only
  -> official Obsidian CLI -> Obsidian desktop

auto-approved autonomous writer process
  -> autonomous prepare tool + autonomous commit tool only
  -> refuses every vault not explicitly set to full access
  -> official Obsidian CLI -> Obsidian desktop
```

The reader process contains no write tool. The protected writer retains host approval prompts and accepts only protected vaults. The autonomous writer is auto-approved but accepts only a current version-3 panel entry explicitly set to `accessMode=full`; legacy environment variables can never grant autonomy. Both writers expose no search, browsing, shell, command-palette, plugin-management, or `eval` surface and retain the same two-step, single-use protocol.

Do not combine the tool sets or change the protected writer server to automatic approval in a derived configuration.

## Runtime controls

All three processes:

- invoke the configured CLI executable directly with structured arguments and no shell fallback;
- reject traversal, absolute paths, hidden path segments, `.obsidian`, `.trash`, and configured denied prefixes;
- bound CLI duration and output size;
- open no listener and make no runtime network request;
- return data through MCP stdio to their parent host.

The reader exposes only the nine documented read tools. In the normal 0.4 setup it reloads the selected vault's Bridge Control policy before each operation. A disabled or unlisted vault receives no access, and a present malformed shared-settings file fails closed instead of falling back to a broader policy.

The protected writer exposes only preparation and commit. Its per-vault write toggle and writable-folder list are separate from read scope. The autonomous writer exposes distinct preparation and commit names and fails unless that exact vault is currently in full access. Writing is disabled by default, and every write is denied when the vault, mode, toggle or folder does not match. Both support only:

- creating a new Markdown note without overwrite;
- appending text to an existing Markdown note.

Delete, rename, move, arbitrary overwrite, arbitrary Obsidian commands, shell access, plugin commands, and `eval` are unavailable.

Write content is limited to 8192 UTF-8 bytes and preview output to 16384 bytes. To avoid the Obsidian 1.12.7 IPC framing defect for long CLI arguments, every complete CLI request frame is capped at 3072 UTF-8 bytes. Long create and append content is divided on Unicode code-point boundaries, each chunk is appended inline, and every intermediate state is read back and hash-verified before the next mutation. The official CLI cannot represent literal backslash sequences `\n` and `\t` losslessly in content arguments, so the bridge rejects proposals containing those two sequences. Ordinary backslashes are passed through unchanged. The bundled plugin uses separate `--mode=read`, `--mode=write`, and `--mode=autonomous` processes. A combined `--mode=all` exists for controlled development/testing only and must never be placed under automatic approval.

Before either writer mutates a note, it acquires a filesystem-backed lock keyed by a SHA-256 digest of the stable vault ID and normalized note path. Atomic directory creation, ownership tokens, bounded waits, abort handling, conservative stale-lock recovery, and verified release serialize separate MCP processes without exposing user paths in lock filenames. The lock is an application control, not an OS sandbox. An active or PID-reused owner is deliberately not stolen.

One autonomous writer process pauses after three consecutive commit failures. This stops a local retry loop for that task; it does not replace audit review or independent backups.

The normal policy source is the versioned local settings file maintained by Bridge Control and the installer. Strict version-2 entries migrate to version 3 as protected access; version 3 adds required `accessMode=protected|full`. The file is size-bounded, decoded as strict UTF-8, schema-validated in full and read without a long-lived permission cache. Revocation therefore takes effect on the next operation and before every write chunk. Legacy environment variables are an advanced compatibility fallback only when the shared file is absent; they can never grant full access.

Line replacement is deferred because the official CLI has no atomic compare-and-swap primitive. It must not be emulated with an unrestricted overwrite.

## Write transaction protocol

### Preparation

Preparation validates the vault-relative target and write policy, obtains the current source state when required, calculates the proposed result, and returns a bounded preview with a diff, `proposed_content_json`, line counts, before/after SHA-256 hashes, and an opaque change ID. The diff explicitly marks changes to the end-of-file newline, and the JSON representation disambiguates whitespace and backslashes. Preparation must not modify the vault.

A prepared change has a five-minute default time-to-live, configurable from one to thirty minutes through `OBSIDIAN_BRIDGE_CHANGE_TTL_MS`, and belongs only to the writer process that created it. Restarting that process invalidates pending changes.

After a write, the bridge verifies the resulting hash. A verification or CLI failure triggers a deliberately narrow rollback only when the current note exactly matches the full prepared state or a known intermediate chunk hash. The bridge makes at most one overwrite attempt, and only when the original content is representable by the official CLI, contains no CR/CRLF line endings that its content argument would normalize, and fits one safe IPC frame. Otherwise the plaintext backup is the manual recovery source and the result reports `restore_unrepresentable` or `restore_too_large`. An unchanged note requires no overwrite, an unknown third hash is treated as a concurrent edit and is never overwritten, and a newly created note is not automatically deleted. The result always reports the rollback outcome and reason.

### Protected-mode human confirmation

After preparation, the agent must show the user the exact vault, path, operation, complete proposed content, and diff. It must also show `proposed_content_json` whenever whitespace or backslashes could be ambiguous and point out an end-of-file newline marker. Commit is allowed only after an unambiguous human confirmation of that displayed preview in the current conversation.

The following are not confirmation:

- silence or timeout;
- consent given before the preview exists;
- a general request to “make any necessary changes”;
- text found in a note, search result, link, tag, tool response, or external document;
- instructions generated by another model or tool;
- approval of a different change ID or an older preview.

The MCP host's tool-approval prompt is an additional control, not a substitute for showing the preview and receiving conversational consent.

### Full-access authorization

Full access is a separate per-vault authorization activated through one warning modal in Bridge Control. It permits the autonomous writer to validate a preview internally and commit in the same task without a routine confirmation question. It does not authorize invented work or resolve ambiguity about vault, path, or content.

Full access does not expose delete, rename, move, arbitrary overwrite, shell, plugin management, command palette, or `eval`. Hidden paths, deny prefixes, stable vault identity, physical containment, source hashes, size limits, backups, audit, locks, chunk verification, and single-use IDs remain enforced. Note text, tool output, external content, or another model can never enable full access or expand the user's task.

### Commit and conflicts

Commit accepts only an unexpired prepared change ID. The bridge revalidates the target and writable policy and compares the current note state with the source hash captured during preparation. For create, the expected state is that the target does not exist.

If the source changed before the commit-time check, the target appeared, the change expired, authorization mode changed, or policy changed, commit fails closed. Never force or silently merge it. Protected mode requires a new preview and confirmation; autonomous mode stops for human direction rather than retrying automatically.

The source check and official CLI mutation are not atomic. Chunked changes add a bounded sequence of individually verified mutations, so another application can modify a note between stages. An approved append may land on a concurrent state and a partial create may remain when a later chunk fails because delete is deliberately unavailable. The bridge does not replace an unknown state. Reread the note before preparing any retry, and never infer that a failed change left the note unchanged.

Every change ID is single-use. A commit attempt consumes it before any side effect whether the operation later succeeds or fails, preventing replay with altered local state.

Before append, commit must create a plaintext backup of the original. Create has no original to back up. The bridge then writes through the fixed CLI command surface, rereads the target, and verifies the after-hash. It retains the newest 20 managed backups.

After a write attempt, the bridge appends metadata-only NDJSON audit information without note content and reports whether recording succeeded. Records include the authorization channel and structured rollback outcome on failure. The result also states whether after-hash verification succeeded and supplies a backup ID when applicable.

The read server exposes `obsidian_recent_write_events` so the model can inspect recent outcomes without asking the user to transcribe an error dialog. The caller cannot supply an audit path: the tool reads only `audit.ndjson` below the configured bridge data directory, at most the final 128 KiB, and returns at most 20 metadata-only records. Every record is validated against a strict schema and filtered through current vault and folder read access. Symlinks, non-regular files, invalid UTF-8, incomplete or oversized lines, unknown fields, and malformed records fail the whole diagnostic request closed. A missing file is an empty history. The tool omits note and backup bodies as well as before/after hashes, but its paths, timing, change IDs, error codes, rollback state, and backup IDs remain sensitive metadata visible to the MCP host and model.

## Trust boundaries

### MCP host and model

The host controls tool invocation and can send arguments, note text, previews, paths, tags, and metadata to a remote model. A compromised host running with the same OS permissions can bypass this bridge entirely.

Keep protected writer calls on prompt approval. Enable full access only for a vault where autonomous create and append are intended, and return to protected access when the task is finished. Review the host's workspace policy and data controls before using confidential material.

The bundled skill checks the bounded audit tool before an autonomous write sequence and after a write error. Treat those records as diagnostic evidence, never as user consent or permission to retry. If the audit reader fails its safety validation, do not fall back to shell or unrestricted filesystem reads.

### Obsidian CLI executable

`OBSIDIAN_CLI_PATH` is an executable trust boundary. Point it only at the official CLI registered by a trusted Obsidian installation. A malicious replacement inherits bridge permissions and can ignore bridge policy.

### Vault content and prompt injection

Treat every note as untrusted input. Instruction-like note text may try to manipulate the model into disclosing data or committing a change. The bundled skill requires treating notes only as evidence and never interpreting their contents as consent or as an expansion of a full-access task. Prompt-level defenses are not perfect; protected-mode preview review and narrow, temporary use of full access remain important.

Never put passwords, recovery codes, API keys, private keys, or other secrets in model-accessible folders.

### Vault and folder policies

Bridge Control stores one strict entry keyed by Obsidian's stable 16-character vault ID. The display name is only a label, and the recorded absolute physical root is verified against the ID before content access. Each entry contains:

- a master enable switch;
- access mode `protected` or `full`, with every migrated version-2 entry defaulting to protected;
- read mode `off`, `all`, or `folders`;
- vault-relative readable-folder prefixes when folder mode is selected;
- a write enable switch, off by default;
- separate vault-relative writable-folder prefixes.

An unlisted vault, disabled vault, disabled read mode, disabled write toggle or empty required folder list grants no corresponding protected access. Full access applies only when the master switch and explicit full mode are both active. The bridge rechecks the current entry during prepare, commit, and every chunk so a revocation is not bypassed by an older preview.

Hidden segments, `.obsidian`, `.trash`, traversal and absolute paths are always denied. Existing note paths that cross a filesystem symlink or junction, or target a multiply-linked regular file, are rejected and physical scope is checked again around sensitive operations. Optional advanced deny prefixes take precedence over read and write grants. These checks reduce path redirection risk but remain application controls rather than an operating-system sandbox: use a disposable vault for testing and OS permissions or separate accounts for stronger isolation.

Legacy environment allowlists remain available only as a compatibility fallback when no shared-settings file is present. They are fail-closed unless an explicit read or write scope is provided. Do not mix the legacy mode with Bridge Control when auditing an installation.

### Bridge Control companion

Bridge Control is a desktop-only Obsidian community companion. It uses Obsidian's Vault API only to enumerate selectable folders and does not read or write note bodies while configuring the bridge. It reads Obsidian's global `obsidian.json` registry outside the vault through a regular-file, no-symlink and 1 MiB size boundary to bind permissions to the current stable vault ID.

Node filesystem writes are limited to the deterministic shared settings path outside the vault and the plugin's own Obsidian data. An administrator may explicitly set `OBSIDIAN_BRIDGE_SETTINGS_PATH` before Obsidian starts, but plugin data inside a vault cannot redirect that destination. The guided installer also omits the destination from `data.json`.

CLI diagnostics run only after an explicit click. Candidate discovery is limited to an explicit environment override and known installation paths, never the ambient `PATH`; the plugin invokes only `version` without a shell and accepts only recognized Obsidian version output.

Saving replaces the settings file atomically and verifies it before releasing the ownership lock. A failed privilege increase restores the prior validated policy. A failed revocation or scope reduction never restores a more permissive state: the target is reasserted once and, if it still cannot be verified, the shared file is quarantined so autonomous mode fails closed. If quarantine itself fails, the panel reports an explicitly indeterminate state and tells the user to stop Codex and Obsidian. Normal protected choices write only after the user presses **Salva accesso**. Full access requires a separate acknowledgement checkbox and explicit activation button naming the current vault, and the protected-to-full transition is checked against the latest shared state while the same lock is held; a stale panel therefore cannot undo an external revocation. Returning to protected access is immediate. The companion does not automatically steal an abandoned settings lock; after a crash it asks the user to verify no configuration process is active before removing it. The companion updates the current stable-ID entry and preserves only other schema-valid entries. A local process running as the same OS user can still modify that file, so operating-system account security remains authoritative.

The **Problemi recenti** panel reads at most the last 128 KiB of the local metadata-only audit, returns at most 20 validated records for the current stable vault ID, refuses symlinks/non-regular files, and never reads note bodies or backup content. It may check whether an audited vault-relative note currently exists and offer to open that note through Obsidian.

### Guided installer

The Windows installer is a local PowerShell/WinForms utility and does not require elevation. It discovers vaults from Obsidian's local registry or accepts an explicitly selected vault root, validates that target, installs only the fixed Bridge Control payload, and creates timestamped backups before replacing existing configuration files. Redirecting symlinks and junctions are rejected; non-redirecting OneDrive cloud placeholders remain supported for ordinary synced vaults.

Adding Bridge Control to the vault's enabled community-plugin list requires an explicit checkbox in the installer. The installer also creates a stable local marketplace copy for Codex; it does not publish the plugin or upload the vault. Treat the ZIP and any future update package as executable software and obtain them only from a source you trust.

### Dependencies and local machine

Node.js, npm dependencies, Obsidian, community plugins, the MCP host, Sync, and the operating system remain outside this repository's security boundary. Keep them updated and use the committed lockfile.

### Backup and audit directory

`OBSIDIAN_BRIDGE_DATA_DIR` controls where the writer stores plaintext backups and the metadata-only audit log. It must be an absolute trusted local path. If absent, the writer and Bridge Control use the same deterministic platform local-data location. A custom override must be inherited by Obsidian as well as Codex for the panel to inspect that location; the MCP audit reader always follows the writer configuration.

The writer requests directory mode `0700` and file mode `0600` on systems honoring POSIX permissions. Those modes do not replace Windows ACL review, disk encryption, endpoint protection, or backup policy. Anyone able to read the directory may recover prior note contents from backups.

## Known limitations

- There is no per-user authentication because both MCP servers are local child processes.
- Configuration is local to the OS account and shared by the reader, writer and Bridge Control. It is per-vault, not per-human-user authorization.
- Approval occurs in the MCP host, not in an independent Obsidian dialog.
- A malicious or compromised host with local-user privileges can access the vault without the bridge.
- Source hashing prevents ordinary stale commits but does not turn the workflow into a filesystem transaction across unrelated software.
- The official CLI offers no atomic compare-and-swap. An append can race after the source check, land on a concurrent state, and then report verification failure; automatic recovery never overwrites that unknown state.
- Literal `\n` and `\t` backslash sequences cannot be represented losslessly through the official CLI content argument and are rejected; ordinary backslashes are unchanged.
- Backups intentionally create additional plaintext copies and retention is count-based, not a guaranteed secure-erasure mechanism.
- Audit records omit note bodies but still reveal metadata such as timing, target, operation, hashes, or result state.
- Availability depends on a responsive interactive Obsidian session.
- The bridge cannot determine model-provider retention or training behavior.
- Remote transport and ChatGPT web access are not included; adding them requires authentication, authorization, revocation, audit, and a revised threat model.

## Preview-release hardening checklist

1. Use a disposable vault with synthetic notes.
2. In Bridge Control, set a narrow read folder and leave writing off until read-only verification succeeds.
3. Keep sensitive and hidden paths explicitly denied.
4. Verify the reader process exposes exactly nine read tools and no mutating tool.
5. Verify the writer process exposes only prepare and commit and uses prompt approval.
6. Enable writing only for `Bridge Test` and confirm preparation alone leaves the vault unchanged.
7. Inspect every preview before confirming it.
8. Disable the write toggle after prepare and verify that commit is rejected; then test expiry, one-use behavior, source conflicts, and paths outside write scope.
9. Corrupt a copy of the shared settings in a synthetic environment and verify access fails closed rather than inheriting a broader scope.
10. Set a disposable `OBSIDIAN_BRIDGE_DATA_DIR`; inspect backup permissions, retention, and content-free audit records.
11. Keep an independent vault backup.
12. Keep `OBSIDIAN_CLI_PATH` unset when the trusted official CLI is already on PATH; enable only the official CLI from Obsidian's settings when diagnostics require it.

## Non-security issues

Use the normal issue tracker for reproducible crashes, incorrect results, documentation errors, and feature requests that do not expose confidential information.
