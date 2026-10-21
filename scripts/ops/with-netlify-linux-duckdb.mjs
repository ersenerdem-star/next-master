import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtemp, readdir, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { absoluteNetlifyDeployPaths } from "./netlify-deploy-paths.mjs";

// Netlify CLI bundles functions from the caller's macOS node_modules. Hide
// macOS DuckDB binaries only for that bundle/deploy, then restore them even if
// the deploy fails. The staging site is pinned in package.json's command.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const scopedModules = join(root, "node_modules", "@duckdb");
const cli = join(root, "node_modules", ".bin", "netlify");
const scratch = await mkdtemp(join(tmpdir(), "netlify-duckdb-deploy-"));
const hidden = [];
const delimiter = process.argv.indexOf("--");
const command = absoluteNetlifyDeployPaths(delimiter < 0 ? [] : process.argv.slice(delimiter + 1), root);
if (command.length === 0 && !process.argv.includes("--verify-only")) {
  throw new Error("Expected --verify-only or -- followed by the Netlify deploy command");
}

try {
  execFileSync("node", ["scripts/ops/prepare-netlify-duckdb-linux.mjs"], { cwd: root, stdio: "inherit" });
  for (const name of await readdir(scopedModules)) {
    if (!name.startsWith("node-bindings-darwin-")) continue;
    const original = join(scopedModules, name);
    const moved = join(scratch, name);
    await rename(original, moved);
    hidden.push({ original, moved });
  }

  const bundle = join(scratch, "functions");
  execFileSync(cli, ["functions:build", "--src", "netlify/functions", "--functions", bundle], {
    cwd: root, stdio: "inherit",
  });
  const archive = join(bundle, "portal-export-worker-background.zip");
  const entries = execFileSync("unzip", ["-Z", "-1", archive], { encoding: "utf8" }).split("\n");
  for (const file of ["duckdb.node", "libduckdb.so"]) {
    assert.ok(entries.includes(`node_modules/@duckdb/node-bindings-linux-x64/${file}`), `${file} missing from Netlify export worker`);
  }
  assert.ok(!entries.some((entry) => entry.startsWith("node_modules/@duckdb/node-bindings-darwin-")),
    "macOS DuckDB binding leaked into Linux function bundle");
  const bytes = (await stat(archive)).size;
  assert.ok(bytes < 50_000_000, `Netlify export worker ZIP exceeds 50 MB (${bytes} bytes)`);
  console.log(`Netlify Linux DuckDB export worker bundle verified (${bytes} bytes)`);

  if (command.length > 0) execFileSync(command[0], command.slice(1), { cwd: root, stdio: "inherit" });
} finally {
  for (const { original, moved } of hidden.reverse()) await rename(moved, original);
  await rm(scratch, { recursive: true, force: true });
}
