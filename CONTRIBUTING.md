# Contributing

Obsidian Bridge welcomes focused fixes, tests and documentation improvements.

## Development

Use Node.js 20 or newer, then run:

```powershell
npm ci
npm run check
```

Automated tests must use synthetic fixture data. Never add real vault contents, personal paths, tokens or credentials to issues, tests or commits.

## Design constraints

- Keep the default server local and read-only.
- Invoke the Obsidian CLI with structured arguments and `shell: false`.
- Reject unsafe paths before any CLI invocation.
- Bound query length, result counts, line counts, execution time and output size.
- Return only data needed for the requested workflow.
- Add or update tests for every security-relevant change.

Write, delete, arbitrary-command, network, indexing and remote-transport features require a separate threat-model and privacy review. Do not add them as incidental extensions to the existing tools.

## Pull requests

Describe the user-facing behavior, security impact and verification performed. Keep changes small enough to review. For vulnerabilities, follow [SECURITY.md](SECURITY.md) instead of opening a public issue.
