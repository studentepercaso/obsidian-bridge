# Obsidian Bridge

[English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/studentepercaso/obsidian-bridge?display_name=tag)](https://github.com/studentepercaso/obsidian-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/installer-Windows-0078D4.svg)](#requirements)

Obsidian Bridge connects Codex and compatible ChatGPT desktop plugin hosts to local Obsidian vaults. It can search and read notes, create or append content, and—only after a separate explicit authorization—manage existing Markdown notes. Vault, folder, and management permissions are controlled from the **Bridge Control** panel inside Obsidian.

> [!WARNING]
> This is an independent public preview, not an official Obsidian or OpenAI product. Start with a disposable vault or test folder and keep an independent backup.

> [!IMPORTANT]
> Content returned by the bridge reaches the MCP host and may be sent to the model answering your request. The bridge itself has no network client, telemetry, account system, or remote index. Read [PRIVACY.md](PRIVACY.md) before authorizing sensitive notes.

## What it provides

- A guided Windows installer with vault discovery and no administrator privileges.
- A visual Obsidian panel with three explicit profiles: folder-scoped **Protected access**, vault-wide **Autonomous access**, and granular **Full management**.
- Nine bounded, non-mutating read tools for search, excerpts, outlines, links, tags, backlinks, recent notes, and metadata-only write diagnostics.
- Separate protected and autonomous writer processes for **create** and **append**, plus a dedicated management process for exact replacement, literal text replacement, frontmatter updates, move/rename, and move to Obsidian trash.
- A two-step single-use preview/commit protocol; per-change confirmation remains mandatory in protected access.
- Default-deny access, per-vault settings, hidden-folder rejection, path containment, timeouts, and output limits.
- Separate **edit**, **move**, and **trash** grants in Full management; none is inferred during an update or from a note, prompt, or environment variable.
- Cross-process commit locks, at most 20 shared local plaintext recovery backups, postcondition verification, content-free audit metadata, a **Recent problems** panel, and direct bounded audit diagnostics for Codex after an error. Version 0.5.4 retains settings-backed exact UTF-8 snapshots for every create/append and managed transactional observation, including notes without a final newline, while hardening the companion for Obsidian review.

## Quick start on Windows

1. Download **Obsidian-Bridge-Setup-0.5.4.zip** from the [releases page](https://github.com/studentepercaso/obsidian-bridge/releases).
2. Extract the ZIP completely. Do not run the installer from inside the archive preview.
3. Double-click **INSTALLA-OBSIDIAN-BRIDGE.cmd**.
4. Select a vault and complete the guided installation.
5. In Obsidian, open **Settings → Community plugins → Bridge Control**.
6. Keep **Protected access** and choose folders, enable **Autonomous access** for vault-wide read/create/append, or explicitly activate **Full management** and only the edit, move, or trash permissions you need.
7. Start a new Codex task and test a synthetic note.

The installer keeps new vaults deny-by-default and preserves existing Bridge Control permissions during an update. The full walkthrough is in [docs/INSTALLATION.en.md](docs/INSTALLATION.en.md).

Use the asset whose name starts with **Obsidian-Bridge-Setup**. GitHub's automatically generated **Source code** archives are development snapshots, not the guided installer. SHA-256 values are published beside every release in **SHA256-0.5.4.txt**.

The 0.5.4 installer and Bridge Control interface are currently in Italian; the English guide maps each step.

If diagnostics report that the Obsidian CLI is unavailable, enable it under **Obsidian → Settings → General → Command line interface**. The bridge uses the official local CLI and does not emulate vault access through an HTTP service.

## Install through the Codex marketplace

Advanced users can add this public repository as a Codex marketplace:

```powershell
codex plugin marketplace add studentepercaso/obsidian-bridge --ref 0.5.4
codex plugin add obsidian-bridge@obsidian-bridge-community
```

The marketplace installs the Codex plugin component. The release installer remains the recommended route because it also installs **Bridge Control** in the selected vault and creates the shared local configuration.

## Permission and write model

Each vault has three profiles:

- **Protected access** uses saved read/write folder scopes and requires confirmation for every create or append.
- **Autonomous access** (the profile previously called Full access) permits autonomous read/create/append across eligible non-hidden Markdown paths in the vault.
- **Full management** includes autonomous access and can separately authorize **edit**, **move**, and **trash**. Edit covers exact whole-note replacement, counted literal `replace_text`, and frontmatter set/remove. Move covers moving and renaming one file without rewriting backlinks or other notes. Trash uses Obsidian's trash flow; permanent deletion is never exposed.

Autonomous access and Full management each require an explicit in-panel activation. Full management additionally records the exact granular permissions acknowledged by the user. Returning to a narrower profile or disabling a permission takes effect on the next stage and preserves protected folder choices.

Every write uses two calls:

1. **Prepare** validates the vault, path, permission, source state, and proposed content. It returns a bounded preview without changing the note.
2. **Commit** accepts only that unexpired, single-use preview and rechecks permissions and source state. Protected access requires explicit confirmation; Autonomous access or Full management may commit create/append immediately after the agent internally validates the preview in the same task.

For Bridge Control settings-backed vaults, create/append preparation, commit CAS, backup capture, intermediate chunk checks, final verification, and recovery classification all read the same bounded exact UTF-8 representation. The read is physically confined to the authorized vault and never mutates a note directly; create/append mutations still use only the allowlisted official Obsidian CLI. The resulting appended document must remain at or below 1 MiB, and create requires its parent folder to exist, before mutation. The legacy environment-only writer fails closed for create/append because normalized CLI stdout is not an exact CAS source; migrate the vault through Bridge Control.

Create/append does not perform destructive automatic CLI rollback after a post-mutation failure. It preserves the exact backup and metadata-only audit evidence, leaves the observed note state untouched, and reports `manual_recovery_required=true`; a partial create remains `delete_disabled`. Inspect the current note and obtain explicit user direction. Atomic automatic restoration would require a future Bridge Control transaction.

Full-management changes use their own prepare/commit pair. Prepare returns a bounded exact preview without changing the vault and derives the conflict hash from an exact UTF-8 snapshot rather than CLI-normalized read output. Commit consumes that unexpired, single-use preview, rechecks the matching granular permission and source hash under cross-process locks, creates a plaintext recovery backup, invokes only Bridge Control's fixed `bridge-control:commit` handler, and verifies the postcondition. Rename is represented by the `move` operation with a new destination path.

The handler runs inside Obsidian. Replacement and frontmatter use `Vault.process` with a compare-and-swap check on the prepared source hash; frontmatter is parsed and serialized with Obsidian's public YAML helpers. Move/rename uses `Vault.rename` and deliberately changes only the selected file: it does **not** rewrite backlinks or other notes. Trash uses Obsidian's public trash API. The management channel exposes no permanent delete, arbitrary command, command palette, plugin management, shell, or `eval`. Hidden paths, `.obsidian`, `.trash`, and physical redirects outside the vault remain denied. Reader, protected writer, autonomous writer, and management tools run in distinct MCP processes with different capabilities.

Bridge Control 0.5.4 contains no `child_process` use and launches no executable. Its CLI panel only identifies a non-authoritative candidate; the external bridge performs the definitive readiness check when needed. The picker uses the vault's actual `Vault.configDir`. Companion Node filesystem access is restricted to documented external settings/lock/quarantine, read-only registry, one-time request, backup, and audit stores, never note paths; note reads and mutations inside the companion remain on public Obsidian APIs. These review-hardening changes add no permission, protocol field, or write surface.

Shared settings now use schema version 5 and carry the real `Vault.configDir` as an authoritative deny rule for every bridge mode. Version-2 through version-4 entries keep their explicit permission choices but remain deny-all until that exact vault opens and records its real configuration directory; any saved folder grant intersecting it is removed. The migration never invents authority.

## Requirements

- Windows 10 or 11 for the guided installer in this preview.
- Obsidian desktop 1.12.7 or newer.
- The official Obsidian CLI enabled when requested by diagnostics.
- Node.js 20 or newer.
- Codex/ChatGPT desktop with local plugin support, or a compatible local MCP host that supports stdio and approval for mutating tools.

Obsidian must run in an interactive desktop session. This release does not directly connect to the ChatGPT website.

## Development and verification

```powershell
npm ci
npm --prefix companion/obsidian-bridge-control ci
npm run check:all
```

Automated tests use a simulated CLI and synthetic data. A release also requires a manual smoke test with the official Obsidian CLI and a disposable vault. See [docs/SUBMISSION_TESTS.md](docs/SUBMISSION_TESTS.md).

## Documentation

- [English installation guide](docs/INSTALLATION.en.md)
- [Guida di installazione in italiano](docs/INSTALLATION.md)
- [Controlled writing protocol](docs/WRITING.md)
- [0.5.4 bilingual release notes](docs/RELEASE_NOTES_0.5.4.md)
- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Project status

Version 0.5.4 is a public community preview distributed from GitHub. The **Bridge Control** companion is also published in its own review-ready repository and listed in the official Obsidian Community Plugins directory. The local stdio MCP architecture is not the same as a hosted MCP endpoint and is not currently submitted to the universal OpenAI Plugins Directory.

Obsidian is a trademark of Dynalist Inc. ChatGPT, Codex, and OpenAI are trademarks of OpenAI. This independent project is not affiliated with or endorsed by either company.
