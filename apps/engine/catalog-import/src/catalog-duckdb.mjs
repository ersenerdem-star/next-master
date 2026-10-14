import { DuckDBInstance } from "@duckdb/node-api";

function quote(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

function safePath(value) {
  if (typeof value !== "string" || !value || value.includes("\0")) throw new Error("CATALOG_DUCKDB_PATH_INVALID");
  return value;
}

/**
 * DuckDB is used as a bounded source preflight. It detects the CSV dialect,
 * rejects malformed rows before any staging RPC, and gives the worker a
 * source row count. Catalog domain validation remains in the existing SQL
 * stage/validate/finalize boundary.
 */
export async function preflightCatalogCsv({ inputPath, memoryLimit = "512MB", threads = 4, tempDirectory } = {}) {
  const path = safePath(inputPath);
  const instance = await DuckDBInstance.create(":memory:", {
    memory_limit: memoryLimit,
    threads: String(threads),
    ...(tempDirectory ? { temp_directory: tempDirectory } : {}),
  });
  let connection;
  try {
    connection = await instance.connect();
    const source = `read_csv_auto(${quote(path)}, header=true, all_varchar=true, ignore_errors=false, strict_mode=true)`;
    const reader = await connection.runAndReadAll(`select count(*)::UBIGINT as total_rows from ${source}`);
    const raw = reader.getRowObjectsJson()?.[0]?.total_rows;
    const totalRows = Number(raw);
    if (!Number.isSafeInteger(totalRows) || totalRows < 1) throw new Error("CATALOG_SOURCE_NO_ROWS");
    return { engine: "duckdb", totalRows };
  } finally {
    connection?.disconnectSync();
    instance.closeSync();
  }
}
