import { describe, expect, it } from "vitest";
import path from "node:path";

import {
  ManagementProtocolError,
  isVisibleMarkdownPath,
  managementRequestPath,
  parseManagementRequest,
  hashPresentDocument,
} from "../src/management-protocol.js";

const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
const CHANGE_ID = "22222222-2222-4222-8222-222222222222";
const TOKEN = "a".repeat(64);
const BEFORE = "b".repeat(64);

function request(operation: string, payload: unknown): Record<string, unknown> {
  return {
    version: 1,
    request_id: REQUEST_ID,
    token: TOKEN,
    change_id: CHANGE_ID,
    created_at: "2026-07-12T10:00:00.000Z",
    expires_at: "2026-07-12T10:05:00.000Z",
    vault_id: "0123456789abcdef",
    operation,
    path: "Scuola/Lezione.md",
    before_sha256: BEFORE,
    payload,
  };
}

function parse(value: unknown) {
  return parseManagementRequest(JSON.stringify(value));
}

describe("management request protocol v1", () => {
  it("parses every exact operation payload", () => {
    const content = "# Nuovo contenuto\n";
    expect(
      parse(request("replace", { content, after_sha256: hashPresentDocument(content) })),
    ).toMatchObject({ operation: "replace", payload: { content } });

    const frontmatter = parse(
      request("frontmatter", {
        set: { stato: "pronto", voto: 8, attivo: true, tags: ["a", "b"] },
        remove: ["vecchio"],
      }),
    );
    expect(frontmatter).toMatchObject({
      operation: "frontmatter",
      payload: { remove: ["vecchio"] },
    });

    expect(
      parse(request("move", { destination: "Archivio/Lezione.md" })),
    ).toMatchObject({
      operation: "move",
      payload: { destination: "Archivio/Lezione.md" },
    });
    expect(parse(request("trash", {}))).toMatchObject({
      operation: "trash",
      payload: {},
    });
  });

  it("rejects unknown base and operation-specific fields", () => {
    expect(() => parse({ ...request("trash", {}), surprise: true })).toThrow(
      ManagementProtocolError,
    );
    expect(() => parse(request("trash", { permanent: true }))).toThrow(
      /trash payload must be empty/u,
    );
    expect(() =>
      parse(
        request("replace", {
          content: "x",
          after_sha256: hashPresentDocument("x"),
          mode: "overwrite",
        }),
      ),
    ).toThrow(/replace payload/u);
  });

  it("accepts only normalized visible Markdown paths", () => {
    expect(isVisibleMarkdownPath("Scuola/Italiano/Nota.md")).toBe(true);
    expect(isVisibleMarkdownPath("Scuola/è una nota.MD")).toBe(true);
    for (const invalid of [
      "../Nota.md",
      "Scuola/../Nota.md",
      ".obsidian/plugins/x.md",
      "Scuola/.segreta.md",
      "C:/Vault/Nota.md",
      "/Nota.md",
      "Scuola\\Nota.md",
      "Scuola/Nota.txt",
      "Scuola//Nota.md",
    ]) {
      expect(isVisibleMarkdownPath(invalid), invalid).toBe(false);
      expect(() => parse({ ...request("trash", {}), path: invalid })).toThrow(
        /visible \.md path/u,
      );
    }
  });

  it("limits frontmatter to trimmed scalar keys and scalar arrays", () => {
    const invalidPayloads = [
      { set: {}, remove: [] },
      { set: { " spaced ": "x" }, remove: [] },
      { set: { nested: { unsafe: true } }, remove: [] },
      { set: { nested: [["unsafe"]] }, remove: [] },
      { set: { same: "x" }, remove: ["same"] },
      { set: {}, remove: ["a", "a"] },
      { set: JSON.parse('{"__proto__":"unsafe"}') as unknown, remove: [] },
    ];
    for (const payload of invalidPayloads) {
      expect(() => parse(request("frontmatter", payload))).toThrow(
        ManagementProtocolError,
      );
    }
  });

  it("binds replace content to its declared hash", () => {
    expect(() =>
      parse(
        request("replace", {
          content: "nuovo",
          after_sha256: hashPresentDocument("diverso"),
        }),
      ),
    ).toThrow(/does not match/u);
  });

  it("rejects invalid or excessive expiry windows", () => {
    expect(() =>
      parse({
        ...request("trash", {}),
        expires_at: "2026-07-12T10:00:00.000Z",
      }),
    ).toThrow(/expiry window/u);
    expect(() =>
      parse({
        ...request("trash", {}),
        expires_at: "2026-07-12T11:00:00.000Z",
      }),
    ).toThrow(/expiry window/u);
  });

  it("derives request paths only from absolute data roots and UUIDs", () => {
    const dataDirectory = path.resolve("BridgeData");
    const file = managementRequestPath(dataDirectory, REQUEST_ID);
    expect(file.replace(/\\/gu, "/")).toContain(
      `/management/requests/${REQUEST_ID}.json`,
    );
    expect(() => managementRequestPath("relative", REQUEST_ID)).toThrow(
      /absolute path/u,
    );
    expect(() => managementRequestPath(dataDirectory, "../request")).toThrow(
      /request_id/u,
    );
  });

  it("rejects invalid UTF-8 and oversized files before JSON parsing", () => {
    expect(() => parseManagementRequest(Buffer.from([0xff, 0xfe]))).toThrow(
      /UTF-8/u,
    );
    expect(() => parseManagementRequest(Buffer.alloc(1024 * 1024 + 1, 0x20))).toThrow(
      /between 2/u,
    );
  });
});
