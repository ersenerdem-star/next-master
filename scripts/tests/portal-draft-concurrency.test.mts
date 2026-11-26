import test from 'node:test';
import assert from 'node:assert/strict';
import { deletePortalSalesOrder } from '../../netlify/functions/_shared/portal-orders.mts';

test('portal delete is conditional on the version, invitation and draft state', async () => {
  const previous=globalThis.fetch;const requests:Array<{url:URL;method:string}> = [];
  globalThis.fetch=async (input,init) => {
    const url=new URL(String(input));const method=init?.method || 'GET';requests.push({url,method});
    const data=method==='GET'?[{id:'old',status:'draft',updated_at:'2026-11-26T10:00:00+00:00',portal_submitted_at:null,portal_invite_id:'invite'}]:[];
    return new Response(JSON.stringify(data),{status:200,headers:{'content-type':'application/json'}});
  };
  try {
    await assert.rejects(deletePortalSalesOrder('https://example.test','test-key',{id:'invite',organization_id:'org'} as never,'old','2026-11-26T10:00:00+00:00'),/changed since you opened/);
    assert.equal(requests.length,2);assert.equal(requests[1].method,'DELETE');
    assert.equal(requests[1].url.searchParams.get('portal_invite_id'),'eq.invite');
    assert.equal(requests[1].url.searchParams.get('organization_id'),'eq.org');
    assert.equal(requests[1].url.searchParams.get('status'),'eq.draft');
    assert.equal(requests[1].url.searchParams.get('portal_submitted_at'),'is.null');
    assert.equal(requests[1].url.searchParams.get('updated_at'),'eq.2026-11-26T10:00:00+00:00');
  } finally {globalThis.fetch=previous;}
});

test('portal delete with no version performs no network write',async()=>{
 let calls=0;const previous=globalThis.fetch;globalThis.fetch=async()=>{calls++;return new Response('[]');};
 try {await assert.rejects(deletePortalSalesOrder('https://example.test','test-key',{id:'invite',organization_id:'org'} as never,'old',''),/changed since you opened/);assert.equal(calls,0);}
 finally {globalThis.fetch=previous;}
});
