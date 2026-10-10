// Read-only, whitelisted evidence. Never infer publication from "validated".
export type ReleaseAudit = {
  checked: boolean; reviewRequired: boolean; totalCodes: number;
  brands: {id: string; name: string; matches: number; percent: number; samples: string[]}[];
};
export type ReleaseReviewRow = {
  id: string; brandId: string; brand: string; supplier: string; status: string;
  createdAt: string; totalRows: number; processedRows: number;
  acceptedRows: number | null; rejectedRows: number | null; warningRows: number | null; conflictRows: number | null;
  errorCode: string | null; errorMessage: string | null;
  audit: ReleaseAudit | null; current: boolean;
};
const record=(v: unknown): Record<string,unknown> | null => v && typeof v==='object' && !Array.isArray(v) ? v as Record<string,unknown> : null;
const count=(v:unknown)=>typeof v==='number' && Number.isSafeInteger(v) && v>=0 ? v : null;
export function parseReleaseAudit(value:unknown,brandId:string): ReleaseAudit | null {
  const a=record(value);
  if (!a || a.policy!=='cross-brand-v1' || typeof a.checked!=='boolean' || typeof a.review_required!=='boolean') return null;
  if (a.checked===false) return {checked:false,reviewRequired:true,totalCodes:0,brands:[]};
  const n=count(a.distinct_incoming_codes);
  if (a.selected_brand_id!==brandId || n===null || !Array.isArray(a.brands) || a.brands.length>10) return null;
  const brands: ReleaseAudit['brands']=[];
  for(const value of a.brands){
    const b=record(value); const matches=count(b?.matching_codes);
    if(!b || typeof b.brand_id!=='string' || typeof b.brand_name!=='string' || b.brand_name.length>180
      || matches===null || matches>n || !Array.isArray(b.sample_codes) || b.sample_codes.length>10
      || b.sample_codes.some(c=>typeof c!=='string' || c.length>200)) return null;
    brands.push({id:b.brand_id,name:b.brand_name,matches,percent:n ? Math.round(matches*10000/n)/100 : 0,samples:b.sample_codes as string[]});
  }
  const detected=n===0 || brands.some(b=>b.matches>=5000 || (b.matches>=100 && b.matches*100>=n*80));
  return {checked:true,reviewRequired:a.review_required || detected,totalCodes:n,brands};
}
export function releaseReviewState(row:ReleaseReviewRow) {
  if (row.status==='cancelled' && row.errorCode==='REVIEW_REJECTED') return 'rejected';
  if (row.errorCode || row.audit?.reviewRequired) return 'review_required';
  if (['failed','cancelled','superseded','archived'].includes(row.status)) return 'inactive';
  if (row.status==='published' && row.current) return 'active';
  if (!row.audit?.checked) return 'unverified';
  if (row.status==='validated') return 'awaiting_publication';
  return 'processing';
}
