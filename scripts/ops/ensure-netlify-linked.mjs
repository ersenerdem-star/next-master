#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const repoRoot = path.resolve(path.dirname(__filename), "../..");
const statePath = path.join(repoRoot, ".netlify", "state.json");

const targetState = {
  siteId: "08d7af8d-484c-4dba-a069-234e52dcfd6c",
  siteName: "ersen-quote-desk",
  siteUrl: "https://ersen-quote-desk.netlify.app",
  adminUrl: "https://app.netlify.com/projects/ersen-quote-desk",
};

function readState() {
  if (!existsSync(statePath)) return {};
  try {
    return JSON.parse(readFileSync(statePath, "utf8"));
  } catch {
    return {};
  }
}

function writeState(state) {
  mkdirSync(path.dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

const currentState = readState();
const mergedState = {
  ...currentState,
  ...targetState,
  siteId: targetState.siteId,
};

if (currentState.siteId !== targetState.siteId || currentState.siteName !== targetState.siteName || currentState.siteUrl !== targetState.siteUrl) {
  writeState(mergedState);
  console.log(`Netlify CLI state linked to ${targetState.siteName}`);
  console.log(`- state file: ${statePath}`);
  console.log(`- site id: ${targetState.siteId}`);
  console.log(`- admin url: ${targetState.adminUrl}`);
} else {
  console.log(`Netlify CLI state already linked to ${targetState.siteName}`);
  console.log(`- state file: ${statePath}`);
}
