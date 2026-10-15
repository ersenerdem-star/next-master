import {useEffect,useRef,useState} from 'react';
import {fetchSupplierReleaseReviewPage,type ReleaseReviewCursor} from '../../infrastructure/api/supplierReleaseReviewApi';
import {releaseReviewState, splitReleaseReviewHistory, type ReleaseReviewRow} from '../../shared/supplierReleaseReview';
import {SectionCard} from '../../presentation/components/common/SectionCard';
import {Button} from '../../presentation/components/common/Button';
import {useActionFeedback} from '../../presentation/components/common/ActionFeedback';
import {SupplierReleaseIssuePanel} from './SupplierReleaseIssuePanel';
import {SupplierReleaseReviewCard} from './SupplierReleaseReviewCard';
import {supplierReleaseActionsEnabled} from '../../infrastructure/api/supplierReleaseActionsApi';

export function SupplierReleaseReviewPanel({locale}:{locale:string}){
  const tr=locale==='tr',feedback=useActionFeedback();
  const actionsEnabled=supplierReleaseActionsEnabled();
  const [rows,setRows]=useState<ReleaseReviewRow[]>([]),[next,setNext]=useState<ReleaseReviewCursor|null>(null);
  const [cursor,setCursor]=useState<ReleaseReviewCursor|null>(null),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState(false),[loaded,setLoaded]=useState(false);
  const [issueRelease,setIssueRelease]=useState<ReleaseReviewRow|null>(null);
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
  const grouped=splitReleaseReviewHistory(rows);
  const stateLabel=(state:string)=>tr
    ? ({staged:'dosya işlendi — kontrol bekliyor',processing_interrupted:'işlem durdu',active:'aktif',review_required:'inceleme gerekli',awaiting_publication:'yayın bekliyor',unverified:'kontrol bekliyor',processing:'işleniyor',inactive:'pasif',rejected:'reddedildi'} as Record<string,string>)[state] || state
    : state.replaceAll('_',' ');
  const latestSummary=grouped.latest.reduce((counts,row)=>{
    const state=releaseReviewState(row);
    counts[state]=(counts[state]||0)+1;
    return counts;
  },{} as Record<string,number>);
  return <SectionCard title={tr?'Tedarikçi fiyat yayınları':'Supplier price releases'} actions={
    <Button variant="secondary" disabled={loading} onClick={()=>setRefresh(v=>v+1)}>{tr?'Yenile':'Refresh'}</Button>}>
    <p>{actionsEnabled?(tr?'Dosya kabulü, doğrulama ve fiyat yayını ayrı aşamalardır. Kaydı açarak güncel kontrol sonucunu inceleyin; yayın için ayrıca onay verin.'
      :'File acceptance, validation, and publication are separate stages. Open a release to review current evidence; publication requires a separate confirmation.')
      :(tr?'Salt okunur kontrol ekranı. Dosya kabulü, doğrulama ve fiyat yayını farklı aşamalardır. Bu bölüm eski upload akışının güvenlik kontrolünden geçtiğini göstermez.':'Read-only review. File acceptance, validation and price publication are separate stages. This section does not certify the legacy upload path.')}</p>
    {error ? <div role="alert" className="error-text">{tr?'Upgrade kontrol durumu alınamadı. Gösterilen eski veriler güncel olmayabilir; kontrol tamamlandı kabul etmeyin.':'Upgrade review status is unavailable. Previously displayed data may be stale; do not treat the check as completed.'}</div> : null}
    {loading ? <p role="status">{tr?'Kontroller yükleniyor…':'Loading checks…'}</p> : null}
    {loaded && !error && !rows.length ? <p>{tr?'Bu sayfada upgrade kaydı yok. Eski yüklemeler kontrol edilmiş sayılmaz.':'No upgraded releases on this page. Legacy uploads are not considered checked.'}</p> : null}
    {grouped.latest.length ? <div className="supplier-release-review-summary" aria-label={tr?'En yeni kapsam özeti':'Latest scope summary'}>
      {Object.entries(latestSummary).map(([state,count])=><span key={state}><strong>{count}</strong> {stateLabel(state)}</span>)}
    </div> : null}
    <SupplierReleaseReviewCard onIssues={setIssueRelease} rows={grouped.latest} tr={tr} onDetails={feedback.fail} actionsEnabled={actionsEnabled} onChanged={()=>setRefresh(v=>v+1)}/>
    {grouped.history.length ? <details className="supplier-release-history">
      <summary>{tr?`Geçmiş yüklemeler (${grouped.history.length})`:`Older uploads (${grouped.history.length})`}</summary>
      <SupplierReleaseReviewCard onIssues={setIssueRelease} rows={grouped.history} tr={tr} onDetails={feedback.fail} actionsEnabled={actionsEnabled} onChanged={()=>setRefresh(v=>v+1)}/>
    </details> : null}
    {issueRelease ? <SupplierReleaseIssuePanel key={issueRelease.id} release={issueRelease} tr={tr} onClose={()=>setIssueRelease(null)} /> : null}
    <div className="toolbar toolbar--wrap">
      {cursor ? <Button variant="secondary" disabled={loading} onClick={()=>setCursor(null)}>{tr?'En yeni kayıtlar':'Latest releases'}</Button> : null}
      {next ? <Button variant="secondary" disabled={loading||error} onClick={()=>setCursor(next)}>{tr?'Daha eski kayıtlar':'Older releases'}</Button> : null}
    </div>
  </SectionCard>;
}
