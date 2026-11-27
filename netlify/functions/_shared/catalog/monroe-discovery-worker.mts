import { createHash } from 'node:crypto';
import { assertBrandEngineSource } from './brand-engine-registry.mts';
import { fetchMonroeDiscoveryPage } from './tecalliance-sync.mts';

export const MONROE_DISCOVERY_ADAPTER = 'monroe-official-discovery.v1';
export const MONROE_DISCOVERY_REVIEW_ADAPTER = 'monroe-discovered-products.v1';

export function monroeDiscoveryReceipt(response: Awaited<ReturnType<typeof fetchMonroeDiscoveryPage>>, prefix: string, page: number) {
  const { status, totalMatchingArticles: total, maxAllowedPage: lastPage, articles } = response;
  if (status !== 200 || typeof total !== 'number' || !Number.isSafeInteger(total) || total < 0 ||
      typeof lastPage !== 'number' || lastPage !== Math.ceil(total / 100) || lastPage > 200 ||
      (!Array.isArray(articles) && total !== 0) ||
      (articles?.length ?? 0) !== Math.min(100, Math.max(0, total - (page - 1) * 100))) {
    throw Error('MONROE_DISCOVERY_SOURCE_PAGINATION_INVALID');
  }
  const codes = (articles ?? []).map(article => {
    const code = article.articleNumber?.trim();
    if (String(article.mfrName).trim().toUpperCase() !== 'MONROE' ||
        Number(article.dataSupplierId ?? article.mfrId) !== 37 ||
        !code || !/^[A-Za-z0-9][A-Za-z0-9 ._+/-]{0,99}$/.test(code) || code[0].toUpperCase() !== prefix) {
      throw Error('MONROE_DISCOVERY_SOURCE_IDENTITY_INVALID');
    }
    return code;
  });
  const payload = { prefix, page, lastPage, total, codes };
  return { ...payload, fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex') };
}

export async function runClaimedMonroeDiscovery({
  db, organizationId, job, fetchPage = fetchMonroeDiscoveryPage,
}: any) {
  const scope = { input_org: organizationId, input_job: job.id, input_token: job.lease_token };
  const rpc = async (name: string, args: any) => {
    const result = await db.rpc(name, args);
    if (result.error) throw Error(result.error.message);
    return result.data;
  };
  try {
    const { adapter, brand, source_key: sourceKey, prefix, page } = job.manifest;
    if (adapter !== MONROE_DISCOVERY_ADAPTER || brand !== 'Monroe' || sourceKey !== 'tecalliance_monroe' ||
        job.mode !== 'stage' || job.total_items !== 1 || job.next_index !== 0) {
      throw Error('MONROE_DISCOVERY_JOB_INVALID');
    }
    const source = await db.from('catalog_external_sources').select('*')
      .eq('organization_id', organizationId).eq('source_key', sourceKey).single();
    if (source.error || source.data?.robots_posture !== 'allowed') throw Error('MONROE_DISCOVERY_SOURCE_UNAVAILABLE');
    assertBrandEngineSource(source.data, brand);
    await rpc('heartbeat_catalog_brand_job', scope);
    const receipt = monroeDiscoveryReceipt(await fetchPage(prefix, page), prefix, page);
    const result = await rpc('complete_catalog_monroe_discovery', { ...scope, input_page: receipt });
    return { claimed: true, ...result };
  } catch (error) {
    const message = (error instanceof Error ? error.message : 'MONROE_DISCOVERY_FAILED').slice(0, 200);
    const retry = /TecAlliance request failed (429|5\d\d)|timeout|abort|fetch failed|ECONN|network/i.test(message)
      && Number(job.retry_attempts || 0) < 4;
    const status = retry ? 'paused' : 'failed';
    await rpc('checkpoint_catalog_brand_job', {
      ...scope, input_index: 0, input_observation: null, input_checkpoint: {}, input_state: 'failed',
      input_advance: false, input_end_status: status, input_error: message,
    }).catch(() => {});
    return { claimed: true, status, error: message };
  }
}
