import { readFile, readdir } from "node:fs/promises";

const sourceRoot = new URL("../src/", import.meta.url);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const location = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) {
      files.push(...await sourceFiles(location));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(location);
    }
  }
  return files;
}

const forbidden = [
  ["Node child-process module", /(?:node:)?child_process/u],
  ["exec/execFile call", /\bexec(?:File)?(?:Sync)?\s*\(/u],
  ["spawn call", /\bspawn(?:Sync)?\s*\(/u],
  ["fork call", /\bfork\s*\(/u],
  ["shell execution option", /\bshell\s*:\s*true/u],
];

const targets = [
  ...await sourceFiles(sourceRoot),
  new URL("../main.js", import.meta.url),
];

for (const target of targets) {
  const contents = await readFile(target, "utf8");
  for (const [label, pattern] of forbidden) {
    if (pattern.test(contents)) {
      throw new Error(`${label} is forbidden in ${target.pathname}.`);
    }
  }
}

console.log("No process-execution primitives found in runtime source or bundle.");
