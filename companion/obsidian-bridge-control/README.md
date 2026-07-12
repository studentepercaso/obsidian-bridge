# Bridge Control

[English](README.md) · [Italiano](README.it.md)

Bridge Control is the desktop-only Obsidian companion for Obsidian Bridge. Version 0.5.4 removes all child-process execution from the companion, addresses the current Obsidian review findings, and preserves the explicit **Full management**, Protected, and Autonomous profiles without adding permissions or mutation capabilities.

## Default behavior

On first run:

- access is bound to the current vault's stable identity and local path;
- reading remains off until the user selects folders or the whole eligible vault;
- writing and every management permission are off;
- the initial profile is **Protected access**;
- no folder is preselected and no update silently increases access.

The panel includes a searchable visual folder picker, separate **Read** and **Write** checkboxes, verified access-mode controls, non-executing Obsidian CLI candidate diagnostics, and a **Recent problems** view. The picker uses the vault's actual `Vault.configDir` instead of assuming that the configuration folder is named `.obsidian`.

## Access profiles

- **Protected access** keeps reading and guarded create/append operations inside the folders selected by the user. Each protected write still requires a preview and explicit confirmation.
- **Autonomous access** allows read, create, and append across the eligible vault without per-change confirmation. It does not grant in-place replacement, frontmatter editing, rename, move, or trash.
- **Full management** is a separate, explicitly confirmed profile. The user chooses the exact capabilities to grant: **Edit notes and frontmatter**, **Rename and move**, and **Move to Obsidian trash**.

Full management applies only while the profile and the corresponding capability remain enabled. Bridge Control checks the authoritative shared settings again immediately before a mutation. Returning to Protected or Autonomous access removes all management grants.

## Managed operations

Obsidian Bridge prepares a bounded preview and a short-lived, one-time request. Bridge Control consumes that request through the public Obsidian CLI handler `bridge-control:commit`, authenticates its opaque ID and token, rechecks the vault, permission, path, expiry, and source hash, then performs the operation inside Obsidian using public APIs:

- `Vault.process()` for atomic note replacement;
- `Vault.process()` plus Obsidian's public YAML helpers for an atomic, hash-checked frontmatter change;
- `Vault.rename()` for rename/move without silently rewriting other notes or expanding the Move grant into Edit;
- `FileManager.trashFile()` for recoverable deletion.

The matching 0.5.4 bridge uses settings-backed bounded exact UTF-8 snapshots for every create/append and managed transactional observation, including prepare, CAS, backup capture, chunk/final verification, and recovery classification. The snapshot path is read-only; create/append mutation remains on the allowlisted official Obsidian CLI. Environment-only create/append requires migration to Bridge Control, the resulting appended document must remain at or below 1 MiB, and create requires an existing parent folder. Version 0.5.4 changes neither the command protocol nor managed mutation code.

Before mutation, the handler stores a local recovery backup. It verifies the result, records metadata in the shared audit log, and attempts a bounded rollback when a partially applied operation does not meet its postcondition. Requests are serialized and consumed once.

The external create/append writer does not attempt destructive automatic CLI rollback after a post-mutation failure. It keeps the exact backup and audit evidence, leaves the observed note untouched, and reports `manual_recovery_required=true`; a partial create remains `delete_disabled`. This is not an atomic rollback claim and does not change the companion handler.

There is deliberately no permanent-delete operation, JavaScript evaluation, shell access, child-process launch, arbitrary Obsidian command execution, plugin management, or direct filesystem access to note paths. Full management is not an `eval` or terminal capability.

## Shared settings

Bridge Control 0.5.4 atomically maintains strict shared-settings version 5:

- Windows: `%LOCALAPPDATA%\ObsidianBridge\settings.json`
- macOS: `~/Library/Application Support/ObsidianBridge/settings.json`
- Linux: `$XDG_CONFIG_HOME/ObsidianBridge/settings.json` or `~/.config/ObsidianBridge/settings.json`

Version-2 settings migrate to Protected access. Version-3 Full access remains Autonomous access and receives no management permission. Existing version-4 entries retain their explicit choices, but remain deny-all until that exact vault opens and Bridge Control records its real `Vault.configDir`; any saved folder scope that intersects the configuration directory is removed during migration. Version 5 rejects invalid management combinations and treats an unknown configuration directory as deny-all. Missing, malformed, stale, or unverifiable settings fail closed; the per-vault plugin cache cannot restore an elevated profile.

The shared file stores the stable vault ID, normalized local path, actual configuration directory, access mode, authorized relative folders, and the three management booleans. It does not store note bodies.

Administrators may explicitly redirect the shared settings file with the `OBSIDIAN_BRIDGE_SETTINGS_PATH` environment variable before starting Obsidian. Bridge Control never accepts that path from vault plugin data.

Paths must be normalized Markdown paths relative to the vault. Absolute paths, traversal, `.`, `..`, backslash paths, and hidden locations such as `.obsidian` and `.trash` are rejected.

## Privacy and security

- No network requests or telemetry.
- The settings panel enumerates folders but does not scan note bodies. The management handler reads only the note involved in an authenticated request.
- A short-lived replacement request can contain the proposed new note body. Its local request file is claimed once and removed before mutation; it is never sent over the network.
- Recovery backups contain the affected pre-change note body and share the deterministic local Obsidian Bridge directory's newest-20 JSON pool. They are never shown by **Recent problems** or returned by the metadata-only audit tool; keep an independent backup.
- Audit records can contain paths, operation types, hashes, outcome, backup identifiers, recovery status, and bounded `failure_stage` and `cause_code` values, but never raw exception messages, CLI output, note text, proposed content, or backup bodies.
- Node filesystem access is limited to the documented external stores: shared settings and their lock/quarantine state, the read-only size-bounded Obsidian registry, one-time management requests, recovery backups, and metadata-only audit records. Note content and note mutation use only public Obsidian APIs.
- CLI diagnostics run only after an explicit click. They inspect an environment override or known installation paths, never the ambient `PATH`, and do not launch any executable. The external bridge performs the definitive CLI readiness check when a CLI-backed operation is requested.
- The management channel accepts only `bridge-control:commit` with an exact one-time request ID and 256-bit token. It does not accept note content as a CLI argument.

## Build

```shell
npm ci
npm run check
```

For manual testing, copy `main.js`, `manifest.json`, and `styles.css` to:

```text
<vault>/.obsidian/plugins/bridge-control/
```

Then reload Obsidian and enable **Bridge Control** under Community plugins. Managed operations require Obsidian 1.12.7 or later, the official CLI enabled for the external bridge, and the matching Obsidian Bridge 0.5.4 release.

This project is independent and is not affiliated with or endorsed by Obsidian.
