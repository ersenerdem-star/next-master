import { supabaseClient } from './supabaseClient';

export type EngineReviewItem = {
  engine: 'brand' | 'zf' | 'elring';
  jobId: string;
  itemIndex: number;
  receiptIndex: number;
  brand: string;
  sourceKey: string;
  reviewKey: string;
  productCode: string;
  reason: string;
  fingerprint: string;
  sourceUrl: string | null;
  sourceEan: string | null;
  currentEan: string | null;
  currentDescription: string | null;
  sourceDescription: string | null;
  canApprove: boolean;
  decision: 'approved' | 'rejected' | null;
  application: Record<string, unknown>;
  decidedAt: string | null;
  observedAt: string | null;
};

export type EngineReviewQueue = { total: number; items: EngineReviewItem[] };

async function accessToken() {
  let { data, error } = await supabaseClient.auth.getSession();
  if (data.session?.expires_at && data.session.expires_at * 1000 < Date.now() + 30000) {
    const refreshed = await supabaseClient.auth.refreshSession();
    data = refreshed.data;
    error = refreshed.error;
  }
  if (error || !data.session?.access_token) throw Error('Oturum bulunamadı. Yeniden giriş yapın.');
  return data.session.access_token;
}

async function request<T>(url: string, method: 'GET' | 'POST', body?: unknown): Promise<T> {
  const response = await fetch(url, {
    method,
    headers: { authorization: `Bearer ${await accessToken()}`, 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(30000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw Error(payload.error || 'İnceleme işlemi tamamlanamadı.');
  return payload as T;
}

async function retryTransient<T>(work: () => Promise<T>): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { return await work(); }
    catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (/^(AUTH_|REVIEW_|Invalid |Duplicate )/.test(message) || attempt === 2) throw error;
      await new Promise((resolve) => setTimeout(resolve, 350 * (attempt + 1)));
    }
  }
  throw lastError;
}

export function getEngineReviewQueue(brand: string, status: string, offset: number, limit = 50) {
  const params = new URLSearchParams({ brand, status, offset: String(offset), limit: String(limit) });
  return retryTransient(() => request<EngineReviewQueue>(`/api/catalog/engine-review?${params}`, 'GET'));
}

export function decideEngineReviewItem(item: EngineReviewItem, decision: 'approved' | 'rejected') {
  return request<{ decision: string; application: Record<string, unknown>; replayed: boolean }>(
    '/api/catalog/engine-review', 'POST', {
      engine: item.engine, jobId: item.jobId, itemIndex: item.itemIndex, receiptIndex: item.receiptIndex,
      fingerprint: item.fingerprint, decision,
    },
  );
}

export type EngineReviewBatchResult = { key: string; ok: boolean; error?: string };

export function engineReviewItemKey(item: EngineReviewItem) {
  return `${item.engine}:${item.jobId}:${item.itemIndex}:${item.receiptIndex}`;
}

export function decideEngineReviewBatch(items: EngineReviewItem[], decision: 'approved' | 'rejected') {
  // The server decision RPC is idempotent for the same fingerprint and choice.
  // Retrying a lost response therefore retrieves the result without deciding twice.
  return retryTransient(() => request<{ results: EngineReviewBatchResult[] }>(
    '/api/catalog/engine-review', 'POST', {
      decision,
      items: items.map((item) => ({
        engine: item.engine, jobId: item.jobId, itemIndex: item.itemIndex,
        receiptIndex: item.receiptIndex, fingerprint: item.fingerprint,
      })),
    },
  ));
}
