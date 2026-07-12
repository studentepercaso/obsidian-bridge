# Publishing paths

Obsidian Bridge 0.5.3 is distributed as a public community preview from GitHub. Public catalog submissions remain separate review processes.

## GitHub community distribution

1. Publish the bilingual source and release documentation from the public Git repository.
2. Expose the Codex plugin through `.agents/plugins/marketplace.json` pinned to tag `0.5.3`.
3. Publish the guided setup ZIP, companion ZIP, raw Obsidian assets, and `SHA256-0.5.3.txt` in the GitHub release.
4. Publish the matching `0.5.3` companion tag and release assets in [studentepercaso/bridge-control](https://github.com/studentepercaso/bridge-control).
5. Smoke-test a clean marketplace install, a guided update from 0.5.2, and a clean installer run with a disposable vault.
6. Confirm that migration preserves old protected/autonomous choices but grants no Full-management permission.

This route keeps all MCP servers local. Label 0.5.3 as preview software with opt-in vault mutation. Direct testers to use a disposable vault or `Bridge Test`, retain an independent backup, and activate only one Full-management permission at a time during initial testing.

## OpenAI public plugin submission

The public submission is a later milestone. The current OpenAI review flow requires:

- a verified developer or business identity;
- public website, support, privacy-policy and terms URLs;
- a public production MCP endpoint with domain verification;
- accurate annotations for every tool;
- five positive and three negative reproducible test cases;
- a documented content-security policy and reviewer access where authentication is used.

The current bridge is a local stdio plugin, not a hosted production MCP endpoint. OpenAI's guidelines also say that apps whose primary purpose is an unofficial connector to a third-party service may not be approved. Before submitting under the Obsidian name, obtain the permissions or partnership needed to make the integration authorized. Until then, describe it accurately as independent open-source community software.

Official references:

- https://learn.chatgpt.com/docs/submit-plugins
- https://developers.openai.com/apps-sdk/app-guidelines
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Obsidian Community Plugins

This repository contains the desktop-only **Bridge Control** companion used by the guided installer. Its canonical source and release assets are also published in the standalone companion repository, which is listed in the Obsidian Community Plugins catalog. Each update must still ship matching public metadata and release assets.

The 0.5.3 companion registers the same fixed public CLI handler, `bridge-control:commit`, and performs managed operations through public Obsidian APIs. It is not a general vault server: the handler accepts only bounded one-time request IDs and tokens from the private bridge data directory, rechecks the current granular permission and exact source hash, creates a recovery backup, verifies the postcondition, and writes metadata-only audit state. Bridge Control 0.5.3 updates metadata, documentation, and the read-only audit diagnostics parser/UI for the two bounded manual-recovery codes; its protocol and managed mutation code are unchanged. The exact create/append observations and manual-recovery behavior are implemented by the bridge, not a new companion command or mutation surface. It exposes no shell, `eval`, arbitrary command, command palette, plugin management, or permanent delete.

For every catalog update, publish the required companion assets, retain public source/support/security information, verify the minimum Obsidian version, satisfy automated checks, and independently test activation, update, revocation, and uninstall behavior.

## Release gate

Do not publish 0.5.3 until all of the following are true:

- `npm run check:all` passes and generated server and companion bundles are current;
- a real Obsidian 1.12.7+ smoke test passes in a disposable vault with the official CLI enabled;
- the final archive passes Codex plugin and skill validators;
- reader, protected writer, autonomous writer, and manager remain four separate MCP processes with only their documented tools and approval policies;
- the manager exposes only `obsidian_prepare_managed_change` and `obsidian_commit_managed_change`;
- Autonomous access accepts only current `full` or `management` entries; management operations accept only current `management` entries and the exact matching edit/move/trash grant;
- strict version-2 and version-3 settings migrate to version 4 without management authority; invalid combinations fail schema validation;
- Full management requires an explicit warning, the named vault, and an exact non-empty permission snapshot under the shared-settings lock;
- stale local plugin data cannot reactivate Autonomous access, Full management, or a previously revoked granular grant;
- protected create/append retains post-preview human confirmation, while autonomous create/append retains its separate two-step verified workflow;
- settings-backed create/append preparation, commit CAS, exact backup, chunk/final verification, and recovery classification all use the bounded exact UTF-8 reader; no-final-newline, LF, CRLF, BOM, and Unicode regression tests pass;
- the exact reader is read-only and physically confined, while every create/append mutation remains on the allowlisted official CLI surface;
- environment-only legacy create/append fails closed with migration guidance to Bridge Control shared settings;
- append results over 1 MiB and create destinations with a missing parent folder fail before mutation;
- post-mutation create/append failures never attempt a destructive CLI rollback, preserve backup/audit evidence, and report `manual_recovery_required=true` with the appropriate bounded manual-recovery code; partial create remains `delete_disabled`;
- managed `replace`, `replace_text`, `frontmatter`, `move`/rename, and `trash` pass prepare, commit, conflict, expiry, replay, revocation, size, and path-policy tests;
- managed preparation and commit use an exact bounded UTF-8 source snapshot; no-final-newline, LF, CRLF, BOM, and genuine concurrent-change regression tests pass without weakening compare-and-swap checks;
- `replace_text` enforces the expected exact occurrence count and commits the prepared full-document hash;
- frontmatter uses `Vault.process`, checks the prepared before-hash inside the transform, uses `getFrontMatterInfo`/`parseYaml`/`stringifyYaml`, and verifies set/remove results;
- move/rename refuses an existing destination and case-only rename, locks source and destination, uses `Vault.rename`, and proves that backlinks and other notes are not rewritten;
- trash uses Obsidian's public trash API, provides no permanent-delete option, and never writes directly to `.trash`;
- every managed operation creates and validates a plaintext version-2 recovery backup before mutation, and create/append plus management enforce one shared newest-20 JSON retention pool;
- managed rollback remains bounded to a known bridge-written state, move reversal is conflict-aware, and trash failure clearly reports manual backup/trash recovery; no claim of atomic create/append rollback is made;
- successful management requires a verified postcondition and metadata-only audit outcome; move audit includes the optional target path;
- bounded audit readers accept current create/append and management records, enforce the current vault/folder policy, and never return note or backup bodies;
- failed create/append records preserve bounded `failure_stage` and `cause_code` values without raw exception messages, CLI output, note text, proposed content, or backup bodies;
- Bridge Control and `obsidian_recent_write_events` expose the matching safe diagnostics, while skill and documentation still require a state reread and explicit human direction before retry;
- one-time request files are bounded, expiring, token-bound, claimed once, cleaned up, and confined to the fixed bridge data directory;
- the only management CLI command is `bridge-control:commit`; duplicate or unexpected arguments are rejected;
- no shell, `eval`, arbitrary Obsidian command, command-palette access, plugin management, direct filesystem note mutation, or permanent deletion is exposed; exact read-side snapshots must not become a direct write path;
- policy, identity, physical scope, hashes, and destination state are rechecked after prepare and before mutation;
- source and destination locks have timeout, abort, ownership, release, and stale-lock coverage;
- three consecutive autonomous or management failures pause that process for the task;
- installer update/dry-run/self-test preserve safe settings and never silently activate management;
- privacy, security, installation, writing, submission tests, skill instructions, release notes, and checksums match the shipped artifacts;
- publisher identity, trademark wording, and preview warnings are reviewed.
