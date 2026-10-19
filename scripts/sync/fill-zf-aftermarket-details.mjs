#!/usr/bin/env node
// Compatibility entrypoint: legacy catalog writes bypassed source review,
// field CAS and the replacement guards. Keep a single exact read-only probe.
const args=new Map();
for(let i=2;i<process.argv.length;i++){
 const token=process.argv[i];if(!token.startsWith('--'))continue;
 const [key,value]=token.slice(2).split('=',2);
 args.set(key,value??(process.argv[i+1]&&!process.argv[i+1].startsWith('--')?process.argv[++i]:true));
}
if(args.has('apply')||args.has('import'))throw Error('ZF_REVIEWED_ENGINE_REQUIRED: use Catalog > ZF Group Catalog Engine to review and apply catalog corrections. Legacy bulk writes are disabled.');
const brand=String(args.get('brand')||args.get('brands')||''),code=String(args.get('code')||'');
if(!brand||!code||brand.includes(',')||!/^[A-Za-z0-9][A-Za-z0-9 ./-]{0,59}$/.test(code)||!/[0-9]/.test(code)){
 throw Error('For one exact read-only probe use --brand Sachs --code 105843. Use the reviewed portal engine for collections and catalog writes.');
}
const {readZfOfficialProduct}=await import('../../netlify/functions/_shared/catalog/zf-aftermarket-sync.mts');
console.log(JSON.stringify(await readZfOfficialProduct(brand,code),null,2));
