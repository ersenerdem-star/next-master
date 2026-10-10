import {useEffect,useRef,useState} from 'react';
import {fetchSupplierReleaseReviewPage,type ReleaseReviewCursor} from '../../infrastructure/api/supplierReleaseReviewApi';
import type {ReleaseReviewRow} from '../../shared/supplierReleaseReview';
import {SectionCard} from '../../presentation/components/common/SectionCard';
import {Button} from '../../presentation/components/common/Button';
import {useActionFeedback} from '../../presentation/components/common/ActionFeedback';
import {SupplierReleaseReviewCard} from './SupplierReleaseReviewCard';

export function SupplierReleaseReviewPanel({locale}:{locale:string}){
  const tr=locale==='tr',feedback=useActionFeedback();
  const [rows,setRows]=useState<ReleaseReviewRow[]>([]),[next,setNext]=useState<ReleaseReviewCursor|null>(null);
  const [cursor,setCursor]=useState<ReleaseReviewCursor|null>(null),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState(false),[loaded,setLoaded]=useState(false);
  const serial=useRef(0);
  useEffect(()=>{
    const controller=new AbortController(), version=++serial.current;
    setLoading(true);
    const timer=window.setTimeout(()=>controller.abort(),12000);
    void fetchSupplierReleaseReviewPage(cursor,controller.signal).then(page=>{
      if(version!==serial.current || controller.signal.aborted)return;
      setRows(page.rows);setNext(page.next);setLoaded(true);setError(false);
    }).catch(()=>{if(version===serial.current)setError(true);}).finally(()=>{
      window.clearTimeout(timer);if(version===serial.current)setLoading(false);
    });
    return ()=>{++serial.current;window.clearTimeout(timer);controller.abort();};
  },[cursor,refresh]);
  useEffect(()=>{
    const interval=window.setInterval(()=>{if(document.visibilityState==='visible')setRefresh(v=>v+1);},45000);
    return ()=>window.clearInterval(interval);
  },[]);
  return <SectionCard title={tr?'Upgrade — marka güvenlik kontrolleri':'Upgrade — brand safety checks'} actions={
    <Button variant="secondary" disabled={loading} onClick={()=>setRefresh(v=>v+1)}>{tr?'Yenile':'Refresh'}</Button>}>
    <p>{tr?'Salt okunur kontrol ekranı. Dosya kabulü, doğrulama ve fiyat yayını farklı aşamalardır. Bu bölüm eski upload akışının güvenlik kontrolünden geçtiğini göstermez.':'Read-only review. File acceptance, validation and price publication are separate stages. This section does not certify the legacy upload path.'}</p>
    {error ? <div role="alert" className="error-text">{tr?'Upgrade kontrol durumu alınamadı. Gösterilen eski veriler güncel olmayabilir; kontrol tamamlandı kabul etmeyin.':'Upgrade review status is unavailable. Previously displayed data may be stale; do not treat the check as completed.'}</div> : null}
    {loading ? <p role="status">{tr?'Kontroller yükleniyor…':'Loading checks…'}</p> : null}
    {loaded && !error && !rows.length ? <p>{tr?'Bu sayfada upgrade kaydı yok. Eski yüklemeler kontrol edilmiş sayılmaz.':'No upgraded releases on this page. Legacy uploads are not considered checked.'}</p> : null}
    <SupplierReleaseReviewCard rows={rows} tr={tr} onDetails={feedback.fail}/>
    <div className="toolbar toolbar--wrap">
      {cursor ? <Button variant="secondary" disabled={loading} onClick={()=>setCursor(null)}>{tr?'En yeni kayıtlar':'Latest releases'}</Button> : null}
      {next ? <Button variant="secondary" disabled={loading||error} onClick={()=>setCursor(next)}>{tr?'Daha eski kayıtlar':'Older releases'}</Button> : null}
    </div>
  </SectionCard>;
}
