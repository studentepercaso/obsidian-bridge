# Obsidian Bridge

[English](README.md) · [Italiano](README.it.md)

[![CI](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml/badge.svg)](https://github.com/studentepercaso/obsidian-bridge/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/studentepercaso/obsidian-bridge?display_name=tag)](https://github.com/studentepercaso/obsidian-bridge/releases/latest)
[![License: MIT](https://img.shields.io/badge/license-MIT-green.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/installer-Windows-0078D4.svg)](#requirements)

Obsidian Bridge connects Codex and compatible ChatGPT desktop plugin hosts to local Obsidian vaults. It can search and read notes and, only when you enable it, create a note or append text. Vault and folder permissions are managed from the **Bridge Control** panel inside Obsidian.

> [!WARNING]
> This is an independent public preview, not an official Obsidian or OpenAI product. Start with a disposable vault or test folder and keep an independent backup.

> [!IMPORTANT]
> Content returned by the bridge reaches the MCP host and may be sent to the model answering your request. The bridge itself has no network client, telemetry, account system, or remote index. Read [PRIVACY.md](PRIVACY.md) before authorizing sensitive notes.

## What it provides

- A guided Windows installer with vault discovery and no administrator privileges.
- A visual Obsidian settings panel for separate read and write folder selection.
- Eight bounded, non-mutating read tools for search, excerpts, outlines, links, tags, backlinks, and recent notes.
- A separate writer process limited to **create** and **append**.
- A two-step write protocol: preview first, then an explicit confirmation and commit.
- Default-deny access, per-vault settings, hidden-folder rejection, path containment, timeouts, and output limits.
- Local recovery backups for append and content-free write audit metadata.

## Quick start on Windows

1. Download **Obsidian-Bridge-Setup-0.3.3.zip** from the [latest release](https://github.com/studentepercaso/obsidian-bridge/releases/latest).
2. Extract the ZIP completely. Do not run the installer from inside the archive preview.
3. Double-click **INSTALLA-OBSIDIAN-BRIDGE.cmd**.
4. Select a vault and complete the guided installation.
5. In Obsidian, open **Settings → Community plugins → Bridge Control**.
6. Select **Choose folders**, enable **Read** and optionally **Write**, then save access.
7. Start a new Codex task and test a synthetic note.

The installer keeps new vaults deny-by-default and preserves existing Bridge Control permissions during an update. The full walkthrough is in [docs/INSTALLATION.en.md](docs/INSTALLATION.en.md).

Use the asset whose name starts with **Obsidian-Bridge-Setup**. GitHub's automatically generated **Source code** archives are development snapshots, not the guided installer. SHA-256 values are published beside every release in **SHA256-0.3.3.txt**.

The 0.3.3 installer and Bridge Control interface are currently in Italian; the English guide maps each step.

If diagnostics report that the Obsidian CLI is unavailable, enable it under **Obsidian → Settings → General → Command line interface**. The bridge uses the official local CLI and does not emulate vault access through an HTTP service.

## Install through the Codex marketplace

Advanced users can add this public repository as a Codex marketplace:

```powershell
codex plugin marketplace add studentepercaso/obsidian-bridge --ref 0.3.3
codex plugin add obsidian-bridge@obsidian-bridge-community
```

The marketplace installs the Codex plugin component. The release installer remains the recommended route because it also installs **Bridge Control** in the selected vault and creates the shared local configuration.

## Permission and write model

Reading can be disabled, limited to selected folders, or extended to the eligible vault. Writing has a separate switch and separate folder list and is disabled by default.

Every write uses two calls:

1. **Prepare** validates the vault, path, permission, source state, and proposed content. It returns a bounded preview without changing the note.
2. **Commit** accepts only that unexpired, single-use preview after explicit confirmation and rechecks permissions and source state.

The writer cannot delete, rename, move, overwrite arbitrary files, execute shell commands, manage plugins, or invoke arbitrary Obsidian commands. Read and write tools run in separate MCP processes with different approval policies.

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

Version 0.3.3 is a public community preview distributed from GitHub. The **Bridge Control** companion is also published in its own review-ready repository for submission to the official Obsidian Community Plugins directory. The local stdio MCP architecture is not the same as a hosted MCP endpoint and is not currently submitted to the universal OpenAI Plugins Directory.

Obsidian is a trademark of Dynalist Inc. ChatGPT, Codex, and OpenAI are trademarks of OpenAI. This independent project is not affiliated with or endorsed by either company.
