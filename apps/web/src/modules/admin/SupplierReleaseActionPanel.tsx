import React,{useCallback,useEffect,useRef,useState} from 'react';
import {Button} from '../../presentation/components/common/Button';
import {supplierReleaseActionsClient,SupplierReleaseActionError} from '../../infrastructure/api/supplierReleaseActionsApi';
import {actionScope,prepareDurableAction,publicationConfirmationKey,publishCommand,readDurableAction,reconcileDurableAction,recordActionFailure,
  releasePublicationReady,reviewCommand,updateDurableAction,type ActionKind,type DurableAction,type ReceiptStorage,
  type ReleaseActionEvidence,type ReviewReason} from '../../shared/supplierReleaseActions';

type Records={review:DurableAction|null;publish:DurableAction|null};
const unresolved=(r:DurableAction|null)=>Boolean(r&&['pending','unknown'].includes(r.phase));
export function releaseActionErrorMessage(code:string,tr:boolean) {
  if(code.includes('LEGACY_COMMERCIAL_FIELDS_UNSUPPORTED'))return tr?'Mevcut fiyatlarda bu motorun koruyamadığı ticari alanlar var. Yayın engellendi; bu alanlar korunacak şekilde uyumlu içe aktarma gerekiyor.':'Current prices contain commercial fields this engine cannot preserve. Publication is blocked until a compatible import preserves those fields.';
  if(code.includes('SOURCE_COMPATIBILITY_REQUIRED'))return tr?'Kaynak dosyanın desteklenmeyen ticari alanlar açısından kontrolü tamamlanmadı. Fiyat yayını bekletiliyor.':'The source file has not completed the check for unsupported commercial fields. Publication is on hold.';
  if(code.includes('NOT_ENABLED'))return tr?'İnceleme ve yayın işlemleri bu ortamda henüz etkin değil.':'Review and publication actions are not enabled in this environment.';
  if(code.includes('AUTH')||code.includes('ACTOR'))return tr?'Oturum değişti veya doğrulanamadı. Kendi hesabınızla giriş yapıp kontrolü yenileyin.':'Your session changed or could not be verified. Sign in and refresh the evidence.';
  if(code.includes('STORAGE'))return tr?'İşlem kimliği bu tarayıcıda güvenle saklanamıyor. Gönderim durduruldu; mevcut işlem kaydını silmeyin.':'This browser cannot safely retain the decision receipt. Submission is blocked; keep the existing receipt.';
  if(code.includes('STALE')||code.includes('CONFLICT')||code.includes('REVISION')||code.includes('MISMATCH'))return tr?'Kontrol sonucu veya aktif sürüm değişti. Güncel kontrolü alın ve kararı yeniden değerlendirin.':'The evidence or active version changed. Refresh the evidence and review your decision.';
  if(code==='ACTION_OUTCOME_UNKNOWN')return tr?'İsteğin sonucu henüz doğrulanamadı. Aynı işlem kimliğiyle sonucu kontrol edin.':'The request outcome is not yet verified. Check it using the same decision ID.';
  return tr?'İşlem doğrulanamadı. Kontrolü yenileyin; sonuç alınmadan yayın tamamlandı kabul etmeyin.':'The operation could not be verified. Refresh the evidence; publication is incomplete until a receipt is confirmed.';
}

type ViewProps={tr:boolean;evidence:ReleaseActionEvidence|null;records:Records;error:string|null;loading:boolean;busy:boolean;
  confirmed:boolean;reason:ReviewReason;onConfirm:(checked:boolean)=>void;onReason:(reason:ReviewReason)=>void;
  onRefresh:()=>void;onReview:()=>void;onPublish:()=>void;onRetry:(kind:ActionKind)=>void;};
export function SupplierReleaseActionView(p:ViewProps) {
  const {tr,evidence:e,records}=p;
  const pending=unresolved(records.review)||unresolved(records.publish);
  const remotePending=Boolean(e&&[e.reviewOperation,e.publishOperation].some(op=>op&&['queued','running'].includes(op.status)));
  const ready=releasePublicationReady(e)&&!pending&&!remotePending&&!p.error;
  return <section className="list-stack" aria-label={tr?'İnceleme ve yayın':'Review and publication'} style={{borderTop:'1px solid var(--border-color, #d8e1ee)',paddingTop:16}}>
    <div className="toolbar toolbar--wrap"><strong>{tr?'İnceleme ve yayın':'Review and publication'}</strong>
      <Button variant="secondary" disabled={p.loading||p.busy} onClick={p.onRefresh}>{tr?'Güncel kontrolü al':'Refresh evidence'}</Button></div>
    {p.loading?<span role="status">{tr?'Güncel durum doğrulanıyor…':'Verifying the current status…'}</span>:null}
    {p.error?<p role="alert" className="error-text">{releaseActionErrorMessage(p.error,tr)}</p>:null}
    {e?<>
      <strong>{e.supplier} · {e.brand}</strong>
      <span>{tr?'Dosya satırları':'Source rows'}: {e.totalRows.toLocaleString(tr?'tr-TR':'en-US')} · {tr?'Kabul':'Accepted'}: {e.acceptedRows.toLocaleString(tr?'tr-TR':'en-US')}</span>
      <span>{tr?'Çakışma':'Conflicts'}: {e.conflictRows.toLocaleString()} · {tr?'Reddedilen':'Rejected'}: {e.rejectedRows.toLocaleString()} · {tr?'Uyarı':'Warnings'}: {e.warningRows.toLocaleString()}</span>
      <span>{e.sourceVerified?(tr?'Dosya kaynağı doğrulandı.':'Source file verified.'):(tr?'Dosya kaynağı henüz doğrulanmadı.':'Source file has not been verified.')}</span>
      {e.publicationBlocker?<p role="status">{releaseActionErrorMessage(e.publicationBlocker,tr)}</p>:null}
      <span>{tr?'Şu anki yayın':'Current publication'}: {e.currentPublicationVersion===null?(tr?'Önceki yayın yok':'No previous publication'):`v${e.currentPublicationVersion}`}</span>
      {e.currentPublicationId?<details><summary>{tr?'Teknik ayrıntılar':'Technical details'}</summary><span className="operations-subtle">{e.currentPublicationId}</span></details>:null}
      {remotePending?<p role="status">{e.publishOperation&&['queued','running'].includes(e.publishOperation.status)
        ?(tr?'Fiyat yayını sürüyor. Sonuç otomatik kontrol ediliyor.':'Price publication is in progress. Its result is checked automatically.')
        :(tr?'Kontrol sürüyor. Sonuç otomatik kontrol ediliyor.':'Review is in progress. Its result is checked automatically.')}</p>:null}
      {e.canReview?<div className="list-stack">
        <label>{tr?'İnceleme kararı':'Review decision'}<select value={p.reason} disabled={p.busy||pending||remotePending||Boolean(p.error)} onChange={event=>p.onReason(event.target.value as ReviewReason)}>
          <option value="comparison_repaired">{tr?'Marka ve dosya kontrolünü tamamla':'Complete brand and file checks'}</option>
          <option value="wrong_brand_file">{tr?'Yanlış marka dosyası — reddet':'Wrong brand file — reject'}</option>
          <option value="wrong_source_file">{tr?'Yanlış kaynak dosyası — reddet':'Wrong source file — reject'}</option>
        </select></label>
        <p>{tr?'Bu adım marka ve dosya doğrulamasını çalıştırır. Fiyat yayını için ayrıca onay gerekir.':'This step checks the brand and source file. Publication requires a separate confirmation.'}</p>
        <Button variant="secondary" disabled={p.busy||p.loading||pending||remotePending||Boolean(p.error)} onClick={p.onReview}>
          {p.reason==='comparison_repaired'?(tr?'Kontrolü tamamla':'Complete checks'):(tr?'Dosyayı reddet':'Reject source')}
        </Button>
      </div>:null}
      {ready?<p role="status">{tr?'Güncel sunucu kontrolü yayına hazır olduğunu doğruladı.':'The current server check confirms that this release is ready to publish.'}</p>
        :!e.isCurrent&&!e.publicationBlocker?<p>{tr?'Yayın için temiz ve güncel kontrol sonucu gerekiyor.':'Publication requires clear, current evidence.'}</p>:null}
      {!e.isCurrent?<>
        <p>{tr?`${e.supplier} / ${e.brand} kapsamındaki fiyat listesinin tamamı bu dosyanın ${e.totalRows.toLocaleString('tr-TR')} satırıyla değiştirilecek.`
          :`The complete price list for ${e.supplier} / ${e.brand} will be replaced by the ${e.totalRows.toLocaleString('en-US')} rows in this file.`}</p>
        <label style={{display:'flex',gap:8,alignItems:'flex-start'}}><input type="checkbox" checked={p.confirmed} disabled={!ready||p.busy||p.loading} onChange={event=>p.onConfirm(event.target.checked)}/>
          {tr?'Tedarikçiyi, markayı, satır sayısını ve yukarıdaki önceki sürümü kontrol ettim; kapsamın tamamının değiştirilmesini onaylıyorum.'
            :'I checked the supplier, brand, row count, and previous version above; I confirm replacement of this complete scope.'}</label>
        <Button disabled={!ready||!p.confirmed||p.busy||p.loading} onClick={p.onPublish}>{tr?'Onayla ve yayınla':'Confirm and publish'}</Button>
      </>:<p role="status">{tr?'Bu sürüm şu anda aktif.':'This release is currently active.'}</p>}
    </>:null}
    {(['review','publish'] as const).map(kind=>{
      const r=records[kind];if(!r)return null;
      const label=kind==='review'?(tr?'İnceleme':'Review'):(tr?'Yayın':'Publication');
      const status=r.phase==='unknown'?(tr?'Sonuç bilinmiyor; aynı işlem korunuyor.':'Outcome unknown; the same decision is retained.')
        :r.phase==='pending'?(tr?'İşlem sonucu bekleniyor.':'Waiting for the operation result.')
        :r.phase==='failed'?releaseActionErrorMessage(r.errorCode||'ACTION_FAILED',tr)
        :r.receipt?.status==='published'?(tr?`Yayın tamamlandı: v${r.receipt.version}.`:`Publication completed: v${r.receipt.version}.`)
        :r.receipt?.status==='rechecked_clear'?(tr?'Yeniden kontrol temiz. Yayın ayrı onay bekliyor.':'Recheck cleared. Publication requires a separate confirmation.')
        :r.receipt?.status==='rejected'?(tr?'Dosya reddedildi; yayınlanmadı.':'Source rejected; not published.')
        :(tr?'İnceleme gerekli; yayınlanmadı.':'Review required; not published.');
      return <div key={kind} role="status" className="list-stack"><strong>{label}: {status}</strong>
        <details><summary>{tr?'Teknik ayrıntılar':'Technical details'}</summary><span className="operations-subtle">{tr?'İşlem kimliği':'Decision ID'}: {r.command.decisionId}</span></details>
        {unresolved(r)?<Button variant="secondary" disabled={p.busy||p.loading||!e||Boolean(p.error)} onClick={()=>p.onRetry(kind)}>
          {tr?'Aynı işlemin sonucunu kontrol et':'Check the same decision'}
        </Button>:null}
      </div>;
    })}
  </section>;
}

export function SupplierReleaseActionPanel({releaseId,tr,onChanged}:{releaseId:string;tr:boolean;onChanged?:()=>void}) {
  const [evidence,setEvidence]=useState<ReleaseActionEvidence|null>(null),[records,setRecords]=useState<Records>({review:null,publish:null});
  const [error,setError]=useState<string|null>(null),[loading,setLoading]=useState(false),[busy,setBusy]=useState(false);
  const [confirmed,setConfirmed]=useState(false),[reason,setReason]=useState<ReviewReason>('comparison_repaired');
  const alive=useRef(true),serial=useRef(0),busyRef=useRef(false),evidenceRef=useRef<ReleaseActionEvidence|null>(null),onChangedRef=useRef(onChanged);
  onChangedRef.current=onChanged;
  const storage=()=>window.localStorage as ReceiptStorage;
  const load=useCallback(async()=>{
    const version=++serial.current;setLoading(true);
    try {
      const fresh=await supplierReleaseActionsClient.evidence(releaseId);
      if(!alive.current||version!==serial.current)return null;
      const scope=actionScope(fresh,window.location.origin),next:Records={review:null,publish:null};
      let changed=false;
      for(const kind of ['review','publish'] as const) {
        const saved=readDurableAction(storage(),scope,kind);
        next[kind]=saved?reconcileDurableAction(storage(),saved,fresh):null;
        if(saved&&saved.phase!==next[kind]?.phase&&next[kind]?.phase==='completed')changed=true;
      }
      if(!evidenceRef.current||publicationConfirmationKey(evidenceRef.current)!==publicationConfirmationKey(fresh))setConfirmed(false);
      evidenceRef.current=fresh;setEvidence(fresh);setRecords(next);setError(null);
      if(changed)onChangedRef.current?.();
      return fresh;
    }catch(err) {
      if(alive.current&&version===serial.current){setEvidence(null);evidenceRef.current=null;setConfirmed(false);
        setError(err instanceof Error?err.message:'ACTION_EVIDENCE_UNAVAILABLE');}
      return null;
    }finally{if(alive.current&&version===serial.current)setLoading(false);}
  },[releaseId]);
  useEffect(()=>{alive.current=true;void load();return()=>{alive.current=false;++serial.current;};},[load]);
  const needsPolling=unresolved(records.review)||unresolved(records.publish)
    ||Boolean(evidence&&[evidence.reviewOperation,evidence.publishOperation].some(op=>op&&['queued','running'].includes(op.status)));
  useEffect(()=>{
    if(!needsPolling)return;
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible'&&!busyRef.current)void load();},4000);
    return()=>window.clearInterval(timer);
  },[needsPolling,load]);

  async function send(r:DurableAction,retry:boolean) {
    try {
      const receipt=await supplierReleaseActionsClient.submit(r);
      updateDurableAction(storage(),r,{receipt});
      if(!['queued','running'].includes(receipt.status))onChangedRef.current?.();
    }catch(err) {
      const requestError=err instanceof SupplierReleaseActionError?err:null;
      recordActionFailure(storage(),r,{code:requestError?.code||'ACTION_OUTCOME_UNKNOWN',outcome:requestError?.outcome||'unknown'},retry);
    }
  }
  async function act(kind:ActionKind,retry=false) {
    if(busyRef.current||!evidenceRef.current)return;
    busyRef.current=true;setBusy(true);setError(null);
    try {
      const before=evidenceRef.current;
      const scope=actionScope(before,window.location.origin);
      const saved=readDurableAction(storage(),scope,kind);
      if(retry) {
        if(!saved||!unresolved(saved))throw new Error('ACTION_RECEIPT_STORAGE_INVALID');
        await send(saved,true); // Exact persisted command: never replace CAS fields from refreshed evidence.
      } else {
        if(unresolved(readDurableAction(storage(),scope,kind==='review'?'publish':'review')))throw new Error('ACTION_PENDING');
        const fresh=await load();if(!fresh)return;
        if(fresh.actorId!==scope.actorId||fresh.organizationId!==scope.organizationId)throw new Error('ACTION_ACTOR_CHANGED');
        if(publicationConfirmationKey(before)!==publicationConfirmationKey(fresh))throw new Error('ACTION_EVIDENCE_STALE');
        if(kind==='publish'&&(!confirmed||!releasePublicationReady(fresh)))throw new Error('ACTION_NOT_READY');
        if(kind==='review'&&!fresh.canReview)throw new Error('ACTION_NOT_READY');
        const command=kind==='review'?reviewCommand(fresh,reason,crypto.randomUUID()):publishCommand(fresh,crypto.randomUUID());
        const durable=prepareDurableAction(storage(),scope,kind,command);
        await send(durable,durable.command.decisionId!==command.decisionId);
      }
      setConfirmed(false);
      await load();
    }catch(err){if(alive.current)setError(err instanceof Error?err.message:'ACTION_REQUEST_FAILED');}
    finally{busyRef.current=false;if(alive.current)setBusy(false);}
  }
  return <SupplierReleaseActionView tr={tr} evidence={evidence} records={records} error={error} loading={loading} busy={busy}
    confirmed={confirmed} reason={reason} onConfirm={setConfirmed} onReason={setReason} onRefresh={()=>void load()}
    onReview={()=>void act('review')} onPublish={()=>void act('publish')} onRetry={kind=>void act(kind,true)}/>;
}
