import { describe, expect, it } from "vitest";

import { authorizeManagementConfigDirectory } from "../src/management-authorization.js";
import type { ManagementRequest } from "../src/management-protocol.js";

function request(path: string, destination?: string): ManagementRequest {
  const base = {
    version: 1 as const,
    request_id: "00000000-0000-4000-8000-000000000001",
    token: "a".repeat(64),
    change_id: "00000000-0000-4000-8000-000000000002",
    created_at: "2026-07-12T10:00:00.000Z",
    expires_at: "2026-07-12T10:05:00.000Z",
    vault_id: "0123456789abcdef",
    path,
    before_sha256: "b".repeat(64),
  };
  return destination === undefined
    ? {
        ...base,
        operation: "trash",
        payload: {},
      }
    : {
        ...base,
        operation: "move",
        payload: { destination },
      };
}

describe("management config-directory authorization", () => {
  it("fails closed until configDir is recorded and when the live value changes", () => {
    expect(
      authorizeManagementConfigDirectory(request("Notes/A.md"), null, "Config"),
    ).toEqual({ allowed: false, errorCode: "CONFIG_DIRECTORY_UNVERIFIED" });
    expect(
      authorizeManagementConfigDirectory(
        request("Notes/A.md"),
        ".obsidian",
        "Config",
      ),
    ).toEqual({ allowed: false, errorCode: "CONFIG_DIRECTORY_CHANGED" });
  });

  it("denies source and move destination inside the live configDir", () => {
    expect(
      authorizeManagementConfigDirectory(
        request("config/plugins/A.md"),
        "Config",
        "Config",
      ),
    ).toEqual({ allowed: false, errorCode: "CONFIG_DIRECTORY_PATH_DENIED" });
    expect(
      authorizeManagementConfigDirectory(
        request("Notes/A.md", "Config/Archive/A.md"),
        "Config",
        "Config",
      ),
    ).toEqual({ allowed: false, errorCode: "CONFIG_DIRECTORY_PATH_DENIED" });

    expect(
      authorizeManagementConfigDirectory(
        request("workspace/config/plugins/bridge-control/data.md"),
        "Workspace/Config",
        "Workspace/Config",
      ),
    ).toEqual({ allowed: false, errorCode: "CONFIG_DIRECTORY_PATH_DENIED" });
  });

  it("allows ordinary paths only when stored and live configDir agree", () => {
    expect(
      authorizeManagementConfigDirectory(
        request("Notes/A.md", "Archive/A.md"),
        "Config",
        "config",
      ),
    ).toEqual({ allowed: true });
  });
});
