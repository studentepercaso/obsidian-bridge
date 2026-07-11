# Publishing paths

Obsidian Bridge 0.3.3 is distributed as a public community preview from GitHub. Public catalog submissions remain separate review processes.

## GitHub community distribution

1. Publish the bilingual source and release archives from the public Git repository.
2. Expose the plugin through `.agents/plugins/marketplace.json`.
3. Pin both the marketplace and plugin source to the release tag.
4. Publish the setup ZIP, companion ZIP, raw Obsidian assets and SHA-256 file in the GitHub release.
5. Smoke-test a clean marketplace install and the guided installer with a disposable vault.

This route keeps both MCP servers local and is suitable for an open-source preview release. Clearly label 0.3 as preview software with opt-in vault mutation, and direct testers to use the guided installer with a disposable vault or `Bridge Test` first.

## OpenAI public plugin submission

The public submission is a later milestone. The current OpenAI review flow requires:

- a verified developer or business identity;
- public website, support, privacy-policy and terms URLs;
- a public production MCP endpoint with domain verification;
- accurate annotations for every tool;
- five positive and three negative reproducible test cases;
- a documented content-security policy and reviewer access where authentication is used.

OpenAI's current guidelines also say that apps whose primary purpose is an unofficial connector to a third-party service may not be approved. Before submitting under the Obsidian name, obtain the permissions or partnership needed to make the integration authorized. Until then, distribute this project as an open-source local plugin and describe it accurately as community software, not an official Obsidian product.

Official references:

- https://learn.chatgpt.com/docs/submit-plugins
- https://developers.openai.com/apps-sdk/app-guidelines
- https://developers.openai.com/api/docs/guides/secure-mcp-tunnels

## Obsidian Community Plugins

This repository contains the desktop-only **Bridge Control** companion used by the guided installer. Its canonical, review-ready source and release assets are also published at [studentepercaso/bridge-control](https://github.com/studentepercaso/bridge-control). Publication there does not imply acceptance by the Obsidian Community Plugins catalog.

Before a catalog submission, publish the required companion release assets, provide a public source repository and support/security information, verify the minimum Obsidian version, satisfy Obsidian's automated and manual review requirements, and test update/uninstall behavior independently of the Codex marketplace package. The companion should remain a permission and diagnostics surface rather than becoming an unrestricted vault server.

## Release gate

Do not call a release production-ready until all of the following are true:

- `npm run check` passes on Windows, macOS and Linux;
- a real Obsidian 1.12.7+ CLI smoke test passes on each platform;
- the final archive passes the Codex plugin and skill validators;
- the auto-approved reader process exposes exactly the eight documented read tools and no mutating tool;
- the prompt-approved writer process exposes only prepare and commit;
- Bridge Control starts with writing off, and a disabled vault, disabled write toggle, empty writable-folder list or non-matching exact vault entry rejects every write;
- the shared-settings file is reloaded per operation, malformed present configuration fails closed, and revocation between prepare and commit is tested;
- create and append pass preview, confirmation, conflict, expiry, replay, and out-of-scope tests;
- preparation is proven non-mutating and commit requires a previously prepared opaque change ID;
- previews include both the diff and `proposed_content_json`, and explicitly mark final-newline changes;
- append backup creation, 20-file retention, after-hash verification, non-atomic append races, bounded single-overwrite rollback, manual-recovery reasons, and content-free audit records are tested;
- literal `\n` and `\t` sequences are rejected while ordinary backslashes remain unchanged;
- line replacement remains unavailable until the official CLI provides an atomic compare-and-swap or an equivalent reviewed safety control;
- delete, rename, move, arbitrary commands, command-palette access, shell access, plugin management, and `eval` remain unavailable;
- privacy and security documents match the actual tool responses;
- test instructions begin with a disposable vault and an independent backup;
- publisher identity and trademark wording are reviewed.
