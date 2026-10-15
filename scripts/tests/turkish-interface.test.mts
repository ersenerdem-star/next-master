import test from 'node:test';
import assert from 'node:assert/strict';
import React from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import {translateInterfaceText,trInterfaceMessages} from '../../apps/web/src/i18n/interfaceMessages.ts';
import {InterfaceText} from '../../apps/web/src/i18n/InterfaceText.tsx';
import {I18nProvider,useI18n} from '../../apps/web/src/i18n/I18nProvider.tsx';
import {Input} from '../../apps/web/src/presentation/components/common/Input.tsx';
import {Select} from '../../apps/web/src/presentation/components/common/Select.tsx';
import {Button} from '../../apps/web/src/presentation/components/common/Button.tsx';
import {DataTable} from '../../apps/web/src/presentation/components/common/DataTable.tsx';
import {enMessages} from '../../apps/web/src/i18n/locales/en.ts';
import {trMessages} from '../../apps/web/src/i18n/locales/tr.ts';
import {CustomerDeskHome} from '../../apps/web/src/modules/portal/components/CustomerDeskHome.tsx';
import {BrandPill} from '../../apps/web/src/presentation/components/common/BrandPill.tsx';
import type {PortalSnapshot} from '../../apps/web/src/types/portalSession';

const render=(locale:'tr'|'en',children:React.ReactNode)=>renderToStaticMarkup(React.createElement(I18nProvider,{preferredLocale:locale,children}));
test('Turkish copy replaces English slogans while English and unknown business text stay exact',()=>{
 const source='Keep markets moving';
 assert.equal(translateInterfaceText(source,'en'),source);
 assert.equal(translateInterfaceText(source,'tr'),'Ticaretin ritmini koruyun');
 assert.equal(translateInterfaceText(source,'tr').toLocaleUpperCase('tr'),'TİCARETİN RİTMİNİ KORUYUN');
 for(const value of ['Vitesco','Bosch','61/1','Product_Code','Brand','F26-001','Product description supplied by customer']){
  if(value==='Brand')continue; // An explicitly identified interface caption.
  assert.equal(translateInterfaceText(value,'tr'),value);
 }
 assert.equal(translateInterfaceText('  Close ','tr'),'  Kapat ');
});
test('registered notification formats preserve dynamic names literally, including replacement characters',()=>{
 assert.equal(translateInterfaceText('New Bosch price list available','tr'),'Bosch için yeni fiyat listesi hazır');
 assert.equal(translateInterfaceText('New AC$&ME price list available','tr'),'AC$&ME için yeni fiyat listesi hazır');
 assert.equal(translateInterfaceText('New VAG catalog brand available','tr'),'VAG markası eklendi');
 assert.equal(translateInterfaceText('New VAG catalog data available','tr'),'VAG için yeni katalog verileri hazır');
 assert.equal(translateInterfaceText('New catalog brand VAG is now available in your customer portal.','tr'),'VAG markası artık müşteri portalınızda kullanılabilir.');
 assert.equal(translateInterfaceText('The new AC$&ME price list is now available in your customer portal.','tr'),'AC$&ME için yeni fiyat listesi müşteri portalınızda hazır.');
 assert.equal(translateInterfaceText('The new Bosch price list is now available in your customer portal.','en'),'The new Bosch price list is now available in your customer portal.');
 assert.equal(translateInterfaceText('A Price List','tr'),'A Fiyat Listesi');
 assert.equal(translateInterfaceText('Uses the A price list assigned on this customer account.','tr'),'Bu müşteri hesabına atanmış A fiyat listesi kullanılır.');
 assert.equal(translateInterfaceText('View all 1.234 results','tr'),'1.234 sonucun tümünü gör');
 assert.equal(translateInterfaceText('New unknown message from customer','tr'),'New unknown message from customer');
});
test('shared form and table captions follow locale without translating control values, choices or product cells',()=>{
 const controls=React.createElement(React.Fragment,null,
  React.createElement(InterfaceText,{text:'Supplier Price Upload Center'}),
  React.createElement(Input,{label:'Source date',value:'2026-10-15',onChange:()=>{}}),
  React.createElement(Select,{label:'Brand',value:'Brand',options:[{value:'Brand',label:'Brand'},{value:'vitesco-id',label:'Vitesco'}],onChange:()=>{}}),
  React.createElement(Button,{children:'Download Excel',onClick:()=>{}}),
  React.createElement(DataTable,{rows:[{id:'1',description:'English product description'}],columns:[{key:'description',header:'Description',render:(row:{description:string})=>row.description}]})
 );
 const tr=render('tr',controls),en=render('en',controls);
 assert.match(tr,/Tedarikçi Fiyat Yükleme Merkezi/);assert.match(tr,/Kaynak tarihi/);assert.match(tr,/Marka/);assert.match(tr,/Excel indir/);assert.match(tr,/Açıklama/);
 assert.match(en,/Supplier Price Upload Center/);assert.match(en,/Source date/);assert.match(en,/Download Excel/);
 for(const html of [tr,en]){assert.match(html,/value="2026-10-15"/);assert.match(html,/value="Brand" selected="">Brand/);assert.match(html,/English product description/);assert.match(html,/Vitesco/);}
});
test('dashboard order status keys resolve in both languages without missing-key fallback',()=>{
 function StatusProbe(){const {t}=useI18n();return React.createElement('span',null,t('statuses.draft'),' / ',t('statuses.confirmed'));}
 assert.match(render('tr',React.createElement(StatusProbe)),/Taslak \/ Onaylandı/);
 assert.match(render('en',React.createElement(StatusProbe)),/Draft \/ Confirmed/);
});
test('all existing English translation keys have a Turkish entry and registered display copy is nonempty',()=>{
 for(const [namespace,group] of Object.entries(enMessages))for(const key of Object.keys(group)){
  assert.equal(typeof (trMessages as Record<string,Record<string,string>>)[namespace]?.[key],'string',`${namespace}.${key}`);
 }
 assert.ok(Object.keys(trInterfaceMessages).length>400);
 for(const [key,value] of Object.entries(trInterfaceMessages)){assert.ok(key.trim());assert.ok(value.trim());}
});

test('customer home renders Turkish slogans, status, dates and money while keeping order identity and brand spelling',()=>{
 const snapshot={accountSummary:{currency:'EUR',creditAmount:1234.5},pricingProfile:{currency:'EUR',price_list_type:'A'},
  invite:{party_name:'Customer Original Name'},accountRows:[],
  salesOrders:[{id:'SO26-TEST',sales_order_no:'SO26-TEST',status:'draft',currency:'EUR',sales_total:1234.5,line_count:1,updated_at:'2026-10-15T12:00:00Z',lines:[]}]
 } as unknown as PortalSnapshot;
 const noop=()=>{};
 const home=React.createElement(CustomerDeskHome,{snapshot,searchValue:'',onSearchValueChange:noop,onSearch:noop,onOpenSearch:noop,onOpenStatement:noop,onOpenOrder:noop,onOpenOrders:noop,onOpenBilling:noop,onOpenPriceLists:noop});
 const tr=render('tr',home),en=render('en',home);
 assert.match(tr,/İşletmeniz için/);assert.match(tr,/doğru parçayı bulun/);assert.match(tr,/Taslak/);assert.match(tr,/15 Eki 2026/);assert.match(tr,/1\.234,50 EUR/);
 assert.doesNotMatch(tr,/Find a part|Recent orders|View all orders|Draft/);
 assert.match(en,/Find a part/);assert.match(en,/Draft/);assert.match(en,/1,234\.50 EUR/);
 for(const html of [tr,en]){assert.match(html,/SO26-TEST/);assert.match(html,/Customer Original Name/);}
 const brand=render('tr',React.createElement(BrandPill,{brand:'Vitesco'}));assert.match(brand,/lang="en"/);assert.match(brand,/>Vitesco</);
});
