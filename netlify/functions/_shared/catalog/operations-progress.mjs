export const progressSources = [
 {table:'catalog_brand_jobs',kind:'brand',select:'id,brand:manifest->>brand,source:manifest->>source_key,mode,status,total_items,next_index,updated_at'},
 {table:'catalog_zf_jobs',kind:'zf',select:'id,brand:manifest->>brand,mode,status,total_items,next_index,updated_at'},
 {table:'catalog_elring_jobs',kind:'elring',select:'id,mode,status,total_items,next_index,updated_at'},
 {table:'catalog_elring_completion_jobs',kind:'elring-completion',select:'run_id,phase,status,processed,changed,updated_at'},
 {table:'catalog_elring_image_jobs',kind:'elring-images',select:'run_id,status,scanned,applied,updated_at'},
 {table:'catalog_elring_spareto_jobs',kind:'elring-secondary',select:'run_id,status,expected_products,scalar_processed,vehicle_processed,tariff_processed,changed,updated_at'},
];
export const activeProgressStates=['queued','running','paused','retrying','pending'];
const count=value=>value==null||value===''?null:Number.isSafeInteger(Number(value))&&Number(value)>=0?Number(value):null;
export function summarizeCatalogProgress(records){
 const groups=new Map();
 for(const {kind,rows} of records){
  for(const row of rows){
   const brand=String(row.brand||(kind.startsWith('elring')?'Elring':'Unknown'));
   const phase=String(row.phase||row.mode||(kind==='elring-images'?'images':kind==='elring-secondary'?'secondary':'catalog'));
   const key=JSON.stringify([brand,kind,row.source||'',phase]);
   const item={id:String(row.id||row.run_id),brand,kind,source:String(row.source||''),phase,status:String(row.status),processed:count(row.next_index??row.processed??row.scanned??row.scalar_processed??0),total:count(row.total_items??row.expected_products),changed:row.changed==null&&row.applied==null?null:count(row.changed??row.applied),updatedAt:row.updated_at||null,activeJobs:0};
   const active=activeProgressStates.includes(item.status),previous=groups.get(key);
   const activeJobs=(previous?.activeJobs||0)+(active?1:0);
   if(!previous || (active&&!activeProgressStates.includes(previous.status)) || (active===activeProgressStates.includes(previous.status)&&String(item.updatedAt)>String(previous.updatedAt)))groups.set(key,{...item,activeJobs});
   else previous.activeJobs=activeJobs;
  }
 }
 return [...groups.values()].sort((a,b)=>Number(b.activeJobs>0)-Number(a.activeJobs>0)||String(b.updatedAt).localeCompare(String(a.updatedAt)));
}
export async function readCatalogProgress(db,organizationId,brandSearch=''){
 const results=await Promise.all(progressSources.map(async source=>{
  const search=brandSearch.trim();
  if(source.kind.startsWith('elring')&&search&&!('elring'.includes(search.toLowerCase())))return {kind:source.kind,rows:[],truncated:false};
  const read=()=>{
   let query=db.from(source.table).select(source.select).eq('organization_id',organizationId);
   if(search&&!source.kind.startsWith('elring'))query=query.ilike('manifest->>brand',`%${search.replace(/[\\%_]/g,'\\$&')}%`);
   return query;
  };
  const [active,recent]=await Promise.all([read().in('status',activeProgressStates).order('updated_at',{ascending:false}).limit(201),read().not('status','in',`(${activeProgressStates.join(',')})`).order('updated_at',{ascending:false}).limit(60)]);
  if(active.error||recent.error)throw Error('CATALOG_PROGRESS_UNAVAILABLE');
  const unique=new Map();for(const row of [...(recent.data||[]),...(active.data||[]).slice(0,200)])unique.set(`${row.id||row.run_id}:${row.phase||''}`,row);
  return {kind:source.kind,rows:[...unique.values()],truncated:(active.data||[]).length>200};
 }));
 return {rows:summarizeCatalogProgress(results),truncated:results.some(row=>row.truncated),checkedAt:new Date().toISOString()};
}
