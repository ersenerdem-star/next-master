import {useEffect,useRef,useState} from 'react';
import {supabaseClient} from '../../infrastructure/api/supabaseClient';
import {NavGlyph} from '../../presentation/components/common/NextMasterBrand';

type Statistics={totalBrands:number;pricedBrands:number;pricedParts:number;asOf:string};
function Count({value,locale}:{value:number;locale:string}){
 const [display,setDisplay]=useState(0),previous=useRef(0);
 useEffect(()=>{
  const from=previous.current;previous.current=value;
  if(window.matchMedia('(prefers-reduced-motion: reduce)').matches){setDisplay(value);return;}
  let frame=0,start=0;
  const tick=(now:number)=>{start||=now;const progress=Math.min((now-start)/850,1);
   setDisplay(Math.round(from+(value-from)*(1-Math.pow(1-progress,3))));
   if(progress<1)frame=requestAnimationFrame(tick);};
  frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);
 },[value]);
 return <><span aria-hidden="true">{display.toLocaleString(locale)}</span><span className="sr-only">{value.toLocaleString(locale)}</span></>;
}
export function SupplierPriceStatistics({tr,refresh}:{tr:boolean;refresh:number}){
 const [stats,setStats]=useState<Statistics|null>(null),[error,setError]=useState(false);
 const [loading,setLoading]=useState(true);
 useEffect(()=>{
  const controller=new AbortController();let live=true;
  const timer=setTimeout(()=>controller.abort(),11000);setLoading(true);setError(false);
  void Promise.resolve(supabaseClient.rpc('get_supplier_current_price_statistics').abortSignal(controller.signal)).then(({data,error})=>{
   if(!live)return;
   if(error||!data||!['totalBrands','pricedBrands','pricedParts'].every(k=>Number.isSafeInteger(data[k])&&data[k]>=0)
    ||data.pricedBrands>data.totalBrands||typeof data.asOf!=='string')throw Error('Statistics unavailable');
   setStats(data as Statistics);
  }).catch(()=>{if(live)setError(true);}).finally(()=>{clearTimeout(timer);if(live)setLoading(false);});
  return()=>{live=false;clearTimeout(timer);controller.abort();};
 },[refresh]);
 const language=tr?'tr-TR':'en-US';
 return <section className="supplier-live-stats" aria-label={tr?'Güncel fiyat kapsamı':'Current price coverage'} aria-busy={loading}>
  <div className="supplier-live-stats__card supplier-live-stats__card--brands">
   <span className="supplier-live-stats__icon"><NavGlyph name="brand"/></span>
   <div><span className="supplier-live-stats__label">{tr?'Toplam marka':'Total brands'}</span>
    <strong>{stats&&!error?<Count value={stats.totalBrands} locale={language}/>:loading?'…':'—'}</strong>
    <small>{stats&&!error?(tr?`${stats.pricedBrands.toLocaleString(language)} markada aktif fiyat`:`${stats.pricedBrands.toLocaleString(language)} brands with active prices`):(tr?'Marka kapsamı':'Brand coverage')}</small>
   </div>
  </div>
  <div className="supplier-live-stats__card supplier-live-stats__card--parts">
   <span className="supplier-live-stats__icon"><NavGlyph name="inventory"/></span>
   <div><span className="supplier-live-stats__label">{tr?'Fiyatlanan parça numarası':'Priced part numbers'}</span>
    <strong>{stats&&!error?<Count value={stats.pricedParts} locale={language}/>:loading?'…':'—'}</strong>
    <small>{tr?'Marka + parça no · tekil kayıt':'Brand + part no · unique entries'}</small>
   </div>
   {stats&&!error&&!loading?<span className="supplier-live-stats__live"><i/>{tr?'Aktif':'Active'}</span>:null}
  </div>
  <p className="supplier-live-stats__note" role={error?'status':undefined}>{error
   ?(tr?'İstatistikler şu an alınamıyor. Yenile ile tekrar deneyin.':'Statistics are unavailable. Use Refresh to try again.')
   :loading?(tr?'Güncel fiyat kapsamı hesaplanıyor…':'Calculating current price coverage…')
   :(tr?'Geçerli fiyatlar esas alınır; tekrarlar ve eski yayınlar sayılmaz.':'Based on effective prices; duplicates and previous publications are excluded.')}</p>
 </section>;
}
