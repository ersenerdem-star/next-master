import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { DuckDBInstance } from "@duckdb/node-api";
import { preflightCatalogCsv } from "../src/catalog-duckdb.mjs";

test("catalog DuckDB preflight closes its instance on success and query failure", async (t) => {
  const originalCreate = DuckDBInstance.create;
  let closed = 0;
  let failConnect = false;
  DuckDBInstance.create = async (...args) => {
    const instance = await originalCreate(...args);
    if (failConnect) instance.connect = async () => { throw new Error("CATALOG_DUCKDB_CONNECT_TEST"); };
    const originalClose = instance.closeSync.bind(instance);
    instance.closeSync = () => {
      closed += 1;
      return originalClose();
    };
    return instance;
  };
  t.after(() => {
    DuckDBInstance.create = originalCreate;
  });

  const directory = await mkdtemp(join(tmpdir(), "catalog-duckdb-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const validPath = join(directory, "valid.csv");
  await writeFile(validPath, "Brand,Product_Code\nClevite,A-1\n");

  assert.deepEqual(await preflightCatalogCsv({ inputPath: validPath, threads: 1 }), { engine: "duckdb", totalRows: 1 });
  await assert.rejects(preflightCatalogCsv({ inputPath: join(directory, "missing.csv"), threads: 1 }));
  failConnect = true;
  await assert.rejects(preflightCatalogCsv({ inputPath: validPath, threads: 1 }), /CATALOG_DUCKDB_CONNECT_TEST/);
  assert.equal(closed, 3, "every opened DuckDB instance is closed, including connection failures");
});
