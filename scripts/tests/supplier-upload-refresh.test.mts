import test from 'node:test';
import assert from 'node:assert/strict';
import React, {useState} from 'react';
import {act, create} from 'react-test-renderer';
import {useSupplierUploadRefresh} from '../../apps/web/src/shared/useSupplierUploadRefresh.ts';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const pending = <T,>() => {
  let resolve!: (value:T) => void; let reject!: (error:Error) => void;
  const promise = new Promise<T>((yes,no) => { resolve=yes; reject=no; });
  return {promise,resolve,reject};
};

test('opening and retrying upload refreshes suppliers without losing file or selection; stale responses are ignored', async () => {
  type Row = {id:string,name:string};
  const requests: ReturnType<typeof pending<Row[]>>[] = [];
  const load = () => {const request=pending<Row[]>();requests.push(request);return request.promise;};
  function Fixture() {
    const [open,setOpen]=useState(false);
    const [rows,setRows]=useState<Row[]>([{id:'old',name:'Existing'}]);
    const [selection]=useState('old');
    const [file]=useState('prices.csv');
    const refresh=useSupplierUploadRefresh(open,load,setRows);
    return React.createElement('div',{},
      React.createElement('button',{id:'open',onClick:()=>setOpen(true)},'Open'),
      React.createElement('button',{id:'close',onClick:()=>setOpen(false)},'Close'),
      React.createElement('button',{id:'retry',onClick:refresh.retry},'Retry'),
      React.createElement('output',{id:'rows'},rows.map(x=>x.name).join(',')),
      React.createElement('output',{id:'selection'},selection),
      React.createElement('output',{id:'file'},file),
      React.createElement('output',{id:'loading'},String(refresh.loading)),
      React.createElement('output',{id:'failed'},String(refresh.failed)));
  }
  let renderer!: ReturnType<typeof create>;
  await act(async()=>{renderer=create(React.createElement(Fixture));});
  const node=(id:string)=>renderer.root.findByProps({id});
  const text=(id:string)=>node(id).children.join('');
  await act(async()=>node('open').props.onClick());
  assert.equal(text('loading'),'true');
  await act(async()=>node('close').props.onClick());
  await act(async()=>node('open').props.onClick());
  await act(async()=>{requests[0].resolve([{id:'stale',name:'Old response'}]); await requests[0].promise;});
  assert.equal(text('rows'),'Existing');
  await act(async()=>{requests[1].resolve([{id:'old',name:'Existing'},{id:'new',name:'New supplier'}]);await requests[1].promise;});
  assert.equal(text('rows'),'Existing,New supplier');
  assert.equal(text('selection'),'old');assert.equal(text('file'),'prices.csv');assert.equal(text('loading'),'false');
  await act(async()=>node('close').props.onClick());
  await act(async()=>node('open').props.onClick());
  await act(async()=>{requests[2].reject(new Error('offline'));await requests[2].promise.catch(()=>{});});
  assert.equal(text('failed'),'true');assert.equal(text('rows'),'Existing,New supplier');
  assert.equal(text('selection'),'old');assert.equal(text('file'),'prices.csv');
  await act(async()=>node('retry').props.onClick());
  await act(async()=>{requests[3].resolve([{id:'new',name:'New supplier'}]);await requests[3].promise;});
  assert.equal(text('failed'),'false');assert.equal(text('rows'),'New supplier');
  await act(async()=>renderer.unmount());
});

test('a stalled supplier refresh fails visibly and ignores a late response', async () => {
  const request=pending<string[]>();
  function Fixture() {
    const [rows,setRows]=useState(['existing']);
    const refresh=useSupplierUploadRefresh(true,()=>request.promise,setRows,10);
    return React.createElement('div',{},
      React.createElement('output',{id:'rows'},rows.join(',')),
      React.createElement('output',{id:'loading'},String(refresh.loading)),
      React.createElement('output',{id:'failed'},String(refresh.failed)));
  }
  let renderer!:ReturnType<typeof create>;
  await act(async()=>{renderer=create(React.createElement(Fixture));});
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
  const text=(id:string)=>renderer.root.findByProps({id}).children.join('');
  assert.equal(text('failed'),'true');assert.equal(text('loading'),'false');
  await act(async()=>{request.resolve(['late']);await request.promise;});
  assert.equal(text('rows'),'existing');
  await act(async()=>renderer.unmount());
});
