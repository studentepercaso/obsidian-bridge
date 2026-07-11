import { realpath } from "node:fs/promises";
import path from "node:path";

import {
  buildVaultArgs,
  type CliInvocationOptions,
  type ObsidianCliRunner,
} from "./cli.js";
import type { VaultAccess } from "./shared-settings.js";

function comparisonKey(value: string): string {
  const normalized = path.normalize(value).replace(/[\\/]+$/u, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function parseVaultPath(output: string): string {
  const trimmed = output.trim();
  if (trimmed.length === 0 || /[\r\n]/u.test(trimmed)) {
    throw new Error("Obsidian CLI returned an invalid vault path");
  }
  if (!path.isAbsolute(trimmed) || /[\u0000-\u001f\u007f]/u.test(trimmed)) {
    throw new Error("Obsidian CLI returned a non-absolute vault path");
  }
  return trimmed;
}

/**
 * Bind a GUI grant to the exact registered vault before content is accessed.
 * Environment-only legacy configuration has no recorded root and is left to
 * the explicit environment policy.
 */
export async function assertVaultIdentity(
  runner: ObsidianCliRunner,
  access: VaultAccess,
  options: CliInvocationOptions = {},
): Promise<void> {
  if (access.source !== "settings" || access.vaultPath === undefined) return;

  const result = await runner(
    buildVaultArgs(access.vaultSelector, "vault", ["info=path"]),
    options,
  );
  const actualPath = parseVaultPath(result.stdout);
  let expectedReal: string;
  let actualReal: string;
  try {
    [expectedReal, actualReal] = await Promise.all([
      realpath(access.vaultPath),
      realpath(actualPath),
    ]);
  } catch (error) {
    throw new Error("The configured Obsidian vault path cannot be verified", {
      cause: error,
    });
  }

  if (comparisonKey(expectedReal) !== comparisonKey(actualReal)) {
    throw new Error(
      "Obsidian vault identity mismatch; reopen Bridge Control and save the vault configuration again",
    );
  }
}
