import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

test("Netlify background export bundle contains the Linux DuckDB native binding", { timeout: 60_000 }, () => {
  execFileSync("node", ["scripts/ops/with-netlify-linux-duckdb.mjs", "--verify-only"], { cwd: root, stdio: "pipe" });
});
