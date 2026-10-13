import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isPreparedBinding, recordPreparedBinding } from "./netlify-duckdb-binding-state.mjs";

// A local macOS Netlify deploy does not install npm's optional Linux binding.
// The hosted background function needs the glibc x64 package in node_modules
// when Netlify bundles it, even though the local build runs on macOS.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = "@duckdb/node-bindings-linux-x64";
const destination = join(root, "node_modules", packageName);
const lock = JSON.parse(await readFile(join(root, "package-lock.json"), "utf8"));
const locked = lock.packages?.[`node_modules/${packageName}`];
if (!locked?.version || !locked?.integrity?.startsWith("sha512-")) {
  throw new Error(`Missing locked ${packageName} package`);
}

if (!await isPreparedBinding(destination, locked)) {
  const scratch = await mkdtemp(join(tmpdir(), "netlify-duckdb-linux-"));
  try {
    const archiveName = execFileSync("npm", ["pack", `${packageName}@${locked.version}`, "--pack-destination", scratch, "--silent"], {
      cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"],
    }).trim().split("\n").at(-1);
    const archive = join(scratch, archiveName);
    const integrity = `sha512-${createHash("sha512").update(await readFile(archive)).digest("base64")}`;
    if (integrity !== locked.integrity) throw new Error(`${packageName} archive integrity mismatch`);
    const unpacked = join(scratch, "unpacked");
    await mkdir(unpacked);
    execFileSync("tar", ["-xzf", archive, "--strip-components=1", "-C", unpacked]);
    await recordPreparedBinding(unpacked, locked);
    if (!await isPreparedBinding(unpacked, locked)) throw new Error(`${packageName} archive has no valid native binding`);
    await mkdir(dirname(destination), { recursive: true });
    await rm(destination, { recursive: true, force: true });
    await rename(unpacked, destination);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}
console.log(`${packageName}@${locked.version} ready for Netlify Linux function bundling`);
