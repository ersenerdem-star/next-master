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
 const purpose=(row:CatalogProgress['rows'][number])=>{
  if(tr){
   if(row.kind==='zf')return 'Sachs / ZF kaynak farkı karşılaştırması';
   if(row.kind==='elring')return 'Elring resmî kaynak incelemesi';
   if(row.kind==='elring-completion')return 'Elring eksik alan tamamlama';
   if(row.kind==='elring-secondary')return 'Elring ikincil kaynak kontrolü';
   if(row.source.includes('wilmink'))return `${row.brand} · Wilmink destek kontrolü`;
   if(row.source.includes('spareto'))return `${row.brand} · Spareto düzeltme kontrolü`;
   return `${row.brand} kaynak incelemesi`;
  }
  if(row.kind==='zf')return 'Sachs / ZF source comparison';
  if(row.kind==='elring')return 'Elring official source review';
  if(row.kind==='elring-completion')return 'Elring missing-field completion';
  if(row.kind==='elring-secondary')return 'Elring secondary-source check';
  if(row.source.includes('wilmink'))return `${row.brand} · Wilmink support check`;
  if(row.source.includes('spareto'))return `${row.brand} · Spareto correction check`;
  return `${row.brand} source review`;
 };
 const approval=(row:CatalogProgress['rows'][number])=>{
  if(tr){
   if(row.status==='reviewed')return 'Onay bekliyor';
   if(row.status==='completed')return row.kind==='elring'?'Uygulandı / doğrulandı':'Kontrol tamamlandı';
   if(row.status==='failed')return 'Kontrol gerekli';
   if(row.status==='paused')return 'Devam bekliyor';
   if(['queued','running','pending','retrying'].includes(row.status))return 'İnceleme sürüyor';
   return '—';
  }
  if(row.status==='reviewed')return 'Awaiting approval';
  if(row.status==='completed')return row.kind==='elring'?'Applied / verified':'Review complete';
  if(row.status==='failed')return 'Review required';
  if(row.status==='paused')return 'Resume required';
  if(['queued','running','pending','retrying'].includes(row.status))return 'Review in progress';
  return '—';
 };
 const nextStep=(row:CatalogProgress['rows'][number])=>{
  if(tr){
   if(row.status==='reviewed')return row.source.includes('wilmink')?'Ürün bazında onayla → uygun alanları kataloğa uygula':'İnceleme paketini aç → doğrulanmış düzeltmeleri uygula';
   if(row.status==='completed')return row.kind==='elring'?'Katalog kaydı güncellendi; yeni inceleme gerekirse yeni paket aç':'İş tamamlandı; kaynak kanıtı saklandı';
   if(row.status==='failed')return 'Hata nedenini aç → aynı işi devam ettir veya yeniden başlat';
   if(row.status==='paused')return 'Devam et ile kaldığı üründen sürdür';
   if(['queued','running','pending','retrying'].includes(row.status))return 'Kaynak okuması tamamlanınca inceleme paketi oluşacak';
   return '—';
  }
  if(row.status==='reviewed')return row.source.includes('wilmink')?'Approve per product → apply eligible fields':'Open review package → apply verified corrections';
  if(row.status==='completed')return row.kind==='elring'?'Catalog record updated; start a new package for another review':'Completed; source evidence retained';
  if(row.status==='failed')return 'Open the failure reason → resume or restart the same job';
  if(row.status==='paused')return 'Resume from the saved checkpoint';
  if(['queued','running','pending','retrying'].includes(row.status))return 'A review package will be available after source reading';
  return '—';
 };
 const detailCopy=(row:CatalogProgress['rows'][number])=>{
  if(row.source.includes('wilmink'))return tr
   ? {what:'Wilmink tedarikçi kaynağındaki ürün sayfaları okundu; üretici kodu/EAN ve eksik alan kanıtı paketlendi.',where:'Onaylanan eksik alanlar katalog ürününe uygulanır. Mevcut dolu alanlar ve fiyatlar korunur; çelişkiler uygulanmaz.',next:nextStep(row)}
   : {what:'Wilmink distributor product pages were read; manufacturer article/EAN and missing-field evidence were packaged.',where:'Approved missing fields are applied to the catalog product. Existing populated fields and prices are preserved; conflicts are held.',next:nextStep(row)};
  if(row.kind==='zf')return tr
   ? {what:'Sachs/ZF kaynağı ile mevcut katalog kaydı karşılaştırıldı.',where:'İnceleme ekranındaki doğrulanmış farklar seçilerek kataloğa uygulanır.',next:nextStep(row)}
   : {what:'The Sachs/ZF source was compared with the current catalog record.',where:'Verified differences are selected in the review screen and then applied to the catalog.',next:nextStep(row)};
  if(row.kind.startsWith('elring'))return tr
   ? {what:'Elring kaynağından ürün, yaşam döngüsü veya ikincil alan kanıtı işlendi.',where:'Elring motorundaki inceleme paketi üzerinden onaylanır; yayın yetkisi varsa kataloğa uygulanır.',next:nextStep(row)}
   : {what:'Elring product, lifecycle, or secondary-field evidence was collected.',where:'It is approved through the Elring review package and applied only when publication authorization exists.',next:nextStep(row)};
  return tr
   ? {what:'Marka kaynağı için katalog inceleme işi çalıştırıldı.',where:'İnceleme paketi tamamlandığında ürün bazında onay ve uygulama yapılır.',next:nextStep(row)}
   : {what:'A catalog review job ran for this brand source.',where:'When the package is ready, products are approved and applied individually.',next:nextStep(row)};
 };
 return <section className="catalog-job-progress" aria-label={tr?'Katalog iş ilerlemeleri':'Catalog job progress'}>
  <div className="toolbar toolbar--wrap"><h3>{tr?'Katalog iş ilerlemeleri':'Catalog job progress'}</h3><Button variant="secondary" disabled={loading} onClick={()=>void refresh()}>{loading?(tr?'Güncelleniyor…':'Refreshing…'):(tr?'İlerlemeyi yenile':'Refresh progress')}</Button></div>
  <p>{tr?'15 saniyede bir yenilenir. Sayılar belirtilen işe aittir; ürün veri doluluk oranından ayrıdır.':'Refreshes every 15 seconds. Counts belong to each job and are separate from product completeness.'}</p>
  <p>{tr?'İşlenen kayıt sayısı, alanların eksiksiz doldurulduğu anlamına gelmez. — toplam kapsamın iş kaydında belirtilmediğini gösterir.':'Processed records do not mean every field is complete. — means the job does not specify its total scope.'}</p>
  {data?<p>{tr?'Son başarılı kontrol':'Last successful check'}: <strong>{date(data.checkedAt)}</strong></p>:null}
  {failed?<p role="alert" className="error-text">{tr?'Güncel ilerleme alınamadı. Varsa son başarılı kontrolün verileri gösteriliyor.':'Live progress is unavailable. Any displayed data is from the last successful check.'}</p>:null}
  {data?.truncated?<p role="status">{tr?'Yoğun kuyruk: gösterilen bekleyen iş sayısı kısmi olabilir.':'Busy queue: pending job counts may be partial.'}</p>:null}
  {rows.length?<div className="catalog-enrichment-table-wrap"><table className="catalog-enrichment-table"><thead><tr>{(tr?['Marka','İşin amacı','Kaynak / motor','Aşama','İş durumu','Onay / uygulama','Sonraki adım','İşlenen / kapsam','Değişiklik','Aktif iş','Son hareket']:['Brand','Purpose','Source / engine','Phase','Job status','Approval / application','Next step','Processed / scope','Changes','Active jobs','Last activity']).map(title=><th key={title}>{title}</th>)}</tr></thead><tbody>{rows.map(row=>{const detail=detailCopy(row);return <tr key={`${row.kind}:${row.id}:${row.phase}`}><td>{row.brand}</td><td>{purpose(row)}<details className="catalog-job-progress__details"><summary>{tr?'Akışı gör':'View flow'}</summary><dl><div><dt>{tr?'Ne yaptı':'What it did'}</dt><dd>{detail.what}</dd></div><div><dt>{tr?'Nereye gider':'Where it goes'}</dt><dd>{detail.where}</dd></div><div><dt>{tr?'Sonraki adım':'Next step'}</dt><dd>{detail.next}</dd></div></dl></details></td><td>{engines[row.kind]||row.kind}{row.source?<small> · {row.source.includes('wilmink')?'Wilmink':row.source.includes('spareto')?'Spareto':row.source}</small>:null}<small className="catalog-job-progress__id">{row.id}</small></td><td>{phases[row.phase]||row.phase}</td><td>{states[row.status]||row.status}{row.activeJobs>0&&row.updatedAt&&Date.now()-Date.parse(row.updatedAt)>15*60*1000?<small>{tr?' · Son hareket 15 dakikadan eski':' · Last activity over 15 minutes ago'}</small>:null}</td><td><strong>{approval(row)}</strong></td><td>{nextStep(row)}</td><td>{number(row.processed)} / {number(row.total)}</td><td>{number(row.changed)}</td><td>{number(row.activeJobs)}</td><td>{date(row.updatedAt)}</td></tr>;})}</tbody></table></div>:current&&data&&!failed&&!loading?<p>{tr?'Seçili marka için son iş kaydı yok.':'No recent jobs for the selected brand.'}</p>:null}
 </section>;
}
