import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { isPreparedBinding, recordPreparedBinding } from "../ops/netlify-duckdb-binding-state.mjs";

test("prepared Linux binding is invalidated by a version change or corrupted binary", async () => {
  const directory = await mkdtemp(join(tmpdir(), "duckdb-binding-state-test-"));
  const locked = { version: "1.5.6-r.1", integrity: "sha512-locked-archive" };
  try {
    await writeFile(join(directory, "package.json"), JSON.stringify({ name: "@duckdb/node-bindings-linux-x64", version: locked.version }));
    await writeFile(join(directory, "duckdb.node"), "binding-v1");
    await writeFile(join(directory, "libduckdb.so"), "library-v1");
    assert.equal(await isPreparedBinding(directory, locked), false);
    await recordPreparedBinding(directory, locked);
    assert.equal(await isPreparedBinding(directory, locked), true);
    assert.equal(await isPreparedBinding(directory, { ...locked, version: "1.5.7" }), false);
    assert.equal(await isPreparedBinding(directory, { ...locked, integrity: "sha512-different" }), false);
    await writeFile(join(directory, "duckdb.node"), "binding-corrupted");
    assert.equal(await isPreparedBinding(directory, locked), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
