import {InterfaceText,useInterfaceText} from "../../i18n/InterfaceText";
import {fetchCloudSuppliers} from '../../infrastructure/api/suppliersApi';
import {SupplierPriceStatistics} from './SupplierPriceStatistics';
import {useEffect,useId,useRef,useState} from 'react';
import {createPortal} from 'react-dom';
import {SupplierReleaseSummaryTable} from './SupplierReleaseSummaryTable';
import {NavGlyph} from '../../presentation/components/common/NextMasterBrand';
import {fetchSupplierReleaseReviewPage,type ReleaseReviewCursor} from '../../infrastructure/api/supplierReleaseReviewApi';
import {splitReleaseReviewHistory, type ReleaseReviewRow} from '../../shared/supplierReleaseReview';
import {SectionCard} from '../../presentation/components/common/SectionCard';
import {Button} from '../../presentation/components/common/Button';
import {useActionFeedback} from '../../presentation/components/common/ActionFeedback';
import {SupplierReleaseIssuePanel} from './SupplierReleaseIssuePanel';
import {SupplierReleaseReviewCard} from './SupplierReleaseReviewCard';
import {supplierReleaseActionsEnabled} from '../../infrastructure/api/supplierReleaseActionsApi';

export function SupplierReleaseReviewPanel({locale,showArchive:controlledArchive,dashboard=false,onOpenWorkspace,filterable=false}:{locale:string;filterable?:boolean;showArchive?:boolean;dashboard?:boolean;onOpenWorkspace?:()=>void}){
  const ui=useInterfaceText();
  const [brandSearch,setBrandSearch]=useState('');
  const [filters,setFilters]=useState({brandSearch:'',supplierId:'',fromDate:'',toDate:''});
  const [suppliers,setSuppliers]=useState<{id:string;name:string}[]>([]);
  const [filterError,setFilterError]=useState(false);
  useEffect(()=>{
    if(!filterable)return;
    let cancelled=false;
    void fetchCloudSuppliers().then(value=>{if(!cancelled){setSuppliers(value.map(row=>({id:row.supplier_id,name:row.name})));setFilterError(false);}}).catch(()=>{if(!cancelled)setFilterError(true);});
    return ()=>{cancelled=true;};
  },[filterable]);
  useEffect(()=>{
    if(!filterable || brandSearch===filters.brandSearch)return;
    const timer=window.setTimeout(()=>{setFilters(value=>({...value,brandSearch}));setCursor(null);setRows([]);setLoaded(false);},300);
    return ()=>window.clearTimeout(timer);
  },[brandSearch,filters.brandSearch,filterable]);
  function changeFilter(key:'supplierId'|'fromDate'|'toDate',value:string){
    setFilters(previous=>({...previous,[key]:value}));setCursor(null);setRows([]);setLoaded(false);
  }

  const [archive,setShowArchive]=useState(false);
  const showArchive=controlledArchive ?? archive;
  const [issueRelease,setIssueRelease]=useState<ReleaseReviewRow|null>(null);
  const tr=locale==='tr',feedback=useActionFeedback(),titleId=useId();
  const actionsEnabled=supplierReleaseActionsEnabled();
  const [rows,setRows]=useState<ReleaseReviewRow[]>([]),[next,setNext]=useState<ReleaseReviewCursor|null>(null);
  const [cursor,setCursor]=useState<ReleaseReviewCursor|null>(null),[refresh,setRefresh]=useState(0);
  const [loading,setLoading]=useState(false),[error,setError]=useState(false),[loaded,setLoaded]=useState(false);
  const serial=useRef(0),dialog=useRef<HTMLDialogElement>(null);
  const [selectedId,setSelectedId]=useState<string|null>(null);
  const selected=rows.find(row=>row.id===selectedId);
  useEffect(()=>{
    const el=dialog.current;
    if(!selected || !el)return;
    const previousOverflow=document.body.style.overflow;
    document.body.style.overflow='hidden';
    el.showModal();
    return ()=>{el.close();document.body.style.overflow=previousOverflow;};
  },[selected?.id]);
  useEffect(()=>{
    const controller=new AbortController(), version=++serial.current;
    setLoading(true);
    const timer=window.setTimeout(()=>controller.abort(),12000);
    void fetchSupplierReleaseReviewPage(cursor,controller.signal,filterable?filters:{}).then(page=>{
      if(version!==serial.current || controller.signal.aborted)return;
      setRows(page.rows);setNext(page.next);setLoaded(true);setError(false);
    }).catch(()=>{if(version===serial.current)setError(true);}).finally(()=>{
      window.clearTimeout(timer);if(version===serial.current)setLoading(false);
    });
    return ()=>{++serial.current;window.clearTimeout(timer);controller.abort();};
  },[cursor,refresh,filterable,filters]);
  useEffect(()=>{
    const interval=window.setInterval(()=>{if(document.visibilityState==='visible')setRefresh(v=>v+1);},45000);
    return ()=>window.clearInterval(interval);
  },[]);
  const grouped=splitReleaseReviewHistory(rows);
  const displayedRows=showArchive ? (cursor ? rows : grouped.history) : grouped.latest;
  return <><SectionCard className={`supplier-upload-summary${dashboard?' supplier-upload-summary--dashboard dashboard-upload-center':''}`} title={dashboard ? <span className="supplier-upload-summary__title"><span className="dashboard-reference-card__icon"><NavGlyph name="upload"/></span><InterfaceText text={"Supplier Price Upload Center"}/></span> : showArchive ? (tr?'Yükleme arşivi':'Upload archive') : (tr?'Güncel tedarikçi yüklemeleri':'Current supplier uploads')} actions={<>
    {onOpenWorkspace?<Button onClick={onOpenWorkspace}>{tr?'Fiyat dosyası yükle':'Upload price file'}</Button>:null}
    <Button variant="secondary" disabled={loading} onClick={()=>setRefresh(v=>v+1)}>{tr?'Yenile':ui("Refresh")}</Button></>}>
    {filterable?<div className="supplier-upload-filters">
      <label>{tr?'Marka ara':'Search brand'}<input type="search" value={brandSearch} placeholder={tr?'Örn. Mercedes, Sachs':'e.g. Mercedes, Sachs'} onChange={event=>setBrandSearch(event.target.value)}/></label>
      <label>{tr?'Tedarikçi':'Supplier'}<select value={filters.supplierId} onChange={event=>changeFilter('supplierId',event.target.value)}><option value="">{tr?'Tüm tedarikçiler':'All suppliers'}</option>{suppliers.map(supplier=><option key={supplier.id} value={supplier.id}>{supplier.name}</option>)}</select></label>
      <label>{tr?'Başlangıç tarihi':'From date'}<input type="date" value={filters.fromDate} max={filters.toDate||undefined} onChange={event=>changeFilter('fromDate',event.target.value)}/></label>
      <label>{tr?'Bitiş tarihi':'To date'}<input type="date" value={filters.toDate} min={filters.fromDate||undefined} onChange={event=>changeFilter('toDate',event.target.value)}/></label>
      <Button variant="secondary" onClick={()=>{setBrandSearch('');setFilters({brandSearch:'',supplierId:'',fromDate:'',toDate:''});setCursor(null);setRows([]);setLoaded(false);}}>{tr?'Filtreleri temizle':'Clear filters'}</Button>
      {filterError?<p role="alert">{tr?'Tedarikçi seçenekleri alınamadı. Marka ve tarih filtrelerini kullanabilirsiniz.':'Supplier options are unavailable. Brand and date filters remain available.'}</p>:null}
    </div>:null}
    {dashboard?<SupplierPriceStatistics tr={tr} refresh={refresh}/>:null}
    {controlledArchive === undefined ? <Button variant="secondary" aria-pressed={showArchive} onClick={()=>{setShowArchive(v=>!v);setIssueRelease(null);setSelectedId(null);if(cursor){setRows([]);setLoaded(false);setCursor(null);}}}>
      {showArchive?(tr?'Güncel yüklemelere dön':'Back to current uploads'):(tr?'Yükleme arşivini aç':'Open upload archive')}
    </Button> : null}
    <p className="supplier-upload-summary__intro">{showArchive
      ? (tr?'Önceki yüklemeler burada saklanır. Güncel göstergeler için güncel yüklemelere dönün.':'Previous uploads are kept here. Return to current uploads for current indicators.')
      : (tr?'Güncel yüklemeler. Ayrıntıları görmek için bir satıra tıklayın.':'Latest uploads. Select a row to view details.')}</p>
    {error ? <div role="alert" className="error-text">{tr?'Yükleme kontrol durumu alınamadı. Gösterilen eski veriler güncel olmayabilir; kontrol tamamlandı kabul etmeyin.':'Upgrade review status is unavailable. Previously displayed data may be stale; do not treat the check as completed.'}</div> : null}
    {loading ? <p role="status">{tr?'Kontroller yükleniyor…':'Loading checks…'}</p> : null}
    {loaded && !loading && !error && !displayedRows.length ? <p>{showArchive ? (tr?'Bu sayfada arşivlenmiş yükleme yok.':'No archived uploads on this page.') : (tr?'Seçime uygun güncel yükleme yok.':'No current uploads match the selection.')}</p> : null}
    {displayedRows.length?<SupplierReleaseSummaryTable rows={displayedRows} tr={tr} onOpen={setSelectedId}/>:null}
    {dashboard&&onOpenWorkspace?<button type="button" className="supplier-upload-summary__workspace" onClick={onOpenWorkspace}><NavGlyph name="upload"/>{tr?'Yükleme alanını aç':'Open upload workspace'}</button>:null}
    {showArchive ? <div className="toolbar toolbar--wrap">
      {cursor ? <Button variant="secondary" disabled={loading} onClick={()=>setCursor(null)}>{tr?'Arşiv başlangıcı':'Archive start'}</Button> : null}
      {next ? <Button variant="secondary" disabled={loading||error} onClick={()=>setCursor(next)}>{tr?'Daha eski kayıtlar':'Older releases'}</Button> : null}
    </div> : null}
  </SectionCard>
  {createPortal(<dialog ref={dialog} className="supplier-upload-details" aria-labelledby={titleId} onCancel={()=>setSelectedId(null)} onClick={event=>{if(event.target===event.currentTarget)setSelectedId(null);}}>
    <div className="supplier-upload-details__surface">
      <header><div><span>{tr?'Tedarikçi fiyat yüklemesi':'Supplier price upload'}</span><h2 id={titleId}>{selected?`${selected.supplier} / ${selected.brand}`:''}</h2></div>
        <Button variant="secondary" onClick={()=>setSelectedId(null)}>{tr?'Kapat':'Close'}</Button></header>
      {selected?<SupplierReleaseReviewCard onIssues={setIssueRelease} key={selected.id} rows={[selected]} tr={tr} onDetails={feedback.fail} actionsEnabled={actionsEnabled} initialExpanded onChanged={()=>setRefresh(v=>v+1)}/>:null}
      {issueRelease&&selected?.id===issueRelease.id?<SupplierReleaseIssuePanel key={issueRelease.id} release={issueRelease} tr={tr} onClose={()=>setIssueRelease(null)}/>:null}
    </div>
  </dialog>,document.body)}
  </>;
}
