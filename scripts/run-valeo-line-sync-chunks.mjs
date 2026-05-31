import { syncBrandCatalog } from "../netlify/functions/_shared/catalog-sync-provider.mts";

const supabaseUrl = String(process.env.SUPABASE_URL || "").trim().replace(/\/+$/, "");
const serviceRoleKey = String(process.env.SUPABASE_SERVICE_ROLE_KEY || "").trim();
const brandName = String(process.argv[2] || "").trim();
const concurrencyArg = process.argv.find((arg) => arg.startsWith("--concurrency="));
const timeoutArg = process.argv.find((arg) => arg.startsWith("--timeout-ms="));
const lineIdsArg = process.argv.find((arg) => arg.startsWith("--line-ids="));

if (!supabaseUrl || !serviceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
}

if (!brandName) {
  throw new Error("Brand name argument is required");
}

const DEFAULT_VALEO_LINES = [
  { id: 12, name: "Air and Fuel Delivery" },
  { id: 4, name: "Belts and Cooling" },
  { id: 2, name: "Body" },
  { id: 3, name: "Brake" },
  { id: 6, name: "Electrical, Charging and Starting" },
  { id: 7, name: "Electrical, Lighting and Body" },
  { id: 9, name: "Emission Control" },
  { id: 10, name: "Engine" },
  { id: 13, name: "HVAC" },
  { id: 23, name: "Hardware and Service Supplies" },
  { id: 44, name: "Household, Shop and Office Products" },
  { id: 14, name: "Ignition" },
  { id: 46, name: "Oil, Fluids and Chemicals" },
  { id: 15, name: "Steering" },
  { id: 20, name: "Transmission" },
  { id: 18, name: "Vehicles, Equipment, Tools, and Supplies" },
  { id: 22, name: "Wiper and Washer" },
];

const requestedLineIds = String(lineIdsArg?.split("=")[1] || "")
  .split(",")
  .map((value) => Number.parseInt(value.trim(), 10))
  .filter((value) => Number.isFinite(value) && value > 0);

const selectedLines = requestedLineIds.length
  ? DEFAULT_VALEO_LINES.filter((line) => requestedLineIds.includes(line.id))
  : DEFAULT_VALEO_LINES;

const concurrency = Number.parseInt(concurrencyArg?.split("=")[1] || "4", 10);
const requestTimeoutMs = Number.parseInt(timeoutArg?.split("=")[1] || "20000", 10);

const summary = {
  brandName,
  linesProcessed: 0,
  resolvedRows: 0,
  candidateRows: 0,
  newRowsInListing: 0,
  replacementRows: 0,
  discontinuedRows: 0,
  lineSummaries: [],
};

for (const line of selectedLines) {
  console.log(`LINE_START ${line.id} ${line.name}`);
  const startedAt = Date.now();
  const result = await syncBrandCatalog({
    supabaseUrl,
    serviceRoleKey,
    brandName,
    refreshExisting: true,
    concurrency: Number.isFinite(concurrency) ? concurrency : 4,
    requestTimeoutMs: Number.isFinite(requestTimeoutMs) ? requestTimeoutMs : 20000,
    lineIds: [line.id],
  });
  const finishedAt = Date.now();
  summary.linesProcessed += 1;
  summary.resolvedRows += Number(result.resolvedRows || 0);
  summary.candidateRows += Number(result.candidateRows || 0);
  summary.newRowsInListing += Number(result.newRowsInListing || 0);
  summary.replacementRows += Number(result.replacementRows || 0);
  summary.discontinuedRows += Number(result.discontinuedRows || 0);
  summary.lineSummaries.push({
    lineId: line.id,
    lineName: line.name,
    durationMs: finishedAt - startedAt,
    resolvedRows: Number(result.resolvedRows || 0),
    candidateRows: Number(result.candidateRows || 0),
    newRowsInListing: Number(result.newRowsInListing || 0),
    replacementRows: Number(result.replacementRows || 0),
    discontinuedRows: Number(result.discontinuedRows || 0),
  });
  console.log(`LINE_DONE ${line.id} ${line.name} ${JSON.stringify(summary.lineSummaries.at(-1))}`);
}

console.log(JSON.stringify(summary, null, 2));
