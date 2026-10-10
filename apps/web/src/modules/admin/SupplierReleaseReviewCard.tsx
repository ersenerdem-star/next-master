import React from 'react';
import {releaseReviewState, type ReleaseReviewRow} from '../../shared/supplierReleaseReview';
import {Button} from '../../presentation/components/common/Button';

export function releaseReviewMessage(row:ReleaseReviewRow, tr:boolean) {
  const evidence=row.audit?.brands.map(b=>`${b.name}: ${b.matches.toLocaleString(tr?'tr-TR':'en-US')} (${b.percent}%)`).join('; ');
  const counts=typeof row.acceptedRows==='number'
    ? (tr ? `Kabul: ${row.acceptedRows.toLocaleString('tr-TR')}, çakışma: ${(row.conflictRows||0).toLocaleString('tr-TR')}, reddedilen: ${(row.rejectedRows||0).toLocaleString('tr-TR')}`
      : `Accepted: ${row.acceptedRows.toLocaleString('en-US')}, conflicts: ${(row.conflictRows||0).toLocaleString('en-US')}, rejected: ${(row.rejectedRows||0).toLocaleString('en-US')}`)
    : '';
  return tr ? `${row.brand} / ${row.supplier}: ${row.errorCode || 'Marka kimliği incelemesi'}. ${row.errorMessage || ''} ${counts} ${evidence || 'Karşılaştırma henüz doğrulanamadı.'} Yayınlama tamamlandı olarak kabul etmeyin; marka ve dosyayı kontrol edin.`
    : `${row.brand} / ${row.supplier}: ${row.errorCode || 'Brand identity review'}. ${row.errorMessage || ''} ${counts} ${evidence || 'Comparison has not been verified.'} Do not treat this as published; check the brand and source file.`;
}
export function SupplierReleaseReviewCard({rows,tr,onDetails}:{rows:ReleaseReviewRow[];tr:boolean;onDetails:(message:string)=>void}) {
  const labels=tr ? {rejected:'Dosya reddedildi — yayınlanmadı',review_required:'İnceleme gerekli — yayın durduruldu',inactive:'Aktif değil',active:'Güncel aktif sürüm',unverified:'Kontrol doğrulanmadı',awaiting_publication:'Doğrulandı — henüz yayınlanmadı',processing:'İşleniyor'}
    : {rejected:'Source rejected — not published',review_required:'Review required — publication held',inactive:'Not active',active:'Current active release',unverified:'Check not verified',awaiting_publication:'Validated — not yet published',processing:'Processing'};
  return <div className="list-stack">{rows.map(row=>{
    const state=releaseReviewState(row);
    return <article key={row.id} className="list-stack" style={{border:'1px solid var(--border-color, #d8e1ee)',borderRadius:12,padding:16}}>
      <strong>{row.brand} · {row.supplier}</strong>
      <span className={`mark-badge mark-badge--${state==='review_required'||state==='rejected'?'failed':state==='active'?'completed':'pending'}`}>{labels[state]}</span>
      <span>{row.processedRows.toLocaleString()} / {row.totalRows.toLocaleString()} · {row.status} · {row.createdAt}</span>
      <span className="operations-subtle">{row.id}</span>
      {typeof row.acceptedRows==='number' ? <div className="operations-subtle">
        {tr ? `Kabul: ${row.acceptedRows.toLocaleString('tr-TR')} · Çakışma: ${(row.conflictRows||0).toLocaleString('tr-TR')} · Reddedilen: ${(row.rejectedRows||0).toLocaleString('tr-TR')} · Uyarı: ${(row.warningRows||0).toLocaleString('tr-TR')}`
          : `Accepted: ${row.acceptedRows.toLocaleString('en-US')} · Conflicts: ${(row.conflictRows||0).toLocaleString('en-US')} · Rejected: ${(row.rejectedRows||0).toLocaleString('en-US')} · Warnings: ${(row.warningRows||0).toLocaleString('en-US')}`}
      </div> : null}
      {!row.audit?.checked ? <span>{tr?'Marka karşılaştırması henüz doğrulanmadı.':'Brand comparison has not yet been verified.'}</span> : null}
      {row.errorCode ? <strong className="error-text">{row.errorCode}</strong> : null}
      {row.errorMessage ? <span className="operations-subtle">{row.errorMessage}</span> : null}
      {state==='rejected' ? <p>{tr?'Doğru marka ve düzeltilmiş dosyayla yeni yükleme başlatın. Mevcut fiyatlar bu kararla değiştirilmedi.':'Start a new upload with the correct brand and corrected file. This decision did not change existing prices.'}</p> : null}
      {row.audit?.brands.length ? <div className="table-wrap"><table className="data-table"><thead><tr>
        <th>{tr?'Örtüşen marka':'Matching brand'}</th><th>{tr?'Farklı kod':'Distinct codes'}</th><th>%</th><th>{tr?'Örnek kodlar':'Sample codes'}</th>
      </tr></thead><tbody>{row.audit.brands.map(b=><tr key={b.id}><td>{b.name}</td><td>{b.matches.toLocaleString()}</td><td>{b.percent}%</td><td>{b.samples.join(', ')}</td></tr>)}</tbody></table></div> : null}
      {state==='review_required' || state==='unverified' ? <Button variant="secondary" onClick={()=>onDetails(releaseReviewMessage(row,tr))}>{tr?'Uyarıyı aç':'Show warning'}</Button> : null}
    </article>;
  })}</div>;
}
