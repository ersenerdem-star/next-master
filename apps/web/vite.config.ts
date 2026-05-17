import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const buildMeta = {
  context: process.env.VITE_DEPLOY_CONTEXT || process.env.CONTEXT || "local",
  branch: process.env.HEAD || process.env.BRANCH || "localhost",
  commit: process.env.COMMIT_REF || "local",
  builtAt: new Date().toISOString(),
  deployUrl: process.env.DEPLOY_URL || "",
  siteUrl: process.env.URL || ""
};

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_BUILD_META__: JSON.stringify(buildMeta)
  },
  server: {
    host: "localhost",
    port: 4173
  }
});
