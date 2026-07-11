# Changelog

## 0.3.3 - 2026-07-11

- Publish the standalone, bilingual [Bridge Control](https://github.com/studentepercaso/bridge-control) repository and release assets for Obsidian Community Plugins review.
- Stop accepting a shared-settings destination from vault plugin data, and stop persisting that destination from both the companion and guided installer.
- Read Obsidian's global vault registry through a regular-file, no-symlink and fixed 1 MiB boundary before parsing.
- Run companion CLI diagnostics only after an explicit click, remove ambient `PATH` discovery, and require recognized Obsidian version output.
- Replace inline folder indentation styles with scoped CSS classes.
- Add 17 companion tests and CI protection against stale generated server or companion bundles.
- Keep all existing permissions, default-deny behavior and two-step write confirmation unchanged during update.

## 0.3.2 - 2026-07-11

- Publish the community preview with a Git-backed Codex marketplace, bilingual GitHub documentation, CI, issue templates, support information and reproducible release packaging.
- Wait for the Obsidian CLI process to close after timeout, abort or output-limit termination before reporting failure, preventing recovery work from racing the terminated process.
- Remove vault-specific examples from source, tests and release assets; expand ignore rules for local settings, credentials, backups and audits.
- Add publisher/repository metadata and third-party notices for the bundled runtime.
- Remove the confusing manual read/write folder fields from the Windows installer; folder permissions are now configured only through the visual picker in Obsidian.
- Fix the blocked installation path where enabling write with an empty folder contradicted the instruction to configure folders later.
- Preserve existing per-vault permissions during reinstall while keeping new vaults deny-by-default.
- Shorten the consent step and make the installer button depend only on a selected vault, Node.js readiness and explicit installation consent.

## 0.3.1 - 2026-07-11

- Add a searchable visual folder picker to Bridge Control, with separate **Read** and **Write** checkboxes for every existing vault folder.
- Make write selection automatically include the read permission required for preview and verification, and collapse redundant child scopes under selected parents.
- Move the normal flow to **Choose folders → Apply selection → Save access**, keep manual paths under advanced options, and keep the save action visible near the top.
- Remove `Bridge Test` as the companion's fallback and move shared-file details and CLI diagnostics out of the main path.
- Improve status labels for themes where plugin styles are delayed or unavailable.
- Detect Obsidian's "CLI not enabled" success-exit message as an actual error in the server, companion diagnostic and doctor.
- Treat one-line `Error: ...` responses from the official CLI as failures even when the CLI exits 0, so missing notes are not mistaken for existing content.
- Accept normal OneDrive Files On-Demand placeholders when reading installer JSON while continuing to reject symlinks and junctions.
- Isolate integration tests from a real locally installed shared-settings file and add coverage for folder selection, hidden folders and parent scope behavior.

## 0.3.0 - 2026-07-11

- Add a guided Windows installer launched through `INSTALLA-OBSIDIAN-BRIDGE.cmd`; it discovers or browses for a vault, installs the fixed companion payload without elevation, creates timestamped configuration backups, and prepares a stable local Codex marketplace copy.
- Add the desktop-only Obsidian companion **Bridge Control** with a clear per-vault settings panel, first-run guidance, a `Bridge Test` starter scope and official CLI diagnostics.
- Replace environment-variable setup in the normal user flow with a versioned local shared-settings file managed by the installer and companion.
- Reload and validate permissions for every operation so read/write restrictions and revocations take effect without restarting the bridge.
- Make a present shared-settings file authoritative: disabled or unlisted vaults receive no access, and malformed, oversized or invalid configuration fails closed.
- Allow reading to be off, whole-vault or folder-scoped, with writing controlled by a separate switch and separate folder list.
- Keep writing disabled in the initial panel configuration and retain the two-step prepare/explicit-confirmation/commit workflow for every create or append.
- Keep legacy environment scopes only as an advanced fallback when the shared-settings file is absent; an unconfigured fallback grants no access.
- Bind GUI permissions to Obsidian's stable vault ID and verified physical root, reject ambiguous duplicate names, and refuse note paths crossing filesystem links or junctions.
- Make the companion write settings only after an explicit save, use a shared ownership lock, require one folder per line, and validate the same strict version-2 schema as the server and installer.
- Add installation, update, removal and troubleshooting documentation for the preview package. This release is not a claim of publication in an official Obsidian or OpenAI directory.

## 0.2.0 - 2026-07-11

- Add opt-in note creation and append. Line replacement remains deferred because the official CLI has no atomic compare-and-swap primitive.
- Add separate, default-deny write scope through required exact `OBSIDIAN_BRIDGE_WRITABLE_VAULTS` and vault-relative `OBSIDIAN_BRIDGE_WRITABLE_FOLDERS` allowlists.
- Split the bundled configuration into an auto-approved eight-tool reader and a prompt-approved two-tool writer.
- Require a two-step write flow: prepare a preview, obtain explicit human confirmation, then commit the prepared change.
- Reject stale or modified-source commits with content-hash conflict checks.
- Use expiring, single-use change identifiers so a prepared write cannot be replayed.
- Return both a diff and `proposed_content_json` in previews, with explicit end-of-file newline markers.
- Add mandatory plaintext recovery backups for append, 20-file retention, and metadata-only NDJSON audit records under a configurable local data directory.
- Limit automatic rollback to one overwrite when the original is CLI-representable and at most 8192 UTF-8 bytes; otherwise retain the backup for manual recovery with an explicit reason.
- Detect and report append verification failures caused by the non-atomic gap between source checking and the official CLI append, without overwriting a concurrent state.
- Reject literal `\n` and `\t` backslash sequences that the official CLI cannot represent losslessly while preserving ordinary backslashes.
- Bound proposed content to 8192 UTF-8 bytes and preview output to 16384 bytes.
- Keep delete, rename, move, arbitrary Obsidian commands, plugin commands, shell access, and `eval` unavailable.
- Update the bundled skill and documentation for safe interactive write testing.

## 0.1.0 - 2026-07-10

- Add a local read-only MCP server backed by the official Obsidian CLI.
- Add bounded tools for vault discovery, search, targeted reads, outlines, links, tags and recents.
- Add allowlist, denylist, hidden-path, traversal, timeout and output-size controls.
- Add the `use-obsidian-vault` skill, local plugin manifest and community-preview documentation.
- Add simulated CLI and MCP integration tests that do not require a real vault.
