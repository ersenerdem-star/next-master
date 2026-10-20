// A dropped keep-alive socket can be retried for a GET. A write is never
// retried: its durable server checkpoint must first be inspected by an operator.
export async function readSafeFetch(url,init,fetchImpl=fetch){
 try{return await fetchImpl(url,init);}
 catch(e){if((init?.method||'GET')!=='GET'||e.name!=='TypeError'||init?.signal?.aborted)throw e;
  return fetchImpl(url,{...init,headers:{...init.headers,connection:'close'}});
 }
}
