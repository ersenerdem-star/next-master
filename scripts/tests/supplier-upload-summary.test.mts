import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {SupplierReleaseSummaryTable,uploadSummaryStatus} from '../../apps/web/src/modules/admin/SupplierReleaseSummaryTable.tsx';
import {splitReleaseReviewHistory,type ReleaseReviewRow} from '../../apps/web/src/shared/supplierReleaseReview.ts';
const row:ReleaseReviewRow={id:'release-new',supplierId:'supplier',brandId:'brand',supplier:'Romany',brand:'Bosch',status:'published',current:true,createdAt:'2026-10-15T07:09:28Z',updatedAt:'2026-10-15T07:42:41Z',totalRows:45170,processedRows:45170,acceptedRows:45170,rejectedRows:0,warningRows:0,conflictRows:0,errorCode:null,errorMessage:null,audit:{checked:true,reviewRequired:false,totalCodes:45170,brands:[]}};
test('compact table shows current scope rows with accessible detail control; verbose review stays outside the summary',()=>{
 const latest=splitReleaseReviewHistory([row,{...row,id:'old',createdAt:'2026-09-17T00:00:00Z',status:'failed',current:false}]).latest;
 const html=renderToStaticMarkup(React.createElement(SupplierReleaseSummaryTable,{rows:latest,tr:false,onOpen:()=>{}}));
 assert.match(html,/<table/);assert.match(html,/Romany/);assert.match(html,/Bosch/);assert.match(html,/45,170/);assert.match(html,/Published/);assert.match(html,/Upload details: Romany \/ Bosch/);
 assert.doesNotMatch(html,/2026-09-17|Accepted:|Publication details|Review and publish/);
});
test('only a current published release is shown as published; pending or interrupted checks stay explicit',()=>{
 assert.equal(uploadSummaryStatus(row,false).label,'Published');
 assert.equal(uploadSummaryStatus({...row,current:false},false).label,'Previous release');
 assert.equal(uploadSummaryStatus({...row,status:'validated'},false).label,'Awaiting publication');
 assert.equal(uploadSummaryStatus({...row,errorCode:'WORKER_ERROR'},false).label,'Needs review');
 assert.equal(uploadSummaryStatus(row,true).label,'Yayında');
});
