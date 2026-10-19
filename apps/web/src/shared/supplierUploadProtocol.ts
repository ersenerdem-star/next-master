export type UploadPhase='hashing'|'admitting'|'uploading'|'verifying'|'queued'|'verified'|'failed'|'paused'|'unknown'|'attention';
export type UploadProgress={phase:UploadPhase;bytes:number;totalBytes:number;sessionId?:string;releaseId?:string;message:string};
export type UploadStatus={sessionId:string;releaseId:string;uploadStatus:string;verificationStatus:string;transferReady:boolean;
 totalBytes:number;totalRows:number;processedRows:number;releaseStatus:string;errorCode:string|null;releaseUpdatedAt:string;
 expiresAt:string;updatedAt:string;published:false;failureReason?:string|null};
export const SUPPLIER_PROCESSING_INTERRUPTED='SUPPLIER_PROCESSING_INTERRUPTED';
export const SUPPLIER_SOURCE_UNSUPPORTED_FIELDS={
 SOURCE_UNSUPPORTED_STOCK_QTY:{column:'Stock_Qty',en:'stock quantity',tr:'stok miktarı'},
 SOURCE_UNSUPPORTED_ORDER_MULTIPLE:{column:'Order_Multiple',en:'order multiple',tr:'sipariş katı'},
 SOURCE_UNSUPPORTED_VALID_TO:{column:'Valid_To',en:'validity end date',tr:'geçerlilik bitiş tarihi'},
} as const;
export type SupplierSourceUnsupportedCode=keyof typeof SUPPLIER_SOURCE_UNSUPPORTED_FIELDS;
export const SUPPLIER_SOURCE_INVALID_FIELDS={
 SOURCE_INVALID_STOCK_QTY:{column:'Stock_Qty',en:'Use a whole number from 0 to 2147483647, or leave unknown supplier stock blank.',tr:'0–2147483647 arasında bir tam sayı kullanın; bilinmeyen tedarikçi stoğunu boş bırakın.'},
 SOURCE_INVALID_ORDER_MULTIPLE:{column:'Order_Multiple',en:'Use a whole number from 1 to 2147483647, or leave an unspecified order multiple blank.',tr:'1–2147483647 arasında bir tam sayı kullanın; belirtilmemiş sipariş katını boş bırakın.'},
 SOURCE_INVALID_VALID_TO:{column:'Valid_To',en:'Use a valid YYYY-MM-DD date on or after Price_Date (or the selected source date when Price_Date is blank), or leave an open-ended price blank.',tr:'Price_Date (boşsa seçilen kaynak tarihi) tarihinden önce olmayan, geçerli bir YYYY-MM-DD tarihi kullanın; bitiş tarihi olmayan fiyatı boş bırakın.'},
} as const;
function sourceInvalidMessage(code:string|null,tr:boolean):string|null {
 if(!code||!Object.hasOwn(SUPPLIER_SOURCE_INVALID_FIELDS,code))return null;
 const field=SUPPLIER_SOURCE_INVALID_FIELDS[code as keyof typeof SUPPLIER_SOURCE_INVALID_FIELDS];
 return tr?`Dosya reddedildi: ${field.column}. ${field.tr} Fiyatlar yayımlanmadı. Kaynaktaki değeri doğrulayın; anlamlı ticari bilgiyi silmeyin.`
  :`File rejected: ${field.column}. ${field.en} Prices were not published. Verify the source value; do not delete meaningful commercial data.`;
}
function sourceUnsupportedMessage(code:string|null,tr:boolean):string|null {
 if(!code||!Object.hasOwn(SUPPLIER_SOURCE_UNSUPPORTED_FIELDS,code))return null;
 const field=SUPPLIER_SOURCE_UNSUPPORTED_FIELDS[code as SupplierSourceUnsupportedCode];
 return tr
  ?`Dosya reddedildi: ${field.column} (${field.tr}) bu yüklemenin işlendiği önceki sürümde desteklenmiyordu. Fiyatlar yayımlanmadı. Ticari açıdan gerekli bilgiyi silmeyin; bu kayıt önceki yüklemenin sonucunu korur.`
  :`File rejected: ${field.column} (${field.en}) was unsupported by the earlier version that processed this upload. Prices were not published. Do not delete meaningful commercial data; this record preserves that earlier upload's outcome.`;
}
export function supplierProcessingInterruptedMessage(tr=false,reason?:string|null) {
 const messages:Record<string,[string,string]>={
  SUPPLIER_FAILURE_VALIDATION_DATABASE_TIMEOUT:[
   'Son satır ve marka kontrolü veritabanının süre sınırını aştı. Dosya ve alınan satırlar korunuyor. Fiyatlar henüz yayınlanmadı; bu yüklemenin son kontrolü tamamlanmalı. Aynı dosyayı tekrar yüklemeniz gerekmiyor.',
   'The final row and brand check exceeded the database time limit. The file and received rows are preserved. Prices are not published yet; the final check for this upload must finish. Do not upload the same file again.'],
  SUPPLIER_FAILURE_PROCESSING_DATABASE_TIMEOUT:[
   'Satırlar işlenirken veritabanının süre sınırı aşıldı. Dosya ve işlenen satırlar korunuyor. İşlem bu yükleme üzerinden devam ettirilmeli; dosyayı tekrar yüklemeyin.',
   'The database time limit was exceeded while processing rows. The file and processed rows are preserved. Resume this upload instead of uploading again.'],
  SUPPLIER_FAILURE_SERVICE_UNAVAILABLE:[
   'İşleme hizmeti isteği tamamlayamadı veya geçici olarak yanıt vermedi. Dosya ve işlenen satırlar korunuyor. Aynı yükleme kontrol edilerek devam ettirilmeli.',
   'The processing service could not complete the request or was temporarily unavailable. The file and processed rows are preserved. Check and resume this same upload.'],
  SUPPLIER_FAILURE_SOURCE_VALIDATION_FAILED:[
   'Dosyanın satır kontrolü tamamlanamadı; fiyatlar yayınlanmadı. Kayıt, sütun, hücre değeri ve düzeltme için aşağıdaki satır kontrol raporunu açın.',
   'Source row validation did not complete; prices were not published. See the row validation report below for records, columns, cell values and corrections.'],
  SUPPLIER_FAILURE_SOURCE_UNAVAILABLE:[
   'Yüklenen dosya depodan okunamadı. Dosya kaydı korunuyor; bu yüklemenin depolama bağlantısı kontrol edilmeli.',
   'The uploaded file could not be read from storage. Its record is preserved; check the storage connection for this upload.'],
 };
 if(reason&&Object.hasOwn(messages,reason))return messages[reason][tr?0:1];
 return tr?'Dosyanın işlenmesi durdu; operasyon kontrolü gerekiyor. Yükleme ve işlenen satırlar korunuyor. Aynı yüklemenin durumunu kontrol edin.'
  :'File processing stopped and needs operational review. The upload and processed rows are preserved. Check this same upload.';
}
export function supplierUploadStatusView(status:UploadStatus,tr=false):{phase:UploadPhase;message:string} {
 const displayStatuses:Record<string,string>={received:'Alındı',uploaded:'Yüklendi',staged:'Satırlar hazırlandı',validated:'Doğrulandı',published:'Yayında',failed:'Başarısız',cancelled:'İptal edildi',archived:'Arşivlendi'};
 const displayStatus=tr?(displayStatuses[status.releaseStatus]||status.releaseStatus):status.releaseStatus;
 const invalid=sourceInvalidMessage(status.errorCode,tr);
 if(invalid)return {phase:'failed',message:invalid};
 const unsupported=sourceUnsupportedMessage(status.errorCode,tr);
 if(unsupported)return {phase:'failed',message:unsupported};
 const progress=`${status.processedRows.toLocaleString(tr?'tr-TR':'en-US')} / ${status.totalRows.toLocaleString(tr?'tr-TR':'en-US')}`;
 const activity=new Date(status.releaseUpdatedAt).toLocaleString(tr?'tr-TR':'en-US');
 if(status.errorCode===SUPPLIER_PROCESSING_INTERRUPTED)return {phase:'attention',
  message:`${supplierProcessingInterruptedMessage(tr,status.failureReason)} ${progress}. ${tr?'Son durum':'Last status'}: ${activity}.`};
 if(status.errorCode)return {phase:'attention',message:tr
  ?`Dosya inceleme gerektiriyor (${status.errorCode}). ${progress}. Aynı yüklemenin kontrol ayrıntılarını açın.`
  :`File review is required (${status.errorCode}). ${progress}. Open the review details for this same upload.`};
 if(status.verificationStatus==='failed')return {phase:'failed',message:tr?'Kaynak dosya doğrulanamadı. Aynı yüklemeyi kontrol edin.':'Source verification failed. Check this same upload.'};
 if(status.verificationStatus==='verified')return {phase:'verified',message:tr
  ?`Kaynak doğrulandı. İşlenen satır: ${progress}. Durum: ${displayStatus}. Son durum: ${activity}. Fiyat yayını ayrı aşamadır.`
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
