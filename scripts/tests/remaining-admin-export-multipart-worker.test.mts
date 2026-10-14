import assert from "node:assert/strict";
import test from "node:test";
import {
  assertExportArtifactReady,
  runSupplierPriceListExportJob,
  toPublicExportJobStatus,
  type ExportJobRow,
} from "../../netlify/functions/_shared/export-jobs.mts";

const sourceUrl = "https://multipart-export.example.invalid";
const totalRows = 15_000;
const maximumPartBytes = 40 * 1024 * 1024;
const notes = `${"N".repeat(2999)}ş`;
const csvHeader = "Supplier,Product_Code,Brand,Product_Name,OEM_No,Buy_Price_EUR,Price_Date,MOQ,Order_Multiple,Lead_Time_Days,Notes";

type CapturedUpload = { path: string; body: Buffer; contentType: string; succeeded: boolean };

function newJob(): ExportJobRow {
  const now = new Date().toISOString();
  return {
    id: "multipart-job", organization_id: "org-1", requested_by: "admin-1",
    audience: "admin", export_type: "supplier_price_list", status: "queued",
    scope: { supplierId: "supplier-1", supplierName: "Supplier", brandId: "brand-1", brandName: "Clevite", search: "SKU", freshness: "fresh", format: "csv" },
    cache_key: "multipart-cache", data_version: "version-1", file_name: null,
    content_type: null, storage_bucket: null, storage_path: null,
    row_count: 0, byte_size: 0, progress_total: null, progress_done: 0,
    progress_message: null, error_message: null, started_at: null,
    finalized_at: null, failed_at: null,
    expires_at: new Date(Date.now() + 60_000).toISOString(), created_at: now, updated_at: now,
  };
}

function sourceRow(index: number, includeTotal: boolean) {
  return {
    total_count: includeTotal ? totalRows : null,
    price_id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    product_code: `SKU-${String(index).padStart(6, "0")}`,
    brand: "Clevite", description: `Bearing ${index}`, oem_no: `OEM-${index}`,
    buy_price: 12.34, currency: "EUR", price_date: "2026-10-14",
    moq: 2, order_multiple: 4, lead_time_days: 3, notes, freshness: "fresh",
  };
}

async function withMultipartWorker(
  failPart: number | null,
  check: (state: { run: () => Promise<void>; job: ExportJobRow; uploads: CapturedUpload[]; pageRequests: Record<string, unknown>[]; events: string[] }) => Promise<void>,
) {
  const previousFetch = globalThis.fetch;
  const job = newJob();
  const uploads: CapturedUpload[] = [];
  const pageRequests: Record<string, unknown>[] = [];
  const events: string[] = [];
  globalThis.fetch = async (input, init) => {
    const url = new URL(String(input));
    assert.equal(url.origin, sourceUrl);
    if (url.pathname === "/rest/v1/app_export_jobs") {
      if (init?.method === "PATCH") {
        const matches = ["id", "status", "updated_at", "started_at"].every((field) => {
          const condition = url.searchParams.get(field);
          return condition == null || condition === `eq.${job[field as keyof ExportJobRow]}`;
        });
        if (!matches) return Response.json([]);
        const patch = JSON.parse(String(init.body)) as Partial<ExportJobRow>;
        Object.assign(job, patch);
        if (patch.status) events.push(`status:${patch.status}`);
      }
      return Response.json([{ ...job }]);
    }
    if (url.pathname === "/rest/v1/rpc/cloud_supplier_price_export_chunk_v3") {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      assert.equal(body.input_organization_id, "org-1");
      assert.equal(body.input_supplier_id, "supplier-1");
      assert.equal(body.input_brand_id, "brand-1");
      assert.equal(body.input_search, "SKU");
      assert.equal(body.input_freshness, "fresh");
      const pageSize = pageRequests.length === 0 ? 1000 : 5000;
      assert.equal(body.input_page_size, pageSize);
      const after = body.input_after_product_code == null ? 0 : Number(String(body.input_after_product_code).slice(4));
      assert.equal(body.input_after_id, after === 0 ? null : sourceRow(after, false).price_id);
      pageRequests.push(body);
      assert.ok(pageRequests.length <= 4, "keyset must finish the bounded source in four requests");
      events.push("source-page");
      const count = Math.min(pageSize, totalRows - after);
      return Response.json(Array.from({ length: count }, (_, index) => sourceRow(after + index + 1, after === 0)));
    }
    if (url.pathname === "/rest/v1/rpc/get_supplier_price_export_version") {
      events.push("source-version");
      return Response.json("version-1");
    }
    if (url.pathname.startsWith("/storage/v1/object/app-exports/")) {
      assert.ok(Buffer.isBuffer(init?.body), "worker uploads raw binary chunks");
      const part = uploads.length + 1;
      const path = decodeURIComponent(url.pathname.slice("/storage/v1/object/app-exports/".length));
      const contentType = new Headers(init?.headers).get("Content-Type") || "";
      uploads.push({ path, body: init.body, contentType, succeeded: part !== failPart });
      events.push(`upload:${part}`);
      return part === failPart
        ? Response.json({ message: "simulated second part upload failure" }, { status: 503 })
        : Response.json({ Key: path });
    }
    throw new Error(`Unexpected multipart export request: ${url.pathname}`);
  };
  try {
    await check({ run: () => runSupplierPriceListExportJob(sourceUrl, "test-key", job.id), job, uploads, pageRequests, events });
  } finally {
    globalThis.fetch = previousFetch;
  }
}

test("actual supplier worker publishes a complete multipart CSV only after every bounded binary upload succeeds", { concurrency: false }, async () => {
  await withMultipartWorker(null, async ({ run, job, uploads, pageRequests, events }) => {
    await run();
    assert.equal(job.status, "finalized");
    assert.equal(job.row_count, totalRows);
    assert.equal(job.progress_total, totalRows);
    assert.equal(job.content_type, "text/csv");
    assert.ok(job.byte_size > maximumPartBytes);
    assert.equal(uploads.length, 2);
    assert.deepEqual(pageRequests.map((request) => request.input_page_size), [1000, 5000, 5000, 5000]);
    assert.deepEqual(pageRequests.map((request) => request.input_after_product_code), [null, "SKU-001000", "SKU-006000", "SKU-011000"]);
    assert.ok(uploads.every((part) => part.succeeded && part.body.byteLength > 0 && part.body.byteLength <= maximumPartBytes));
    assert.ok(uploads.every((part) => part.contentType === "application/octet-stream"));
    assert.equal(uploads[0].body.byteLength, maximumPartBytes);
    assert.equal(uploads.reduce((sum, part) => sum + part.body.byteLength, 0), job.byte_size);
    assert.equal(new Set(uploads.map((part) => part.path)).size, uploads.length);
    for (const [index, part] of uploads.entries()) {
      assert.match(part.path, /^org-1\/supplier-price\/multipart-cache\/[a-f0-9]{24}\//);
      assert.ok(part.path.endsWith(`${job.file_name}.part-${String(index + 1).padStart(3, "0")}`));
    }
    assert.equal(job.storage_path, uploads[0].path);
    assert.deepEqual(job.scope.artifactParts, uploads.map((part) => ({ path: part.path, byteSize: part.body.byteLength })));
    assert.ok(events.indexOf("source-version") < events.indexOf("upload:1"));
    assert.ok(events.indexOf("upload:2") < events.indexOf("status:finalized"));
    assert.doesNotThrow(() => assertExportArtifactReady(job));

    const completeCsv = Buffer.concat(uploads.map((part) => part.body));
    assert.equal(completeCsv.byteLength, job.byte_size);
    const lines = completeCsv.toString("utf8").replace(/^\uFEFF/, "").trimEnd().split("\n");
    assert.equal(lines.length, totalRows + 1);
    assert.equal(lines[0], csvHeader);
    assert.equal(lines.filter((line) => line === csvHeader).length, 1);
    const codes = new Set<string>();
    for (let index = 1; index <= totalRows; index += 1) {
      const fields = lines[index].split(",");
      assert.equal(fields.length, 11);
      assert.equal(fields[1], sourceRow(index, false).product_code);
      assert.equal(fields[5], "12.34");
      assert.equal(fields[10], notes);
      codes.add(fields[1]);
    }
    assert.equal(codes.size, totalRows);
  });
});

test("failure uploading the second binary part never exposes the first part as a finished export", { concurrency: false }, async () => {
  await withMultipartWorker(2, async ({ run, job, uploads, events }) => {
    await assert.rejects(run(), /simulated second part upload failure/);
    assert.equal(uploads.length, 2);
    assert.equal(uploads[0].succeeded, true);
    assert.equal(uploads[1].succeeded, false);
    assert.equal(job.status, "failed");
    assert.equal(toPublicExportJobStatus(job).status, "failed");
    assert.equal(job.finalized_at, null);
    assert.equal(job.storage_path, null);
    assert.equal(job.storage_bucket, null);
    assert.equal(job.scope.artifactParts, undefined);
    assert.equal(events.includes("status:finalized"), false);
    assert.throws(() => assertExportArtifactReady(job), /not ready/);
  });
});
