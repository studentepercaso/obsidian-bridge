# Bridge Control

[English](README.md) · [Italiano](README.it.md)

Bridge Control is the desktop-only Obsidian companion for Obsidian Bridge. It lets users choose folder-scoped protected access or explicit full/autonomous access for the current vault, and shows recent write problems.

## Default behavior

On first run:

- access is scoped to the current vault identity;
- reading remains off until the user selects folders or the whole eligible vault;
- writing is off;
- the initial profile is **Protected access**;
- no folder is preselected.

The panel includes a searchable visual picker, separate **Read** and **Write** checkboxes, one-time explicit **Full access** activation, recursive parent-folder coverage, save/read-back verification, official CLI diagnostics, and a **Recent problems** view.

## Shared settings

The companion reads version 2 as protected access and atomically updates the shared settings file to version 3:

- Windows: `%LOCALAPPDATA%\ObsidianBridge\settings.json`
- macOS: `~/Library/Application Support/ObsidianBridge/settings.json`
- Linux: `$XDG_CONFIG_HOME/ObsidianBridge/settings.json` or `~/.config/ObsidianBridge/settings.json`

It stores the stable vault ID, normalized local path, access mode, and authorized relative folders. It does not store note bodies.

Administrators may explicitly redirect the shared settings file with the `OBSIDIAN_BRIDGE_SETTINGS_PATH` environment variable before starting Obsidian. Bridge Control never accepts that path from vault plugin data.

Paths must be relative to the vault. Absolute paths, traversal, `.`, `..`, and hidden folders such as `.obsidian` and `.trash` are rejected.

## Privacy and security

- No network requests or telemetry.
- Note contents are not read or written by the settings companion; Recent problems reads only a bounded audit tail without note or backup bodies.
- The Obsidian Vault API is used only to enumerate folders.
- The plugin reads Obsidian's size-bounded global `obsidian.json` registry outside the vault to bind permissions to the current vault's stable ID.
- Node filesystem writes are limited to the deterministic shared settings path outside the vault and the plugin's own Obsidian data. Vault plugin data cannot redirect that path.
- CLI diagnostics run only after an explicit click. They inspect an environment override or known installation paths, never the ambient `PATH`, invoke only `version` without a shell, and accept only recognized Obsidian version output.
- Actual note writes remain disabled by default. Protected access uses preview plus explicit confirmation; Full access enables only the separately gated autonomous writer while preserving path, hash, backup, lock, and audit controls.

## Build

```shell
npm ci
npm run check
```

For manual testing, copy `main.js`, `manifest.json`, and `styles.css` to:

```text
<vault>/.obsidian/plugins/bridge-control/
```

Then reload Obsidian and enable **Bridge Control** under Community plugins.

This project is independent and is not affiliated with or endorsed by Obsidian.
