import assert from "node:assert/strict";
import test from "node:test";
import * as XLSX from "xlsx";
import { createXlsxExportStream } from "../../netlify/functions/_shared/admin-export-stream.mts";

test("supplier detail sheets roll over without dropping or duplicating rows", async () => {
  const writer = await createXlsxExportStream(["Product"], "Master", { headers: ["Code", "Price"], sheetName: "Supplier Offers", maxRows: 2 });
  try {
    await writer.append([["001"], ["002"]]);
    await writer.appendAdditional!([["001", 3.89], ["001", 4.05], ["001", 4.96], ["002", 6]]);
    const workbook = XLSX.read(await writer.finish(), { type: "buffer" });
    assert.deepEqual(workbook.SheetNames, ["Master", "Supplier Offers 1", "Supplier Offers 2"]);
    const offers = workbook.SheetNames.slice(1).flatMap((name) => XLSX.utils.sheet_to_json<Record<string, unknown>>(workbook.Sheets[name]));
    assert.deepEqual(offers.map((row) => row.Price), [3.89, 4.05, 4.96, 6]);
    assert.deepEqual(offers.map((row) => row.Code), ["001", "001", "001", "002"]);
  } finally { await writer.cleanup(); }
});
