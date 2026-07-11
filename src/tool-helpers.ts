import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

import { filterAllowedPaths, type PathPolicy } from "./path-policy.js";

export interface LineSelection {
  readonly content: string;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number;
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function jsonResult(value: unknown): CallToolResult {
  return textResult(JSON.stringify(value, null, 2));
}

export function errorResult(error: unknown): CallToolResult {
  const message = error instanceof Error ? error.message : String(error);
  return {
    content: [{ type: "text", text: message.slice(0, 2_000) }],
    isError: true,
  };
}

export function selectLineRange(
  content: string,
  startLine = 1,
  endLine?: number,
): LineSelection {
  if (!Number.isSafeInteger(startLine) || startLine < 1) {
    throw new RangeError("start_line must be a positive integer");
  }
  if (
    endLine !== undefined &&
    (!Number.isSafeInteger(endLine) || endLine < startLine)
  ) {
    throw new RangeError("end_line must be greater than or equal to start_line");
  }

  const normalized = content.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
  const lines = normalized.length === 0 ? [] : normalized.split("\n");
  if (normalized.endsWith("\n")) {
    lines.pop();
  }
  const totalLines = lines.length;
  const effectiveEnd = Math.min(endLine ?? totalLines, totalLines);
  const selected =
    startLine > effectiveEnd
      ? ""
      : lines.slice(startLine - 1, effectiveEnd).join("\n");

  return {
    content: selected,
    startLine,
    endLine: Math.max(0, effectiveEnd),
    totalLines,
  };
}

export function numberLineSelection(selection: LineSelection): string {
  if (selection.content.length === 0) return "";
  return selection.content
    .split("\n")
    .map((line, index) => `${selection.startLine + index}: ${line}`)
    .join("\n");
}

function collectJsonPathCandidates(value: unknown, output: string[]): void {
  if (typeof value === "string") {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectJsonPathCandidates(item, output);
    return;
  }
  if (value === null || typeof value !== "object") return;

  const record = value as Record<string, unknown>;
  const pathKeys = ["path", "file", "source", "target"];
  let foundPathKey = false;
  for (const key of pathKeys) {
    if (key in record) {
      foundPathKey = true;
      collectJsonPathCandidates(record[key], output);
    }
  }
  if (!foundPathKey) {
    for (const nested of Object.values(record)) {
      if (Array.isArray(nested) || (nested !== null && typeof nested === "object")) {
        collectJsonPathCandidates(nested, output);
      }
    }
  }
}

function cleanTextPathCandidate(line: string): string {
  const withoutBullet = line.trim().replace(/^[-*]\s+/u, "");
  const firstColumn = withoutBullet.split("\t", 1)[0] ?? "";
  if (firstColumn.startsWith('"') && firstColumn.endsWith('"')) {
    try {
      const parsed = JSON.parse(firstColumn) as unknown;
      if (typeof parsed === "string") return parsed;
    } catch {
      // Fall through to the literal value.
    }
  }
  return firstColumn;
}

/** Parse untrusted CLI path output and enforce the path policy on every item. */
export function extractAllowedNotePaths(
  output: string,
  policy: PathPolicy,
): string[] {
  const candidates: string[] = [];
  const trimmed = output.trim();

  if (trimmed.length > 0) {
    try {
      collectJsonPathCandidates(JSON.parse(trimmed) as unknown, candidates);
    } catch {
      for (const line of trimmed.split(/\r?\n/u)) {
        const candidate = cleanTextPathCandidate(line);
        if (candidate.length > 0) candidates.push(candidate);
      }
    }
  }

  return filterAllowedPaths(candidates, policy);
}

export function parseJsonOrLines(output: string): unknown {
  const trimmed = output.trim();
  if (trimmed.length === 0) return [];
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return trimmed.split(/\r?\n/u).filter((line) => line.length > 0);
  }
}

export function parseKeyValueLines(output: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of output.trim().split(/\r?\n/u)) {
    const separator = line.search(/[\t ]/u);
    if (separator < 1) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key.length > 0) result[key] = value;
  }
  return result;
}

export function parseVaultList(output: string): Array<{
  readonly name: string;
  readonly path?: string;
}> {
  const trimmedOutput = output.trim();
  if (trimmedOutput.length === 0) return [];

  try {
    const parsed = JSON.parse(trimmedOutput) as unknown;
    if (Array.isArray(parsed)) {
      const jsonResult: Array<{ name: string; path?: string }> = [];
      for (const item of parsed) {
        if (typeof item === "string" && item.trim().length > 0) {
          jsonResult.push({ name: item.trim() });
          continue;
        }
        if (item === null || typeof item !== "object") continue;
        const record = item as Record<string, unknown>;
        if (typeof record.name !== "string" || record.name.trim().length === 0) {
          continue;
        }
        const name = record.name.trim();
        const vaultPath =
          typeof record.path === "string" ? record.path.trim() : "";
        jsonResult.push(vaultPath.length > 0 ? { name, path: vaultPath } : { name });
      }
      return jsonResult;
    }
  } catch {
    // Fall through to the documented line-oriented CLI output.
  }

  const result: Array<{ name: string; path?: string }> = [];
  for (const line of trimmedOutput.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    const columns = trimmed.split("\t");
    const name = columns[0]?.trim();
    if (name === undefined || name.length === 0) continue;
    const vaultPath = columns.slice(1).join("\t").trim();
    result.push(vaultPath.length > 0 ? { name, path: vaultPath } : { name });
  }
  return result;
}
