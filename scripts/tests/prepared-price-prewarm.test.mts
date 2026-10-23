import test from "node:test";
import assert from "node:assert/strict";
import { runPreparedPricePrewarm } from "../../netlify/functions/_shared/prepared-price-prewarm.mts";
import type { ExportJobRow } from "../../netlify/functions/_shared/export-jobs.mts";

test("prewarm reuses ready bytes, dispatches only queued work, and finishes the durable claim", async () => {
  for (const status of ["finalized", "queued", "running"] as const) {
    const calls: unknown[] = [];
    const profile = { id: "p", seed_job_id: "j", organization_id: "o", lease_token: "t", revision: 2 };
    const result = await runPreparedPricePrewarm({
      claim: async () => [profile],
      prepare: async () => ({ job: { id: "j", status } as ExportJobRow, cached: status === "finalized" }),
      dispatch: async id => { calls.push(id); },
      finish: async (p, error) => { assert.equal(p, profile); calls.push(error); },
    });
    assert.deepEqual(calls, status === "queued" ? ["j", null] : [null]);
    assert.equal(result.failed, 0);
    assert.equal(result.reused, status === "finalized" ? 1 : 0);
  }
});

test("one bad customer profile yields to the queue without leaking its error or losing the claim", async () => {
  const finished: unknown[] = [];
  const result = await runPreparedPricePrewarm({
    claim: async () => [{ id: "p", seed_job_id: "j", organization_id: "o", lease_token: "t", revision: 2 }],
    prepare: async () => { throw new Error("private customer credentials"); },
    dispatch: async () => { throw new Error("must not dispatch"); },
    finish: async (_, error) => { finished.push(error); },
  });
  assert.deepEqual(finished, ["PREPARED_PRICE_REFRESH_FAILED"]);
  assert.equal(result.failed, 1);
  assert.doesNotMatch(JSON.stringify(result), /credentials/);
});
