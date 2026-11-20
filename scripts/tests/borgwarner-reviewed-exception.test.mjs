import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {PGlite} from '@electric-sql/pglite';

test('approved release exception is limited to verified exact file, brand, supplier and rows',async()=>{
 const db=new PGlite();
 try{
  await db.exec(`create schema supplier_price_validation_internal;
   create table public.supplier_price_releases(id uuid,organization_id uuid,supplier_id uuid,brand_id uuid,status text,source_verification_required boolean,accepted_rows bigint,total_rows bigint,rejected_rows bigint,conflict_rows bigint,source_file_sha256 text);
   create table public.supplier_price_release_rows(release_id uuid,source_row_number bigint,product_code text,buy_price numeric,row_status text);
   create function supplier_price_validation_internal.cross_brand_audit(input_release_id uuid) returns jsonb language plpgsql as $fn$
   declare v_release public.supplier_price_releases%rowtype; v_result jsonb;
   begin select * into strict v_release from public.supplier_price_releases where id=input_release_id;
     v_result:=jsonb_build_object('checked',true,'review_required',true,'brands',jsonb_build_array('test'));
  return v_result;
   end $fn$;`);
  const hash=(await db.query("select md5(pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure)) h")).rows[0].h;
  const digest=(await db.query("select md5('1|ABC-1|12.34') h")).rows[0].h;
  let migration=await readFile(new URL('../../supabase/migrations/20261120130500_borgwarner_reviewed_release_exception.sql',import.meta.url),'utf8');
  migration=migration.replace('92a5198c6c9571324f877a6fa092895e',hash).replace('492::bigint', '1::bigint').replace('e7d121f2b5b2dd2b460ad1f894c6bf66',digest);
  await db.exec(migration);
  await db.exec(`insert into public.supplier_price_releases values ('f4ab679d-fbd7-4b05-8483-23362727f3c6','1e4c5e99-e387-41aa-a6d3-cbe74558f766','bb8aa954-5c9c-4edb-8c25-37e170253a1b','6a667fc1-3785-4f02-88fd-031b02cc9d50','validated',true,1,1,0,0,'28404f30319ef59d83bea72f9e7a9c5b60f2c5988a866d5e1640046369d7b02d');
  insert into public.supplier_price_release_rows values ('f4ab679d-fbd7-4b05-8483-23362727f3c6',1,'ABC-1',12.34,'accepted');`);
  const audit=async()=> (await db.query("select supplier_price_validation_internal.cross_brand_audit('f4ab679d-fbd7-4b05-8483-23362727f3c6') a")).rows[0].a;
  let a=await audit(); assert.equal(a.review_required,false);assert.equal(a.original_review_required,true);assert.deepEqual(a.brands,['test']);
  for(const [change,restore] of [
   ["update supplier_price_release_rows set buy_price=12.35","update supplier_price_release_rows set buy_price=12.34"],
   ["update supplier_price_release_rows set product_code='ABC1'","update supplier_price_release_rows set product_code='ABC-1'"],
   ["update supplier_price_releases set source_file_sha256='changed'","update supplier_price_releases set source_file_sha256='28404f30319ef59d83bea72f9e7a9c5b60f2c5988a866d5e1640046369d7b02d'"],
   ["update supplier_price_releases set brand_id=gen_random_uuid()","update supplier_price_releases set brand_id='6a667fc1-3785-4f02-88fd-031b02cc9d50'"],
   ["update supplier_price_releases set supplier_id=gen_random_uuid()","update supplier_price_releases set supplier_id='bb8aa954-5c9c-4edb-8c25-37e170253a1b'"],
   ["update supplier_price_releases set source_verification_required=false","update supplier_price_releases set source_verification_required=true"]]){
    await db.exec(change);assert.equal((await audit()).review_required,true);await db.exec(restore);
   }
 }finally{await db.close();}
});
