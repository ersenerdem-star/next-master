// DBOS recovery and the named application queue have independent concurrency
// limits. They can therefore both invoke the storage importer in one worker.
// Keep this lock process-local: DBOS remains the durable ownership/retry
// boundary, while the lock only protects concurrent heavy source work in this
// Node process (download, DuckDB preflight and staging).
let queueTail = Promise.resolve();

export async function withCatalogHeavyImportGate(work) {
  if (typeof work !== "function") throw new TypeError("CATALOG_IMPORT_GATE_WORK_REQUIRED");
  let release;
  const previous = queueTail;
  queueTail = new Promise((resolve) => { release = resolve; });
  await previous;
  try {
    return await work();
  } finally {
    release();
  }
}
