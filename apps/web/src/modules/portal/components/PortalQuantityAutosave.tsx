import { useEffect, useRef, useState } from 'react';
import { savePortalOrderQuantities } from '../../../infrastructure/api/portalOrderApi';
import type { PortalCredentials, PortalSnapshot } from '../../../types/portalSession';
import { useInterfaceText } from '../../../i18n/InterfaceText';

type Order = PortalSnapshot['salesOrders'][number];
export type QuantityEdit = {index:number;code:string;previousQty:number;qty:number};
type Props = { order:Order; edits:Record<string,number>; credentials:PortalCredentials; paused:boolean; onBusy:(value:boolean)=>void; onSaved:(order:Order, edits:QuantityEdit[], result:{updatedAt:string;salesTotal:number})=>void };

export function PortalQuantityAutosave(props:Props) {
  const ui=useInterfaceText();
  const latest=useRef(props); latest.current=props;
  const active=useRef(false);
  const [failure,setFailure]=useState('');
  const editSignature=JSON.stringify(props.edits);
  useEffect(() => { setFailure(''); },[editSignature,props.order.id]);
  useEffect(() => {
    if (props.paused || active.current || failure || !props.order.updated_at || !props.order.lines) return;
    const changes:QuantityEdit[]=props.order.lines.flatMap((line,index)=>{
      const qty=props.edits[`${props.order.id}:${index}`];
      return qty != null && qty !== Number(line.qty) ? [{index,code:String(line.code || line.requested_code || ''),previousQty:Number(line.qty),qty}] : [];
    });
    if (!changes.length) return;
    const timer=window.setTimeout(()=>{
      if(active.current) return;
      active.current=true; latest.current.onBusy(true);
      const order=props.order;
      void savePortalOrderQuantities(props.credentials,{orderId:order.id,updatedAt:order.updated_at!,edits:changes})
        .then(result=>latest.current.onSaved(order,changes,result))
        .catch(error=>setFailure(error instanceof Error ? error.message : 'Quantity save failed.'))
        .finally(()=>{active.current=false;latest.current.onBusy(false);});
    },2000);
    return ()=>window.clearTimeout(timer);
  },[props.order.id,props.order.updated_at,editSignature,props.paused,failure]);
  const pending=props.order.lines?.some((line,index)=>props.edits[`${props.order.id}:${index}`] != null && props.edits[`${props.order.id}:${index}`] !== Number(line.qty));
  useEffect(()=>{ if (!pending && !active.current) return; const handler=(event:BeforeUnloadEvent)=>{event.preventDefault();event.returnValue='';}; window.addEventListener('beforeunload',handler); return ()=>window.removeEventListener('beforeunload',handler); },[pending]);
  if (pending && !props.order.updated_at) return <span role="alert">{ui('Cannot verify order version. Reload before saving quantities.')}</span>;
  return failure ? <span role="alert">{ui(failure)} {ui('Your changes are not saved; reload the order and try again.')}</span> : pending ? <span role="status">{ui('Saving quantity changes automatically…')}</span> : <span role="status">{ui('Quantities saved.')}</span>;
}
