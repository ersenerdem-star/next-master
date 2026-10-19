import {useCallback,useEffect,useRef,useState} from 'react';
import {useI18n} from '../../../i18n/I18nProvider';
import {CATALOG_MARKET_SEGMENT_OPTIONS} from '../../../domain/shared/catalogSegments';
import {actOnElringJob,getElringStatus,type ElringStatus} from '../../../infrastructure/api/elringCatalogApi';
import {Button} from './Button';
import {Select} from './Select';
import './ElringCatalogEngine.css';

export function ElringCatalogEngine({onClose,onPublished,defaultSegment=''}:{onClose:()=>void;onPublished:()=>void;defaultSegment?:string}){
 const {locale}=useI18n();const tr=locale==='tr';const dialog=useRef<HTMLDialogElement>(null);
 const supportedSegments=['pc','cv','lcv','motorcycle','engines','universal','marine','industrial','agriculture'];
 const [data,setData]=useState<ElringStatus|null>(null),[jobId,setJobId]=useState(''),[codes,setCodes]=useState(''),[segment,setSegment]=useState(supportedSegments.includes(defaultSegment)?defaultSegment:'');
 const [busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const requestKey=useRef<string|null>(null);const published=useRef(new Set<string>());
 const labels:Record<string,string>=tr?{queued:'Sırada',running:'Çalışıyor',paused:'Devam bekliyor',reviewed:'İnceleme paketi hazır',completed:'Yayınlandı ve doğrulandı',failed:'İşlem durdu',pending:'Bekliyor',observed:'Kaynak okundu',processing:'İşleniyor'}:
  {queued:'Queued',running:'Running',paused:'Resume required',reviewed:'Review package ready',completed:'Published and verified',failed:'Stopped',pending:'Pending',observed:'Source collected',processing:'Processing'};
 const fieldNames:Record<string,string>=tr?{product_code:'Ürün kodu',description:'Açıklama',description_tr:'Türkçe açıklama',weight_kg:'Ağırlık (kg)',hs_code:'Tarife',origin:'Menşe',image_url:'Görsel',vehicle:'Araç',vehicle_model:'Araç modeli',ean:'EAN',market_segment:'Segment',dimensions:'Ölçüler',oem_no:'OEM',lifecycle_status:'Yaşam döngüsü',lifecycle_note:'Yaşam döngüsü notu'}:
  {product_code:'Product code',description:'Description',description_tr:'Turkish description',weight_kg:'Weight (kg)',hs_code:'Tariff',origin:'Origin',image_url:'Image',vehicle:'Vehicle',vehicle_model:'Vehicle model',ean:'EAN',market_segment:'Segment',dimensions:'Dimensions',oem_no:'OEM',lifecycle_status:'Lifecycle',lifecycle_note:'Lifecycle note'};
 const load=useCallback(async()=>{try{const next=await getElringStatus(jobId||undefined);setData(next);setError('');
  if(!jobId&&next.jobs[0])setJobId(next.jobs[0].id);
 }catch(e){setError(e instanceof Error?e.message:'ELRING_REQUEST_FAILED');}},[jobId]);
 useEffect(()=>{dialog.current?.showModal();const el=dialog.current;return()=>el?.close();},[]);
 useEffect(()=>{let active=true;const poll=async()=>{if(active)await load();};void poll();const timer=setInterval(()=>void poll(),5000);return()=>{active=false;clearInterval(timer);};},[load]);
 const job=data?.jobs.find(j=>j.id===jobId);
 useEffect(()=>{if(job?.status==='completed'&&!published.current.has(job.id)){published.current.add(job.id);onPublished();}},[job,onPublished]);
 const parsed=[...new Map(codes.split(/[\n,;]+/).map(c=>c.trim()).filter(Boolean).map(c=>[c.replace(/[^a-z0-9]/gi,'').toUpperCase(),c])).values()];
 const running=job?.status==='running'&&Boolean(job.lease_expires_at&&new Date(job.lease_expires_at).getTime()>Date.now());
 const act=async(action:'start'|'resume'|'publish')=>{setBusy(true);setError('');setNotice('');try{
  if(action==='start')requestKey.current ||= crypto.randomUUID();
  const result=await actOnElringJob(action==='start'?{action,codes:parsed,segment,requestId:requestKey.current!}:{action,jobId});
  setJobId(result.job.id);setNotice(result.dispatchPending?(tr?'İş kaydedildi. Çalıştırmayı yeniden denemek için Devam et’i kullanın.':'Job saved. Use Resume to retry dispatch.'):'');
  if(action==='start'){setCodes('');requestKey.current=null;}
  const next=await getElringStatus(result.job.id);setData(next);
 }catch(e){setError(e instanceof Error?e.message:'ELRING_REQUEST_FAILED');}finally{setBusy(false);}};
 const friendlyError=error?(/AUTH|Forbidden|Missing caller/i.test(error)?(tr?'Bu işlem için katalog yöneticisi olarak giriş yapın.':'Sign in as a catalog administrator.'):
  /authorization|source.*(enabled|unavailable)/i.test(error)?(tr?'Resmi kaynak veya yayın yetkisi henüz hazır değil.':'Official source or publication authorization is not ready.'):
  (tr?'İşlem tamamlanamadı. Tamamlanan paketler korundu; yeniden deneyebilirsiniz.':'The request could not complete. Completed packages are preserved; you can retry.')):'';
 const downloadReport=async()=>{setBusy(true);try{const report=await getElringStatus(jobId,true);
  const url=URL.createObjectURL(new Blob([JSON.stringify(report,null,2)],{type:'application/json'}));
  const a=document.createElement('a');a.href=url;a.download=`elring-${jobId}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
 }catch(e){setError(e instanceof Error?e.message:'ELRING_REQUEST_FAILED');}finally{setBusy(false);}};
 return <dialog ref={dialog} className="elring-engine-dialog" onCancel={event=>{event.preventDefault();onClose();}} aria-labelledby="elring-engine-title">
  <div className="elring-engine-header"><div><h2 id="elring-engine-title">{tr?'Elring Katalog Motoru':'Elring Catalog Engine'}</h2>
   <a href="https://web.tecalliance.net/elring/en/home" target="_blank" rel="noreferrer">{tr?'Resmi Elring kataloğu':'Official Elring catalog'}</a></div>
   <Button variant="secondary" onClick={onClose}>{tr?'Kapat':'Close'}</Button></div>
  <p>{tr?'Ürün kodlarıyla resmi kaynak inceleme paketi oluşturun. Paketleri kontrol ettikten sonra yetkili yayını başlatın.':'Collect official review packages by product code. Inspect the packages before starting authorized publication.'}</p>
  <p className="info-text">{tr?'Sayfayı kapatmak işi silmez. Ürün bilgileri, replacement ve discontinued kaynak kanıtıyla işlenir; görseller kontrollü onayda kalır.':'Closing this page preserves the job. Product facts, replacements and discontinued signals retain source evidence; images remain subject to controlled approval.'}</p>
  {friendlyError?<p role="alert" className="error-text">{friendlyError}</p>:null}{notice?<p role="status">{notice}</p>:null}
  <fieldset disabled={busy||!data?.readAllowed}><legend>{tr?'Yeni inceleme paketi':'New review collection'}</legend>
   <label className="field"><span className="field__label">{tr?'Ürün kodları — satır veya virgülle ayrılmış, en fazla 100':'Product codes — one per line or comma separated, up to 100'}</span>
    <textarea className="field__input" rows={4} value={codes} placeholder="115.100" onChange={e=>{setCodes(e.target.value);requestKey.current=null;}}/></label>
   <Select label={tr?'Kaynakta bulunmayan ürünler için market segment':'Market segment when missing at source'} value={segment} onChange={v=>{setSegment(v);requestKey.current=null;}}
    options={[{value:'',label:tr?'Segment seçin':'Select segment'},...CATALOG_MARKET_SEGMENT_OPTIONS.filter(option=>supportedSegments.includes(option.value))]}/>
   <Button onClick={()=>void act('start')} disabled={!parsed.length||parsed.length>100||!segment} busy={busy}>{tr?'İnceleme için topla':'Collect for review'}</Button>
  </fieldset>
  {data&&!data.readAllowed?<p role="status">{tr?'Resmi kaynak okuma yetkisi hazır değil.':'Official source read authorization is not ready.'}</p>:null}
  {data?.jobs.length?<section>
   <Select label={tr?'Kayıtlı işler':'Saved jobs'} value={jobId} onChange={setJobId} options={data.jobs.map(j=>({value:j.id,label:`${j.id.slice(0,8)} · ${labels[j.status]} · ${j.total_items}`}))}/>
   {job?<><p role="status" aria-live="polite"><strong>{labels[job.status]}</strong> · {job.next_index} / {job.total_items}</p>
    <progress max={job.total_items} value={job.next_index} aria-label={tr?'Paket ilerlemesi':'Package progress'}/>
    <div className="elring-engine-actions">
     {['paused','failed','queued'].includes(job.status)||job.status==='running'&&!running?<Button onClick={()=>void act('resume')} busy={busy}>{tr?'Devam et':'Resume'}</Button>:null}
     {job.status==='reviewed'?<Button onClick={()=>void act('publish')} disabled={!data.publishAllowed} busy={busy}>{tr?'İncelenen paketi yayınla':'Publish reviewed package'}</Button>:null}
     <Button variant="secondary" onClick={()=>void load()} disabled={busy}>{tr?'Durumu yenile':'Refresh status'}</Button>
     <Button variant="secondary" onClick={()=>void downloadReport()} disabled={busy}>{tr?'Kaynak değerleriyle raporu indir':'Download report with source values'}</Button>
    </div>
    {job.status==='reviewed'&&!data.publishAllowed?<p>{tr?'İnceleme hazır. Kaynak için kayıtlı yayın yetkisi bulunmadığından yayın kapalı.':'Review is ready. Publication is disabled until source publication authorization is registered.'}</p>:null}
    {job.error_message?<p role="alert">{tr?'İş bu üründe durdu; önceki paketler korundu. Kaynak, segment veya uyumluluk kapsamını kontrol edin.':'The job stopped at this product; earlier packages are preserved. Check source identity, segment or fitment scope.'}</p>:null}
    <div className="elring-engine-results"><table><thead><tr><th>{tr?'Ürün':'Product'}</th><th>{tr?'Durum':'Status'}</th><th>{tr?'Kaynak alanları':'Source fields'}</th><th>{tr?'Yaşam döngüsü':'Lifecycle'}</th></tr></thead>
     <tbody>{data.items.map(item=><tr key={item.productCode}><td>{item.productCode}</td><td>{labels[item.state]||item.state}</td>
      <td><details><summary>{Object.values(item.fields).filter(v=>v==='present').length} / {Object.keys(item.fields).length}</summary>
       <dl>{Object.entries(item.fields).map(([field,value])=><div key={field}><dt>{fieldNames[field]||field}</dt><dd>{value==='present'?(tr?'Kaynakta var':'Present'):(tr?'Kaynakta yok':'Missing')}</dd></div>)}</dl></details>
       {item.limitations.some(l=>l.startsWith('vehicle_fitment_'))?<div>{tr?'Araç uyumluluğu eksik; yayın engellenir.':'Incomplete fitment; publication blocked.'}</div>:null}</td>
      <td>{!item.sourceChecks?.discontinued?(tr?'Henüz okunmadı':'Not yet collected'):item.sourceChecks.discontinued==='found'?(tr?'Resmi discontinued beyanı var':'Official discontinued signal'):(tr?'Açık discontinued sinyali yok':'No explicit discontinued signal')}
       <div>{!item.sourceChecks?.replacement?(tr?'Henüz okunmadı':'Not yet collected'):item.sourceChecks.replacement==='found'?(tr?'Yönlü replacement beyanı var':'Directional replacement signal'):(tr?'Replacement sinyali yok':'No replacement signal')}</div>
       {item.lifecycle?<div>{tr?'Uygulanan discontinued':'Discontinued applied'}: {item.lifecycle.discontinued_applied||0} · {tr?'Eklenen ilişki':'Relations added'}: {item.lifecycle.relations_inserted||0}</div>:null}</td></tr>)}</tbody></table></div>
   </>:null}
  </section>:null}
 </dialog>;
}
