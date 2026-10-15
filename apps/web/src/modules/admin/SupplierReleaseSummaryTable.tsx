import {useInterfaceText} from "../../i18n/InterfaceText";
import {releaseReviewState, type ReleaseReviewRow} from '../../shared/supplierReleaseReview';
import {BrandPill} from '../../presentation/components/common/BrandPill';

export function uploadSummaryStatus(row:ReleaseReviewRow,tr:boolean) {
  const state=releaseReviewState(row);
  const labels:Record<string,string>=tr
    ? {active:'Yayında',previous_publication:'Önceki yayın',processing:'İşleniyor',awaiting_publication:'Yayın bekliyor',review_required:'İnceleme gerekli',processing_interrupted:'İşlem durdu',unverified:'Kontrol bekliyor',inactive:'Pasif',rejected:'Reddedildi'}
    : {active:'Published',previous_publication:'Previous release',processing:'Processing',awaiting_publication:'Awaiting publication',review_required:'Needs review',processing_interrupted:'Interrupted',unverified:'Pending checks',inactive:'Inactive',rejected:'Rejected'};
  const tone=state==='active'?'success':['review_required','processing_interrupted','rejected'].includes(state)?'warning':'neutral';
  return {label:labels[state]||state,tone};
}

export function SupplierReleaseSummaryTable({rows,tr,onOpen}:{rows:ReleaseReviewRow[];tr:boolean;onOpen:(id:string)=>void}) {
  const ui=useInterfaceText();
 const locale=tr?'tr-TR':'en-GB';
 return <div className="supplier-upload-summary__table-wrap"><table className="supplier-upload-summary__table">
   <thead><tr><th>{tr?'Tedarikçi':ui("Supplier")}</th><th>{tr?'Marka':ui("Brand")}</th><th>{tr?'Yükleme':'Uploaded'}</th><th className="supplier-upload-summary__number">{tr?'Satır':'Rows'}</th><th>{tr?'Durum':ui("Status")}</th><th aria-label={tr?'Ayrıntı':'Details'}></th></tr></thead>
   <tbody>{rows.map(row=>{
     const status=uploadSummaryStatus(row,tr),date=new Date(row.createdAt);
     return <tr key={row.id} onClick={()=>onOpen(row.id)}>
       <td><button type="button" className="supplier-upload-summary__open" aria-label={`${tr?'Yükleme ayrıntıları':'Upload details'}: ${row.supplier} / ${row.brand}`} onClick={event=>{event.stopPropagation();onOpen(row.id);}}>{row.supplier}</button></td>
       <td><BrandPill brand={row.brand}/></td>
       <td><time dateTime={row.createdAt}>{date.toLocaleDateString(locale,{day:'2-digit',month:'short',year:'numeric'})}<small>{date.toLocaleTimeString(locale,{hour:'2-digit',minute:'2-digit'})}</small></time></td>
       <td className="supplier-upload-summary__number">{row.totalRows.toLocaleString(tr?'tr-TR':'en-US')}</td>
       <td><span className={`supplier-upload-summary__status supplier-upload-summary__status--${status.tone}`}>{status.label}</span></td>
       <td className="supplier-upload-summary__detail">{tr?'Ayrıntı':'Details'}</td>
     </tr>;
   })}</tbody>
 </table></div>;
}
