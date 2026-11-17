import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PortalFirstDraftAutosave } from '../../apps/web/src/modules/portal/components/PortalFirstDraftAutosave.tsx';
Object.assign(globalThis,{React});

test('large imported lists show the save limit and remain available to export',()=>{
  const line={requestedCode:'P1',resolvedCode:'P1',brand:'Bosch',qty:1,sell_price:1} as any;
  const props={inviteId:'test',credentials:{email:'test@example.test'},lines:Array.from({length:201},(_,i)=>({...line,requestedCode:`P${i}`})),paused:false,deliveryTerm:'',paymentTerms:'',packingDetails:'',onBusy:()=>{},onSaved:()=>{}};
  const html=renderToStaticMarkup(React.createElement(PortalFirstDraftAutosave,props));
  assert.match(html,/more than 200 items/);assert.match(html,/can be exported/);assert.doesNotMatch(html,/Saving new draft automatically/);
});
