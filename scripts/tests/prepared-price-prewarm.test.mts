import test from "node:test";
import assert from "node:assert/strict";
import { runPreparedPricePrewarm, runPreparedPricePrewarmBatch } from "../../netlify/functions/_shared/prepared-price-prewarm.mts";
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

test("batch advances past unavailable profiles and stops on a cold build", async () => {
  let calls = 0;
  const result = await runPreparedPricePrewarmBatch(async () => {
    calls++;
    return { status: "checked", prepared: calls === 3 ? 1 : 0, reused: calls === 2 ? 1 : 0, failed: calls === 1 ? 1 : 0 };
  }, { deadlineMs: 100, now: () => 0 });
  assert.deepEqual(result, { status: "checked", checked: 3, prepared: 1, reused: 1, failed: 1 });
  assert.equal(calls, 3);
});

test("batch respects the clock, profile cap, and empty queue", async () => {
  let calls = 0;
  const run = async () => { calls++; return { status: "checked", prepared: 0, reused: 1, failed: 0 }; };
  assert.equal((await runPreparedPricePrewarmBatch(run, { deadlineMs: 2, now: () => calls, maxProfiles: 8 })).checked, 2);
  calls = 0;
  assert.equal((await runPreparedPricePrewarmBatch(run, { deadlineMs: 100, now: () => 0, maxProfiles: 3 })).checked, 3);
  const idle = await runPreparedPricePrewarmBatch(async () => ({ status: "idle", prepared: 0, reused: 0, failed: 0 }), { deadlineMs: 100, now: () => 0 });
  assert.equal(idle.checked, 0);
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

test("prewarm never dispatches a shared follower as a new producer",async()=>{
 let dispatched=0;
 const profile={id:'p',seed_job_id:'j',organization_id:'o',lease_token:'t',revision:1};
 const result=await runPreparedPricePrewarm({claim:async()=>[profile],prepare:async()=>({job:{id:'j',status:'queued',scope:{sharedLeaderJobId:'leader'}} as unknown as ExportJobRow,cached:false}),dispatch:async()=>{dispatched++;},finish:async()=>{}});
 assert.equal(dispatched,0);assert.equal(result.prepared,0);
});
