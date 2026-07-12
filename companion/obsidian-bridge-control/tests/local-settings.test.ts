import { describe, expect, it } from "vitest";

import { coerceProtectedLocalSettings } from "../src/local-settings";
import type { VaultBridgeSettings } from "../src/shared-settings";

const DEFAULTS: VaultBridgeSettings = {
  accessMode: "protected",
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
      enabled: true,
      readMode: "all",
      readFolders: ["Study Notes"],
      writeEnabled: true,
      writeFolders: ["Study Notes"],
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
