import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

const appRoot = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(appRoot, "../..");
const packageJson = JSON.parse(readFileSync(resolve(appRoot, "package.json"), "utf8")) as { version?: string };

// A production deploy must never silently select the local example client.
if ((process.env.VITE_DEPLOY_CONTEXT || process.env.CONTEXT) === "production") {
  const env = { ...loadEnv("production", appRoot, "VITE_"), ...process.env };
  const url = env.VITE_SUPABASE_URL || "";
  const key = env.VITE_SUPABASE_ANON_KEY || "";
  let publicKey = key.startsWith("sb_publishable_");
  try { publicKey ||= JSON.parse(Buffer.from(key.split(".")[1] || "", "base64url").toString()).role === "anon"; } catch { /* Not a public JWT. */ }
  if (!/^https:\/\/[a-z0-9]+\.supabase\.co\/?$/.test(url) || url.includes("example.supabase.co") || !publicKey) {
    throw new Error("Production Supabase public client configuration is missing or invalid; refusing to build.");
  }
}

function readGitValue(command: string, fallback: string) {
  try {
    return execSync(command, { cwd: repoRoot, stdio: ["ignore", "pipe", "ignore"] }).toString().trim() || fallback;
  } catch {
    return fallback;
  }
}

const builtAt = new Date().toISOString();
const gitSha = process.env.COMMIT_REF || readGitValue("git rev-parse HEAD", "local");
const deployId = process.env.DEPLOY_ID || "";
const appVersion = packageJson.version || "0.0.0";

const buildMeta = {
  appId: "shared",
  appVersion,
  buildVersion: process.env.VITE_APP_BUILD_VERSION || deployId || gitSha,
  gitSha,
  deployId,
  builtAt,
  apiContractVersion: process.env.VITE_API_CONTRACT_VERSION || "2026-06-30",
  minSupportedVersion: process.env.VITE_MIN_SUPPORTED_VERSION || "",
  forceReload: process.env.VITE_FORCE_RELOAD === "true",
  environment: process.env.VITE_DEPLOY_CONTEXT || process.env.CONTEXT || "local",
  context: process.env.VITE_DEPLOY_CONTEXT || process.env.CONTEXT || "local",
  branch: process.env.HEAD || process.env.BRANCH || readGitValue("git rev-parse --abbrev-ref HEAD", "localhost"),
  commit: gitSha,
  deployUrl: process.env.DEPLOY_URL || "",
  siteUrl: process.env.URL || ""
};

function versionJsonPlugin(): Plugin {
  const source = `${JSON.stringify(buildMeta, null, 2)}\n`;
  return {
    name: "next-master-version-json",
    configureServer(server) {
      server.middlewares.use("/version.json", (_request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
        response.end(source);
      });
    },
    generateBundle() {
      this.emitFile({
        type: "asset",
        fileName: "version.json",
        source,
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), versionJsonPlugin()],
  define: {
    __APP_BUILD_META__: JSON.stringify(buildMeta)
  },
  server: {
    host: "localhost",
    port: 4173
  }
});
