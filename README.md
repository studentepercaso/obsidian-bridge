# Obsidian Bridge

[English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/studentepercaso/obsidian-bridge?display_name=tag)](https://github.com/studentepercaso/obsidian-bridge/releases)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/installer-Windows-0078D4.svg)](#requirements)

Obsidian Bridge connects Codex and compatible ChatGPT desktop plugin hosts to local Obsidian vaults. It can search and read notes and, only when you enable it, create a note or append text. Vault and folder permissions are managed from the **Bridge Control** panel inside Obsidian.

> [!WARNING]
> This is an independent public preview, not an official Obsidian or OpenAI product. Start with a disposable vault or test folder and keep an independent backup.

> [!IMPORTANT]
> Content returned by the bridge reaches the MCP host and may be sent to the model answering your request. The bridge itself has no network client, telemetry, account system, or remote index. Read [PRIVACY.md](PRIVACY.md) before authorizing sensitive notes.

## What it provides

- A guided Windows installer with vault discovery and no administrator privileges.
- A visual Obsidian panel with folder-scoped **Protected access** or an explicit **Full access** mode for autonomous work across the vault.
- Nine bounded, non-mutating read tools for search, excerpts, outlines, links, tags, backlinks, recent notes, and metadata-only write diagnostics.
- Separate protected and autonomous writer processes, both limited to **create** and **append**; the autonomous process is gated to vaults explicitly set to full access.
- A two-step single-use preview/commit protocol; per-change confirmation remains mandatory in protected access.
- Default-deny access, per-vault settings, hidden-folder rejection, path containment, timeouts, and output limits.
- Cross-process commit locks, local append recovery backups, content-free audit metadata, a **Recent problems** panel, and direct bounded audit diagnostics for Codex after an error.

## Quick start on Windows

1. Download **Obsidian-Bridge-Setup-0.4.1.zip** from the [releases page](https://github.com/studentepercaso/obsidian-bridge/releases).
2. Extract the ZIP completely. Do not run the installer from inside the archive preview.
3. Double-click **INSTALLA-OBSIDIAN-BRIDGE.cmd**.
4. Select a vault and complete the guided installation.
5. In Obsidian, open **Settings → Community plugins → Bridge Control**.
6. Keep **Protected access** and choose folders, or explicitly enable **Full access** once if you want autonomous read/create/append across the vault.
7. Start a new Codex task and test a synthetic note.

The installer keeps new vaults deny-by-default and preserves existing Bridge Control permissions during an update. The full walkthrough is in [docs/INSTALLATION.en.md](docs/INSTALLATION.en.md).

Use the asset whose name starts with **Obsidian-Bridge-Setup**. GitHub's automatically generated **Source code** archives are development snapshots, not the guided installer. SHA-256 values are published beside every release in **SHA256-0.4.1.txt**.

The 0.4.1 installer and Bridge Control interface are currently in Italian; the English guide maps each step.

If diagnostics report that the Obsidian CLI is unavailable, enable it under **Obsidian → Settings → General → Command line interface**. The bridge uses the official local CLI and does not emulate vault access through an HTTP service.

## Install through the Codex marketplace

Advanced users can add this public repository as a Codex marketplace:

```powershell
codex plugin marketplace add studentepercaso/obsidian-bridge --ref 0.4.1
codex plugin add obsidian-bridge@obsidian-bridge-community
```

The marketplace installs the Codex plugin component. The release installer remains the recommended route because it also installs **Bridge Control** in the selected vault and creates the shared local configuration.

## Permission and write model

Each vault has two profiles. **Protected access** uses the saved read/write folder scopes and requires confirmation for every change. **Full access**, enabled through a one-time warning and acknowledgement in Bridge Control, permits autonomous read/create/append across the eligible vault. Returning to protected access is immediate and preserves the earlier folder choices.

Every write uses two calls:

1. **Prepare** validates the vault, path, permission, source state, and proposed content. It returns a bounded preview without changing the note.
2. **Commit** accepts only that unexpired, single-use preview and rechecks permissions and source state. Protected access requires explicit confirmation; full access may commit immediately after the agent internally validates the preview in the same task.

Full access does not add destructive capabilities. The bridge still cannot delete, rename, move, overwrite arbitrary files, execute shell commands, manage plugins, or invoke arbitrary Obsidian commands. Hidden paths, `.obsidian`, `.trash`, and physical redirects outside the vault remain denied. Reading, protected writing, and autonomous writing run in distinct MCP processes with different approval policies.

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
- [Privacy](PRIVACY.md)
- [Security policy](SECURITY.md)
- [Changelog](CHANGELOG.md)
- [Contributing](CONTRIBUTING.md)
- [Support](SUPPORT.md)
- [Third-party notices](THIRD_PARTY_NOTICES.md)

## Project status

Version 0.4.1 is a public community preview distributed from GitHub. The **Bridge Control** companion is also published in its own review-ready repository for submission to the official Obsidian Community Plugins directory. The local stdio MCP architecture is not the same as a hosted MCP endpoint and is not currently submitted to the universal OpenAI Plugins Directory.

Obsidian is a trademark of Dynalist Inc. ChatGPT, Codex, and OpenAI are trademarks of OpenAI. This independent project is not affiliated with or endorsed by either company.
