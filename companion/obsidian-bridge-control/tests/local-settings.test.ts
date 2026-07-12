import { describe, expect, it } from "vitest";

import { coerceProtectedLocalSettings } from "../src/local-settings";
import type { VaultBridgeSettings } from "../src/shared-settings";

const DEFAULTS: VaultBridgeSettings = {
  accessMode: "protected",
  managementPermissions: { edit: false, move: false, trash: false },
  enabled: false,
  readMode: "folders",
  readFolders: ["Bridge Test"],
  writeEnabled: false,
  writeFolders: ["Bridge Test"],
};

describe("local plugin-data fallback", () => {
  it("never restores full access when authoritative shared settings are absent", () => {
    expect(
      coerceProtectedLocalSettings(
        {
          accessMode: "full",
          enabled: true,
          readMode: "all",
          readFolders: ["Study Notes"],
          writeEnabled: true,
          writeFolders: ["Study Notes"],
        },
        DEFAULTS,
      ),
    ).toEqual({
      accessMode: "protected",
      managementPermissions: { edit: false, move: false, trash: false },
      enabled: true,
      readMode: "all",
      readFolders: ["Study Notes"],
      writeEnabled: true,
      writeFolders: ["Study Notes"],
    });
  });

  it("never restores management access or capabilities from the local cache", () => {
    expect(
      coerceProtectedLocalSettings(
        {
          accessMode: "management",
          managementPermissions: { edit: true, move: true, trash: true },
          enabled: true,
          readMode: "all",
          readFolders: ["Study Notes"],
          writeEnabled: true,
          writeFolders: ["Study Notes"],
        },
        DEFAULTS,
      ),
    ).toMatchObject({
      accessMode: "protected",
      managementPermissions: { edit: false, move: false, trash: false },
    });
  });

  it("falls back safely when cached folders are malformed", () => {
    expect(
      coerceProtectedLocalSettings(
        {
          accessMode: "full",
          enabled: true,
          readMode: "folders",
          readFolders: ["../outside"],
          writeEnabled: true,
          writeFolders: [],
        },
        DEFAULTS,
      ),
    ).toEqual({
      ...DEFAULTS,
      enabled: true,
      writeFolders: [],
    });
  });
});
