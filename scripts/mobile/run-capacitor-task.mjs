import fs from "node:fs/promises";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { loadConfig } = require("../../node_modules/@capacitor/cli/dist/config");
const { addCommand } = require("../../node_modules/@capacitor/cli/dist/tasks/add");
const { sync } = require("../../node_modules/@capacitor/cli/dist/tasks/sync");
const { copy } = require("../../node_modules/@capacitor/cli/dist/tasks/copy");
const { open } = require("../../node_modules/@capacitor/cli/dist/tasks/open");
const { update } = require("../../node_modules/@capacitor/cli/dist/tasks/update");
const { addIOS } = require("../../node_modules/@capacitor/cli/dist/ios/add");
const { editProjectSettingsIOS } = require("../../node_modules/@capacitor/cli/dist/ios/common");

async function exists(targetPath) {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function ensureIosScaffold(config) {
  if (!(await exists(config.ios.platformDirAbs))) {
    await addIOS(config);
    await editProjectSettingsIOS(config);
  }
}

async function addPlatform(config, platform) {
  if (platform === "android") {
    await addCommand(config, "android");
    return;
  }

  if (platform === "ios") {
    await ensureIosScaffold(config);
    if (await exists(config.app.webDirAbs)) {
      await copy(config, "ios", false);
    }
    process.stdout.write("iOS native project scaffolded and web assets copied.\n");
    return;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

async function syncPlatform(config, platform) {
  if (platform === "android") {
    await sync(config, "android", false, false);
    return;
  }

  if (platform === "ios") {
    await ensureIosScaffold(config);
    await copy(config, "ios", false);
    try {
      await update(config, "ios", false);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error || "");
      if (message.includes("CocoaPods")) {
        process.stdout.write("iOS web assets copied. This Mac still needs CocoaPods for the selected native dependency flow.\n");
        return;
      }
      throw error;
    }
    return;
  }

  throw new Error(`Unsupported platform: ${platform}`);
}

async function openPlatform(config, platform) {
  if (platform !== "android" && platform !== "ios") {
    throw new Error(`Unsupported platform: ${platform}`);
  }
  await open(config, platform);
}

async function main() {
  const [, , action = "", platform = "all"] = process.argv;
  const config = await loadConfig();

  if (action === "add") {
    if (platform === "all") {
      await addPlatform(config, "android");
      await addPlatform(config, "ios");
      return;
    }
    await addPlatform(config, platform);
    return;
  }

  if (action === "sync") {
    if (platform === "all") {
      if (await exists(config.android.platformDirAbs)) {
        await syncPlatform(config, "android");
      }
      if (await exists(config.ios.platformDirAbs)) {
        await syncPlatform(config, "ios");
      }
      return;
    }
    await syncPlatform(config, platform);
    return;
  }

  if (action === "open") {
    await openPlatform(config, platform);
    return;
  }

  throw new Error("Usage: node scripts/run-capacitor-task.mjs <add|sync|open> <android|ios|all>");
}

await main();
