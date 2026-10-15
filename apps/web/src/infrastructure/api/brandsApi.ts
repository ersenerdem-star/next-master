import type { BrandOption } from "../../types/brand";
import { callAppAdminRecords } from "./appAdminRecordsApi";
import {supabaseClient} from './supabaseClient';
import {getCurrentOrgId} from './organizationApi';
import {ensureBrandRecord} from '../../shared/brandCreation';

let brandsCache: BrandOption[] | null = null;
let brandsCachePromise: Promise<BrandOption[]> | null = null;

export function clearCloudBrandsCache() {
  brandsCache = null;
  brandsCachePromise = null;
}

/** Uses the existing authenticated admin RLS policy, with no service key. */
export async function createCloudBrand(name: string) {
  const organizationId=await getCurrentOrgId(true);
  const result=await ensureBrandRecord(name,{
    async find(normalizedName) {
      const {data,error}=await supabaseClient.from('brands').select('id,name')
        .eq('organization_id',organizationId).eq('normalized_name',normalizedName).maybeSingle();
      if(error) throw error;
      return data as BrandOption|null;
    },
    async insert(brandName) {
      const {data,error}=await supabaseClient.from('brands').insert({organization_id:organizationId,name:brandName})
        .select('id,name').single();
      if(error) throw error;
      if(!data?.id) throw Error('BRAND_CREATE_UNCONFIRMED');
      return data as BrandOption;
    },
  });
  clearCloudBrandsCache();
  return result;
}

export async function fetchCloudBrands(): Promise<BrandOption[]> {
  if (brandsCache) return brandsCache;
  if (brandsCachePromise) return brandsCachePromise;

  brandsCachePromise = (async () => {
    const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
      resource: "brands",
      action: "list",
    });
    const rows = (data || []).map((row) => ({
      id: String(row.id || ""),
      name: String(row.name || ""),
    }));
    brandsCache = rows;
    brandsCachePromise = null;
    return rows;
  })().catch((error) => {
    brandsCachePromise = null;
    throw error;
  });

  return brandsCachePromise;
}

/** Brands that can actually produce an admin A/B price-list export. */
export async function fetchCloudPriceListBrands(): Promise<BrandOption[]> {
  const data = await callAppAdminRecords<Array<Record<string, unknown>>>({
    resource: "priceListBrands",
    action: "list",
  });
  return (data || [])
    .map((row) => ({ id: String(row.id || ""), name: String(row.name || "") }))
    .filter((row) => row.id && row.name);
}
