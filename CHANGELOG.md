# Changelog

## 0.5.2 - 2026-07-12

- Fix false `CHANGE_CONFLICT` failures during managed replacement, literal replacement, frontmatter, move, and trash commits when the source note does not end with a newline.
- Derive the managed compare-and-swap source hash from a bounded exact UTF-8 snapshot instead of CLI-normalized read output, preserving terminal-newline, LF/CRLF, and BOM distinctions.
- Keep real concurrent-change detection fail-closed by requiring Bridge Control's exact in-Obsidian source content to match the prepared snapshot before any mutation.
- Preserve the version-4 shared settings schema, management request protocol, granular permissions, recovery backups, audit format, and public Obsidian API mutation surface.
- Add regression coverage for no-final-newline notes, LF, CRLF, BOM, and genuine concurrent changes. This patch adds no direct note-write path or new permission.

## 0.5.1 - 2026-07-12

- Preserve the bounded failure stage and safe cause code when a create or append attempt previously collapsed to the generic `write_failed` result.
- Return the same metadata-only diagnostics through `obsidian_recent_write_events` and Bridge Control's Recent problems view without exposing exception messages, CLI output, note text, proposed content, or backup bodies.
- Keep existing rollback evidence intact so `unchanged`, restored, conflicted, or unverified outcomes can be distinguished after rereading the affected note.
- Treat diagnostic metadata only as evidence: it never grants permission, authorizes a retry, or replaces the required state reread and explicit human direction after a failed autonomous or managed change.
- Preserve all 0.5.0 permission profiles, settings schema, management grants, backup limits, and mutation surfaces.

## 0.5.0 - 2026-07-12

- Rename the previous user-facing **Full access** profile to **Autonomous access** while preserving its stable `accessMode=full` value and its vault-wide read/create/append behavior.
- Add a separate, explicitly activated **Full management** profile (`accessMode=management`) with independent edit, move, and trash grants. Migrations from version-2 or version-3 settings never infer these permissions.
- Add a dedicated auto-approved management MCP process exposing only `obsidian_prepare_managed_change` and `obsidian_commit_managed_change`.
- Support exact whole-note replacement, counted literal `replace_text`, frontmatter set/remove, move/rename, and move to Obsidian trash. Permanent deletion remains unavailable.
- Register the fixed `bridge-control:commit` CLI handler in Bridge Control; use `Vault.process` plus public YAML helpers and an in-transform before-hash CAS for content/frontmatter, `Vault.rename` for isolated move/rename without backlink rewriting, and FileManager only for trash. Do not expose shell, `eval`, arbitrary commands, command palette, or plugin management.
- Pass bounded, expiring, single-use, token-bound management requests through the private bridge data directory and recheck vault identity, physical scope, granular permission, source hash, destination state, and expiry before mutation.
- Create a plaintext version-2 recovery backup before every managed operation, verify each postcondition, attempt only conflict-aware bounded recovery, and retain manual recovery evidence when an automatic reversal is unsafe or impossible.
- Extend metadata-only audit diagnostics and **Problemi recenti** to replacement, frontmatter, move/rename, and trash outcomes, including an optional destination path without exposing note or backup bodies.
- Share filesystem-backed locks across all mutating processes and lock both source and destination for move/rename.
- Add strict version-4 shared settings, exact permission-snapshot activation, fail-closed revocation, management circuit breaking, protocol validation, handler tests, migration tests, and bilingual installation/release documentation.

## 0.4.1 - 2026-07-12

- Fix the Bridge Control rerender crash that appeared immediately after successfully enabling Full access.
- Pass each CSS class as a valid individual DOM token and add a regression test for multi-token `addClass` calls.
- Keep a verified activation successful when only the post-save UI refresh fails, and report the rendering problem separately.
- Preserve the already verified version-3 Full-access policy; this patch changes no vault permissions or note data.

## 0.4.0 - 2026-07-12

- Add a prominent per-vault **Accesso completo** mode with one explicit acknowledgement and immediate return to protected access.
- Keep the prompt-approved protected writer and add a distinct auto-approved autonomous writer that refuses every vault without a current full-access panel grant.
- Preserve the two-step, expiring, single-use preview/commit protocol in both channels; full access reviews the preview internally instead of asking a routine confirmation.
- Migrate strict version-2 shared settings to version 3 as protected access only, while preserving existing folder choices for later restoration.
- Allow full access to read/create/append eligible Markdown notes at the vault root and in non-hidden folders while continuing to deny hidden paths, `.obsidian`, `.trash`, redirected paths, delete, rename, move, arbitrary overwrite, shell, plugin management, and `eval`.
- Add a filesystem-backed SHA-256-keyed commit lock shared by protected and autonomous MCP processes, with bounded wait, abort, ownership verification, and conservative stale recovery.
- Pause an autonomous writer process after three consecutive failures in one task.
- Add **Problemi recenti** to Bridge Control: a bounded, read-only audit-tail view that classifies recovery, checks whether the target note exists, and never reads note or backup bodies.
- Add `obsidian_recent_write_events` to the read server so Codex can inspect at most 20 currently permitted metadata-only audit outcomes before autonomous work and after an error, without asking for screenshots.
- Authorize protected-to-full transitions under the shared-settings lock and verify the written policy before release. Failed increases restore the previous policy; failed revocations reassert the narrower target or quarantine the shared file instead of restoring full access.
- Retain failed diagnostics independently from later successes, serialize companion data updates, and use one deterministic default audit directory across Codex and Obsidian.
- Record authorization mode and structured rollback metadata in write audit events.
- Retain the 0.3.4 Unicode-safe CLI chunking and 3072-byte full-frame cap that prevents the Obsidian 1.12.7 Windows JSON crash.

## 0.3.4 - 2026-07-12

- Cap every complete Obsidian CLI IPC request at 3072 UTF-8 bytes to avoid the Windows main-process JSON framing crash observed with long `content=` arguments.
- Split long create and append content on Unicode code-point boundaries, verify every intermediate hash, and recheck vault permission, identity, and physical scope before every bounded mutation.
- Keep the public 8192-byte proposed-content limit while refusing any request whose non-content metadata leaves no safe IPC payload capacity.
- Recognize exact intermediate bridge-written states during recovery without overwriting an unknown concurrent edit.
- Keep rollback to one safe overwrite; partial creates are reported for manual review because delete remains unavailable.
- Serialize incoming and outgoing link CLI calls within one request to reduce concurrent pressure on Obsidian's local IPC channel.

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
