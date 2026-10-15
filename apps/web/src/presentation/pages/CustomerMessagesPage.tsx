import {useInterfaceText} from "../../i18n/InterfaceText";
import {useEffect,useRef,useState} from 'react';
import {messagingRequest,type CustomerMessage,type MessageCustomer,type MessageConversation,type MessageCursor} from '../../infrastructure/api/customerMessagesApi';
import {SectionCard} from '../components/common/SectionCard';
import {Button} from '../components/common/Button';
import {useI18n} from '../../i18n/I18nProvider';

export function CustomerMessagesPage({portal=false}:{portal?:boolean}){
  const ui=useInterfaceText();
  const {locale}=useI18n(),tr=locale==='tr';
  const [customers,setCustomers]=useState<MessageCustomer[]>([]),[conversations,setConversations]=useState<MessageConversation[]>([]);
  const [customerId,setCustomerId]=useState(''),[messages,setMessages]=useState<CustomerMessage[]>([]),[next,setNext]=useState<MessageCursor|null>(null);
  const [draft,setDraft]=useState(''),[loading,setLoading]=useState(false),[sending,setSending]=useState(false),[error,setError]=useState('');
  const [tick,setTick]=useState(0),[inboxError,setInboxError]=useState('');
  const firstPageLoaded=useRef(false);
  const generation=useRef(0),pending=useRef<{id:string;text:string;customerId:string}|null>(null),bottom=useRef<HTMLDivElement|null>(null);
  const active=portal||Boolean(customerId);
  useEffect(()=>{
    const timer=window.setInterval(()=>{if(document.visibilityState==='visible')setTick(v=>v+1);},15000);
    const focus=()=>setTick(v=>v+1);window.addEventListener('focus',focus);
    return()=>{window.clearInterval(timer);window.removeEventListener('focus',focus);};
  },[]);
  useEffect(()=>{
    if(portal)return;
    const controller=new AbortController();
    void messagingRequest<{customers:MessageCustomer[];conversations:MessageConversation[]}>(false,{action:'inbox'},controller.signal).then(data=>{
      setCustomers(data.customers);setConversations(data.conversations);setInboxError('');
    }).catch(e=>{if(!controller.signal.aborted)setInboxError(e.message);});
    return()=>controller.abort();
  },[portal,tick]);
  useEffect(()=>{
    const version=++generation.current;firstPageLoaded.current=false;setMessages([]);setNext(null);setDraft('');pending.current=null;setError('');
    if(!active)return;
    setLoading(true);const controller=new AbortController();
    void loadMessages(null,version,controller.signal).finally(()=>{if(version===generation.current)setLoading(false);});
    return()=>controller.abort();
  },[portal,customerId]);
  useEffect(()=>{
    if(!active||!tick)return;
    const controller=new AbortController();void loadMessages(null,generation.current,controller.signal);return()=>controller.abort();
  },[tick]);
  async function loadMessages(before:MessageCursor|null,version=generation.current,signal?:AbortSignal){
    try{
      const data=await messagingRequest<{messages:CustomerMessage[];next:MessageCursor|null}>(portal,{action:'list',customerId,before},signal);
      if(version!==generation.current||signal?.aborted)return;
      setMessages(previous=>{
        const merged=new Map((before?[...data.messages,...previous]:[...previous,...data.messages]).map(m=>[m.id,m]));
        return [...merged.values()].sort((a,b)=>a.created_at.localeCompare(b.created_at)||a.id.localeCompare(b.id));
      });
      if(before || !firstPageLoaded.current)setNext(data.next);firstPageLoaded.current=true;
      setError('');
      const latest=data.messages.at(-1);
      if(latest && document.visibilityState==='visible'){
        void messagingRequest(portal,{action:'read',customerId,through:{createdAt:latest.created_at,id:latest.id}},signal).then(()=>{
          if(version===generation.current)setConversations(rows=>rows.map(c=>c.customer_id===customerId?{...c,unread_count:0}:c));
        }).catch(()=>{/* A read receipt failure never changes the delivered message. */});
      }
    }catch(e){if(version===generation.current&&!signal?.aborted)setError(e instanceof Error?e.message:'Messages unavailable.');}
  }
  async function send(){
    const text=draft.trim();if(!active||!text||sending)return;
    const version=generation.current;
    if(!pending.current||pending.current.text!==text||pending.current.customerId!==customerId)pending.current={id:crypto.randomUUID(),text,customerId};
    setSending(true);setError('');
    try{
      const data=await messagingRequest<{message:CustomerMessage}>(portal,{action:'send',customerId,id:pending.current.id,text});
      if(version!==generation.current)return;
      setMessages(rows=>[...rows.filter(m=>m.id!==data.message.id),data.message]);setDraft('');pending.current=null;setTick(v=>v+1);
      window.setTimeout(()=>bottom.current?.scrollIntoView({block:'nearest'}),0);
    }catch(e){if(version===generation.current)setError(e instanceof Error?e.message:'Message could not be sent.');}
    finally{setSending(false);}
  }
  const choices=new Map(customers.map(c=>[c.id,c]));
  for(const c of conversations)if(!choices.has(c.customer_id))choices.set(c.customer_id,{id:c.customer_id,name:c.customer_name});
  const sorted=[...choices.values()].sort((a,b)=>{
    const ca=conversations.find(c=>c.customer_id===a.id),cb=conversations.find(c=>c.customer_id===b.id);
    return (cb?.last_message_at||'').localeCompare(ca?.last_message_at||'')||a.name.localeCompare(b.name);
  });
  return <div className="page-shell customer-messages-page">
    <SectionCard title={tr?'Mesajlar':'Messages'} actions={<Button variant="secondary" onClick={()=>setTick(v=>v+1)}>{tr?'Yenile':ui("Refresh")}</Button>}>
      <p>{portal?(tr?'Firma yetkilisiyle buradan yazışabilirsiniz.':'Send a message to your account team.'):(tr?'Müşteriyi seçerek portal yazışmasını açın.':'Select a customer to open their portal conversation.')}</p>
      {inboxError?<p role="alert" className="error-text">{inboxError}</p>:null}
      {!portal?<label className="field-label">{tr?'Müşteri':ui("Customer")}
        <select aria-label={tr?'Mesajlaşılacak müşteri':'Message customer'} value={customerId} disabled={sending} onChange={e=>setCustomerId(e.target.value)}>
          <option value="">{tr?'Müşteri seçin':'Choose a customer'}</option>
          {sorted.map(c=>{const count=conversations.find(v=>v.customer_id===c.id)?.unread_count||0;return <option key={c.id} value={c.id}>{c.name}{count?` (${count} ${tr?'okunmamış':'unread'})`:''}</option>;})}
        </select>
      </label>:null}
      {active?<>
        <div className="customer-message-thread" aria-label={tr?'Yazışma':'Conversation'} aria-busy={loading}>
          {next?<Button variant="secondary" onClick={()=>void loadMessages(next)}>{tr?'Önceki mesajlar':'Older messages'}</Button>:null}
          {loading?<p role="status">{tr?'Mesajlar yükleniyor…':'Loading messages…'}</p>:null}
          {!loading&&!messages.length&&!error?<p>{tr?'Henüz mesaj yok. İlk mesajınızı yazabilirsiniz.':'No messages yet. You can write the first message.'}</p>:null}
          {messages.map(message=><article key={message.id} className={`customer-message${message.sender_kind===(portal?'customer':'admin')?' customer-message--own':''}`}>
            <div className="customer-message__meta"><strong>{message.sender_name}</strong><time dateTime={message.created_at}>{new Date(message.created_at).toLocaleString(tr?'tr-TR':'en-GB')}</time></div>
            <p>{message.body}</p>
            {message.sender_kind===(portal?'customer':'admin')?<small>{message.read_at?(tr?'Okundu':'Read'):(tr?'Gönderildi':'Sent')}</small>:null}
          </article>)}<div ref={bottom}/>
        </div>
        {error?<p role="alert" className="error-text">{error}</p>:null}
        <form className="customer-message-compose" onSubmit={e=>{e.preventDefault();void send();}}>
          <label htmlFor="customer-message-draft">{tr?'Mesajınız':'Your message'}</label>
          <textarea id="customer-message-draft" value={draft} onChange={e=>setDraft(e.target.value)} maxLength={4000} rows={4} disabled={sending||loading}/>
          <div className="toolbar toolbar--wrap"><small>{draft.length}/4000</small><Button type="submit" busy={sending} disabled={loading||!draft.trim()}>{tr?'Gönder':'Send'}</Button></div>
        </form>
      </>:null}
    </SectionCard>
  </div>;
}
