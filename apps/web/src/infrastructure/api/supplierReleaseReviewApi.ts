import {supabaseClient} from './supabaseClient';
import {getCurrentOrgId} from './organizationApi';
import {parseReleaseAudit, type ReleaseReviewRow, type ReleaseIssueRow} from '../../shared/supplierReleaseReview';

export type ReleaseReviewCursor={createdAt:string;id:string};
export type ReleaseIssueCursor={sourceRowNumber:number;id:number};
const uuid=(value:string)=>/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
export async function fetchSupplierReleaseReviewPage(cursor:ReleaseReviewCursor|null, signal:AbortSignal, filters:{brandSearch?:string;supplierId?:string;fromDate?:string;toDate?:string}={}):Promise<{rows:ReleaseReviewRow[];next:ReleaseReviewCursor|null}> {
  const org=await getCurrentOrgId();
  if(signal.aborted) throw new DOMException('Cancelled','AbortError');
  let query=supabaseClient.from('supplier_price_releases').select(`id,brand_id,supplier_id,status,created_at,updated_at,total_rows,processed_rows,accepted_rows,rejected_rows,warning_rows,conflict_rows,error_code,error_message,brand_identity_audit,${filters.brandSearch?.trim()?'brands!inner(name)':'brands(name)'},suppliers(name)`)
    .eq('organization_id',org).order('created_at',{ascending:false}).order('id',{ascending:false}).limit(26);
  if(filters.brandSearch?.trim()) query=query.ilike('brands.name',`%${filters.brandSearch.trim().replace(/[\\%_]/g,'\\$&')}%`);
  if(filters.supplierId){
    if(!uuid(filters.supplierId)) throw new Error('Invalid supplier filter');
    query=query.eq('supplier_id',filters.supplierId);
  }
  for(const date of [filters.fromDate,filters.toDate]) if(date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date filter');
  if(filters.fromDate) query=query.gte('created_at',`${filters.fromDate}T00:00:00+03:00`);
  if(filters.toDate) query=query.lte('created_at',`${filters.toDate}T23:59:59.999+03:00`);
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
    return {id:r.id,brandId:r.brand_id,supplierId:r.supplier_id,brand:relationName(r.brands),supplier:relationName(r.suppliers),status:r.status,
      createdAt:r.created_at,updatedAt:r.updated_at,totalRows:r.total_rows,processedRows:r.processed_rows,
      acceptedRows:countOrNull(r.accepted_rows),rejectedRows:countOrNull(r.rejected_rows),
      warningRows:countOrNull(r.warning_rows),conflictRows:countOrNull(r.conflict_rows),
      errorCode:textOrNull(r.error_code),errorMessage:textOrNull(r.error_message),
      audit:parseReleaseAudit(r.brand_identity_audit,r.brand_id),current:current.has(r.id)};
  });
  const last=rows.at(-1);
  return {rows,next:data.length>25 && last ? {id:last.id,createdAt:last.createdAt} : null};
}

export async function fetchSupplierReleaseIssuePage(releaseId:string,cursor:ReleaseIssueCursor|null,signal:AbortSignal):Promise<{rows:ReleaseIssueRow[];next:ReleaseIssueCursor|null}> {
  const org=await getCurrentOrgId();
  if(signal.aborted) throw new DOMException('Cancelled','AbortError');
  if(!uuid(releaseId)) throw new Error('Invalid release id');
  if(cursor && (!Number.isSafeInteger(cursor.sourceRowNumber)||cursor.sourceRowNumber<0||!Number.isSafeInteger(cursor.id)||cursor.id<0)) throw new Error('Invalid issue cursor');
  let query=supabaseClient.from('supplier_price_release_rows')
    .select('id,source_row_number,product_code,buy_price,row_status,error_code,error_message,supplier_price_releases!inner(organization_id)')
    .eq('supplier_price_releases.organization_id',org).eq('release_id',releaseId)
    .or('row_status.neq.accepted,row_status.is.null')
    .order('source_row_number',{ascending:true}).order('id',{ascending:true}).limit(51);
  if(cursor) query=query.or(`source_row_number.gt.${cursor.sourceRowNumber},and(source_row_number.eq.${cursor.sourceRowNumber},id.gt.${cursor.id})`);
  const result=await query.abortSignal(signal);
  if(result.error) throw new Error('Release issue details could not be verified.');
  const data=result.data||[];
  const toSafeInt=(v:unknown)=>{
    const n=typeof v==='number'?v:typeof v==='string'&&/^\d+$/.test(v)?Number(v):NaN;
    return Number.isSafeInteger(n)&&n>=0?n:null;
  };
  const text=(v:unknown,max:number)=>typeof v==='string'&&v.length<=max?v:null;
  const rows:ReleaseIssueRow[]=data.slice(0,50).map(r=>{
    const id=toSafeInt(r.id), sourceRowNumber=toSafeInt(r.source_row_number);
    if(id===null||sourceRowNumber===null) throw new Error('Invalid issue row');
    const price=typeof r.buy_price==='number'&&Number.isFinite(r.buy_price) ? String(r.buy_price)
      : typeof r.buy_price==='string'&&r.buy_price.length<=100 ? r.buy_price : null;
    return {id,sourceRowNumber,productCode:text(r.product_code,200),buyPrice:price,
      rowStatus:text(r.row_status,40)||'unknown',errorCode:text(r.error_code,120),errorMessage:text(r.error_message,1000)};
  });
  const last=rows.at(-1);
  return {rows,next:data.length>50&&last?{sourceRowNumber:last.sourceRowNumber,id:last.id}:null};
}
