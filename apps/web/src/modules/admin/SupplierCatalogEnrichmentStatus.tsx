import {useEffect,useState} from 'react';
import {supabaseClient} from '../../infrastructure/api/supabaseClient';
import {Button} from '../../presentation/components/common/Button';

type Status={releaseId:string;status:string;phase:string;totalRows:number;processedRows:number;changedProducts:number;reviewRows:number;officialChecked:number;missingRows:number;errorCode:string|null;errorSourceRow:number|null;errorProvider:string|null};
type Issue={phase:string;source_row_number:number;product_code:string;issues:{field:string;code:string}[];missing_fields?:string[]};
const fieldNames:Record<string,string>={origin:'Menşe',hs_code:'Tarife',ean:'Barkod',oem_no:'OEM numarası',vehicle:'Araç',vehicle_model:'Araç modeli',weight_kg:'Ağırlık',dimensions:'Boyutlar',description:'Açıklama',description_tr:'Türkçe açıklama',market_segment:'Pazar grubu',source:'Resmî kaynak',product_code:'Parça numarası'};
const reasons:Record<string,[string,string]>={
 CATALOG_ENRICHMENT_DATABASE_TIMEOUT:['Katalog kaydı sırasında süre sınırına ulaşıldı; sistem kaldığı yerden otomatik yeniden deniyor. Dosyayı tekrar yüklemeyin.','Catalog write timed out; the system automatically retries from saved progress. Do not upload the file again.'],
 CATALOG_ENRICHMENT_DATABASE_BUSY:['Katalog veritabanı meşgul; sistem kaldığı yerden otomatik yeniden deniyor.','Catalog database is busy; the system automatically retries from saved progress.'],
 SOURCE_CONFLICT:['Kaynaklarda farklı değerler var; mevcut değer korundu.','Sources disagree; existing value was retained.'],
 OLDER_SOURCE:['Kaynak tarihi mevcut bilgiden eski.','Source predates the existing information.'],
 CATALOG_CHANGED_AFTER_SOURCE:['Katalog son aktarımdan sonra düzenlenmiş; mevcut değer korundu.','Catalog was edited after the previous import; existing value was retained.'],
 INVALID_ORIGIN:['Menşe geçerli iki harfli ülke kodu olmalı.','Origin must be a valid two-letter country code.'],
 INVALID_TARIFF_TEXT:['Tarife metni geçersiz; kodu metin biçiminde kontrol edin.','Invalid tariff text; check the code as text.'],
 INVALID_WEIGHT:['Ağırlık pozitif ve geçerli bir sayı olmalı.','Weight must be a valid positive number.'],
 INVALID_DIMENSIONS:['Boyut bilgisi geçerli metin veya alanlar halinde olmalı.','Dimensions must contain valid text or structured fields.'],
 INVALID_FIELD_VALUE:['Alan değeri desteklenen biçimde değil veya çok uzun.','Field value has an unsupported format or is too long.'],
 EAN_CONFLICT:['Mevcut barkod ile kaynak barkodu farklı.','Existing and source barcodes differ.'],
 OFFICIAL_EXACT_MATCH_NOT_FOUND:['Resmî katalogda bu marka ve tam parça numarası eşleşmedi.','Official catalog has no exact brand and part-number match.'],
 OFFICIAL_SOURCE_NOT_CONFIGURED:['Bu marka için otomatik resmî kaynak henüz tanımlı değil. Dosyadaki bilgiler işlendi.','No automatic official source is configured for this brand. File fields were processed.'],
 OFFICIAL_SOURCE_TIMEOUT:['Resmî katalog yanıt süresini aştı; kayıtlı ilerlemeden yeniden denenecek.','Official catalog timed out; retry resumes from saved progress.'],
 OFFICIAL_SOURCE_RATE_LIMIT:['Resmî katalog istek sınırı uyguladı; daha sonra yeniden denenecek.','Official catalog rate limited requests; retry is deferred.'],
 OFFICIAL_SOURCE_ACCESS_DENIED:['Resmî katalog erişim izni istiyor.','Official catalog requires authorized access.'],
 OFFICIAL_SOURCE_UNAVAILABLE:['Resmî katalog şu an erişilebilir değil.','Official catalog is currently unavailable.'],
 CATALOG_IDENTITY_OR_VALUE_CONFLICT:['Ürün kimliği veya alan değeri mevcut katalogla çakışıyor; kayıt değiştirilmedi.','Product identity or value conflicts with catalog constraints; record was retained.'],
};
export function enrichmentReason(code:string,tr:boolean){return reasons[code]?.[tr?0:1]||(tr?'Katalog kontrolü tamamlanamadı; kayıtlı ilerleme korunuyor.':'Catalog check could not complete; saved progress is retained.');}
export function SupplierCatalogEnrichmentStatus({releaseId,tr}:{releaseId:string;tr:boolean}){
 const [status,setStatus]=useState<Status|null>(null),[error,setError]=useState(false),[loaded,setLoaded]=useState(false),[refresh,setRefresh]=useState(0);
 const [issues,setIssues]=useState<Issue[]>([]),[cursor,setCursor]=useState<{phase:string;row:number}|null>(null),[busy,setBusy]=useState(false);
 const enabled=import.meta.env.VITE_SUPPLIER_CATALOG_ENRICHMENT_ENABLED==='true';
 useEffect(()=>{
  if(!enabled)return;let active=true;
  const load=async()=>{const result=await supabaseClient.rpc('get_supplier_catalog_enrichment_status',{input_release_ids:[releaseId]});
   if(!active)return;if(result.error||!Array.isArray(result.data)){setError(true);return;}
   const row=result.data[0];
   if(row&&(!['queued','running','completed','completed_missing','review_required','superseded','failed'].includes(row.status)||!['file','official'].includes(row.phase)
    ||['totalRows','processedRows','changedProducts','reviewRows','officialChecked','missingRows'].some(k=>!Number.isSafeInteger(row[k])||row[k]<0))){setError(true);return;}
   setStatus(row||null);setLoaded(true);setError(false);
  };
  void load().catch(()=>{if(active)setError(true);});const timer=window.setInterval(()=>{if(document.visibilityState==='visible')void load().catch(()=>{if(active)setError(true);});},15000);
  return()=>{active=false;window.clearInterval(timer);};
 },[enabled,releaseId,refresh]);
 if(!enabled)return null;
 const loadIssues=async()=>{setBusy(true);try{
  const result=await supabaseClient.rpc('get_supplier_catalog_enrichment_details',{input_release_id:releaseId,input_after_phase:cursor?.phase||'',input_after_row:cursor?.row||0});
  if(result.error||!Array.isArray(result.data))throw Error();
  const page=result.data.slice(0,20) as Issue[];setIssues(v=>[...v,...page]);const last=page.at(-1);setCursor(result.data.length>20&&last?{phase:last.phase,row:last.source_row_number}:null);
 }catch{setError(true);}finally{setBusy(false);}};
 const retry=async()=>{setBusy(true);try{const r=await supabaseClient.rpc('retry_supplier_catalog_enrichment',{input_release_id:releaseId});if(r.error)throw Error();setRefresh(v=>v+1);}catch{setError(true);}finally{setBusy(false);}};
 const titles:Record<string,string>=tr?{queued:'Sırada',running:status?.phase==='file'?'Dosya alanları kataloğa işleniyor':'Resmî katalog eksikleri tamamlıyor',completed:'Katalog tamamlandı',completed_missing:'İşlem tamamlandı; bazı alanlar resmî kaynakta bulunamadı',review_required:'Katalogda incelenecek bilgi var',superseded:'Daha yeni yayın nedeniyle durduruldu',failed:'Katalog işlemi durdu'}:{queued:'Queued',running:status?.phase==='file'?'Applying file fields':'Completing from official catalog',completed:'Catalog complete',completed_missing:'Processing complete; some fields were unavailable in the official source',review_required:'Catalog information needs review',superseded:'Stopped because a newer publication exists',failed:'Catalog processing stopped'};
 return <section className="list-stack" aria-label={tr?'Katalog zenginleştirme':'Catalog enrichment'}>
  <strong>{tr?'Katalog zenginleştirme':'Catalog enrichment'}</strong>
  {error?<p role="alert" className="error-text">{tr?'Katalog durumu alınamadı; tamamlandı kabul etmeyin.':'Catalog status is unavailable; do not treat it as completed.'}</p>:null}
  {!loaded&&!error?<p>{tr?'Katalog durumu kontrol ediliyor…':'Checking catalog status…'}</p>:null}
  {loaded&&!status?<p>{tr?'Bu yayın için katalog işi planlanmamış. Fiyat yayını katalog güncelliğini doğrulamaz.':'No catalog job is scheduled for this publication. Price publication does not verify catalog freshness.'}</p>:null}
  {status?<><span>{titles[status.status]}</span><span>{tr?'Dosya alanları':'File fields'}: {status.processedRows.toLocaleString()} / {status.totalRows.toLocaleString()}</span>
   <span>{tr?'Güncellenen kayıt işlemi':'Record updates'}: {status.changedProducts.toLocaleString()} · {tr?'Resmî kaynak kontrolü':'Official checks'}: {status.officialChecked.toLocaleString()} · {tr?'Eksik bilgi içeren satır':'Rows with missing data'}: {status.missingRows.toLocaleString()}</span>
   {status.errorCode?<p role="status">{enrichmentReason(status.errorCode,tr)}{status.errorSourceRow?` ${tr?'Kaynak kayıt no':'Source record'}: ${status.errorSourceRow}.`:''}{status.errorProvider?` ${tr?'Kaynak':'Source'}: ${status.errorProvider}.`:''}</p>:null}
   {(status.reviewRows>0||status.missingRows>0)&&!issues.length?<Button variant="secondary" disabled={busy} onClick={()=>void loadIssues()}>{tr?'Eksik ve sorunlu alanları göster':'Show missing fields and issues'}</Button>:null}
   {status.status==='failed'?<Button variant="secondary" disabled={busy} onClick={()=>void retry()}>{tr?'Kaldığı yerden yeniden dene':'Retry from saved progress'}</Button>:null}
   {issues.length?<div className="table-wrap"><table className="data-table"><thead><tr><th>{tr?'Kaynak kayıt':'Source record'}</th><th>{tr?'Parça no':'Part no'}</th><th>{tr?'Alan':'Field'}</th><th>{tr?'Neden':'Reason'}</th></tr></thead><tbody>{issues.flatMap(row=>[...row.issues,...(row.missing_fields||[]).map(field=>({field,code:'SOURCE_FIELD_UNAVAILABLE'}))].map((issue,i)=><tr key={`${row.phase}:${row.source_row_number}:${i}`}><td>{row.source_row_number}</td><td>{row.product_code}</td><td>{tr?(fieldNames[issue.field]||issue.field):issue.field}</td><td>{issue.code==='SOURCE_FIELD_UNAVAILABLE'?(tr?'Bu alan resmî katalog kaynağında bulunamadı.':'This field was unavailable in the official catalog.'):enrichmentReason(issue.code,tr)}</td></tr>))}</tbody></table>{cursor?<Button variant="secondary" disabled={busy} onClick={()=>void loadIssues()}>{tr?'Daha fazla satır':'More rows'}</Button>:null}</div>:null}
  </>:null}
 </section>;
}
