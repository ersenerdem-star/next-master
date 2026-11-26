import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { act, createElement, useState } from 'react';
import { create } from 'react-test-renderer';
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const output = resolve('scripts/tests/.payment-version-ui-fixture.mjs');
after(async () => { await rm(output, { force: true }); });
await build({
  stdin: {contents: `export {usePaymentDraftEditor} from './apps/web/src/presentation/hooks/usePaymentDraftEditor.ts'; export {upsertPaymentReceived,upsertPaymentMade} from './apps/web/src/infrastructure/api/ordersApi.ts'; export {documentNumberError} from './apps/web/src/shared/documentNumberError.ts';`, resolveDir:process.cwd(), loader:'ts'},
  outfile:output, bundle:true, platform:'node', format:'esm', packages:'external',
  plugins:[{name:'mock-rpc',setup(builder) {
    builder.onResolve({filter:/\/appRpcApi$/},()=>({path:'rpc',namespace:'mock'}));
    builder.onResolve({filter:/\/supabaseClient$/},()=>({path:'supabase',namespace:'mock'}));
    builder.onResolve({filter:/\/organizationApi$/},()=>({path:'organization',namespace:'mock'}));
    builder.onResolve({filter:/\/warehousesApi$/},()=>({path:'warehouses',namespace:'mock'}));
    builder.onLoad({filter:/.*/,namespace:'mock'},({path})=>({loader:'js',contents:
      path==='rpc' ? `export const callAppRpc=(...args)=>globalThis.__paymentUiRpc(...args);` :
      path==='supabase' ? `export const supabaseClient={};` :
      path==='organization' ? `export const getCurrentOrgId=()=>null;` : `export const fetchWarehouses=()=>[];`
    }));
  }}],
});
const {usePaymentDraftEditor, upsertPaymentReceived, upsertPaymentMade, documentNumberError}=await import(pathToFileURL(output).href);
const version='2026-11-26T10:12:34.123456+00:00';
for (const kind of ['received','made']) {
  test(`${kind} editor sends its original version and keeps unsaved input on conflict`, async () => {
    const row:any={id:'PAY-1', amount:100, currency:'EUR', updated_at:version, created_at:'2026-01-01T00:00:00Z', invoice_id:'I',bill_id:'B'};
    let rpcCall:any;
    (globalThis as any).__paymentUiRpc = async (...args:any[]) => { rpcCall=args; throw new Error('PAYMENT_VERSION_CONFLICT'); };
    function Editor() {
      const editor=usePaymentDraftEditor([row]);
      const [message,setMessage]=useState('');
      return createElement('section',{},
        createElement('input',{value:String(editor.draft?.amount||0),onChange:(event:any)=>editor.setDraft((d:any)=>({...d,amount:Number(event.target.value)}))}),
        createElement('button',{onClick:async()=>{try { await (kind==='received'?upsertPaymentReceived:upsertPaymentMade)(editor.draft,editor.persistedId); } catch(e) {setMessage(documentNumberError(e,'tr','hata'));} }},'save'),
        createElement('p',{},message),
      );
    }
    let renderer:any;
    await act(async()=>{renderer=create(createElement(Editor));});
    await act(async()=>{renderer.root.findByType('input').props.onChange({target:{value:'321'}});});
    await act(async()=>{await renderer.root.findByType('button').props.onClick();});
    assert.equal(rpcCall[0],kind==='received'?'save_payment_received_atomic':'save_payment_made_atomic');
    assert.equal(rpcCall[1].payload.expected_updated_at,version);
    assert.equal(rpcCall[1].previous_id,'PAY-1');
    assert.equal(rpcCall[1].payload.amount,321);
    assert.equal(renderer.root.findByType('input').props.value,'321');
    assert.match(renderer.root.findByType('p').children.join(''),/henüz kaydedilmedi/);
    await act(async()=>renderer.unmount());
  });
}
