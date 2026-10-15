import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

const root = new URL("../../", import.meta.url);

test("portal export polling and download guards stay off the full source fingerprint", async () => {
  const [status, download, fallback] = await Promise.all([
    readFile(new URL("netlify/functions/portal-export-status.mts", root), "utf8"),
    readFile(new URL("netlify/functions/portal-export-download.mts", root), "utf8"),
    readFile(new URL("netlify/functions/portal-export-file.mts", root), "utf8"),
  ]);
  assert.match(status, /assertPortalExportJobCurrentContract\(job, invite\)/);
  assert.match(download, /assertPortalExportJobCurrentContract\(job, invite\)/);
  assert.match(fallback, /assertPortalExportJobCurrentContract\(job, invite\)/);
  for (const source of [status, download, fallback]) {
    assert.doesNotMatch(source, /assertPortalExportJobCurrentContext\(/);
  }
});

test("large portal worker is explicitly configured as a background function", async () => {
  const netlify = await readFile(new URL("netlify.toml", root), "utf8");
  const block = netlify.match(/\[functions\.\"portal-export-worker-background\"\]([\s\S]*?)(?=\n\[|$)/)?.[1] || "";
  assert.match(block, /background\s*=\s*true/);
});
