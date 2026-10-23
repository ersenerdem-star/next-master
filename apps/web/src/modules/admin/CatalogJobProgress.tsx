import {useCallback,useEffect,useRef,useState} from 'react';
import {fetchCatalogProgress,type CatalogProgress} from '../../infrastructure/api/catalogProgressApi';
import {includesLooseText} from '../../domain/shared/normalize';
import {Button} from '../../presentation/components/common/Button';
export function CatalogJobProgress({locale,search}:{locale:string;search:string}){
 const tr=locale==='tr',[data,setData]=useState<CatalogProgress|null>(null),[failed,setFailed]=useState(false),[loading,setLoading]=useState(false);
 const [dataSearch,setDataSearch]=useState<string|null>(null);
 const request=useRef<AbortController|null>(null);
 const refresh=useCallback(async()=>{
  if(request.current)return;
  const controller=new AbortController();request.current=controller;setLoading(true);
  const timer=window.setTimeout(()=>controller.abort(),25000);
  try{const next=await fetchCatalogProgress(controller.signal,search);if(!controller.signal.aborted){setData(next);setDataSearch(search.trim());setFailed(false);}}catch{if(request.current===controller)setFailed(true);}finally{window.clearTimeout(timer);if(request.current===controller){request.current=null;setLoading(false);}}
 },[search]);
 useEffect(()=>{
  const initial=window.setTimeout(()=>void refresh(),300);const tick=window.setInterval(()=>{if(document.visibilityState==='visible')void refresh();},15000);
  const focus=()=>{if(document.visibilityState==='visible')void refresh();};window.addEventListener('focus',focus);document.addEventListener('visibilitychange',focus);
  return()=>{window.clearTimeout(initial);window.clearInterval(tick);window.removeEventListener('focus',focus);document.removeEventListener('visibilitychange',focus);const current=request.current;request.current=null;current?.abort();};
 },[refresh]);
 const current=dataSearch===search.trim();
 const rows=(current?data?.rows||[]:[]).filter(row=>!search.trim()||includesLooseText(row.brand,search));
 const number=(value:number|null)=>value==null?'—':value.toLocaleString(tr?'tr-TR':'en-US');
 const date=(value:string|null)=>value?new Date(value).toLocaleString(tr?'tr-TR':'en-GB'):'—';
 const phases:Record<string,string>=tr?{stage:'Kaynak kontrolü',publish:'Kataloğa uygulama',fitment:'Araç uyumluluğu',enrichment:'Veri zenginleştirme',lifecycle:'Ürün yaşam durumu',images:'Görseller',secondary:'Temel alanlar · ikincil kaynak'}:{};
 const engines:Record<string,string>=tr?{brand:'Kaynak kataloğu',zf:'ZF resmî kataloğu',elring:'Elring resmî kataloğu','elring-completion':'Elring veri tamamlama','elring-images':'Elring görselleri','elring-secondary':'Elring ikincil kaynak'}:{brand:'Source catalog',zf:'ZF official catalog',elring:'Elring official catalog','elring-completion':'Elring data completion','elring-images':'Elring images','elring-secondary':'Elring secondary source'};
 const states:Record<string,string>=tr?{running:'Çalışıyor',queued:'Sırada',paused:'Duraklatıldı',pending:'Bekliyor',retrying:'Yeniden deneniyor',completed:'Tamamlandı',reviewed:'Kontrol edildi',failed:'Başarısız',cancelled:'İptal edildi'}:{};
 return <section className="catalog-job-progress" aria-label={tr?'Katalog iş ilerlemeleri':'Catalog job progress'}>
  <div className="toolbar toolbar--wrap"><h3>{tr?'Katalog iş ilerlemeleri':'Catalog job progress'}</h3><Button variant="secondary" disabled={loading} onClick={()=>void refresh()}>{loading?(tr?'Güncelleniyor…':'Refreshing…'):(tr?'İlerlemeyi yenile':'Refresh progress')}</Button></div>
  <p>{tr?'15 saniyede bir yenilenir. Sayılar belirtilen işe aittir; ürün veri doluluk oranından ayrıdır.':'Refreshes every 15 seconds. Counts belong to each job and are separate from product completeness.'}</p>
  <p>{tr?'İşlenen kayıt sayısı, alanların eksiksiz doldurulduğu anlamına gelmez. — toplam kapsamın iş kaydında belirtilmediğini gösterir.':'Processed records do not mean every field is complete. — means the job does not specify its total scope.'}</p>
  {data?<p>{tr?'Son başarılı kontrol':'Last successful check'}: <strong>{date(data.checkedAt)}</strong></p>:null}
  {failed?<p role="alert" className="error-text">{tr?'Güncel ilerleme alınamadı. Varsa son başarılı kontrolün verileri gösteriliyor.':'Live progress is unavailable. Any displayed data is from the last successful check.'}</p>:null}
  {data?.truncated?<p role="status">{tr?'Yoğun kuyruk: gösterilen bekleyen iş sayısı kısmi olabilir.':'Busy queue: pending job counts may be partial.'}</p>:null}
  {rows.length?<div className="catalog-enrichment-table-wrap"><table className="catalog-enrichment-table"><thead><tr>{(tr?['Marka','İş / kaynak','Aşama','Durum','İşlenen / kapsam','Değişiklik sayısı','Bekleyen / aktif iş','Son hareket']:['Brand','Job / source','Phase','Status','Processed / scope','Changes','Pending / active jobs','Last activity']).map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(row=><tr key={`${row.kind}:${row.id}:${row.phase}`}><td>{row.brand}</td><td>{engines[row.kind]||row.kind}{row.source?<small> · {row.source.includes('wilmink')?'Wilmink':row.source.includes('spareto')?'Spareto':row.brand}</small>:null}</td><td>{phases[row.phase]||row.phase}</td><td>{states[row.status]||row.status}{row.activeJobs>0&&row.updatedAt&&Date.now()-Date.parse(row.updatedAt)>15*60*1000?<small>{tr?' · Son hareket 15 dakikadan eski':' · Last activity over 15 minutes ago'}</small>:null}</td><td>{number(row.processed)} / {number(row.total)}</td><td>{number(row.changed)}</td><td>{number(row.activeJobs)}</td><td>{date(row.updatedAt)}</td></tr>)}</tbody></table></div>:current&&data&&!failed&&!loading?<p>{tr?'Seçili marka için son iş kaydı yok.':'No recent jobs for the selected brand.'}</p>:null}
 </section>;
}
