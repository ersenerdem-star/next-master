import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const MANIFEST_NAME = ".netlify-duckdb-binding-integrity.json";
const PACKAGE_NAME = "@duckdb/node-bindings-linux-x64";

async function fileHash(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

async function bindingState(path) {
  const metadata = JSON.parse(await readFile(join(path, "package.json"), "utf8"));
  return {
    name: metadata.name,
    version: metadata.version,
    bindingSha256: await fileHash(join(path, "duckdb.node")),
    librarySha256: await fileHash(join(path, "libduckdb.so")),
  };
}

export async function recordPreparedBinding(path, locked) {
  const state = await bindingState(path);
  if (state.name !== PACKAGE_NAME || state.version !== locked.version) {
    throw new Error(`Unexpected ${PACKAGE_NAME} version`);
  }
  await writeFile(join(path, MANIFEST_NAME), JSON.stringify({ ...state, archiveIntegrity: locked.integrity }));
}

export async function isPreparedBinding(path, locked) {
  try {
    const expected = JSON.parse(await readFile(join(path, MANIFEST_NAME), "utf8"));
    const actual = await bindingState(path);
    return expected.archiveIntegrity === locked.integrity
      && actual.name === PACKAGE_NAME && actual.version === locked.version
      && expected.name === actual.name && expected.version === actual.version
      && expected.bindingSha256 === actual.bindingSha256
      && expected.librarySha256 === actual.librarySha256;
  } catch {
    return false;
  }
}
