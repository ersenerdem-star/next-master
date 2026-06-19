import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function parseEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const text = fs.readFileSync(filePath, "utf8");
  const values = {};
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Z0-9_]+)\s*=\s*(.*)$/i);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    values[key] = value;
  }
  return values;
}

function loadLocalEnvCandidates(projectRoot) {
  const files = [
    path.join(projectRoot, ".sync-secrets.local"),
    path.join(projectRoot, ".env.sync.local"),
    path.join(projectRoot, ".env.local"),
    path.join(projectRoot, "apps/web/.env.local"),
  ];
  return files.reduce((acc, filePath) => Object.assign(acc, parseEnvFile(filePath)), {});
}

function tryNetlifyEnvGet(name, projectRoot, context = "production") {
  const candidates = ["npx", "netlify"];
  for (const command of candidates) {
    try {
      const args = command === "npx" ? ["netlify", "env:get", name, "--context", context] : ["env:get", name, "--context", context];
      const fetched = String(
        execFileSync(command, args, {
          cwd: projectRoot,
          encoding: "utf8",
          maxBuffer: 8 * 1024 * 1024,
          stdio: ["ignore", "pipe", "pipe"],
        }) || "",
      ).trim();
      if (fetched && !/^No value set\b/i.test(fetched)) return fetched;
    } catch {
      continue;
    }
  }
  return "";
}

export function resolveSyncEnvValue(name, {
  projectRoot,
  cliArgs = process.argv.slice(2),
  netlifyContext = "production",
  extraAliases = [],
} = {}) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;

  const aliases = [name, ...extraAliases];
  for (const alias of aliases) {
    const argPrefix = `--${alias.toLowerCase().replace(/_/g, "-")}=`;
    const match = cliArgs.find((arg) => arg.toLowerCase().startsWith(argPrefix));
    if (match) {
      const value = String(match.slice(argPrefix.length) || "").trim();
      if (value) return value;
    }
  }

  if (projectRoot) {
    const envFileValues = loadLocalEnvCandidates(projectRoot);
    for (const alias of aliases) {
      const value = String(envFileValues[alias] || "").trim();
      if (value) return value;
    }
    const fetched = tryNetlifyEnvGet(name, projectRoot, netlifyContext);
    if (fetched) return fetched;
  }

  return "";
}
