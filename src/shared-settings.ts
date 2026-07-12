import { lstat, open } from "node:fs/promises";
import { constants } from "node:fs";
import path, { isAbsolute } from "node:path";

import { z } from "zod";

import type { BridgeConfig } from "./config.js";
import {
  createPathPolicy,
  createWritablePathPolicy,
  normalizeRelativeFolder,
  type PathPolicy,
} from "./path-policy.js";

export const MAX_SETTINGS_BYTES = 65_536;

const VaultName = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value === value.trim().normalize("NFC"), {
    message: "vault name must be trimmed and NFC-normalized",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "vault name contains control characters",
  });
const Folder = z.string().min(1).max(1_024);
const VaultId = z
  .string()
  .regex(/^[0-9a-f]{16}$/u, "vault ID must be the 16-character Obsidian ID");
const VaultPath = z
  .string()
  .min(1)
  .max(4_096)
  .refine((value) => isAbsolute(value), {
    message: "vault path must be absolute",
  })
  .refine((value) => !/[\u0000-\u001f\u007f]/u.test(value), {
    message: "vault path contains control characters",
  });

export function normalizeVaultConfigDir(value: string): string {
  const normalized = value.trim().replaceAll("\\", "/").normalize("NFC");
  if (normalized.length === 0 || normalized.length > 1_024) {
    throw new Error("configDir must contain between 1 and 1024 characters");
  }
  if (
    path.posix.isAbsolute(normalized) ||
    path.win32.isAbsolute(value) ||
    /^[a-zA-Z]:/u.test(normalized) ||
    /[\u0000-\u001f\u007f]/u.test(normalized)
  ) {
    throw new Error("configDir must be a vault-relative folder");
  }
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("configDir contains invalid path segments");
  }
  return segments.join("/");
}

const VaultConfigDir = z
  .string()
  .min(1)
  .max(1_024)
  .refine(
    (value) => {
      try {
        return normalizeVaultConfigDir(value) === value;
      } catch {
        return false;
      }
    },
    { message: "configDir must be a normalized vault-relative folder" },
  );

const LegacyVaultSettingsSchema = z
  .object({
    vaultName: VaultName,
    vaultPath: VaultPath,
    enabled: z.boolean(),
    readMode: z.enum(["off", "all", "folders"]),
    readFolders: z.array(Folder).max(256),
    writeEnabled: z.boolean(),
    writeFolders: z.array(Folder).max(256),
  })
  .strict();

const Version3VaultSettingsSchema = LegacyVaultSettingsSchema.extend({
  accessMode: z.enum(["protected", "full"]),
}).strict();

export const ManagementPermissionsSchema = z
  .object({
    edit: z.boolean(),
    move: z.boolean(),
    trash: z.boolean(),
  })
  .strict();

const Version4VaultSettingsSchema = LegacyVaultSettingsSchema.extend({
  accessMode: z.enum(["protected", "full", "management"]),
  managementPermissions: ManagementPermissionsSchema,
})
  .strict()
  .superRefine((value, context) => {
    const permissions = Object.values(value.managementPermissions);
    const hasManagementPermission = permissions.some(Boolean);
    if (value.accessMode === "management" && !hasManagementPermission) {
      context.addIssue({
        code: "custom",
        path: ["managementPermissions"],
        message: "management mode requires at least one management permission",
      });
    }
    if (value.accessMode !== "management" && hasManagementPermission) {
      context.addIssue({
        code: "custom",
        path: ["managementPermissions"],
        message:
          "management permissions must be disabled outside management mode",
      });
    }
  });

export const VaultSettingsSchema = LegacyVaultSettingsSchema.extend({
  accessMode: z.enum(["protected", "full", "management"]),
  managementPermissions: ManagementPermissionsSchema,
  /** Null is a deny-all marker for a legacy vault not yet migrated by Obsidian. */
  configDir: VaultConfigDir.nullable(),
})
  .strict()
  .superRefine((value, context) => {
    const permissions = Object.values(value.managementPermissions);
    const hasManagementPermission = permissions.some(Boolean);
    if (value.accessMode === "management" && !hasManagementPermission) {
      context.addIssue({
        code: "custom",
        path: ["managementPermissions"],
        message: "management mode requires at least one management permission",
      });
    }
    if (value.accessMode !== "management" && hasManagementPermission) {
      context.addIssue({
        code: "custom",
        path: ["managementPermissions"],
        message:
          "management permissions must be disabled outside management mode",
      });
    }
  });

const SharedSettingsFields = {
  updatedAt: z
    .string()
    .min(1)
    .max(64)
    .refine((value) => Number.isFinite(Date.parse(value)), {
      message: "updatedAt must be a valid date-time",
    }),
} as const;

const LegacySharedSettingsSchema = z
  .object({
    version: z.literal(2),
    ...SharedSettingsFields,
    vaults: z.record(VaultId, LegacyVaultSettingsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.vaults).length > 256) {
      context.addIssue({
        code: "custom",
        path: ["vaults"],
        message: "at most 256 vault entries are allowed",
      });
    }
  });

const Version3SharedSettingsSchema = z
  .object({
    version: z.literal(3),
    ...SharedSettingsFields,
    vaults: z.record(VaultId, Version3VaultSettingsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.vaults).length > 256) {
      context.addIssue({
        code: "custom",
        path: ["vaults"],
        message: "at most 256 vault entries are allowed",
      });
    }
  });

const Version4SharedSettingsSchema = z
  .object({
    version: z.literal(4),
    ...SharedSettingsFields,
    vaults: z.record(VaultId, Version4VaultSettingsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.vaults).length > 256) {
      context.addIssue({
        code: "custom",
        path: ["vaults"],
        message: "at most 256 vault entries are allowed",
      });
    }
  });

export const SharedSettingsSchema = z
  .object({
    version: z.literal(5),
    ...SharedSettingsFields,
    vaults: z.record(VaultId, VaultSettingsSchema),
  })
  .strict()
  .superRefine((value, context) => {
    if (Object.keys(value.vaults).length > 256) {
      context.addIssue({
        code: "custom",
        path: ["vaults"],
        message: "at most 256 vault entries are allowed",
      });
    }
  });

export type VaultSettings = z.infer<typeof VaultSettingsSchema>;
export type SharedSettings = z.infer<typeof SharedSettingsSchema>;
export type AccessMode = VaultSettings["accessMode"];
export type ManagementPermissions = z.infer<typeof ManagementPermissionsSchema>;

export type SharedSettingsSnapshot =
  | { readonly status: "absent" }
  | { readonly status: "loaded"; readonly settings: SharedSettings };

export class SharedSettingsError extends Error {
  readonly code = "INVALID_SHARED_SETTINGS";

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "SharedSettingsError";
  }
}

const NO_MANAGEMENT_PERMISSIONS: ManagementPermissions = Object.freeze({
  edit: false,
  move: false,
  trash: false,
});

function validatePolicyFolders(settings: SharedSettings): void {
  try {
    for (const entry of Object.values(settings.vaults)) {
      const configDir = entry.configDir;
      // Parse all configured paths even when the related toggle is currently
      // off. A malformed present file must never partially grant access.
      createWritablePathPolicy({ allowedFolders: entry.readFolders });
      createWritablePathPolicy({ allowedFolders: entry.writeFolders });
      for (const folders of [entry.readFolders, entry.writeFolders]) {
        const normalized = folders.map((folder) =>
          normalizeRelativeFolder(folder),
        );
        if (
          normalized.some((folder, index) => folder !== folders[index]) ||
          new Set(normalized).size !== normalized.length
        ) {
          throw new Error("policy folders must be normalized and unique");
        }
        if (
          configDir !== null &&
          normalized.some((folder) => vaultFoldersIntersect(folder, configDir))
        ) {
          throw new Error("policy folders must not intersect configDir");
        }
      }
    }
  } catch (error) {
    throw new SharedSettingsError("shared settings contain an invalid folder", {
      cause: error,
    });
  }
}

function comparisonKey(value: string, caseSensitive: boolean): string {
  const normalized = value.normalize("NFC");
  return caseSensitive ? normalized : normalized.toLocaleLowerCase("en-US");
}

function folderContains(
  parent: string,
  candidate: string,
  caseSensitive: boolean,
): boolean {
  const parentKey = comparisonKey(parent, caseSensitive);
  const candidateKey = comparisonKey(candidate, caseSensitive);
  return candidateKey === parentKey || candidateKey.startsWith(`${parentKey}/`);
}

function vaultFoldersIntersect(left: string, right: string): boolean {
  return (
    folderContains(left, right, false) || folderContains(right, left, false)
  );
}

/** Read and validate one complete settings snapshot without caching it. */
export async function readSharedSettings(
  settingsPath: string,
): Promise<SharedSettingsSnapshot> {
  try {
    const linkStats = await lstat(settingsPath);
    if (linkStats.isSymbolicLink()) {
      throw new SharedSettingsError(
        "shared settings path must not be a symbolic link",
      );
    }
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { status: "absent" };
    }
    if (error instanceof SharedSettingsError) throw error;
    throw new SharedSettingsError("shared settings cannot be inspected", {
      cause: error,
    });
  }

  let handle;
  try {
    handle = await open(
      settingsPath,
      process.platform === "win32"
        ? "r"
        : constants.O_RDONLY | constants.O_NOFOLLOW,
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return { status: "absent" };
    }
    throw new SharedSettingsError("shared settings cannot be read", {
      cause: error,
    });
  }

  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new SharedSettingsError("shared settings path is not a file");
    }
    if (stats.size > MAX_SETTINGS_BYTES) {
      throw new SharedSettingsError(
        `shared settings exceed ${MAX_SETTINGS_BYTES} bytes`,
      );
    }

    const bytes = await handle.readFile();
    if (bytes.byteLength > MAX_SETTINGS_BYTES) {
      throw new SharedSettingsError(
        `shared settings exceed ${MAX_SETTINGS_BYTES} bytes`,
      );
    }

    let decoded: string;
    try {
      decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch (error) {
      throw new SharedSettingsError("shared settings are not valid UTF-8", {
        cause: error,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(decoded) as unknown;
    } catch (error) {
      throw new SharedSettingsError("shared settings are not valid JSON", {
        cause: error,
      });
    }

    const current = SharedSettingsSchema.safeParse(parsed);
    const version4 = current.success
      ? undefined
      : Version4SharedSettingsSchema.safeParse(parsed);
    const version3 =
      current.success || version4?.success
        ? undefined
        : Version3SharedSettingsSchema.safeParse(parsed);
    const legacy =
      current.success || version4?.success || version3?.success
        ? undefined
        : LegacySharedSettingsSchema.safeParse(parsed);
    if (
      !current.success &&
      (version4 === undefined || !version4.success) &&
      (version3 === undefined || !version3.success) &&
      (legacy === undefined || !legacy.success)
    ) {
      throw new SharedSettingsError("shared settings do not match schema", {
        cause: current.error,
      });
    }
    let settings: SharedSettings;
    if (current.success) {
      settings = current.data;
    } else if (version4?.success) {
      settings = {
        version: 5,
        updatedAt: version4.data.updatedAt,
        vaults: Object.fromEntries(
          Object.entries(version4.data.vaults).map(([vaultId, entry]) => [
            vaultId,
            {
              ...entry,
              // The external bridge must not guess a custom Obsidian config
              // directory. Null remains deny-all until that vault opens.
              configDir: null,
            },
          ]),
        ),
      };
    } else if (version3?.success) {
      settings = {
        version: 5,
        updatedAt: version3.data.updatedAt,
        vaults: Object.fromEntries(
          Object.entries(version3.data.vaults).map(([vaultId, entry]) => [
            vaultId,
            {
              ...entry,
              // The version-3 acknowledgement explicitly excluded edit,
              // move, and trash. Preserve full-vault create/append access but
              // never infer the new management authority during migration.
              managementPermissions: { ...NO_MANAGEMENT_PERMISSIONS },
              configDir: null,
            },
          ]),
        ),
      };
    } else if (legacy?.success) {
      settings = {
        version: 5,
        updatedAt: legacy.data.updatedAt,
        vaults: Object.fromEntries(
          Object.entries(legacy.data.vaults).map(([vaultId, entry]) => [
            vaultId,
            {
              ...entry,
              accessMode: "protected" as const,
              managementPermissions: { ...NO_MANAGEMENT_PERMISSIONS },
              configDir: null,
            },
          ]),
        ),
      };
    } else {
      throw new SharedSettingsError("shared settings do not match schema");
    }
    validatePolicyFolders(settings);
    return { status: "loaded", settings };
  } catch (error) {
    if (error instanceof SharedSettingsError) throw error;
    throw new SharedSettingsError("shared settings cannot be read", {
      cause: error,
    });
  } finally {
    await handle.close();
  }
}

export interface VaultAccess {
  readonly readPolicy: PathPolicy;
  readonly writablePolicy: PathPolicy;
  readonly writeEnabled: boolean;
  /** Selects the prompt-approved or separately auto-approved writer channel. */
  readonly accessMode: AccessMode;
  /** Effective management grants; all false outside an enabled management entry. */
  readonly managementPermissions: Readonly<ManagementPermissions>;
  /** Stable Obsidian vault ID used for every CLI call. */
  readonly vaultSelector: string;
  readonly vaultName: string;
  /** Canonical path recorded by the installer/panel for physical scope checks. */
  readonly vaultPath?: string;
  readonly source: "settings" | "environment";
}

export type VaultAccessResolver = (vault: string) => Promise<VaultAccess>;

export interface VaultAccessResolverOptions {
  readonly settingsPath: string;
  readonly allowedFolders: readonly string[] | null;
  readonly environmentReadConfigured?: boolean;
  readonly deniedFolders: readonly string[];
  readonly writableVaults: readonly string[];
  readonly writableFolders: readonly string[];
  readonly readSettings?: (
    settingsPath: string,
  ) => Promise<SharedSettingsSnapshot>;
}

function denyPolicy(deniedFolders: readonly string[]): PathPolicy {
  return createWritablePathPolicy({ allowedFolders: [], deniedFolders });
}

function accessFromEntry(
  vaultId: string,
  entry: VaultSettings,
  deniedFolders: readonly string[],
): VaultAccess {
  if (entry.configDir === null) {
    // Legacy v2-v4 entries remain visible only as identity metadata. They do
    // not grant read, write, autonomous, or management access until the
    // companion running inside this exact vault persists Vault.configDir.
    return Object.freeze({
      readPolicy: denyPolicy(deniedFolders),
      writablePolicy: denyPolicy(deniedFolders),
      writeEnabled: false,
      accessMode: "protected",
      managementPermissions: NO_MANAGEMENT_PERMISSIONS,
      vaultSelector: vaultId,
      vaultName: entry.vaultName,
      vaultPath: entry.vaultPath,
      source: "settings" as const,
    });
  }
  const vaultDeniedFolders = [...deniedFolders];
  const configDirectoryDeny = [entry.configDir];
  const accessMode: AccessMode = entry.enabled ? entry.accessMode : "protected";
  const wholeVaultAccess = accessMode === "full" || accessMode === "management";
  const readPolicy =
    wholeVaultAccess || (entry.enabled && entry.readMode === "all")
      ? createPathPolicy({
          allowedFolders: null,
          deniedFolders: vaultDeniedFolders,
          caseInsensitiveDeniedFolders: configDirectoryDeny,
        })
      : entry.enabled && entry.readMode === "folders"
        ? createWritablePathPolicy({
            allowedFolders: entry.readFolders,
            deniedFolders: vaultDeniedFolders,
            caseInsensitiveDeniedFolders: configDirectoryDeny,
          })
        : denyPolicy(vaultDeniedFolders);
  const writeEnabled =
    wholeVaultAccess || (entry.enabled && entry.writeEnabled);
  const writablePolicy = wholeVaultAccess
    ? createPathPolicy({
        allowedFolders: null,
        deniedFolders: vaultDeniedFolders,
        caseInsensitiveDeniedFolders: configDirectoryDeny,
        caseSensitive: readPolicy.caseSensitive,
      })
    : writeEnabled
      ? createWritablePathPolicy({
          allowedFolders: entry.writeFolders,
          deniedFolders: vaultDeniedFolders,
          caseInsensitiveDeniedFolders: configDirectoryDeny,
          caseSensitive: readPolicy.caseSensitive,
        })
      : denyPolicy(vaultDeniedFolders);
  const managementPermissions =
    accessMode === "management"
      ? Object.freeze({ ...entry.managementPermissions })
      : NO_MANAGEMENT_PERMISSIONS;

  return Object.freeze({
    readPolicy,
    writablePolicy,
    writeEnabled,
    accessMode,
    managementPermissions,
    vaultSelector: vaultId,
    vaultName: entry.vaultName,
    vaultPath: entry.vaultPath,
    source: "settings" as const,
  });
}

function unconfiguredSettingsAccess(
  vault: string,
  deniedFolders: readonly string[],
): VaultAccess {
  return Object.freeze({
    readPolicy: denyPolicy(deniedFolders),
    writablePolicy: denyPolicy(deniedFolders),
    writeEnabled: false,
    accessMode: "protected",
    managementPermissions: NO_MANAGEMENT_PERMISSIONS,
    vaultSelector: vault,
    vaultName: vault,
    source: "settings" as const,
  });
}

function environmentAccess(
  vault: string,
  options: VaultAccessResolverOptions,
): VaultAccess {
  const readPolicy =
    options.environmentReadConfigured === true
      ? createPathPolicy({
          allowedFolders: options.allowedFolders,
          deniedFolders: options.deniedFolders,
        })
      : denyPolicy(options.deniedFolders);
  const writeEnabled = options.writableVaults.includes(vault);
  const writablePolicy = writeEnabled
    ? createWritablePathPolicy({
        allowedFolders: options.writableFolders,
        deniedFolders: options.deniedFolders,
        caseSensitive: readPolicy.caseSensitive,
      })
    : denyPolicy(options.deniedFolders);

  return Object.freeze({
    readPolicy,
    writablePolicy,
    writeEnabled,
    accessMode: "protected",
    managementPermissions: NO_MANAGEMENT_PERMISSIONS,
    vaultSelector: vault,
    vaultName: vault,
    source: "environment" as const,
  });
}

/**
 * Resolve one vault's effective access. The settings file is opened for every
 * invocation so panel changes and revocations take effect without a restart.
 */
export function createVaultAccessResolver(
  options: VaultAccessResolverOptions,
): VaultAccessResolver {
  const loader = options.readSettings ?? readSharedSettings;
  return async (vault: string): Promise<VaultAccess> => {
    const snapshot = await loader(options.settingsPath);
    if (snapshot.status === "loaded") {
      const normalizedId = /^[0-9a-f]{16}$/iu.test(vault)
        ? vault.toLowerCase()
        : undefined;
      if (
        normalizedId !== undefined &&
        Object.hasOwn(snapshot.settings.vaults, normalizedId)
      ) {
        return accessFromEntry(
          normalizedId,
          snapshot.settings.vaults[normalizedId]!,
          options.deniedFolders,
        );
      }

      // Names are labels only. Resolve them to exactly one stable ID and fail
      // closed when two registered vaults share the same display name.
      const namedEntries = Object.entries(snapshot.settings.vaults).filter(
        ([, entry]) => entry.vaultName === vault,
      );
      if (namedEntries.length === 1) {
        const [vaultId, entry] = namedEntries[0]!;
        return accessFromEntry(vaultId, entry, options.deniedFolders);
      }
      if (namedEntries.length > 1) {
        throw new SharedSettingsError(
          `vault name is ambiguous; use its stable Obsidian ID: ${vault}`,
        );
      }
      // Once the panel owns configuration, its vault map is authoritative.
      // Never let a missing or differently-cased key inherit broad legacy env
      // access (whose default read policy may allow the entire vault).
      return unconfiguredSettingsAccess(vault, options.deniedFolders);
    }
    return environmentAccess(vault, options);
  };
}

export function createConfigAccessResolver(
  config: BridgeConfig,
): VaultAccessResolver {
  if (config.settingsPath === undefined) {
    throw new Error(
      "BridgeConfig.settingsPath is required for shared settings",
    );
  }
  return createVaultAccessResolver({
    settingsPath: config.settingsPath,
    allowedFolders: config.allowedFolders,
    environmentReadConfigured: config.readEnvironmentConfigured ?? false,
    deniedFolders: config.deniedFolders,
    writableVaults: config.writableVaults ?? [],
    writableFolders: config.writableFolders ?? [],
  });
}
