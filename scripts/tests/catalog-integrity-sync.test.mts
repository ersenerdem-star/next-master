import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { processCatalogIntegrity } from "../../netlify/functions/catalog-integrity-sync.mts";

type RpcCall = {
  name: string;
  args: Record<string, unknown>;
};

const originalBackfillSetting = process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED;

afterEach(() => {
  if (originalBackfillSetting === undefined) {
    delete process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED;
  } else {
    process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED = originalBackfillSetting;
  }
});

function createRpcMock(claimBatches: Array<Array<Record<string, unknown>>> = [[]]) {
  const calls: RpcCall[] = [];
  let claimIndex = 0;

  const callRpc = async <T>(
    _supabaseUrl: string,
    _serviceRoleKey: string,
    name: string,
    args: Record<string, unknown>,
  ): Promise<T> => {
    calls.push({ name, args });

    if (name === "enqueue_catalog_integrity_backfill_batch") {
      return { queued_count: 1 } as T;
    }
    if (name === "claim_catalog_integrity_batch") {
      return (claimBatches[claimIndex++] || []) as T;
    }
    if (name === "evaluate_catalog_integrity_batch") {
      const claims = args.input_claims as Array<Record<string, unknown>>;
      return { evaluated_count: claims.length } as T;
    }
    if (name === "fail_catalog_integrity_batch") {
      return { updated_count: 1 } as T;
    }

    throw new Error(`Unexpected RPC: ${name}`);
  };

  return { calls, callRpc };
}

for (const setting of [undefined, "false", "TRUE"] as const) {
  test(`backfill remains disabled for ${String(setting)}`, async () => {
    if (setting === undefined) {
      delete process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED;
    } else {
      process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED = setting;
    }

    const { calls, callRpc } = createRpcMock();
    const result = await processCatalogIntegrity("url", "key", "worker", callRpc);

    assert.equal(calls.filter((call) => call.name === "enqueue_catalog_integrity_backfill_batch").length, 0);
    assert.equal(result.backfill_status, "backfill_disabled");
  });
}

test("exact lowercase true enables one bounded backfill call", async () => {
  process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED = "true";
  const { calls, callRpc } = createRpcMock();

  const result = await processCatalogIntegrity("url", "key", "worker", callRpc);

  const backfillCalls = calls.filter((call) => call.name === "enqueue_catalog_integrity_backfill_batch");
  assert.equal(backfillCalls.length, 1);
  assert.deepEqual(backfillCalls[0]?.args, { input_chunk_size: 1000 });
  assert.equal(result.backfill_status, "backfill_enqueued");
});

test("queued items process while backfill is disabled", async () => {
  delete process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED;
  const claims = [{
    organization_id: "11111111-1111-4111-8111-111111111111",
    product_id: "22222222-2222-4222-8222-222222222222",
    lock_token: "33333333-3333-4333-8333-333333333333",
    attempt_count: 1,
  }];
  const { calls, callRpc } = createRpcMock([claims, []]);

  const result = await processCatalogIntegrity("url", "key", "worker", callRpc);

  assert.equal(calls.filter((call) => call.name === "enqueue_catalog_integrity_backfill_batch").length, 0);
  assert.equal(calls.filter((call) => call.name === "claim_catalog_integrity_batch").length, 1);
  assert.equal(calls.filter((call) => call.name === "evaluate_catalog_integrity_batch").length, 1);
  assert.equal(result.claimed_count, 1);
  assert.equal(result.evaluated_count, 1);
});

test("empty queue exits successfully while backfill is disabled", async () => {
  delete process.env.CATALOG_INTEGRITY_BACKFILL_ENABLED;
  const { calls, callRpc } = createRpcMock([[]]);

  const result = await processCatalogIntegrity("url", "key", "worker", callRpc);

  assert.equal(calls.filter((call) => call.name === "claim_catalog_integrity_batch").length, 1);
  assert.equal(calls.filter((call) => call.name === "evaluate_catalog_integrity_batch").length, 0);
  assert.equal(result.backfill_status, "backfill_disabled");
  assert.equal(result.claimed_count, 0);
  assert.equal(result.evaluated_count, 0);
  assert.equal(result.failed_batch_count, 0);
});
