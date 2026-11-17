import { useEffect, useRef, useState } from 'react';
import { submitPortalOrder, type PortalPreparedLine } from '../../../infrastructure/api/portalOrderApi';
import type { PortalCredentials, PortalSnapshot } from '../../../types/portalSession';
import { useInterfaceText } from '../../../i18n/InterfaceText';

type Props={inviteId:string;credentials:PortalCredentials;lines:PortalPreparedLine[];paused:boolean;deliveryTerm:string;paymentTerms:string;packingDetails:string;onBusy:(v:boolean)=>void;onSaved:(result:{orderId:string;order:PortalSnapshot['salesOrders'][number]|null;snapshot:PortalSnapshot|null})=>void};
type Intent={id:string;fingerprint:string};
const storageKey=(inviteId:string)=>`next-master:first-draft:${inviteId}`;
async function fingerprint(value:string) {
  const bytes=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes),x=>x.toString(16).padStart(2,'0')).join('');
}
function makeIntentId() { const bytes=crypto.getRandomValues(new Uint8Array(16));return Array.from(bytes,x=>x.toString(16).padStart(2,'0')).join(''); }
export function PortalFirstDraftAutosave(props:Props) {
  const ui=useInterfaceText();
  const latest=useRef(props); latest.current=props;
  const running=useRef(false);
  const [failure,setFailure]=useState('');
  const expected=props.lines.map(line=>({code:line.requestedCode || line.resolvedCode,brand:line.brand,qty:Number(line.qty),sell_price:line.sell_price == null ? null : Number(line.sell_price)}));
  const signature=JSON.stringify(expected);
  useEffect(()=>{
    if(props.paused || running.current || failure || !expected.length || expected.length > 200) return;
    const timer=window.setTimeout(()=>{
      running.current=true; latest.current.onBusy(true);
      void (async()=>{
        try {
          const hash=await fingerprint(signature), key=storageKey(props.inviteId);
          const raw=sessionStorage.getItem(key);
          const stored:Intent|null=raw ? JSON.parse(raw) : null;
          if(stored && stored.fingerprint!==hash) throw new Error('A previous save has an uncertain result. Reload the order list before creating another draft.');
          const intent=stored || {id:makeIntentId(),fingerprint:hash};
          sessionStorage.setItem(key,JSON.stringify(intent));
          let result:Awaited<ReturnType<typeof submitPortalOrder>> | undefined;
          let lastError:unknown;
          for(let attempt=0;attempt<3;attempt++) {
            try { result=await submitPortalOrder(props.credentials,{mode:'draft',deliveryTerm:props.deliveryTerm,paymentTerms:props.paymentTerms,packingDetails:props.packingDetails,notes:'',rows:expected.map(row=>({code:row.code,brand:row.brand,qty:row.qty})),autoSaveIntent:intent.id,expectedPrices:expected});break; }
            catch(error) { lastError=error;if(attempt<2) await new Promise(resolve=>setTimeout(resolve,1000)); }
          }
          if(!result) throw lastError;
          const latestSignature=JSON.stringify(latest.current.lines.map(line=>({code:line.requestedCode || line.resolvedCode,brand:line.brand,qty:Number(line.qty),sell_price:line.sell_price == null ? null : Number(line.sell_price)})));
          if(latestSignature!==signature) throw new Error('The draft was saved, but the list changed while saving. Reopen the saved draft and review the remaining edits.');
          latest.current.onSaved(result);
          sessionStorage.removeItem(key);
        } catch(error) {setFailure(error instanceof Error ? error.message : 'Automatic draft save failed.');}
        finally {running.current=false;latest.current.onBusy(false);}
      })();
    },3000);
    return ()=>window.clearTimeout(timer);
  },[signature,props.paused,props.inviteId,failure]);
  useEffect(()=>{const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';};if(expected.length) window.addEventListener('beforeunload',handler);return ()=>window.removeEventListener('beforeunload',handler);},[signature]);
  if (expected.length > 200) return <div role="alert">{ui('This list has more than 200 items. It can be exported, but a draft can contain at most 200 items; split the list before saving.')}</div>;
  return failure ? <div role="alert">{ui(failure)} {ui('The list has not been confirmed as saved.')}</div> : <div role="status">{ui('Saving new draft automatically…')}</div>;
}
