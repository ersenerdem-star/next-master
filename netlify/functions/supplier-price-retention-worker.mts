import type { Config, Context } from "@netlify/functions";
import { json, sendJson, serviceRoleHeaders } from "./_shared/http.mts";

const BATCH_SIZE = 5000;
const MAX_BATCHES_PER_RUN = 4;

type PurgeResult = {
  status?: string;
  deleted?: number;
  remaining?: number;
  retention_months?: number;
};

export default async (_request: Request, context: Context) => {
  const supabaseUrl = Netlify.env.get("SUPABASE_URL");
  const serviceRoleKey = Netlify.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    return json({ error: "System configuration is incomplete." }, 500);
  }

  const results: PurgeResult[] = [];
  for (let index = 0; index < MAX_BATCHES_PER_RUN; index += 1) {
    const result = await sendJson<PurgeResult>(`${supabaseUrl}/rest/v1/rpc/purge_inactive_supplier_prices`, {
      method: "POST",
      headers: serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({ input_batch_size: BATCH_SIZE }),
      timeoutMs: 50_000,
    });
    results.push(result);
    if (Number(result?.deleted || 0) < BATCH_SIZE || Number(result?.remaining || 0) <= 0) break;
  }

  const deleted = results.reduce((total, result) => total + Number(result?.deleted || 0), 0);
  const remaining = Number(results.at(-1)?.remaining || 0);
  console.info("supplier price retention worker completed", {
    deleted,
    remaining,
    batches: results.length,
    request_id: context.requestId,
  });

  return json({ ok: true, data: { deleted, remaining, batches: results.length } });
};

export const config: Config = { schedule: "0 3 * * *" };
