// Read-only, whitelisted evidence. Never infer publication from "validated".
import {SUPPLIER_PROCESSING_INTERRUPTED} from './supplierUploadProtocol';
export type ReleaseAudit = {
  checked: boolean; reviewRequired: boolean; totalCodes: number;
  reviewThresholdPercent?: number;
  historicalBrands?: ReleaseAudit['brands'];
  brands: {id: string; name: string; matches: number; percent: number; samples: string[]}[];
};
export type ReleaseReviewRow = {
  id: string; brandId: string; supplierId: string; brand: string; supplier: string; status: string;
  createdAt: string; updatedAt: string; totalRows: number; processedRows: number;
  acceptedRows: number | null; rejectedRows: number | null; warningRows: number | null; conflictRows: number | null;
  errorCode: string | null; errorMessage: string | null;
  audit: ReleaseAudit | null; current: boolean;
};
export type ReleaseIssueRow = {
  id: number; sourceRowNumber: number; productCode: string | null; buyPrice: string | null;
  rowStatus: string; errorCode: string | null; errorMessage: string | null;
};
export function releaseIssueExplanation(issue: ReleaseIssueRow, tr: boolean) {
  const code=issue.errorCode;
  if (code==='INVALID_BUY_PRICE') return tr
    ? 'Alış fiyatı geçerli bir sayı olmalı; fiyatı ve para birimini doldurup dosyayı düzeltin.'
    : 'Buy price must be a valid number; fill in the price and currency, then correct the file.';
  if (code==='DUPLICATE_NORMALIZED_CODE') return tr
    ? 'Normalize ürün kodu bu sürümde birden fazla kez bulundu; aynı kodu tek satıra indirin.'
    : 'The normalized product code appears more than once in this release; keep one row per code.';
  if (code) return tr
    ? `Doğrulama kodu: ${code}. Dosyadaki bu satırı düzeltip yeniden doğrulayın.`
    : `Validation code: ${code}. Correct this row and validate the file again.`;
  return tr ? 'Bu satır doğrulamadan geçmedi; ürün kodu ve zorunlu alanları kontrol edin.'
    : 'This row did not pass validation; check the product code and required fields.';
}

// The page is ordered newest first by the API. Scope identity uses UUIDs so
// equal display names never combine releases from different suppliers.
export function splitReleaseReviewHistory(rows: ReleaseReviewRow[]) {
  const scopes = new Set<string>();
  const latest: ReleaseReviewRow[] = [], history: ReleaseReviewRow[] = [];
  for (const row of rows) {
    const scope = `${row.supplierId}:${row.brandId}`;
    if (scopes.has(scope)) history.push(row);
    else { scopes.add(scope); latest.push(row); }
  }
  return { latest, history };
}
const record=(v: unknown): Record<string,unknown> | null => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : null;
const count=(v:unknown)=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null;
export function parseReleaseAudit(value:unknown,brandId:string): ReleaseAudit | null {
  const a=record(value);
  if (!a || !['cross-brand-v1','cross-brand-v2','cross-brand-v3'].includes(String(a.policy)) || typeof a.checked!=='boolean' || typeof a.review_required!=='boolean') return null;
  if (a.checked===false) return {checked:false,reviewRequired:true,totalCodes:0,brands:[]};
  const n=count(a.distinct_incoming_codes);
  if (a.selected_brand_id!==brandId || n===null || !Array.isArray(a.brands) || a.brands.length>10) return null;
  const parseBrands=(values: unknown): ReleaseAudit['brands'] | null => {
    if (!Array.isArray(values) || values.length>10) return null;
    const brands: ReleaseAudit['brands']=[];
    for(const value of values){
      const b=record(value); const matches=count(b?.matching_codes);
      if(!b || typeof b.brand_id!=='string' || typeof b.brand_name!=='string' || b.brand_name.length>180
        || matches===null || matches>n || !Array.isArray(b.sample_codes) || b.sample_codes.length>10
        || b.sample_codes.some(c=>typeof c!=='string' || c.length>200)) return null;
      brands.push({id:b.brand_id,name:b.brand_name,matches,percent:n ? Math.round(matches*10000/n)/100 : 0,samples:b.sample_codes as string[]});
    }
    return brands;
  };
  const brands=parseBrands(a.brands);
  const historicalBrands=a.policy!=='cross-brand-v1' ? parseBrands(a.historical_brands) : undefined;
  if (!brands || historicalBrands===null) return null;
  const percentRule=a.policy==='cross-brand-v3';
  const detected=n===0 || brands.some(b=>percentRule ? b.matches*100>n*5 : b.matches>=5000 || (b.matches>=100 && b.matches*100>=n*80));
  return {checked:true,reviewRequired:a.review_required || detected,totalCodes:n,brands,...(percentRule ? {reviewThresholdPercent:5} : {}),...(historicalBrands ? {historicalBrands} : {})};
}
export function releaseReviewState(row:ReleaseReviewRow) {
  if (row.status==='cancelled' && row.errorCode==='REVIEW_REJECTED') return 'rejected';
  if (row.errorCode===SUPPLIER_PROCESSING_INTERRUPTED && !row.audit?.reviewRequired) return 'processing_interrupted';
  if (row.errorCode || row.audit?.reviewRequired) return 'review_required';
  if (['failed','cancelled','superseded','archived'].includes(row.status)) return 'inactive';
  if (row.status==='published') return row.current ? 'active' : 'previous_publication';
  if (row.status==='staged') return 'staged';
  if (['received','uploaded','parsing','validating'].includes(row.status)) return 'processing';
  if (!row.audit?.checked) return 'unverified';
  if (row.status==='validated') return 'awaiting_publication';
  return 'processing';
}
