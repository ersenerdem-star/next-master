import test from "node:test";
import assert from "node:assert/strict";
import { createThrottledExportProgress } from "../../netlify/functions/_shared/v3-export-progress.mts";

test("V3 export progress skips intermediate writes but reports phase boundaries", async () => {
  let clock = 0;
  const reported: Array<[string, number, number]> = [];
  const progress = createThrottledExportProgress({
    expectedRows: 100_000,
    now: () => clock,
    report: async (event) => { reported.push([event.stage, event.processedRows!, event.totalRows]); },
  });

  assert.equal(await progress({ stage: "partitioning", processedRows: 5_000 }), true);
  clock = 1_000;
  assert.equal(await progress({ stage: "partitioning", processedRows: 10_000 }), false);
  clock = 20_000;
  assert.equal(await progress({ stage: "partitioning", processedRows: 15_000 }), true);
  clock = 20_500;
  assert.equal(await progress({ stage: "partitioning", processedRows: 100_000 }), true);
  clock = 21_000;
  assert.equal(await progress({ stage: "assembling", processedRows: 5_000 }), true);
  assert.equal(await progress({ stage: "assembling", processedRows: 10_000 }), false);
  assert.equal(await progress({ stage: "assembling", processedRows: 100_000 }), true);
  assert.equal(await progress({ stage: "ready", processedRows: 100_000 }), true);
  assert.equal(await progress({ stage: "ready", processedRows: 100_000 }), false);

  assert.deepEqual(reported, [
    ["partitioning", 5_000, 100_000],
    ["partitioning", 15_000, 100_000],
    ["partitioning", 100_000, 100_000],
    ["assembling", 5_000, 100_000],
    ["assembling", 100_000, 100_000],
    ["ready", 100_000, 100_000],
  ]);
});

test("failed advisory progress can retry at the next page", async () => {
  let attempts = 0;
  const progress = createThrottledExportProgress({
    expectedRows: 10_000,
    now: () => 0,
    report: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error("temporary progress failure");
    },
  });

  await assert.rejects(progress({ stage: "partitioning", processedRows: 5_000 }), /temporary progress failure/);
  assert.equal(await progress({ stage: "partitioning", processedRows: 10_000 }), true);
  assert.equal(attempts, 2);
});
