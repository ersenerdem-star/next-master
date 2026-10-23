import {normalizeBrandName, normalizeBrandKey, normalizePartCode} from '../domain/shared/normalize';
import type {BrandOption} from '../types/brand';

type BrandStore = {
  find: (normalizedName: string) => Promise<BrandOption | null>;
  insert: (name: string) => Promise<BrandOption>;
};

// Match the registry's UNIQUE(organization_id, normalize_part_code(name)).
// A retried or concurrent request must reuse that identity, never rename it.
export async function ensureBrandRecord(input: string, store: BrandStore) {
  const normalized=normalizeBrandName(input);
  const name=['contitech','continentalctam'].includes(normalizeBrandKey(normalized))?'Continental CTAM':normalized;
  const key=normalizePartCode(name);
  if (!key || name.length>120 || /[\u0000-\u001f\u007f]/.test(name)) throw Error('BRAND_NAME_INVALID');
  const existing=await store.find(key);
  if(existing) return {brand:existing,created:false};
  try {
    const brand=await store.insert(name);
    return {brand,created:true};
  } catch(error) {
    // Includes uniqueness races and a lost response after a committed insert.
    const recovered=await store.find(key).catch(()=>null);
    if(recovered) return {brand:recovered,created:false};
    throw error;
  }
}
