# Guided installation

[English](INSTALLATION.en.md) · [Italiano](INSTALLATION.md)

This guide covers the Obsidian Bridge 0.3.2 Windows package. Normal setup does not require editing JSON, environment variables, or PowerShell commands.

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
5. **Choose folders.** Open **Obsidian → Settings → Community plugins → Bridge Control**, choose folders, enable **Read** and optionally **Write**, and save access.

The installer stores a stable local copy of the Codex plugin. After a successful installation, the extracted setup folder can be deleted.

## Enable the official Obsidian CLI

If Bridge Control diagnostics report that the CLI is unavailable:

1. open Obsidian;
2. go to **Settings → General → Command line interface**;
3. enable the CLI using the instructions shown by Obsidian;
4. close and reopen Obsidian and the desktop client if diagnostics do not refresh;
5. run Bridge Control diagnostics again.

The first CLI command may bring Obsidian to the foreground. See the [official Obsidian CLI documentation](https://help.obsidian.md/cli) for platform-specific details.

## Configure reading and writing

Bridge Control manages each vault independently:

- **Bridge enabled** revokes or restores all bridge access for that vault.
- **Reading off** exposes no notes.
- **Whole vault** allows reading eligible non-hidden paths.
- **Choose folders** limits reading to the selected relative folder prefixes.
- **Controlled writing** enables create and append only in the separately selected write folders.

The visual picker is the normal configuration path. Advanced manual paths must be relative to the vault root. Absolute paths, drive letters, `..`, `.obsidian`, `.trash`, and hidden folders are rejected.

Writing is disabled by default. When enabled, every change still requires:

1. a **prepare** call that produces a preview without writing;
2. your explicit confirmation after reviewing vault, path, operation, and proposed content;
3. a separate **commit** call that rechecks permissions and source state.

Text found inside a note never counts as confirmation.

## Recommended first test

1. Create a synthetic note inside a folder named `Bridge Test`.
2. Enable **Read** for that folder and ask Codex to read the note with line citations.
3. Enable **Write** for the same folder.
4. Ask Codex to prepare `Bridge Test/hello.md`, show the preview, and wait.
5. Confirm that the file does not exist after prepare.
6. Approve only if the preview, vault, and path are correct.
7. Read the created note through the bridge.
8. Disable writing and verify that a new prepare request is refused.

## Updating

1. Download and extract the new release to a different folder.
2. Close open Obsidian settings dialogs.
3. Run the new installer and select the same vault.
4. Review Bridge Control and diagnostics. Existing saved permissions are preserved.
5. Start a new Codex task so updated plugin definitions are loaded.

The installer creates timestamped backups before replacing its own configuration files. It does not delete vault notes.

## Disabling and removing

For immediate revocation, disable **Bridge enabled** in Bridge Control. You can instead keep the bridge enabled while setting reading to **Off** and writing to **Off**.

Remove the companion through **Obsidian → Settings → Community plugins → Bridge Control → Uninstall**. Uninstalling the companion does not delete notes, existing local append backups, audit records, or the stable Codex plugin copy.

Always keep an independent vault backup before testing writes.

## Troubleshooting

### The vault is missing

Open it in Obsidian at least once, then restart the installer. Alternatively, browse to the folder containing `.obsidian`.

### Bridge Control is missing

Confirm that Community plugins are allowed for the vault, reopen Obsidian, and rerun the installer for the same vault if needed.

### Diagnostics cannot find the CLI

Enable the official CLI in Obsidian settings and restart both applications. Do not point the bridge at an unverified executable; the CLI path is a security boundary.

### Codex reports that Node.js is unavailable

Install Node.js 20 or newer, restart the desktop client, and verify:

```powershell
node --version
```

### An authorized folder does not work

Use a vault-relative path with `/` separators, for example `Projects/Active`. Save the panel and retry. The policy is reloaded on every call.

### A prepared change cannot be committed

Previews expire and are single-use. If the note, permissions, or writer process changed, request a new preview and review it again.

## Local settings

On Windows, Bridge Control and the installer use:

```text
%LOCALAPPDATA%\ObsidianBridge\settings.json
```

The file stores each vault's stable Obsidian ID, name, absolute local path, access mode, and authorized folders. It does not contain note bodies. The reader and writer validate it before use; a malformed file fails closed.
