# Guided installation

[English](INSTALLATION.en.md) · [Italiano](INSTALLATION.md)

This guide covers the Obsidian Bridge 0.5.7 Windows package. Normal setup does not require editing JSON, environment variables, or PowerShell commands.

## Before you start

You need:

- Obsidian desktop 1.12.7 or newer;
- Node.js 20 or newer;
- Codex/ChatGPT desktop with local plugin support, or another compatible local MCP host;
- a local Obsidian vault for the first test.

Use a disposable vault or authorize one synthetic test folder first. The Bridge Control folder picker lists only folders that currently exist in the vault.

## Install in five steps

1. **Extract the archive.** Do not launch the installer from the ZIP preview.
2. **Start the installer.** Double-click **INSTALLA-OBSIDIAN-BRIDGE.cmd**. Administrator rights are not required.
3. **Select a vault.** The installer lists vaults known to Obsidian. If yours is missing, choose **Browse** and select the vault root containing the `.obsidian` folder.
4. **Install the bridge.** Accept the installation of Bridge Control and select **Installa Bridge**. A new vault starts with no note access.
5. **Choose a mode.** Open **Obsidian → Settings → Community plugins → Bridge Control**. Keep **Protected access** and choose folders, activate **Autonomous access** for create/append without routine questions, or enable **Full management** with only the advanced permissions you need.

The installer stores a stable local copy of the Codex plugin. After a successful installation, the extracted setup folder can be deleted.

## Enable the official Obsidian CLI

If the external bridge reports that the CLI is unavailable:

1. open Obsidian;
2. go to **Settings → General → Command line interface**;
3. enable the CLI using the instructions shown by Obsidian;
4. close and reopen Obsidian and the desktop client;
5. retry a harmless bridge read in a new Codex task.

The first CLI command may bring Obsidian to the foreground. Bridge Control 0.5.7 does not execute the CLI: its optional candidate scan only checks allowlisted known paths and cannot certify readiness. The external bridge performs the definitive check. See the [official Obsidian CLI documentation](https://help.obsidian.md/cli) for platform-specific details.

## Configure reading and writing

Bridge Control manages each vault independently:

- **Bridge enabled** revokes or restores all bridge access for that vault.
- **Protected access** uses saved folder scopes and requires confirmation for each create or append.
- **Autonomous access** permits autonomous read/create/append across the eligible vault after explicit panel activation.
- **Full management** includes autonomous access and adds three independent permissions: **edit notes and frontmatter**, **rename and move**, and **Obsidian trash**.
- **Reading off** exposes no notes.
- **Whole vault** allows reading eligible non-hidden paths.
- **Choose folders** limits reading to the selected relative folder prefixes.
- **Controlled writing** enables create and append only in the separately selected folders when Protected access is active.

The visual picker is the normal configuration path. Advanced manual paths must be relative to the vault root. Absolute paths, drive letters, `..`, `.obsidian`, `.trash`, and hidden folders are rejected.

Writing is disabled by default. In **Protected access**, every change requires:

1. a **prepare** call that produces a preview without writing;
2. your explicit confirmation after reviewing vault, path, operation, and proposed content;
3. a separate **commit** call that rechecks permissions and source state.

Text found inside a note never counts as confirmation.

In **Autonomous access**, prepare and commit remain separate, single-use, and verified, but the agent may inspect the preview internally and complete create/append in the same task without a routine confirmation question. This mode does not authorize in-place editing, frontmatter, rename, move, or trash.

For vaults configured through Bridge Control, every create/append observation uses one settings-backed exact UTF-8 path: prepare, commit conflict check, append backup, intermediate chunks, final verification, and recovery classification. This is read-only filesystem access; mutations still use only the allowlisted official Obsidian CLI. Each create/append proposal accepts at most 64 KiB of UTF-8 content and its complete preview is bounded to 192 KiB. The resulting appended document remains bounded to 1 MiB, and create requires its destination parent folder to exist already. Long content is still split into complete CLI frames of at most 3072 UTF-8 bytes; the bridge does not create folders implicitly.

In **Full management**, explicitly choose one or more separate grants:

- **Edit**: exact whole-note replacement, counted literal `replace_text`, and frontmatter property set/remove;
- **Move**: move or rename by supplying a new vault-relative path; the bridge does not automatically rewrite backlinks or other notes;
- **Trash**: send the note through Obsidian's configured trash flow. Permanent deletion is unavailable.

Prepare remains non-mutating. Commit rechecks the permission and source hash, creates a local plaintext recovery backup first, runs the fixed public handler inside Obsidian, and verifies the postcondition. Create/append and management share a pool of at most the newest 20 JSON backups, so always keep an independent backup. The channel exposes no shell, `eval`, command palette, plugin management, or arbitrary Obsidian command. Hidden paths, `.obsidian`, `.trash`, and physical redirects outside the vault remain denied.

**An update never activates Full management.** Open its warning, select the exact permissions, and acknowledge the named vault yourself. Returning to Autonomous or Protected access, clearing a grant, or disabling the bridge revokes management at the next stage; an already prepared preview cannot bypass revocation.

## Recommended first test

1. Create a synthetic note inside a folder named `Bridge Test`.
2. Enable **Read** for that folder and ask Codex to read the note with line citations.
3. Enable **Write** for the same folder.
4. Ask Codex to prepare `Bridge Test/hello.md`, show the preview, and wait.
5. Confirm that the file does not exist after prepare.
6. Approve only if the preview, vault, and path are correct.
7. Read the created note through the bridge.
8. Disable writing and verify that a new prepare request is refused.

To test Full management, use only a synthetic note and an independent backup. Start with **Edit** alone, request one unambiguous literal replacement, read the note back, and inspect **Recent problems**. Add **Move** or **Trash** only in separate tests; do not start with production notes.

## Updating

1. Download and extract the new release to a different folder.
2. Close open Obsidian settings dialogs.
3. Run the new installer and select the same vault.
4. Review Bridge Control, the registered-handler status, and the optional non-executing CLI candidate scan. Existing saved permissions are preserved.
5. Start a new Codex task so updated plugin definitions are loaded.

The installer creates timestamped backups before replacing its own configuration files. It does not delete vault notes.

## Disabling and removing

For immediate revocation, disable **Bridge enabled** in Bridge Control. You can also return from Full management to Autonomous or Protected access, which clears management grants, or keep the bridge enabled while setting protected reading and writing to **Off**.

Remove the companion through **Obsidian → Settings → Community plugins → Bridge Control → Uninstall**. Uninstalling the companion does not delete notes, existing local append backups, audit records, or the stable Codex plugin copy.

Always keep an independent vault backup before testing writes.

## Troubleshooting

### The vault is missing

Open it in Obsidian at least once, then restart the installer. Alternatively, browse to the folder containing `.obsidian`.

### Bridge Control is missing

Confirm that Community plugins are allowed for the vault, reopen Obsidian, and rerun the installer for the same vault if needed.

### The bridge cannot use the CLI

Enable the official CLI in Obsidian settings and restart both applications. Bridge Control's **Detect file** action can report only an allowlisted candidate, never a verified version or ready state. Test through the external bridge. Do not point the bridge at an unverified executable; the CLI path is a security boundary.

### Codex reports that Node.js is unavailable

Install Node.js 20 or newer, restart the desktop client, and verify:

```powershell
node --version
```

### An authorized folder does not work

Use a vault-relative path with `/` separators, for example `Projects/Active`. Save the panel and retry. The policy is reloaded on every call.

### A prepared change cannot be committed

Previews expire and are single-use. If the note, permissions, or writer process changed, request a new preview and review it again.

### Obsidian showed a JavaScript error or a write failed

Open **Bridge Control → Recent problems** and refresh the check. The panel reads only local audit metadata, reports the recorded recovery state, whether the note currently exists, and whether manual review is required. Codex can read the same bounded events through `obsidian_recent_write_events` without asking you to transcribe the error. Version 0.5.7 reports bounded `failure_stage` and `cause_code` values without recording raw exception messages, CLI output, note text, proposed content, or backup bodies. These diagnostics are evidence only: reread the note and do not automatically retry until the user gives explicit direction.

Version 0.5.7 retains exact UTF-8 observations for create/append, including content without a final newline. For synchronized Windows files it performs up to three bounded positional reads from the same stable handle, accepts only after two byte sequences agree and a final metadata window is quiet, and does not treat a `ctime`-only update as a content change. Identity, path, size, `mtime`, truncation, growth, or byte drift still fails closed. If a write or verification failure occurs after append has mutated the note, the writer does not attempt a destructive non-atomic CLI rollback. It preserves the exact backup and audit evidence, leaves the observed note untouched, and returns `manual_recovery_required=true` with `WRITE_FAILED_MANUAL_RECOVERY_REQUIRED` or `VERIFICATION_FAILED_MANUAL_RECOVERY_REQUIRED`. A partial create remains `delete_disabled`. Inspect the note and backup manually and wait for explicit direction.

After three consecutive autonomous or management failures, that process pauses for the task. Review recent problems, return to a narrower mode, and start a new task before enabling autonomy or Full management again.

## Local settings

On Windows, Bridge Control and the installer use:

```text
%LOCALAPPDATA%\ObsidianBridge\settings.json
```

The file stores each vault's stable Obsidian ID, name, absolute local path, `protected`, `full`, or `management` access mode, optional edit/move/trash grants, and protected folder choices. The UI labels `full` as **Autonomous access** and `management` as **Full management**. It does not contain note bodies. Every process validates it before use; a malformed file fails closed.

Early environment variables remain an advanced read-only compatibility mode only when the shared file is absent. Version 0.5.7 fails closed for environment-only create/append because normalized CLI stdout is not an exact compare-and-swap source. Install or configure Bridge Control to migrate writing access to shared settings.
