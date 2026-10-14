export type UploadPhase='hashing'|'admitting'|'uploading'|'verifying'|'queued'|'verified'|'failed'|'paused'|'unknown'|'attention';
export type UploadProgress={phase:UploadPhase;bytes:number;totalBytes:number;sessionId?:string;releaseId?:string;message:string};
export type UploadStatus={sessionId:string;releaseId:string;uploadStatus:string;verificationStatus:string;transferReady:boolean;
 totalBytes:number;totalRows:number;processedRows:number;releaseStatus:string;errorCode:string|null;releaseUpdatedAt:string;
 expiresAt:string;updatedAt:string;published:false};
export const SUPPLIER_PROCESSING_INTERRUPTED='SUPPLIER_PROCESSING_INTERRUPTED';
export const SUPPLIER_SOURCE_UNSUPPORTED_FIELDS={
 SOURCE_UNSUPPORTED_STOCK_QTY:{column:'Stock_Qty',en:'stock quantity',tr:'stok miktarı'},
 SOURCE_UNSUPPORTED_ORDER_MULTIPLE:{column:'Order_Multiple',en:'order multiple',tr:'sipariş katı'},
 SOURCE_UNSUPPORTED_VALID_TO:{column:'Valid_To',en:'validity end date',tr:'geçerlilik bitiş tarihi'},
} as const;
export type SupplierSourceUnsupportedCode=keyof typeof SUPPLIER_SOURCE_UNSUPPORTED_FIELDS;
function sourceUnsupportedMessage(code:string|null,tr:boolean):string|null {
 if(!code||!Object.hasOwn(SUPPLIER_SOURCE_UNSUPPORTED_FIELDS,code))return null;
 const field=SUPPLIER_SOURCE_UNSUPPORTED_FIELDS[code as SupplierSourceUnsupportedCode];
 return tr
  ?`Dosya reddedildi: ${field.column} (${field.tr}) alanında değer var ve doğrulanmış fiyat yükleme bu alanı henüz desteklemiyor. Fiyatlar yayımlanmadı. Ticari açıdan gerekli bilgiyi silmeyin; bu alanı destekleyen aktarım düzeni değerlendirilmelidir.`
  :`File rejected: ${field.column} (${field.en}) contains a value that verified price upload does not yet support. Prices were not published. Do not delete meaningful commercial data; an import path that supports this field must be agreed.`;
}
export function supplierProcessingInterruptedMessage(tr=false) {
 return tr?'Dosyanın işlenmesi durdu; operasyon kontrolü gerekiyor. Yükleme ve işlenen satırlar korunuyor. Aynı yüklemenin durumunu kontrol edin.'
  :'File processing stopped and needs operational review. The upload and processed rows are preserved. Check this same upload.';
}
export function supplierUploadStatusView(status:UploadStatus,tr=false):{phase:UploadPhase;message:string} {
 const unsupported=sourceUnsupportedMessage(status.errorCode,tr);
 if(unsupported)return {phase:'failed',message:unsupported};
 const progress=`${status.processedRows.toLocaleString(tr?'tr-TR':'en-US')} / ${status.totalRows.toLocaleString(tr?'tr-TR':'en-US')}`;
 const activity=new Date(status.releaseUpdatedAt).toLocaleString(tr?'tr-TR':'en-US');
 if(status.errorCode===SUPPLIER_PROCESSING_INTERRUPTED)return {phase:'attention',
  message:`${supplierProcessingInterruptedMessage(tr)} ${progress}. ${tr?'Son durum':'Last status'}: ${activity}.`};
 if(status.errorCode)return {phase:'attention',message:tr
  ?`Dosya inceleme gerektiriyor (${status.errorCode}). ${progress}. Aynı yüklemenin kontrol ayrıntılarını açın.`
  :`File review is required (${status.errorCode}). ${progress}. Open the review details for this same upload.`};
 if(status.verificationStatus==='failed')return {phase:'failed',message:tr?'Kaynak dosya doğrulanamadı. Aynı yüklemeyi kontrol edin.':'Source verification failed. Check this same upload.'};
 if(status.verificationStatus==='verified')return {phase:'verified',message:tr
  ?`Kaynak doğrulandı. İşlenen satır: ${progress}. Durum: ${status.releaseStatus}. Son durum: ${activity}. Fiyat yayını ayrı aşamadır.`
  :`Source verified. Processed rows: ${progress}. Status: ${status.releaseStatus}. Last status: ${activity}. Price publication is a separate step.`};
 return {phase:'queued',message:tr?'Dosya doğrulama kuyruğunda veya doğrulanıyor. Aynı yüklemeyi daha sonra kontrol edin.':'Source verification is queued or running. Check this same upload later.'};
}
export type UploadAdmission={session_id:string;release_id:string;status:string;storage_bucket:string;storage_object_path:string;
 total_bytes:number;upload_endpoint:string;expires_at:string;verification_required:true};
const uuid=(s:unknown):s is string=>typeof s==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
export function requireVerifiedSupplierReplaceMode(mode: unknown): asserts mode is 'replace' {
 if(mode !== 'replace') throw Error('Verified supplier upload currently requires a complete replacement price list. Merge is not supported.');
}
export function validateUploadAdmission(raw:unknown,file:{name:string;size:number},supabaseUrl:string):UploadAdmission {
 const r=raw as UploadAdmission,url=new URL(supabaseUrl),endpoint=new URL(String(r?.upload_endpoint));
 if(!r||!uuid(r.session_id)||!uuid(r.release_id)||r.verification_required!==true
  ||!['created','uploading','uploaded'].includes(r.status)||r.storage_bucket!=='supplier-price-imports'
  ||r.total_bytes!==file.size||!Number.isFinite(Date.parse(r.expires_at))||Date.parse(r.expires_at)<=Date.now()
  ||endpoint.origin!==url.origin||endpoint.pathname!=='/storage/v1/upload/resumable'||endpoint.search||endpoint.hash
  ||!new RegExp(`^[0-9a-f-]{36}/supplier-price/${r.session_id}/`).test(r.storage_object_path)
  ||r.storage_object_path.split('/').length!==4||!uuid(r.storage_object_path.split('/')[0])
  ||r.storage_object_path.split('/')[3]!==file.name.replace(/[^A-Za-z0-9._-]+/g,'_')) throw Error('Upload receipt could not be verified. Do not start a different upload.');
 return r;
}
export function directStorageEndpoint(supabaseUrl:string) {
 const url=new URL(supabaseUrl);
 if(url.protocol!=='https:'||! /^[a-z0-9]+\.supabase\.co$/.test(url.hostname)||url.username||url.password||url.port)
  throw Error('Verified upload requires the configured Supabase project host.');
 return `https://${url.hostname.replace('.supabase.co','.storage.supabase.co')}/storage/v1/upload/resumable`;
}
export function safeTusUrl(value:string,endpoint:string) {
 try{const u=new URL(value),e=new URL(endpoint);return u.origin===e.origin&&!u.username&&!u.password&&!u.search&&!u.hash
  &&u.pathname.startsWith(e.pathname+'/')&&u.pathname.length>e.pathname.length+1;}catch{return false;}
}
export async function hashUploadFile(file:Blob,hasher:{init:()=>unknown;update:(b:Uint8Array)=>unknown;digest:()=>string},
 signal:AbortSignal,onProgress:(bytes:number)=>void,chunkSize=4*1024*1024) {
 if(!Number.isSafeInteger(file.size)||file.size<1||file.size>1073741824||chunkSize<1) throw Error('Select a file between 1 byte and 1 GiB.');
 hasher.init();
 for(let offset=0;offset<file.size;offset+=chunkSize){signal.throwIfAborted();
  const bytes=new Uint8Array(await file.slice(offset,Math.min(offset+chunkSize,file.size)).arrayBuffer());
  signal.throwIfAborted();hasher.update(bytes);onProgress(Math.min(offset+bytes.length,file.size));
  // Yield to render progress and keep the browser responsive.
  await new Promise<void>(resolve=>setTimeout(resolve,0));
 }
 signal.throwIfAborted();return hasher.digest();
}
export function parseUploadStatus(raw:unknown,sessionId:string,totalBytes?:number):UploadStatus {
 const r=raw as UploadStatus;
 if(!r||r.sessionId!==sessionId||!uuid(r.releaseId)||r.published!==false||typeof r.transferReady!=='boolean'
  ||!['created','uploading','uploaded','failed','expired','aborted'].includes(r.uploadStatus)
  ||!['not_requested','queued','verifying','verified','failed'].includes(r.verificationStatus)
  ||!Number.isSafeInteger(r.totalBytes)||r.totalBytes<1||(totalBytes!==undefined&&r.totalBytes!==totalBytes)
  ||!Number.isSafeInteger(r.totalRows)||r.totalRows<0||!Number.isSafeInteger(r.processedRows)||r.processedRows<0
  ||typeof r.releaseStatus!=='string'||r.errorCode!==null&&(typeof r.errorCode!=='string'||! /^[A-Z0-9_]{1,80}$/.test(r.errorCode))
  ||!Number.isFinite(Date.parse(r.releaseUpdatedAt))||!Number.isFinite(Date.parse(r.expiresAt))||!Number.isFinite(Date.parse(r.updatedAt)))
  throw Error('Upload status could not be verified. Check the same session again.');
 return r;
}
