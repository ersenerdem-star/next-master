import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, "..");

const tableConfigs = [
  { name: "profiles", orderBy: "id" },
  { name: "brands", orderBy: "id" },
  { name: "catalog_products", orderBy: "id" },
  { name: "supplier_prices", orderBy: "id" },
  { name: "customers", orderBy: "id" },
  { name: "vendors", orderBy: "id" },
  { name: "company_profiles", orderBy: "id" },
  { name: "customer_price_lists", orderBy: "id" },
  { name: "customer_price_list_items", orderBy: "id" },
  { name: "item_code_references", orderBy: "id" },
  { name: "sales_orders", orderBy: "id" },
  { name: "purchase_orders", orderBy: "id" },
  { name: "invoices", orderBy: "id" },
  { name: "bills", orderBy: "id" },
  { name: "payments_received", orderBy: "id" },
  { name: "payments_made", orderBy: "id" },
  { name: "warehouses", orderBy: "id" },
  { name: "purchase_receives", orderBy: "id" },
  { name: "inventory_movements", orderBy: "id" },
  { name: "stock_transfers", orderBy: "id" },
  { name: "portal_invites", orderBy: "id" },
  { name: "outbound_emails", orderBy: "id" },
  { name: "email_templates", orderBy: "id" },
  { name: "user_presence", orderBy: "user_id" },
];

function parseArgs(argv) {
  const options = {
    pageSize: 1000,
    tables: [],
  };

  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg.startsWith("--page-size=")) {
      const value = Number(arg.slice("--page-size=".length));
      if (Number.isFinite(value) && value > 0) options.pageSize = Math.max(100, Math.min(5000, Math.trunc(value)));
      continue;
    }
    if (arg.startsWith("--tables=")) {
      options.tables = arg
        .slice("--tables=".length)
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean);
    }
  }

  return options;
}

function runCommand(command, args) {
  return String(execFileSync(command, args, { cwd: repoRoot, encoding: "utf8" }) || "").trim();
}

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return runCommand("npx", ["netlify", "env:get", name]);
}

function normalizeDatePart(value) {
  return value.replace(/[:]/g, "-").replace(/\..+$/, "Z");
}

async function fetchTableRows({ supabaseUrl, serviceRoleKey, tableName, orderBy, pageSize }) {
  const rows = [];
  for (let offset = 0; ; offset += pageSize) {
    const url = new URL(`/rest/v1/${tableName}`, supabaseUrl);
    url.searchParams.set("select", "*");
    url.searchParams.set("order", `${orderBy}.asc`);
    url.searchParams.set("limit", String(pageSize));
    url.searchParams.set("offset", String(offset));
    const response = await fetch(url, {
      headers: {
        apikey: serviceRoleKey,
        Authorization: `Bearer ${serviceRoleKey}`,
      },
    });
    if (!response.ok) {
      throw new Error(`${tableName} archive failed: ${response.status} ${await response.text()}`);
    }
    const chunk = await response.json();
    if (!Array.isArray(chunk)) {
      throw new Error(`${tableName} archive failed: unexpected response payload`);
    }
    rows.push(...chunk);
    if (chunk.length < pageSize) break;
  }
  return rows;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const supabaseUrl = resolveEnvValue("SUPABASE_URL");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");

  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const configuredTables = options.tables.length
    ? tableConfigs.filter((config) => options.tables.includes(config.name))
    : [...tableConfigs];

  if (!configuredTables.length) {
    throw new Error("No archive tables selected");
  }

  const startedAt = new Date();
  const dateFolder = startedAt.toISOString().slice(0, 10);
  const runFolder = `run-${normalizeDatePart(startedAt.toISOString().slice(11))}`;
  const archiveDir = path.join(repoRoot, "backups", "daily", dateFolder, runFolder);
  mkdirSync(archiveDir, { recursive: true });

  const restoreDocSource = path.join(repoRoot, "docs", "ops", "system-restore-instructions.md");
  if (existsSync(restoreDocSource)) {
    cpSync(restoreDocSource, path.join(archiveDir, "HELP-RESTORE.md"));
  }

  const packageJsonPath = path.join(repoRoot, "package.json");
  if (existsSync(packageJsonPath)) {
    cpSync(packageJsonPath, path.join(archiveDir, "package.json"));
  }

  const migrationReadmePath = path.join(repoRoot, "supabase", "migrations", "README.md");
  if (existsSync(migrationReadmePath)) {
    cpSync(migrationReadmePath, path.join(archiveDir, "SUPABASE-MIGRATIONS-README.md"));
  }

  const tableSummaries = [];
  for (const table of configuredTables) {
    const rows = await fetchTableRows({
      supabaseUrl,
      serviceRoleKey,
      tableName: table.name,
      orderBy: table.orderBy,
      pageSize: options.pageSize,
    });
    writeFileSync(path.join(archiveDir, `${table.name}.json`), `${JSON.stringify(rows, null, 2)}\n`, "utf8");
    tableSummaries.push({
      table: table.name,
      rowCount: rows.length,
      orderBy: table.orderBy,
    });
  }

  const manifest = {
    created_at: startedAt.toISOString(),
    repo_root: repoRoot,
    archive_dir: archiveDir,
    git_branch: (() => {
      try {
        return runCommand("git", ["rev-parse", "--abbrev-ref", "HEAD"]);
      } catch {
        return "unknown";
      }
    })(),
    git_commit: (() => {
      try {
        return runCommand("git", ["rev-parse", "HEAD"]);
      } catch {
        return "unknown";
      }
    })(),
    tables: tableSummaries,
  };

  writeFileSync(path.join(archiveDir, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

  console.log(JSON.stringify({
    archive_dir: archiveDir,
    table_count: tableSummaries.length,
    total_rows: tableSummaries.reduce((sum, item) => sum + item.rowCount, 0),
  }, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
