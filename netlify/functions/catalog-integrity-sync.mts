import type { Config, Context } from "@netlify/functions";
import { json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";

type IntegrityClaim = {
  organization_id: string;
  product_id: string;
  lock_token: string;
  attempt_count: number;
};

const BACKFILL_CHUNK_SIZE = 1000;
const EVALUATION_BATCH_SIZE = 100;
const MAX_BATCHES_PER_INVOCATION = 4;

async function callServiceRpc<T>(supabaseUrl: string, serviceRoleKey: string, name: string, args: Record<string, unknown>) {
  return sendJson<T>(`${supabaseUrl}/rest/v1/rpc/${name}`, {
    method: "POST",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(args),
    timeoutMs: 25_000,
  });
}

async function processCatalogIntegrity(supabaseUrl: string, serviceRoleKey: string, workerId: string) {
  const backfill = await callServiceRpc<Record<string, unknown>>(
    supabaseUrl,
    serviceRoleKey,
    "enqueue_catalog_integrity_backfill_batch",
    { input_chunk_size: BACKFILL_CHUNK_SIZE },
  );

  let evaluatedCount = 0;
  let claimedCount = 0;
  let failedBatchCount = 0;

  for (let batchIndex = 0; batchIndex < MAX_BATCHES_PER_INVOCATION; batchIndex += 1) {
    const claims = await callServiceRpc<IntegrityClaim[]>(
      supabaseUrl,
      serviceRoleKey,
      "claim_catalog_integrity_batch",
      { input_batch_size: EVALUATION_BATCH_SIZE, input_worker_id: workerId },
    );

    if (!Array.isArray(claims) || claims.length === 0) break;
    claimedCount += claims.length;

    try {
      const result = await callServiceRpc<{ evaluated_count?: number }>(
        supabaseUrl,
        serviceRoleKey,
        "evaluate_catalog_integrity_batch",
        { input_claims: claims },
      );
      evaluatedCount += Number(result?.evaluated_count || 0);
    } catch (error) {
      failedBatchCount += 1;
      const message = error instanceof Error ? error.message : String(error || "Catalog integrity evaluation failed");
      await callServiceRpc(
        supabaseUrl,
        serviceRoleKey,
        "fail_catalog_integrity_batch",
        { input_claims: claims, input_error: message, input_retry: true },
      ).catch((failureError) => {
        console.error("catalog integrity retry registration failed", failureError);
      });
      console.error("catalog integrity batch failed", { batchIndex, claimCount: claims.length, error: message });
      break;
    }

    if (claims.length < EVALUATION_BATCH_SIZE) break;
  }

  console.info("catalog integrity sync completed", {
    workerId,
    backfill,
    claimedCount,
    evaluatedCount,
    failedBatchCount,
  });
}

export default async (_req: Request, context: Context) => {
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  const workerId = `netlify:${context.requestId || crypto.randomUUID()}`;
  const task = processCatalogIntegrity(supabaseUrl, serviceRoleKey, workerId).catch((error) => {
    console.error("catalog integrity sync failed", error);
  });
  context.waitUntil(task);

  return json({
    ok: true,
    data: {
      queued: true,
      worker_id: workerId,
      backfill_chunk_size: BACKFILL_CHUNK_SIZE,
      evaluation_batch_size: EVALUATION_BATCH_SIZE,
      max_batches: MAX_BATCHES_PER_INVOCATION,
    },
  });
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
