import {supabaseClient} from './supabaseClient';
import {getCurrentOrgId} from './organizationApi';
import {parseReleaseAudit, type ReleaseReviewRow} from '../../shared/supplierReleaseReview';

export type ReleaseReviewCursor={createdAt:string;id:string};
export async function fetchSupplierReleaseReviewPage(cursor:ReleaseReviewCursor|null, signal:AbortSignal):Promise<{rows:ReleaseReviewRow[];next:ReleaseReviewCursor|null}> {
  const org=await getCurrentOrgId();
  if(signal.aborted) throw new DOMException('Cancelled','AbortError');
  let query=supabaseClient.from('supplier_price_releases').select('id,brand_id,status,created_at,total_rows,processed_rows,accepted_rows,rejected_rows,warning_rows,conflict_rows,error_code,error_message,brand_identity_audit,brands(name),suppliers(name)')
    .eq('organization_id',org).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(26);
  if(cursor){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cursor.id)
      || !/^\d{4}-\d\d-\d\dT[0-9:.]+(?:Z|[+-]\d\d:\d\d)$/.test(cursor.createdAt)
      || !Number.isFinite(Date.parse(cursor.createdAt))) throw new Error('Invalid release cursor');
    query=query.or(`created_at.lt.${cursor.createdAt},and(created_at.eq.${cursor.createdAt},id.lt.${cursor.id})`);
  }
  const releases=await query.abortSignal(signal);
  if(releases.error) throw new Error('Release review status could not be verified.');
  const data=releases.data||[];
  // Only this page's pointers: never rely on an unpaged, possibly capped list.
  const ids=data.slice(0,25).map(r=>r.id);
  const pointers=ids.length ? await supabaseClient.from('supplier_current_price_pointers')
    .select('release_id,supplier_price_publications!inner(status)').eq('organization_id',org).in('release_id',ids).abortSignal(signal)
    : {data:[],error:null};
  if(pointers.error) throw new Error('Release review status could not be verified.');
  const current=new Set((pointers.data||[]).filter(p=>{
    const publication=p.supplier_price_publications as unknown as {status:string}|{status:string}[];
    return (Array.isArray(publication)?publication[0]?.status:publication?.status)==='published';
  }).map(p=>p.release_id));
  const relationName=(v:unknown)=>{const item=Array.isArray(v)?v[0]:v;return item && typeof item==='object' && 'name' in item && typeof item.name==='string' ? item.name : '—';};
  const rows=data.slice(0,25).map(r=>{
    if(!Number.isSafeInteger(r.total_rows) || r.total_rows<0 || !Number.isSafeInteger(r.processed_rows) || r.processed_rows<0) throw new Error('Invalid release counts');
    const countOrNull=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&value>=0 ? value : null;
    const textOrNull=(value:unknown)=>typeof value==='string'&&value.length<=1000 ? value : null;
    return {id:r.id,brandId:r.brand_id,brand:relationName(r.brands),supplier:relationName(r.suppliers),status:r.status,
      createdAt:r.created_at,totalRows:r.total_rows,processedRows:r.processed_rows,
      acceptedRows:countOrNull(r.accepted_rows),rejectedRows:countOrNull(r.rejected_rows),
      warningRows:countOrNull(r.warning_rows),conflictRows:countOrNull(r.conflict_rows),
      errorCode:textOrNull(r.error_code),errorMessage:textOrNull(r.error_message),
      audit:parseReleaseAudit(r.brand_identity_audit,r.brand_id),current:current.has(r.id)};
  });
  const last=rows.at(-1);
  return {rows,next:data.length>25 && last ? {id:last.id,createdAt:last.createdAt} : null};
}
