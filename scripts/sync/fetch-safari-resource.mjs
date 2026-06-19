#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

const targetPath = String(process.argv[2] || "").trim();
const outputPath = String(process.argv[3] || "").trim();

if (!targetPath || !outputPath) {
  throw new Error("Usage: node scripts/fetch-safari-resource.mjs <path-or-url> <output-file>");
}

const jsCode = [
  "(function(){",
  `var target=${JSON.stringify(targetPath)};`,
  "var x=new XMLHttpRequest();",
  "x.open('GET', target, false);",
  "x.send(null);",
  "if (x.status < 200 || x.status >= 400) {",
  "  return JSON.stringify({ ok:false, status:x.status, body:String(x.responseText||'').slice(0,2000) });",
  "}",
  "return JSON.stringify({ ok:true, status:x.status, body:String(x.responseText||'') });",
  "})()",
].join("");

const raw = execFileSync(
  "osascript",
  ["-e", `tell application "Safari" to do JavaScript ${JSON.stringify(jsCode)} in current tab of front window`],
  {
    encoding: "utf8",
    maxBuffer: 128 * 1024 * 1024,
  },
).trim();

const payload = JSON.parse(raw || "{}");
if (!payload.ok) {
  throw new Error(`Safari resource fetch failed: ${payload.status || "unknown"} ${payload.body || ""}`.trim());
}

const absoluteOutput = path.resolve(outputPath);
fs.mkdirSync(path.dirname(absoluteOutput), { recursive: true });
fs.writeFileSync(absoluteOutput, `${payload.body}`, "utf8");
console.log(JSON.stringify({ targetPath, outputPath: absoluteOutput, bytes: Buffer.byteLength(payload.body || "", "utf8") }, null, 2));
