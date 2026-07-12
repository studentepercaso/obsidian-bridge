OBSIDIAN BRIDGE 0.5.2 - READ THIS FIRST

1. Extract the complete ZIP to a normal folder.
2. Double-click INSTALLA-OBSIDIAN-BRIDGE.cmd.
3. Select an Obsidian vault and complete the guided installation.
4. Open Obsidian > Settings > Community plugins > Bridge Control.
5. Keep protected access, enable autonomous access, or explicitly choose the
   individual permissions offered by Full management.

The user interface of the 0.5.2 installer and Bridge Control panel is currently
in Italian. No administrator rights or OpenAI API key are required.

New vaults start with protected mode and no note access. Folder-scoped writing
requires a preview and separate confirmation. Autonomous access permits create
and append after one acknowledgement. Full management separately grants edit,
move, and Obsidian-trash operations, with previews, hashes, one-time requests,
backups, verification, and audit. The installer never enables either elevated
mode automatically. Updating preserves valid choices and reviewed error IDs.

Access modes in Bridge Control:
- Protected access (recommended): only the selected read/write folders are in
  scope. Every create or append requires an exact preview and a separate user
  confirmation.
- Autonomous access (opt-in): after a dedicated warning, the bridge may read
  visible notes and autonomously create or append, but cannot edit in place,
  rename, move, or trash.
- Full management (opt-in, elevated risk): separately grants note/frontmatter
  editing, rename/move, and Obsidian trash. Permanent deletion, shell access,
  eval, arbitrary commands, hidden paths, and redirects outside the vault are
  unavailable. Returning to a lower mode takes effect immediately.

The Recent problems section reads only bounded local audit metadata, never note
contents. Version 0.5.2 can show a bounded failure stage and safe cause code,
but never raw exception messages, CLI output, proposed content, or backup bodies.
It explains whether a failed write was stopped before applying, restored
automatically, or needs manual review; it can open an existing affected note and
remember up to 100 problems marked as reviewed. For managed operations, version
0.5.2 derives the conflict hash from an exact UTF-8 snapshot and avoids false
CHANGE_CONFLICT results when a note has no final newline. Diagnostics are evidence only:
check the current note and wait for explicit human direction before retrying.

Shared settings use strict schema version 4 and a stable 16-character vault ID
from Obsidian's vault registry. Valid schema-v2/v3 configurations migrate
fail-closed: an old autonomous grant may remain autonomous, but migration never
invents edit, move, or trash permission. Malformed data is not overwritten.

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
