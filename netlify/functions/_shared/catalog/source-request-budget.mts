type BudgetDb = {
  rpc(name: string, args: Record<string, unknown>): PromiseLike<{ data: any; error: any }>;
};
type JobLease = { input_org: string; input_job: string; input_token: string };

export class CatalogSourceDeferred extends Error {
  readonly retryAt: string;

  constructor(retryAt: string) {
    super('CATALOG_SOURCE_BUDGET_WAIT');
    this.retryAt = retryAt;
  }
}

export function sourceRetryAfterSeconds(header: string | null, now = Date.now()): number {
  const delay = !header ? NaN : /^\d+$/.test(header)
    ? Number(header) : Math.ceil((Date.parse(header) - now) / 1000);
  return Number.isFinite(delay) ? Math.max(30, Math.min(604800, delay)) : 60;
}

function retryTime(data: { retryAt?: unknown } | null): string {
  if (typeof data?.retryAt !== 'string' || !Number.isFinite(Date.parse(data.retryAt))) {
    throw Error('CATALOG_SOURCE_BUDGET_INVALID');
  }
  return data.retryAt;
}

export function budgetedCatalogFetch(
  db: BudgetDb,
  sourceGroup: string,
  fetchImpl = fetch,
  wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)),
): typeof fetch {
  return async (input, init) => {
    let inlineWaitMs = 0;
    for (;;) {
      init?.signal?.throwIfAborted();
      const permit = await db.rpc('acquire_catalog_source_request', { input_group: sourceGroup });
      if (permit.error) throw Error('CATALOG_SOURCE_BUDGET_UNAVAILABLE');
      if (permit.data?.granted === true) break;
      const retryAt = retryTime(permit.data);
      const delay = Number(permit.data?.retryAfterMs) + 25;
      if (!Number.isFinite(delay) || delay < 0 || inlineWaitMs + delay > 2500) {
        throw new CatalogSourceDeferred(retryAt);
      }
      inlineWaitMs += delay;
      await wait(delay);
    }
    init?.signal?.throwIfAborted();
    const response = await fetchImpl(input, init);
    const retryAfter = response.headers.get('retry-after');
    if (response.status === 429 || (response.status === 503 && retryAfter)) {
      await response.body?.cancel().catch(() => {});
      const result = await db.rpc('cooldown_catalog_source_requests', {
        input_group: sourceGroup, input_seconds: sourceRetryAfterSeconds(retryAfter),
      });
      if (result.error) throw Error('CATALOG_SOURCE_BUDGET_UNAVAILABLE');
      throw new CatalogSourceDeferred(retryTime(result.data));
    }
    return response;
  };
}

export async function deferCatalogSourceJob(db: BudgetDb, scope: JobLease, error: CatalogSourceDeferred, method = 'defer_catalog_brand_source_request') {
  const result = await db.rpc(method, { ...scope, input_retry_at: error.retryAt });
  if (result.error) throw Error('CATALOG_SOURCE_DEFER_FAILED');
  return { claimed: true, status: 'paused', error: error.message, retryAt: error.retryAt };
}
