import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { runSupplierPriceListExportJob, runCatalogExportJob, runCatalogMasterExportJob, type ExportJobRow } from "../../netlify/functions/_shared/export-jobs.mts";

const sourceUrl = "https://export-source.example.invalid";
const totalRows = 1001;

function exportJob(): ExportJobRow {
  const now = new Date().toISOString();
  return {
    id: "export-1", organization_id: "org-1", requested_by: "admin-1",
    audience: "admin", export_type: "supplier_price_list", status: "queued",
    scope: { supplierId: "supplier-1", supplierName: "Supplier", brandId: "brand-1", brandName: "Clevite", search: "SKU", freshness: "fresh", format: "csv" },
    cache_key: "cache-1", data_version: "version-1", file_name: null,
    content_type: null, storage_bucket: null, storage_path: null,
    row_count: 0, byte_size: 0, progress_total: null, progress_done: 0,
    progress_message: null, error_message: null, started_at: null,
    finalized_at: null, failed_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: now, updated_at: now,
  };
}

function priceRow(index: number, total: number | null = totalRows) {
  return {
    total_count: total,
    price_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    product_code: `SKU-${String(index).padStart(6, "0")}`,
    brand: "Clevite", description: `Bearing ${index}`, oem_no: `OEM-${index}`,
    buy_price: 12.34, currency: "EUR", price_date: "2026-10-14",
    moq: 2, order_multiple: 4, lead_time_days: 3, notes: "In stock", freshness: "fresh",
  };
}

type ExportKind = "supplier_price_list" | "catalog_export" | "catalog_master";
type Scenario = {
  kind?: ExportKind;
  pages?: Record<string, unknown>[][];
  pageSizes?: number[];
  version?: string;
  schemaVersion?: number;
};

async function withExportSource(scenario: Scenario, check: (state: {
  run: () => Promise<unknown>;
  job: ExportJobRow;
  pageRequests: Record<string, unknown>[];
  uploads: Uint8Array[];
  events: string[];
}) => Promise<void>) {
  const previousFetch = globalThis.fetch;
  const job = exportJob();
  const kind = scenario.kind || "supplier_price_list";
  job.export_type = kind;
  job.scope = { ...job.scope, marketSegment: "PC", scope: "catalog", marginA: 0.1, marginB: 0.15, schemaVersion: scenario.schemaVersion || 2 };
  const pageRpc = kind === "supplier_price_list" ? (scenario.schemaVersion === 3 ? "cloud_supplier_price_export_commercial_chunk_v3" : "cloud_supplier_price_export_chunk_v3")
    : kind === "catalog_export" ? "cloud_catalog_export_chunk_v3" : "cloud_catalog_master_export_chunk_v3";
  const versionRpc = kind === "supplier_price_list" ? "get_supplier_price_export_version"
    : kind === "catalog_export" ? "get_catalog_export_version" : "get_catalog_master_export_version";
  const pages = scenario.pages || [Array.from({ length: 1000 }, (_, index) => priceRow(index + 1)), [priceRow(1001, null)]];
  const pageRequests: Record<string, unknown>[] = [];
  const uploads: Uint8Array[] = [];
  const events: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, sourceUrl);
    if (url.pathname === "/rest/v1/app_export_jobs") {
      if (init?.method === "PATCH") {
        const patch = JSON.parse(String(init.body)) as Partial<ExportJobRow>;
        Object.assign(job, patch);
        events.push(`status:${job.status}`);
      }
      return Response.json([{ ...job }]);
    }
    if (url.pathname === `/rest/v1/rpc/${pageRpc}`) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.input_organization_id, "org-1");
      assert.equal(body.input_brand_id, "brand-1");
      if (kind === "supplier_price_list") {
        assert.equal(body.input_supplier_id, "supplier-1");
        assert.equal(body.input_search, "SKU");
        assert.equal(body.input_freshness, "fresh");
      } else if (kind === "catalog_export") {
        assert.equal(body.input_market_segment, "PC");
      } else {
        assert.equal(body.input_scope, "catalog");
        assert.equal(body.input_search, "SKU");
        assert.equal(body.input_margin_a, 0.1);
        assert.equal(body.input_margin_b, 0.15);
      }
      assert.equal(body.input_page_size, scenario.pageSizes?.[pageRequests.length] ?? 1000);
      pageRequests.push(body);
      events.push("source-page");
      assert.ok(pageRequests.length <= 3, "the worker must reject a repeated cursor instead of looping");
      return Response.json(pages[pageRequests.length - 1] || []);
    }
    if (url.pathname === `/rest/v1/rpc/${versionRpc}`) {
      events.push("source-version");
      return Response.json(scenario.version || "version-1");
    }
    if (url.pathname.startsWith("/storage/v1/object/")) {
      events.push("storage-upload");
      uploads.push(new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return Response.json({ Key: "artifact" });
    }
    throw new Error(`Unexpected export request: ${init?.method || "GET"} ${url.pathname}`);
  };
  try {
    const worker = kind === "supplier_price_list" ? runSupplierPriceListExportJob
      : kind === "catalog_export" ? runCatalogExportJob : runCatalogMasterExportJob;
    await check({ run: () => worker(sourceUrl, "test-service-key", job.id), job, pageRequests, uploads, events });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("supplier export follows the full keyset and publishes all rows only after version verification", async () => {
  await withExportSource({}, async ({ run, job, pageRequests, uploads, events }) => {
    await run();
    assert.equal(pageRequests.length, 2);
    assert.equal(pageRequests[0].input_after_product_code, null);
    assert.equal(pageRequests[0].input_after_id, null);
    assert.equal(pageRequests[1].input_after_product_code, priceRow(1000).product_code);
    assert.equal(pageRequests[1].input_after_id, priceRow(1000).price_id);
    assert.equal(job.status, "finalized");
    assert.equal(job.row_count, totalRows);
    assert.equal(job.progress_total, totalRows);
    assert.equal(uploads.length, 1);
    assert.ok(events.lastIndexOf("source-version") < events.indexOf("storage-upload"));
    const csv = new TextDecoder().decode(uploads[0]);
    const lines = csv.trim().split(/\r?\n/);
    assert.equal(lines.length, totalRows + 1);
    assert.match(lines[0], /Buy_Price_EUR/);
    assert.match(lines.at(-1)!, /SKU-001001/);
    assert.match(lines.at(-1)!, /12\.34/);
  });
});

test("supplier export consumes complete 5000-row JSON chunks after its initial count page", async () => {
  const expectedRows = 11_000;
  const pages = [
    Array.from({ length: 1000 }, (_, index) => priceRow(index + 1, expectedRows)),
    Array.from({ length: 5000 }, (_, index) => priceRow(index + 1001, null)),
    Array.from({ length: 5000 }, (_, index) => priceRow(index + 6001, null)),
  ];
  await withExportSource({ pages, pageSizes: [1000, 5000, 5000] }, async ({ run, job, pageRequests, uploads }) => {
    await run();
    assert.deepEqual(pageRequests.map((request) => request.input_page_size), [1000, 5000, 5000]);
    assert.equal(pageRequests[1].input_after_product_code, priceRow(1000).product_code);
    assert.equal(pageRequests[1].input_after_id, priceRow(1000).price_id);
    assert.equal(pageRequests[2].input_after_product_code, priceRow(6000).product_code);
    assert.equal(pageRequests[2].input_after_id, priceRow(6000).price_id);
    assert.equal(job.status, "finalized");
    assert.equal(job.row_count, expectedRows);
    assert.equal(job.progress_total, expectedRows);
    assert.equal(uploads.length, 1);
    const lines = new TextDecoder().decode(uploads[0]).trim().split(/\r?\n/);
    assert.equal(lines.length, expectedRows + 1);
    assert.match(lines[1001], /SKU-001001/);
    assert.match(lines[6001], /SKU-006001/);
    assert.match(lines.at(-1)!, /SKU-011000/);
    assert.equal(new Set(lines.slice(1)).size, expectedRows);
  });
});

test("supplier export rejects an early empty page rather than publishing a partial file", async () => {
  await withExportSource({ pages: [Array.from({ length: 1000 }, (_, index) => priceRow(index + 1)), []] }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /incomplete|count|complete/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});

test("supplier export requires a source total even when the first page is short", async () => {
  await withExportSource({ pages: [[priceRow(1, null)]] }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /count|total|verif/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});

test("supplier export rejects a source row without an identity instead of writing an empty product code", async () => {
  await withExportSource({ pages: [[{ ...priceRow(1, 1), product_code: "" }]] }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /invalid|source|identity/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});

test("supplier export rejects repeated cursor rows instead of counting them as new rows", async () => {
  await withExportSource({ pages: [Array.from({ length: 1000 }, (_, index) => priceRow(index + 1)), [priceRow(1000, null)]] }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /cursor|advance|duplicate/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});

test("supplier export rejects a prior non-boundary row that reappears after the page cursor", async () => {
  await withExportSource({ pages: [Array.from({ length: 1000 }, (_, index) => priceRow(index + 1)), [priceRow(999, null)]] }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /cursor|advance|duplicate/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});

test("supplier export refuses to publish when source prices change after its last page", async () => {
  await withExportSource({ version: "version-2" }, async ({ run, job, uploads, events }) => {
    await assert.rejects(run(), /changed|snapshot|version/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
    assert.ok(events.includes("source-version"));
  });
});

function catalogRow() {
  return {
    product_id: "00000000-0000-4000-8000-000000000001", product_code: "SKU-000001",
    brand: "Clevite", description: "Bearing", ean: "0012345678901", weight_kg: 0.125,
    market_segment: "PC", lifecycle_status: "active", total_count: 1,
  };
}

test("catalog export uses its scoped keyset source and preserves text identifiers in the CSV", async () => {
  await withExportSource({ kind: "catalog_export", pages: [[catalogRow()]] }, async ({ run, job, pageRequests, uploads, events }) => {
    await run();
    assert.equal(pageRequests.length, 1);
    assert.equal(pageRequests[0].input_after_id, null);
    assert.equal(job.status, "finalized");
    assert.equal(job.row_count, 1);
    assert.equal(uploads.length, 1);
    assert.match(new TextDecoder().decode(uploads[0]), /0012345678901/);
    assert.ok(events.lastIndexOf("source-version") < events.indexOf("storage-upload"));
  });
});

function masterRow() {
  return {
    ...catalogRow(), cursor_code: "SKU-000001", cursor_id: catalogRow().product_id,
    cheapest_supplier: "Supplier", cheapest_price: 12.34, second_supplier_name: "Supplier 2",
    second_price: 14.5, price_gap: 2.16, price_gap_percent: 17.5,
    sales_a: 13.57, sales_b: 14.19, supplier_count: 2, catalog_status: "In Catalog",
  };
}

test("master export preserves purchase and A/B sale amounts in the complete XLSX", async () => {
  await withExportSource({ kind: "catalog_master", pages: [[masterRow()]] }, async ({ run, job, pageRequests, uploads }) => {
    await run();
    assert.equal(pageRequests[0].input_after_code, null);
    assert.equal(pageRequests[0].input_after_id, null);
    assert.equal(job.status, "finalized");
    assert.equal(job.row_count, 1);
    assert.equal(uploads.length, 1);
    const workbook = XLSX.read(uploads[0], { type: "array" });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]]);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].Cheapest_EUR, 12.34);
    assert.equal(rows[0].A_Sales_EUR, 13.57);
    assert.equal(rows[0].B_Sales_EUR, 14.19);
  });
});

test("master export refuses stale purchase and sale prices before uploading its workbook", async () => {
  await withExportSource({ kind: "catalog_master", pages: [[masterRow()]], version: "version-2" }, async ({ run, job, uploads }) => {
    await assert.rejects(run(), /changed|snapshot|version/i);
    assert.equal(job.status, "failed");
    assert.equal(uploads.length, 0);
  });
});


test("supplier export v3 preserves real zero, unknown stock, pack rules and expired source dates", async () => {
  const pages = [[
    { ...priceRow(1, 2), stock_qty: 0, order_multiple: 4, valid_to: "2020-01-31" },
    { ...priceRow(2, null), stock_qty: null, order_multiple: null, valid_to: null },
  ]];
  await withExportSource({ pages, schemaVersion: 3 }, async ({ run, job, uploads }) => {
    await run();
    assert.equal(job.status, "finalized");
    const workbook = XLSX.read(uploads[0], { type: "array", raw: true });
    const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[workbook.SheetNames[0]], { defval: "", raw: true });
    assert.equal(rows.length, 2);
    assert.deepEqual(Object.keys(rows[0]), ["Supplier", "Product_Code", "Brand", "Product_Name", "OEM_No", "Buy_Price_EUR", "Price_Date", "MOQ", "Order_Multiple", "Lead_Time_Days", "Notes", "Stock_Qty", "Valid_To"]);
    assert.equal(String(rows[0].Stock_Qty), "0");
    assert.equal(String(rows[0].Order_Multiple), "4");
    assert.equal(rows[0].Valid_To, "2020-01-31");
    assert.equal(rows[1].Stock_Qty, "");
    assert.equal(rows[1].Order_Multiple, "");
    assert.equal(rows[1].Valid_To, "");
    assert.equal(Object.hasOwn(rows[0], "available_qty"), false);
  });
  await withExportSource({ pages, schemaVersion: 2 }, async ({ run, uploads }) => {
    await run();
    const header = new TextDecoder().decode(uploads[0]).split(/\r?\n/)[0];
    assert.doesNotMatch(header, /Stock_Qty|Valid_To/);
  });
});

test("supplier export v3 rejects missing or invalid commercial contracts before artifact publication", async () => {
  for (const fields of [{}, { stock_qty: -1, valid_to: null }, { stock_qty: 0, valid_to: "2026-02-30" }]) {
    await withExportSource({ pages: [[{ ...priceRow(1, 1), ...fields }]], schemaVersion: 3 }, async ({ run, uploads, job }) => {
      await assert.rejects(run(), /could not be verified/);
      assert.equal(job.status, "failed");
      assert.equal(uploads.length, 0);
    });
  }
});
