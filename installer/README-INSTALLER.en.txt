OBSIDIAN BRIDGE 0.5.7 - READ THIS FIRST

1. Extract the complete ZIP to a normal folder.
2. Double-click INSTALLA-OBSIDIAN-BRIDGE.cmd.
3. Select an Obsidian vault and complete the guided installation.
4. Open Obsidian > Settings > Community plugins > Bridge Control.
5. Keep protected access, enable autonomous access, or explicitly choose the
   individual permissions offered by Full management.

The user interface of the 0.5.7 installer and Bridge Control panel is currently
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
contents. Version 0.5.7 can show a bounded failure stage and safe cause code,
but never raw exception messages, CLI output, proposed content, or backup bodies.
It explains whether a failed write was stopped before applying, restored
automatically, or needs manual review; it can open an existing affected note and
remember up to 100 problems marked as reviewed. Version 0.5.7 uses the same
settings-backed exact UTF-8 observation for create/append prepare, conflict
checks, backup capture, chunk/final verification, and recovery classification.
Mutations still use only the allowlisted official Obsidian CLI. Each create or
append proposal accepts at most 64 KiB of UTF-8 content and its complete preview
is bounded to 192 KiB. The resulting appended document remains bounded to 1 MiB.
Long content is split into complete CLI frames of at most 3072 UTF-8 bytes, and
create targets with a missing parent folder fail before mutation.
The environment-only legacy writer now requires migration to Bridge Control.

Create/append never performs a destructive automatic CLI rollback. After a
post-mutation failure it keeps the exact backup and audit evidence, leaves the
observed note untouched, and reports manual_recovery_required. A partial create
remains delete_disabled. Diagnostics are evidence only: check the current note
and wait for explicit human direction before recovery or retry.

Shared settings use strict schema version 5 and a stable 16-character vault ID.
The installer never guesses the active configuration directory from a folder's
presence: new, upgraded, and schema-v2/v3/v4 entries remain deny-all until
Bridge Control runs inside that exact vault and records authoritative Vault.configDir. Existing
choices are retained, but migration never invents edit, move, or trash
permission. Malformed data is not overwritten.

Bridge Control 0.5.7 never launches an executable. Its optional CLI scan only
reports a non-certified candidate from known allowlisted locations; the external
bridge performs the definitive readiness check. If that check fails, enable the
official CLI in Obsidian > Settings > General > Command line interface.

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

Advanced unattended installation
---------------------------------
Automation may invoke the PowerShell installer directly with all three explicit
arguments:

  powershell.exe -NoProfile -ExecutionPolicy Bypass -File `
    .\installer\Install-ObsidianBridge.ps1 -Install `
    -AcceptInstallation -VaultPath "C:\path\to\vault"

`-Install` always requires a complete vault path and `-AcceptInstallation`.
The consent covers only installing the Bridge Control companion and the local
Codex connector. It does not grant note access or enable Autonomous access or
Full management. This mode opens no windows and returns a JSON report. Errors
use exit code 1 and a JSON object on stderr.
