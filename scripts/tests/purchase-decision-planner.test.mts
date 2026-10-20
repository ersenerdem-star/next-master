import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {purchaseDecisionRows,assignPurchaseDecisions,purchasePlanSummary,filterPurchaseDecisions} from '../../apps/web/src/shared/purchaseSourcing.ts';
import {PurchaseSourcingPlanner,PURCHASE_DECISION_PAGE_SIZE} from '../../apps/web/src/presentation/components/purchases/PurchaseSourcingPlanner.tsx';
const order:any={supplier_name:'Romany',currency:'EUR',lines:Array.from({length:200},(_,i)=>({product_code:String(i).padStart(6,'0'),brand:'SACHS',description:`Damper ${i}`,qty:2,buy_price:100}))};
const offer=(i:number,id:string,price:number,stock=1000)=>({supplier_id:id,supplier_name:id,product_code:order.lines[i].product_code,brand:'SACHS',buy_price:price,price_date:'2026-10-20',moq:1,order_multiple:1,stock_qty:stock,valid_to:null});
const rows=order.lines.map((_:any,i:number)=>[offer(i,'TPM',90),offer(i,'GroupAuto',i%2?95:85)]);

test('successive real decimal price choices keep rendering and sum exact cents across supplier groups',()=>{
 const small:any={...order,lines:[{...order.lines[0],buy_price:7.60,qty:1},{...order.lines[1],buy_price:25.83,qty:1}]};
 const prices=[[offer(0,'TPM',8.56),offer(0,'GroupAuto',7.60)],[offer(1,'TPM',28.18),offer(1,'GroupAuto',34.40)]];
 for(const suppliers of [['TPM','TPM'],['TPM','GroupAuto']]) {
  let assignments={};
  for(let index=0;index<2;index++) {
   const before=purchaseDecisionRows(small,prices,assignments);
   assignments=assignPurchaseDecisions(before,assignments,[index],suppliers[index]).assignments;
   const decisions=purchaseDecisionRows(small,prices,assignments);
   const summary=purchasePlanSummary(small,decisions,assignments);
   assert.equal(summary.changed,index+1);
   assert.equal(summary.delta,index===0?0.96:suppliers[1]==='TPM'?3.31:9.53);
   assert.equal(summary.newTotal,index===0?34.39:suppliers[1]==='TPM'?36.74:42.96);
   assert.equal(decisions[0].savings,0);
   assert.equal(decisions[1].savings,-2.35);
   assert.equal(filterPurchaseDecisions(small,decisions,assignments,'','all','original','TPM')[0].savings,-0.96);
   const html=renderToStaticMarkup(createElement(PurchaseSourcingPlanner,{order:small,rows:prices,assignments,vendors:[],locale:'tr',onChange:()=>{}}));
   assert.ok(html.includes(`${index+1}</strong> değişiklik`));
  }
 }
 const cheaper=[[offer(0,'TPM',6.64)],[offer(1,'TPM',23.48)]];
 const assignments={0:'TPM',1:'TPM'};
 const summary=purchasePlanSummary(small,purchaseDecisionRows(small,cheaper,assignments),assignments);
 assert.equal(summary.delta,-3.31);assert.equal(summary.newTotal,30.12);
});

test('200 lines stay unchanged until explicit decisions and render only 40 compact rows',()=>{
 const decisions=purchaseDecisionRows(order,rows,{});
 assert.equal(purchasePlanSummary(order,decisions,{}).changed,0);
 const html=renderToStaticMarkup(createElement(PurchaseSourcingPlanner,{order,rows,assignments:{},vendors:[],locale:'tr',onChange:()=>{}}));
 assert.equal((html.match(/<tbody><tr>|<\/tr><tr>/g)||[]).length,PURCHASE_DECISION_PAGE_SIZE);
 assert.ok(html.includes('000039'));assert.ok(!html.includes('000040'));assert.ok(html.includes('1–40 / 200'));
 assert.ok(!html.includes('purchase-planner-detail-row'),'terms stay collapsed');
});
test('bulk decisions support different suppliers and only assigned demand changes cost',()=>{
 let assignments={};let decisions=purchaseDecisionRows(order,rows,assignments);
 assignments=assignPurchaseDecisions(decisions,assignments,Array.from({length:120},(_,i)=>i),'TPM').assignments;
 assignments=assignPurchaseDecisions(decisions,assignments,Array.from({length:30},(_,i)=>120+i),'GroupAuto').assignments;
 decisions=purchaseDecisionRows(order,rows,assignments);
 const summary=purchasePlanSummary(order,decisions,assignments);
 assert.equal(summary.changed,150);assert.equal(summary.groups.length,2);assert.equal(summary.oldTotal,40000);
 assert.equal(summary.groups[0].newTotal,21600);assert.equal(summary.groups[1].newTotal,5400);assert.equal(summary.newTotal,37000);
 const kept=assignPurchaseDecisions(decisions,assignments,[0,1],'keep').assignments;assert.equal(kept[0],undefined);assert.equal(kept[2],'TPM');
});
test('bulk assignment never substitutes another supplier when the requested offer fails stock or quantity rules',()=>{
 const data=[[offer(0,'TPM',90,0),offer(0,'GroupAuto',85)]];
 const d=purchaseDecisionRows({...order,lines:[order.lines[0]]},data,{0:'GroupAuto'});
 const result=assignPurchaseDecisions(d,{0:'GroupAuto'},[0],'TPM');assert.equal(result.skipped,1);assert.equal(result.assignments[0],'GroupAuto');
 assert.equal(assignPurchaseDecisions(d,{},[0],'best').assignments[0],'GroupAuto');
});
test('filters preserve literal codes and supplier-focused cheapest decisions never change previous choices',()=>{
 const assigned={0:'TPM'};const d=purchaseDecisionRows(order,rows,assigned);
 assert.deepEqual(filterPurchaseDecisions(order,d,assigned,'000001','all','original').map(r=>r.index),[1]);
 assert.equal(filterPurchaseDecisions(order,d,assigned,'','assigned','original').length,1);
 assert.equal(filterPurchaseDecisions(order,d,assigned,'','keep','original').length,199);
 const focused=filterPurchaseDecisions(order,d,assigned,'000000','all','original','TPM')[0];assert.equal(focused.best?.buy_price,90);assert.equal(focused.assigned?.supplier_id,'TPM');
 const missing=filterPurchaseDecisions(order,d,assigned,'','unavailable','original','Missing');assert.equal(missing.length,200);
 assert.equal(filterPurchaseDecisions(order,d,assigned,'','all','impact')[0].index,0);
});

test('planned duplicated SKU quantities cannot exceed shared supplier stock',()=>{
 const duplicateOrder:any={...order,lines:[{...order.lines[0],qty:4},{...order.lines[0],qty:4}]};
 const duplicateRows=[[{...offer(0,'TPM',90),stock_qty:6}],[{...offer(0,'TPM',90),stock_qty:6}]];
 const assignments={0:'TPM',1:'TPM'};
 const summary=purchasePlanSummary(duplicateOrder,purchaseDecisionRows(duplicateOrder,duplicateRows,assignments),assignments);
 assert.equal(summary.invalid,2);assert.equal(summary.stockIssues[0].qty,8);assert.equal(summary.stockIssues[0].stock,6);
});

test('refreshing prices preserves explicit suppliers and recalculates the plan without selecting a cheaper replacement',()=>{
 const small:any={...order,lines:[order.lines[0]]};const assignments={0:'TPM'};
 const before=purchasePlanSummary(small,purchaseDecisionRows(small,[rows[0]],assignments),assignments);
 const refreshed=[[offer(0,'TPM',105),offer(0,'GroupAuto',80)]];
 const decisions=purchaseDecisionRows(small,refreshed,assignments);
 const after=purchasePlanSummary(small,decisions,assignments);
 assert.equal(before.newTotal,180);assert.equal(after.newTotal,210);
 assert.equal(decisions[0].assigned?.supplier_id,'TPM');assert.equal(decisions[0].best?.supplier_id,'GroupAuto');
});
