#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_SITE_NAME = "ersen-quote-desk";
const DEFAULT_SITE_URL = "https://ersen-quote-desk.netlify.app";

function read(command, args, options = {}) {
  return String(execFileSync(command, args, { encoding: "utf8", ...options }) || "").trim();
}

function commandExists(command) {
  return spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" }).status === 0;
}

function readJson(filePath) {
  if (!existsSync(filePath)) return null;
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function trimSlash(value) {
  return String(value || "").replace(/\/+$/, "");
}

function parseArgs(argv) {
  const options = {
    commit: "",
    strict: false,
    timeoutMs: 8000,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--commit") {
      options.commit = String(argv[index + 1] || "").trim();
      index += 1;
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--timeout-ms") {
      options.timeoutMs = Number(argv[index + 1] || options.timeoutMs);
      index += 1;
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }
  return options;
}

function resolveNetlifyState(repoRoot) {
  const localState = readJson(path.join(repoRoot, ".netlify", "state.json")) || {};
  const siteId = process.env.NETLIFY_SITE_ID || localState.siteId || "";
  return {
    siteId,
    localLinked: Boolean(siteId),
    siteName: process.env.NETLIFY_SITE_NAME || localState.siteName || DEFAULT_SITE_NAME,
    siteUrl: trimSlash(process.env.NETLIFY_SITE_URL || process.env.URL || localState.siteUrl || DEFAULT_SITE_URL),
  };
}

function resolveGitState(options) {
  const commit = options.commit || read("git", ["rev-parse", "HEAD"]);
  return {
    branch: read("git", ["branch", "--show-current"]),
    commit,
    shortCommit: commit.slice(0, 8),
    remote: read("git", ["remote", "get-url", "origin"]),
  };
}

async function fetchText(url, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        "Cache-Control": "no-cache",
        Pragma: "no-cache",
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function extractAssetUrls(siteUrl, html) {
  const urls = [];
  const pattern = /<(?:script|link)\b[^>]+(?:src|href)=["']([^"']+\.(?:js|css)(?:\?[^"']*)?)["']/g;
  for (const match of html.matchAll(pattern)) {
    try {
      urls.push(new URL(match[1], `${siteUrl}/`).toString());
    } catch {
      // Ignore malformed asset references.
    }
  }
  return [...new Set(urls)].filter((url) => url.includes("/assets/")).slice(0, 8);
}

function extractBuildMeta(source) {
  const commit = source.match(/\bcommit\s*:\s*["']([^"']+)["']/)?.[1] || "";
  const builtAt = source.match(/\bbuiltAt\s*:\s*["']([^"']+)["']/)?.[1] || "";
  const deployUrl = source.match(/\bdeployUrl\s*:\s*["']([^"']*)["']/)?.[1] || "";
  return { commit, builtAt, deployUrl };
}

async function checkLiveSite({ siteUrl, expectedCommit, timeoutMs }) {
  const expectedShort = expectedCommit.slice(0, 8);
  const checkedUrls = [];
  const html = await fetchText(`${siteUrl}/?deploy_check=${Date.now()}`, timeoutMs);
  checkedUrls.push(siteUrl);

  if (html.includes(expectedCommit) || html.includes(expectedShort)) {
    return { status: "confirmed", checkedUrls, visibleCommit: expectedShort, builtAt: "" };
  }

  let visibleCommit = "";
  let builtAt = "";
  for (const url of extractAssetUrls(siteUrl, html)) {
    const source = await fetchText(url, timeoutMs);
    checkedUrls.push(url);
    if (source.includes(expectedCommit) || source.includes(expectedShort)) {
      const meta = extractBuildMeta(source);
      return {
        status: "confirmed",
        checkedUrls,
        visibleCommit: meta.commit || expectedShort,
        builtAt: meta.builtAt || "",
      };
    }
    const meta = extractBuildMeta(source);
    if (meta.commit && !visibleCommit) visibleCommit = meta.commit;
    if (meta.builtAt && !builtAt) builtAt = meta.builtAt;
  }

  return {
    status: "pending",
    checkedUrls,
    visibleCommit,
    builtAt,
  };
}

function printSummary({ netlifyState, gitState, live }) {
  console.log("Production deploy workflow status");
  console.log(`- route: Git-connected Netlify production site`);
  console.log(`- site: ${netlifyState.siteName} (${netlifyState.siteUrl})`);
  console.log(`- source: ${gitState.branch} ${gitState.shortCommit}`);
  console.log(`- remote: ${gitState.remote}`);
  console.log(`- local Netlify CLI state: ${netlifyState.localLinked ? "linked" : "bootstrap required (run npm run netlify:ensure-link)"}`);

  if (live.status === "confirmed") {
    console.log(`- live check: confirmed ${gitState.shortCommit}`);
    if (live.builtAt) console.log(`- live builtAt: ${live.builtAt}`);
    return;
  }

  if (live.status === "pending") {
    const visible = live.visibleCommit ? ` currently visible ${live.visibleCommit.slice(0, 8)}` : "";
    console.log(`- live check: deploy not visible yet; Netlify may still be building.${visible}`);
    console.log("- next automatic action: rerun npm run deploy:status after the Netlify build finishes");
    return;
  }

  console.log(`- live check: status unavailable (${live.reason})`);
  console.log("- next automatic action: Git-connected deploy remains the source of truth; rerun npm run deploy:status");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const repoRoot = read("git", ["rev-parse", "--show-toplevel"]);
  const netlifyState = resolveNetlifyState(repoRoot);
  const gitState = resolveGitState(options);

  let live;
  if (typeof fetch !== "function") {
    live = { status: "unavailable", reason: "node-fetch-unavailable" };
  } else if (!netlifyState.siteUrl) {
    live = { status: "unavailable", reason: "site-url-not-configured" };
  } else {
    try {
      live = await checkLiveSite({
        siteUrl: netlifyState.siteUrl,
        expectedCommit: gitState.commit,
        timeoutMs: options.timeoutMs,
      });
    } catch (error) {
      live = { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
    }
  }

  printSummary({ netlifyState, gitState, live });

  if (options.strict && live.status !== "confirmed") {
    process.exitCode = 1;
  }

  if (!commandExists("npx")) {
    console.log("- note: npx is unavailable, but deploy status does not depend on local CLI link");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
