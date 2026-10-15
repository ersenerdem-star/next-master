import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {parseUploadStatus,supplierUploadStatusView,SUPPLIER_PROCESSING_INTERRUPTED,type UploadStatus} from '../../apps/web/src/shared/supplierUploadProtocol.ts';
import {releaseReviewState,splitReleaseReviewHistory,type ReleaseReviewRow} from '../../apps/web/src/shared/supplierReleaseReview.ts';
import {SupplierReleaseReviewCard,releaseReviewMessage} from '../../apps/web/src/modules/admin/SupplierReleaseReviewCard.tsx';

const sessionId='10000000-0000-0000-0000-000000000001',releaseId='20000000-0000-0000-0000-000000000002';
const status:UploadStatus={sessionId,releaseId,uploadStatus:'uploaded',verificationStatus:'verified',transferReady:true,
 totalBytes:1000,totalRows:1000000,processedRows:25000,releaseStatus:'parsing',errorCode:SUPPLIER_PROCESSING_INTERRUPTED,
 releaseUpdatedAt:'2026-10-14T14:00:00Z',updatedAt:'2026-10-14T13:00:00Z',expiresAt:'2099-01-01T00:00:00Z',published:false};
const row:ReleaseReviewRow={id:releaseId,brandId:sessionId,supplierId:sessionId,brand:'Clevite',supplier:'Test',status:'parsing',
 createdAt:status.updatedAt,updatedAt:status.releaseUpdatedAt,totalRows:1000000,processedRows:25000,acceptedRows:25000,rejectedRows:0,
 warningRows:0,conflictRows:0,errorCode:SUPPLIER_PROCESSING_INTERRUPTED,errorMessage:'Processing stopped.',audit:null,current:false};

test('processing interruption remains distinct from source verification and domain review',()=>{
 const parsed=parseUploadStatus(status,sessionId,1000),view=supplierUploadStatusView(parsed,true);
 assert.equal(parsed.releaseStatus,'parsing');assert.equal(parsed.verificationStatus,'verified');assert.equal(parsed.processedRows,25000);
 assert.equal(view.phase,'attention');assert.match(view.message,/işlenmesi durdu/);assert.match(view.message,/25\.000 \/ 1\.000\.000/);
 assert.match(view.message,/Aynı yüklemenin/);assert.doesNotMatch(view.message,/yeniden yükle|marka.*kontrol/i);
 assert.equal(releaseReviewState(row),'processing_interrupted');
 assert.equal(releaseReviewState({...row,errorCode:'VALIDATION_REVIEW_REQUIRED'}),'review_required');
 assert.equal(releaseReviewState({...row,audit:{checked:true,reviewRequired:true,totalCodes:3,brands:[]}}),'review_required');
 assert.equal(releaseReviewState({...row,status:'cancelled',errorCode:'REVIEW_REJECTED'}),'rejected');
});

test('real committed recovery removes only the operational display and preserves counts/publication distinction',()=>{
 const recovered={...status,errorCode:null,processedRows:26000,releaseUpdatedAt:'2026-10-14T14:01:00Z'};
 const view=supplierUploadStatusView(parseUploadStatus(recovered,sessionId),false);
 assert.equal(view.phase,'verified');assert.match(view.message,/26,000 \/ 1,000,000/);assert.match(view.message,/publication is a separate step/);
 assert.doesNotMatch(view.message,/processing stopped/i);
 assert.equal(releaseReviewState({...row,status:'validated',errorCode:null,audit:{checked:true,reviewRequired:false,totalCodes:3,brands:[]}}),'awaiting_publication');
});

test('status parser rejects missing/invalid freshness and non-code provider text',()=>{
 for(const patch of [{errorCode:undefined},{errorCode:'provider secret https://private.invalid'},{releaseUpdatedAt:undefined},{releaseUpdatedAt:'invalid'}])
  assert.throws(()=>parseUploadStatus({...status,...patch},sessionId),/could not be verified/);
});

test('rendered review card explains operational interruption without the brand-review warning',()=>{
 const html=renderToStaticMarkup(React.createElement(SupplierReleaseReviewCard,{rows:[row],tr:true,onDetails:()=>{}}));
 assert.match(html,/İşlem durdu/);assert.match(html,/Yükleme ve işlenen satırlar korunuyor/);
 assert.match(html,/25,000 \/ 1,000,000/);assert.match(html,/Son durum/);
 assert.doesNotMatch(html,/Marka karşılaştırması henüz doğrulanmadı|Uyarıyı aç|yeni yükleme başlatın/);
 assert.match(releaseReviewMessage(row,false),/operational review/);
});

test('published history remains a previous publication when a later version owns the current pointer',()=>{
 const previous={...row,status:'published',current:false,errorCode:null,errorMessage:null,processedRows:999998,totalRows:999998,audit:{checked:true,reviewRequired:false,totalCodes:999998,brands:[]}};
 assert.equal(releaseReviewState(previous),'previous_publication');
 assert.equal(releaseReviewState({...previous,audit:null}),'previous_publication');
 assert.equal(releaseReviewState({...previous,current:true}),'active');
 assert.equal(releaseReviewState({...previous,status:'validated'}),'awaiting_publication');
 for(const tr of [true,false]){
  const html=renderToStaticMarkup(React.createElement(SupplierReleaseReviewCard,{rows:[previous],tr,onDetails:()=>{}}));
  assert.match(html,tr?/Önceki yayın — güncel değil/:/Previous publication — not current/);
  assert.doesNotMatch(html,/İşleniyor|>Processing<|Güncel aktif sürüm|Current active release/);
 }
 // An actual stored error still takes priority over a historical success label.
 assert.equal(releaseReviewState({...previous,errorCode:'VALIDATION_REVIEW_REQUIRED'}),'review_required');
});


test('new uploads automatically move all earlier same-scope results out of current indicators',()=>{
 const previous={...row,id:'previous',status:'published',current:true,errorCode:null};
 const latest={...row,id:'latest',status:'failed',errorCode:'WORKER_FAILED',createdAt:'2026-10-15T10:00:00Z'};
 const otherScope={...previous,id:'other-supplier',supplierId:'another-supplier'};
 const before=splitReleaseReviewHistory([previous,otherScope]);
 assert.deepEqual(before.latest.map(r=>r.id),['previous','other-supplier']);
 const after=splitReleaseReviewHistory([latest,previous,otherScope]);
 assert.deepEqual(after.latest.map(r=>r.id),['latest','other-supplier']);
 assert.deepEqual(after.history.map(r=>r.id),['previous']);
 assert.equal(after.latest[0].status,'failed');
 assert.equal(after.latest[0].processedRows,25000);
 assert.equal(after.history[0].current,true);
 const next=splitReleaseReviewHistory([{...latest,id:'next',status:'parsing'},latest,previous,otherScope]);
 assert.deepEqual(next.latest.map(r=>r.id),['next','other-supplier']);
 assert.deepEqual(next.history.map(r=>r.id),['latest','previous']);
});
