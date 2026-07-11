import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

await mkdir(new URL("../dist/", import.meta.url), { recursive: true });
const outputPath = fileURLToPath(new URL("../dist/server.mjs", import.meta.url));

await build({
  entryPoints: [fileURLToPath(new URL("../src/server.ts", import.meta.url))],
  outfile: outputPath,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node20",
  sourcemap: false,
  minify: false,
  legalComments: "eof",
  banner: { js: "#!/usr/bin/env node" }
});

const output = await readFile(outputPath, "utf8");
await writeFile(outputPath, output.replace(/[\t ]+$/gmu, ""), "utf8");
