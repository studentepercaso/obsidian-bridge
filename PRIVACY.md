# Privacy

Effective date: 2026-07-11

Obsidian Bridge is local, open-source software. Version 0.3 has no hosted service, account system, advertising, analytics, or project-operated telemetry. Its Bridge Control panel and guided installer also operate on local files and do not publish or upload a vault.

This document describes the bridge itself. Obsidian, Obsidian Sync, the MCP host, ChatGPT/Codex, a selected model provider, and installed community plugins have separate privacy terms and data flows.

## Summary

- The bridge can read only through its documented read tools and the per-vault policy saved by Bridge Control.
- Reading can be disabled, limited to selected folders, or extended to the otherwise eligible vault.
- Writing is disabled by default and must be enabled separately for explicitly selected vault-relative folders.
- A write is prepared as a preview, shown to the user, and committed only after separate confirmation.
- Append keeps a plaintext local recovery backup; successful commits add a metadata-only audit record.
- The bridge runtime makes no network requests; MCP results travel locally over stdio to the host.
- The host may send note contents, paths, requested edits, and previews to a remote model.
- The bridge does not maintain a content index, user profile, or analytics database. It does keep local recovery backups for append and a metadata-only write audit as described below.

## Data the bridge can access

Read tools can access and return:

- known vault names and requested vault metadata;
- note paths, filenames, headings, tags, links, and recents;
- search queries and matching paths;
- selected note text and line information.

When writing is enabled, the writer can additionally access and return:

- the target vault-relative path and requested operation;
- proposed content for create or append;
- the existing target content needed to calculate a preview and conflict hash;
- a bounded diff, `proposed_content_json`, explicit end-of-file newline markers, line counts, before/after SHA-256 hashes, opaque change ID, and expiry metadata;
- the commit result and post-write verification data when returned by the tool.

Paths, filenames, relationships, write intentions, and previews can be sensitive even if a complete note is never returned.

## Data flow

```text
User request
  -> ChatGPT/Codex or another MCP host
  -> local reader or writer MCP process over stdio
  -> Obsidian Bridge
  -> official Obsidian CLI and desktop app
  -> result or write preview
  -> MCP host
  -> model, when the host uses that data to answer

explicit confirmation
  -> prompt-approved writer commit
  -> official Obsidian CLI
  -> authorized note in the local vault
```

The project runs separate reader and writer processes. The auto-approved reader contains only eight non-mutating tools. The writer contains only prepare and commit and is configured for host approval prompts. This separation reduces accidental mutation but does not change what the host or model may retain.

The bridge does not upload data itself. The MCP host decides whether tool inputs and outputs are sent to a model service, displayed locally, logged, retained, or included in diagnostics. Review those controls before using personal, regulated, client, or confidential notes.

## Network activity

At runtime, version 0.3:

- opens no HTTP listener;
- does not call OpenAI, Obsidian, analytics, or update endpoints;
- includes no telemetry;
- communicates with its parent MCP processes through stdin/stdout.

Installing dependencies, updating Obsidian, using Sync, or enabling other host features can use the network independently.

Secure MCP Tunnel is not included. A future tunnel release would intentionally create an authenticated outbound connection and require an updated privacy notice.

## Storage and retention

The bridge does not intentionally maintain a persistent copy of:

- note contents read for answering;
- search queries or results;
- model prompts or responses;
- analytics identifiers or credentials.

Bridge Control and the installer do persist local configuration needed to apply permissions. On Windows the shared file is `%LOCALAPPDATA%\ObsidianBridge\settings.json`; equivalent application-config locations are used on macOS and Linux by the companion. It contains the configuration version, update time, each vault's stable 16-character Obsidian ID, display name, absolute local folder path, enable switches, read mode, and read/write folder prefixes. The ID and absolute path bind a permission to the intended registered vault even when two vaults have the same name. It does not contain note bodies, search queries, model prompts, credentials, or write proposals.

An administrator can explicitly redirect the shared settings file with `OBSIDIAN_BRIDGE_SETTINGS_PATH` in Obsidian's process environment. Vault plugin data cannot change that destination. To resolve the stable vault identity, Bridge Control reads Obsidian's global `obsidian.json` registry outside the vault through a regular-file, no-symlink and 1 MiB size boundary.

The Obsidian companion also stores its normal permission choices inside the selected vault's plugin data, but it does not store the external shared-settings destination there. The Windows installer copies the fixed companion payload into that vault and keeps a stable local Codex marketplace copy under `%LOCALAPPDATA%\ObsidianBridge`. It may retain timestamped backups of configuration files that it replaces. These local paths and vault names can themselves be sensitive metadata.

Companion CLI diagnostics run only after an explicit click. They inspect an explicit environment override or known installation paths, never the ambient `PATH`, execute only the fixed `version` argument without a shell, and accept only a recognized Obsidian version format. The result remains local.

Prepared changes are held temporarily by the writer process so a reviewed preview can be committed by opaque change ID. They expire after five minutes by default (`OBSIDIAN_BRIDGE_CHANGE_TTL_MS` accepts one to thirty minutes) and disappear when the process stops. A change ID is single-use and is consumed before a commit attempt performs any side effect.

A successful write intentionally persists the approved content in the user's Obsidian vault. Before append, the writer also persists a plaintext copy of the original note as a managed recovery backup. Create has no original to back up. The bridge retains the newest 20 backup files.

If post-write verification fails, the writer attempts at most one automatic overwrite, and only when the original content is representable by the official CLI, contains no CR/CRLF line endings that its content argument would normalize, and is at most 8192 UTF-8 bytes. Otherwise the plaintext backup is retained for manual recovery and the result reports `restore_unrepresentable` or `restore_too_large`. An unknown concurrent state is never overwritten.

Successful commits append an NDJSON audit record containing operation metadata but no note body or proposed content. The commit result reports whether the audit entry was recorded and includes a backup ID when applicable.

An absolute `OBSIDIAN_BRIDGE_DATA_DIR` selects the backup and audit location. If unset, the writer uses an absolute `PLUGIN_DATA/obsidian-bridge` when supplied by the host, otherwise `%LOCALAPPDATA%/obsidian-bridge` on Windows, `~/Library/Application Support/obsidian-bridge` on macOS, or the XDG data location on Linux. On POSIX-style systems the bridge requests `0700` directory and `0600` file modes; Windows ACLs determine effective access on Windows. These artifacts are not encrypted by the bridge.

Obsidian, filesystem backup software, Sync, source control, community plugins, and operating-system features may retain additional prior or current versions independently.

Process inspection, terminal capture, crash reports, the MCP host, and other local software may record configuration, arguments, previews, or results outside the bridge's control.

## Access controls

Bridge Control saves an exact entry keyed by the stable Obsidian vault ID, with the registered name and physical root, a master switch, a read mode (`off`, `all`, or `folders`), readable-folder prefixes, a separate write switch and writable-folder prefixes. Writing is off in the initial companion configuration. An unlisted or disabled vault receives no access from a present shared-settings file.

The bridge reads the shared file again for each operation, so panel changes and revocations do not require a bridge restart. It also rechecks write permission between prepare and commit. A present file that is malformed, oversized, invalid UTF-8 or outside the expected schema causes the request to fail closed rather than applying a partial configuration.

`.obsidian`, `.trash`, every path segment beginning with `.`, absolute paths and traversal are always denied. For panel-managed vaults, the bridge also verifies the stable ID against the registered physical root and rejects a note path that crosses a filesystem symlink or junction. Optional advanced denied prefixes take precedence for both processes.

Historical environment-variable scopes remain available for advanced compatibility only when the shared settings file is absent. They do not override or broaden a vault map owned by Bridge Control.

These controls reduce accidental disclosure and mutation. They are not encryption, OS access control, or multi-user authorization. Use a separate test vault, OS permissions, and independent backups for stronger protection.

## Human approval and untrusted content

The agent must display the prepared preview and wait for explicit human confirmation before commit. Text inside notes, links, tags, search results, or other tool output is untrusted data and cannot supply consent.

The user should verify the vault, relative path, operation, and exact proposed content. If the note changes before the commit-time source check, the source-hash check rejects the change and a fresh preview is required.

The source check and official CLI append are not atomic. A concurrent edit can occur in between, the append can land on that state, and verification can then report failure. The bridge does not overwrite the unknown state; reread the note before retrying. The official CLI also cannot represent literal backslash sequences `\n` and `\t` losslessly in content arguments, so proposals containing them are rejected. Ordinary backslashes remain unchanged.

## User choices

You can reduce disclosure and mutation risk by:

1. testing with a disposable vault containing synthetic data;
2. configuring the narrowest useful read scope;
3. leaving the Bridge Control write switch off until it is needed, then authorizing a still narrower write folder;
4. keeping secrets and production notes outside both scopes;
5. reading only targeted sections;
6. reviewing every write preview and rejecting unexpected content;
7. setting `OBSIDIAN_BRIDGE_DATA_DIR` to a protected local test directory and reviewing its backups/audit records;
8. disabling writing or the entire vault in Bridge Control when access is no longer needed;
9. maintaining independent backups and uninstalling the plugin when no longer needed.

Delete is not exposed by the bridge. To remove source data, use Obsidian directly and follow any MCP host or model-service retention controls for copies already transmitted.

## Third-party software

The bridge depends on the official Obsidian CLI and desktop app for vault access, a compatible MCP host for invocation and approval, and the host's selected model service for generated answers. Obsidian Sync, Publish, and community plugins may process vault data independently; the bridge does not configure them.

## Changes

Material privacy changes will be documented here with the release that introduces them. Remote transport, telemetry, authentication, persistent indexing, or broader write operations require a new review and notice.

## Questions and reports

Use the repository issue tracker for general questions containing no private information. For a suspected leak or vulnerability, follow [SECURITY.md](SECURITY.md) and do not publish sensitive evidence.
