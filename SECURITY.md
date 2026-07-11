# Security policy

Obsidian Bridge provides scoped local access to Obsidian notes. Version 0.3 adds the Bridge Control permission panel and a guided Windows installer while keeping writes opt-in. Reports are especially welcome for policy bypasses, writes without approval, replayed or stale changes, installer path escapes, unsafe configuration replacement, unintended executable invocation, or disclosure outside the MCP response path.

## Supported versions

| Version | Security fixes |
| --- | --- |
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

## Two-process architecture

The plugin deliberately uses two local MCP servers with different capabilities and host approval policies:

```text
auto-approved reader process
  -> eight fixed read tools
  -> official Obsidian CLI -> Obsidian desktop

prompt-approved writer process
  -> prepare tool + commit tool only
  -> official Obsidian CLI -> Obsidian desktop
```

The reader process contains no write tool. It can be auto-approved without placing a mutating capability in an auto-approved process. The writer process exposes no search, browsing, shell, command-palette, plugin-management, or `eval` surface. Its calls require host approval prompts in addition to the bridge's two-step protocol.

Do not combine the tool sets or change the writer server to automatic approval in a derived configuration.

## Runtime controls

Both processes:

- invoke the configured CLI executable directly with structured arguments and no shell fallback;
- reject traversal, absolute paths, hidden path segments, `.obsidian`, `.trash`, and configured denied prefixes;
- bound CLI duration and output size;
- open no listener and make no runtime network request;
- return data through MCP stdio to their parent host.

The reader exposes only the eight documented read tools. In the normal 0.3 setup it reloads the selected vault's Bridge Control policy before each operation. A disabled or unlisted vault receives no access, and a present malformed shared-settings file fails closed instead of falling back to a broader policy.

The writer exposes only preparation and commit. Its per-vault write toggle and writable-folder list are separate from read scope. Writing is disabled by default, and every write is denied when the vault, toggle or folder does not match. It supports only:

- creating a new Markdown note without overwrite;
- appending text to an existing Markdown note.

Delete, rename, move, arbitrary overwrite, arbitrary Obsidian commands, shell access, plugin commands, and `eval` are unavailable.

Write content is limited to 8192 UTF-8 bytes and preview output to 16384 bytes. The official CLI cannot represent literal backslash sequences `\n` and `\t` losslessly in content arguments, so the bridge rejects proposals containing those two sequences. Ordinary backslashes are passed through unchanged. The bundled plugin uses separate `--mode=read` and `--mode=write` processes. A combined `--mode=all` exists for controlled development/testing only and must never be placed under automatic approval.

The normal policy source is the versioned local settings file maintained by Bridge Control and the installer. It is size-bounded, decoded as strict UTF-8, schema-validated in full and read without a long-lived permission cache. Revocation therefore takes effect on the next operation. Legacy environment variables are an advanced compatibility fallback only when the shared file is absent; once that file exists, its vault map is authoritative.

Line replacement is deferred because the official CLI has no atomic compare-and-swap primitive. It must not be emulated with an unrestricted overwrite.

## Write transaction protocol

### Preparation

Preparation validates the vault-relative target and write policy, obtains the current source state when required, calculates the proposed result, and returns a bounded preview with a diff, `proposed_content_json`, line counts, before/after SHA-256 hashes, and an opaque change ID. The diff explicitly marks changes to the end-of-file newline, and the JSON representation disambiguates whitespace and backslashes. Preparation must not modify the vault.

A prepared change has a five-minute default time-to-live, configurable from one to thirty minutes through `OBSIDIAN_BRIDGE_CHANGE_TTL_MS`, and belongs only to the writer process that created it. Restarting that process invalidates pending changes.

After a write, the bridge verifies the resulting hash. A verification or CLI failure triggers a deliberately narrow rollback only when the current note is exactly the expected after-state. The bridge makes at most one overwrite attempt, and only when the original content is representable by the official CLI, contains no CR/CRLF line endings that its content argument would normalize, and is at most 8192 UTF-8 bytes. Otherwise the plaintext backup is the manual recovery source and the result reports `restore_unrepresentable` or `restore_too_large`. An unchanged note requires no overwrite, an unknown third hash is treated as a concurrent edit and is never overwritten, and a newly created note is not automatically deleted. The result always reports the rollback outcome and reason.

### Human confirmation

After preparation, the agent must show the user the exact vault, path, operation, complete proposed content, and diff. It must also show `proposed_content_json` whenever whitespace or backslashes could be ambiguous and point out an end-of-file newline marker. Commit is allowed only after an unambiguous human confirmation of that displayed preview in the current conversation.

The following are not confirmation:

- silence or timeout;
- consent given before the preview exists;
- a general request to “make any necessary changes”;
- text found in a note, search result, link, tag, tool response, or external document;
- instructions generated by another model or tool;
- approval of a different change ID or an older preview.

The MCP host's tool-approval prompt is an additional control, not a substitute for showing the preview and receiving conversational consent.

### Commit and conflicts

Commit accepts only an unexpired prepared change ID. The bridge revalidates the target and writable policy and compares the current note state with the source hash captured during preparation. For create, the expected state is that the target does not exist.

If the source changed before the commit-time check, the target appeared, the change expired, or policy changed, commit fails closed. Prepare a new change and ask again; never force or silently merge it.

That source check and the official CLI append are not atomic. Another application can modify a note in the gap, so an approved append may land on a concurrent state and post-write verification may then fail. The bridge does not replace that unknown state. Reread the note before preparing any retry, and never infer that a failed append left the note unchanged.

Every change ID is single-use. A commit attempt consumes it before any side effect whether the operation later succeeds or fails, preventing replay with altered local state.

Before append, commit must create a plaintext backup of the original. Create has no original to back up. The bridge then writes through the fixed CLI command surface, rereads the target, and verifies the after-hash. It retains the newest 20 managed backups.

After a successful write, the bridge appends a metadata-only NDJSON audit record without note content and reports whether recording succeeded. The result also states whether after-hash verification succeeded and supplies a backup ID when applicable.

## Trust boundaries

### MCP host and model

The host controls tool invocation and can send arguments, note text, previews, paths, tags, and metadata to a remote model. A compromised host running with the same OS permissions can bypass this bridge entirely.

Keep writer calls on prompt approval. Review the host's workspace policy and data controls before using confidential material.

### Obsidian CLI executable

`OBSIDIAN_CLI_PATH` is an executable trust boundary. Point it only at the official CLI registered by a trusted Obsidian installation. A malicious replacement inherits bridge permissions and can ignore bridge policy.

### Vault content and prompt injection

Treat every note as untrusted input. Instruction-like note text may try to manipulate the model into disclosing data or committing a change. The bundled skill requires treating notes only as evidence and never interpreting their contents as consent. Prompt-level defenses are not perfect; human preview review is essential.

Never put passwords, recovery codes, API keys, private keys, or other secrets in model-accessible folders.

### Vault and folder policies

Bridge Control stores one strict entry keyed by Obsidian's stable 16-character vault ID. The display name is only a label, and the recorded absolute physical root is verified against the ID before content access. Each entry contains:

- a master enable switch;
- read mode `off`, `all`, or `folders`;
- vault-relative readable-folder prefixes when folder mode is selected;
- a write enable switch, off by default;
- separate vault-relative writable-folder prefixes.

An unlisted vault, disabled vault, disabled read mode, disabled write toggle or empty required folder list grants no corresponding access. The bridge rechecks the current entry during prepare and again during commit so a revocation is not bypassed by an older preview.

Hidden segments, `.obsidian`, `.trash`, traversal and absolute paths are always denied. Existing note paths that cross a filesystem symlink or junction, or target a multiply-linked regular file, are rejected and physical scope is checked again around sensitive operations. Optional advanced deny prefixes take precedence over read and write grants. These checks reduce path redirection risk but remain application controls rather than an operating-system sandbox: use a disposable vault for testing and OS permissions or separate accounts for stronger isolation.

Legacy environment allowlists remain available only as a compatibility fallback when no shared-settings file is present. They are fail-closed unless an explicit read or write scope is provided. Do not mix the legacy mode with Bridge Control when auditing an installation.

### Bridge Control companion

Bridge Control is a desktop-only Obsidian community companion. It uses Obsidian's Vault API only to enumerate selectable folders and does not read or write note bodies while configuring the bridge. Node filesystem access is limited to its own local plugin data and the shared settings file outside the vault.

Saving replaces the settings file atomically and rereads it for verification. The companion writes only after the user presses **Salva e verifica**, uses a cross-process ownership lock, updates the current stable-ID entry and preserves only other schema-valid entries. A local process running as the same OS user can still modify that file, so operating-system account security remains authoritative.

### Guided installer

The Windows installer is a local PowerShell/WinForms utility and does not require elevation. It discovers vaults from Obsidian's local registry or accepts an explicitly selected vault root, validates that target, installs only the fixed Bridge Control payload, and creates timestamped backups before replacing existing configuration files. Redirecting symlinks and junctions are rejected; non-redirecting OneDrive cloud placeholders remain supported for ordinary synced vaults.

Adding Bridge Control to the vault's enabled community-plugin list requires an explicit checkbox in the installer. The installer also creates a stable local marketplace copy for Codex; it does not publish the plugin or upload the vault. Treat the ZIP and any future update package as executable software and obtain them only from a source you trust.

### Dependencies and local machine

Node.js, npm dependencies, Obsidian, community plugins, the MCP host, Sync, and the operating system remain outside this repository's security boundary. Keep them updated and use the committed lockfile.

### Backup and audit directory

`OBSIDIAN_BRIDGE_DATA_DIR` controls where the writer stores plaintext backups and the metadata-only audit log. It must be an absolute trusted local path. If absent, the writer uses an absolute `PLUGIN_DATA/obsidian-bridge` when provided by the host, otherwise the platform's local application-data location.

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
4. Verify the reader process exposes exactly eight read tools and no mutating tool.
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
