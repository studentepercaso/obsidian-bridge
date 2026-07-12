OBSIDIAN BRIDGE 0.4.0 - READ THIS FIRST

1. Extract the complete ZIP to a normal folder.
2. Double-click INSTALLA-OBSIDIAN-BRIDGE.cmd.
3. Select an Obsidian vault and complete the guided installation.
4. Open Obsidian > Settings > Community plugins > Bridge Control.
5. Keep protected access and choose folders, or explicitly enable full access.

The user interface of the 0.4.0 installer and Bridge Control panel is currently
in Italian. No administrator rights or OpenAI API key are required.

New vaults start with protected mode and no note access. Folder-scoped writing
requires a preview and separate confirmation. Full access requires one explicit
per-vault acknowledgement and then permits autonomous create and append while
keeping path, hash, backup, lock, audit, and non-destructive-operation controls.
The installer never enables full access automatically. Updating preserves an
existing protected/full choice and the IDs of recent errors already reviewed.

Access modes in Bridge Control:
- Protected access (recommended): only the selected read/write folders are in
  scope. Every create or append requires an exact preview and a separate user
  confirmation.
- Full access (opt-in): after a dedicated warning and acknowledgement for that
  vault, the bridge may read visible notes and autonomously create or append.
  Delete, rename, move, shell access, arbitrary overwrite, hidden paths, and
  redirects outside the vault remain unavailable. Returning to protected access
  is immediate and restores the saved per-folder choices.

The Recent problems section reads only bounded local audit metadata, never note
contents. It explains whether a failed write was stopped before applying,
restored automatically, or needs manual review; it can open an existing affected
note and remember up to 100 problems marked as reviewed. Check this section
before retrying a failed change.

Shared settings use strict schema version 3 and a stable 16-character vault ID
from Obsidian's vault registry. A valid schema-v2 configuration is migrated to
version 3 in protected mode; migration never grants full access. Malformed or
unknown data is rejected without overwriting it.

If diagnostics cannot find the official Obsidian CLI, enable it in:
Obsidian > Settings > General > Command line interface.

Requirements:
- Windows 10 or 11 for this guided installer
- Obsidian desktop 1.12.7 or newer
- Node.js 20 or newer
- Codex/ChatGPT desktop with local plugin support

Start with a disposable vault or a synthetic test folder and keep an independent
backup. This is an independent public preview, not an official Obsidian or
OpenAI product.

Project and documentation:
https://github.com/studentepercaso/obsidian-bridge
