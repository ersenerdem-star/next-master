import { createHash } from 'node:crypto';
import { normalizeCatalogMarketSegment } from './catalog-segments.mts';
import { tecLifecycle } from './mira-lifecycle.mts';

export const ELRING = Object.freeze({ brand: 'Elring', sourceKey: 'tecalliance_elring', provider: 2122, supplier: 10,
  url: 'https://web.tecalliance.net/elring/en/home', api: 'https://webservice.tecalliance.services/pegasus-3-0/services/TecdocToCatDLB.jsonEndpoint' });
export const FIELDS = ['product_code', 'description', 'description_tr', 'weight_kg', 'hs_code', 'origin', 'image_url', 'vehicle', 'vehicle_model', 'ean', 'market_segment', 'dimensions', 'oem_no', 'lifecycle_status', 'lifecycle_note'];
export const codeKey = value => String(value ?? '').replace(/[^a-z0-9]/gi, '').toUpperCase();
export const fingerprint = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const text = value => String(value ?? '').trim();
const unique = items => [...new Set(items.map(text).filter(Boolean))];
const number = value => {
  const raw = text(value).replace(',', '.');
  return /^\d+(?:\.\d+)?$/.test(raw) && Number.isFinite(Number(raw)) ? Number(raw) : null;
};
const populated = value => value != null && value !== '' && !(typeof value === 'object' && Object.keys(value).length === 0);

export function assertSource(source, { publish = false, approvalActor, approvalReference } = {}) {
  if (!source || source.source_key !== ELRING.sourceKey || source.base_url !== ELRING.url || source.is_active !== true || source.license_posture !== 'allowed'
    || source.credential_boundary !== 'none' || source.rate_limit_posture !== 'bounded'
    || source.metadata?.automated_read_only_approved !== true || source.metadata?.internal_observation_allowed !== true
    || !source.metadata?.allowed_brands?.some(brand => text(brand).toLowerCase() === 'elring')) throw Error('ELRING_SOURCE_NOT_AUTHORIZED');
  if (publish && (!approvalActor || !approvalReference || source.metadata?.approval_actor !== approvalActor
    || source.metadata?.publication_approval_reference !== approvalReference
    || source.metadata?.internal_catalog_persistence_allowed !== true)) throw Error('ELRING_PUBLICATION_NOT_AUTHORIZED');
}

export function mapElringArticle(article, { requestedCode, defaultMarketSegment = null } = {}) {
  if (!codeKey(article?.articleNumber) || text(article.mfrName).toUpperCase() !== 'ELRING' || article.dataSupplierId !== 10
    || (requestedCode && codeKey(article.articleNumber) !== codeKey(requestedCode))) throw Error('ELRING_IDENTITY_MISMATCH');
  if (defaultMarketSegment && !normalizeCatalogMarketSegment(defaultMarketSegment)) throw Error('INVALID_MARKET_SEGMENT');
  const criteria = [...(article.articleCriteria || []), ...(article.articleLogisticsCriteria || [])];
  const labelled = criteria.map(c => ({ label: text(c.criteriaDescription || c.criteriaAbbrDescription),
    value: text(c.formattedValue ?? c.rawValue), raw: text(c.rawValue ?? c.formattedValue), unit: text(c.criteriaUnitDescription) }));
  const pick = regex => labelled.find(c => regex.test(c.label));
  const weight = pick(/^(?:net )?weight(?:\s*\[.*\])?$/i);
  const weightValue = weight ? number(weight.raw) : null;
  const weightUnit = weight && (weight.unit || weight.label.match(/\[(kg|g)\]/i)?.[1] || '').toLowerCase();
  const dimensions = {};
  const dimensionLabels = { 'inner diameter': 'inner_diameter_mm', 'outer diameter': 'outer_diameter_mm', diameter: 'diameter_mm',
    length: 'length_mm', width: 'width_mm', height: 'height_mm', thickness: 'thickness_mm' };
  for (const c of labelled) {
    const key = dimensionLabels[c.label.replace(/\s*\[.*?\]/g, '').trim().toLowerCase()];
    const unit = (c.unit || c.label.match(/\[(mm|cm|m)\]/i)?.[1] || '').toLowerCase();
    const value = number(c.raw);
    if (key && value != null && ['mm', 'cm', 'm'].includes(unit)) {
      const converted = value * ({ mm: 1, cm: 10, m: 1000 }[unit]);
      if (key in dimensions && dimensions[key] !== converted) throw Error(`AMBIGUOUS_DIMENSION:${key}`);
      dimensions[key] = converted;
    }
  }
  const tariff = pick(/(?:goods tariff|customs tariff|tariff number|hs code|commodity code)/i);
  const tariffValue = tariff?.raw.replace(/[\s.,]/g, '') || '';
  const origin = pick(/^(?:country of origin|origin|manufacturing country)$/i);
  const models = unique([...(article.linkages || []).map(l => l.vehicleModelSeriesName || l.modelSeriesName),
    ...labelled.filter(c => /^(?:vehicle model|model series)$/i.test(c.label)).map(c => c.value)]);
  const vehicles = unique([...(article.linkages || []).map(l => l.mfrName),
    ...labelled.filter(c => /^(?:vehicle manufacturer|vehicle make)$/i.test(c.label)).map(c => c.value)]);
  const segment = pick(/^market segment$/i);
  const barcode = unique(['gtins', 'gtinNumbers', 'eanNumbers', 'eans'].flatMap(key => article[key] || []).map(v =>
    typeof v === 'object' ? v.gtin || v.gtinNumber || v.ean || v.eanNumber || v.value : v)).find(v => /^\d{8,14}$/.test(v));
  const image = (article.images || []).filter(i => i.typeKey == null || i.typeKey === 1)
    .flatMap(i => [i.imageURL1600, i.imageURL800, i.imageURL400, i.imageURL200]).find(v => /^https:\/\//i.test(v || ''));
  const lifecycle = tecLifecycle(article);
  const fields = {
    product_code: text(article.articleNumber),
    description: text(article.genericArticles?.[0]?.genericArticleDescription) || null,
    description_tr: null,
    weight_kg: weightValue == null ? null : weightUnit === 'kg' ? weightValue : weightUnit === 'g' ? weightValue / 1000 : null,
    hs_code: /^\d{6,12}$/.test(tariffValue) ? tariffValue : null,
    origin: origin?.value || null, image_url: image || null,
    vehicle: vehicles.join(', ') || null, vehicle_model: models.join(', ') || null,
    ean: barcode || null, market_segment: normalizeCatalogMarketSegment(segment?.value) || normalizeCatalogMarketSegment(defaultMarketSegment),
    dimensions: Object.keys(dimensions).length ? dimensions : null,
    oem_no: unique((article.oemNumbers || []).map(o => o.articleNumber)).join(', ') || null,
    lifecycle_status: lifecycle.values.lifecycle_status || null,
    lifecycle_note: lifecycle.values.lifecycle_status ? `Elring official status: ${article.misc.articleStatusDescription.trim()}` : null,
  };
  return { brand: ELRING.brand, fields, raw: article, lifecycle,
    replacement_relations: lifecycle.evidence.replacement?.relations || [],
    source_url: `${ELRING.url}?articleNumber=${encodeURIComponent(fields.product_code)}`,
    field_status: Object.fromEntries(FIELDS.map(field => [field, populated(fields[field]) ? 'present' : 'missing'])),
    limitations: [Number(article.totalLinkages || 0) > (article.linkages || []).length ? 'vehicle_linkages_incomplete' : null,
      fields.image_url ? 'image_requires_controlled_review_apply' : null].filter(Boolean) };
}

export function buildArticleRequest(code) {
  if (!codeKey(code)) throw Error('PRODUCT_CODE_REQUIRED');
  return { getArticles: { articleCountry: 'GB', provider: ELRING.provider, lang: 'en', searchQuery: text(code), searchType: 10,
    searchMatchType: 'prefix_or_suffix', dataSupplierIds: [ELRING.supplier], page: 1, perPage: 100,
    includeAll: false, includeGenericArticles: true, includeArticleCriteria: true, includeArticleLogisticsCriteria: true,
    includeImages: true, includeOEMNumbers: true, includeGTINs: true, includeArticleText: true, includeMisc: true,
    includeLinkages: true, linkagesPerPage: 100, includePrices: false,
    includeReplacesArticles: true, includeReplacedByArticles: true } };
}

async function requestJson(payload, fetchImpl) {
  const response = await fetchImpl(ELRING.api, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(15000),
    headers: { 'content-type': 'application/json', origin: 'https://web.tecalliance.net', referer: ELRING.url },
    body: JSON.stringify(payload) });
  if (!response.ok) { await response.body?.cancel(); throw Error(`ELRING_HTTP_${response.status}`); }
  const chunks = []; let bytes = 0;
  for await (const chunk of response.body) { bytes += chunk.byteLength; if (bytes > 2 * 1024 * 1024) throw Error('ELRING_RESPONSE_TOO_LARGE'); chunks.push(chunk); }
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

// These three requests follow the official Elring web client's Ken service:
// getLinkedBrands -> getArticleLinkedAllLinkingTarget4 -> targets in batches of 25.
// getArticles.includeLinkages alone does not return the full article fitment.
export async function readElringFitment(article, { fetchImpl = fetch, maxRequests = 128, wait = ms => new Promise(r => setTimeout(r, ms)) } = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000) throw Error('INVALID_FITMENT_REQUEST_LIMIT');
  const evidence = [], vehicles = [];
  let requests = 0, complete = true;
  const call = async (method, args) => {
    if (requests >= maxRequests) { complete = false; return null; }
    await wait(1100); requests++;
    const request = { [method]: { provider: ELRING.provider, articleCountry: 'GB', lang: 'en', ...args } };
    const result = await requestJson(request, fetchImpl);
    if (result.status !== 200 || !Array.isArray(result.data?.array)) throw Error('ELRING_FITMENT_RESPONSE_INVALID');
    evidence.push({ request, response: result, retrieved_at: new Date().toISOString(), response_fingerprint: fingerprint(result) }); return result.data.array;
  };
  const articles = (article.genericArticles || []).filter(a => Number.isInteger(a.legacyArticleId));
  outer: for (const generic of articles) {
    const types = unique((generic.linkageTargetTypes || []).map(t => ({V:'P',L:'P',P:'P',O:'O',C:'O',B:'B'}[t])).filter(Boolean));
    for (const linkingTargetType of types) {
      const base = { articleId: generic.legacyArticleId, linkingTargetType };
      const brands = await call('getArticleLinkedAllLinkingTargetManufacturer2', { ...base, country: 'GB', countryGroupFlag: false });
      if (!brands) break outer;
      for (const brand of brands) {
        const records = await call('getArticleLinkedAllLinkingTarget4', { ...base, country: 'GB', countryGroupFlag: false,
          linkingTargetManuId: brand.manuId, withMainArticles: false });
        if (!records) break outer;
        const pairs = records.flatMap(r => r.articleLinkages?.array || []);
        for (let offset = 0; offset < pairs.length; offset += 25) {
          const details = await call('getArticleLinkedAllLinkingTargetsByIds3', { ...base, immediateAttributs: true,
            linkedArticlePairs: { array: pairs.slice(offset, offset + 25).map(p => ({ articleLinkId: p.articleLinkId, linkingTargetId: p.linkingTargetId })) } });
          if (!details) break outer;
          for (const record of details) for (const v of record.linkedVehicles?.array || []) vehicles.push(v);
        }
      }
    }
  }
  return { complete, requests, vehicles, evidence };
}

export async function readElringArticle(code, { fetchImpl = fetch, defaultMarketSegment, withFitment = false, fitmentMaxRequests = 128, wait } = {}) {
  const result = await requestJson(buildArticleRequest(code), fetchImpl);
  if (result.status !== 200 || !Number.isInteger(result.totalMatchingArticles) || result.totalMatchingArticles > 100
    || !Array.isArray(result.articles) || result.articles.length > 100) throw Error('ELRING_RESPONSE_INVALID_OR_TRUNCATED');
  const matches = result.articles.filter(a => codeKey(a.articleNumber) === codeKey(code)
    && text(a.mfrName).toUpperCase() === 'ELRING' && a.dataSupplierId === 10);
  if (matches.length !== 1) throw Error(matches.length ? 'ELRING_IDENTITY_AMBIGUOUS' : 'ELRING_PRODUCT_NOT_FOUND');
  const article = matches[0];
  const fitment = withFitment ? await readElringFitment(article, {fetchImpl,maxRequests:fitmentMaxRequests,wait}) : null;
  const mapped = mapElringArticle(article, { requestedCode: code, defaultMarketSegment });
  if (fitment) {
    mapped.fields.vehicle = unique(fitment.vehicles.map(v => v.manuDesc)).join(', ') || mapped.fields.vehicle;
    mapped.fields.vehicle_model = unique(fitment.vehicles.map(v => [v.manuDesc,v.modelDesc].filter(Boolean).join(' '))).join(', ') || mapped.fields.vehicle_model;
    for (const key of ['vehicle','vehicle_model']) mapped.field_status[key] = mapped.fields[key] ? 'present' : 'missing';
    if (!fitment.complete) mapped.limitations.push('vehicle_fitment_request_budget_exhausted');
  } else if ((article.genericArticles || []).some(a => a.legacyArticleId)) mapped.limitations.push('vehicle_fitment_not_collected');
  return { ...mapped, fitment, observed_at: new Date().toISOString(), request: buildArticleRequest(code), response_fingerprint: fingerprint(result) };
}
