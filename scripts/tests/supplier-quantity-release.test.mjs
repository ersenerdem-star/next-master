import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { prepareSupplierQuantityRelease } from '../../apps/engine/supplier-price-shadow/src/prepare-supplier-quantity-release.mjs';
import { verifySupplierPriceUpload } from '../../apps/engine/supplier-price-shadow/src/verified-upload-handoff.mjs';
import { createLocalStreamSource,clearLocalStreamSources } from '../../apps/engine/supplier-price-shadow/src/local-stream-source.mjs';
import { parseNormalizedSupplierPriceRows } from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';

const date = '2026-11-12';
const org = '10000000-0000-4000-8000-000000000001';
const supplier = '10000000-0000-4000-8000-000000000002';
const brand = '10000000-0000-4000-8000-000000000003';
const release = '10000000-0000-4000-8000-000000000004';
const marked = '10000000-0000-4000-8000-000000000006';
const other = '10000000-0000-4000-8000-000000000005';
const source = Buffer.from('Product_Code;MOQ;Buy_Price_Eur\n411471.103D;1;30,58\n411471.103D;16;29,68\n411471.103D;256;28,82\n104892;1;1,20\n104892;100;1,16\n');

test('verified base matches every product; publish pointer enables tiers and manual override wins', async() => {
  const db = new PGlite();
  try {
    await db.exec(`
      create role anon; create role authenticated; create role service_role;
      create schema auth; create schema supplier_price_ingestion_internal; create schema supplier_manual_price_internal;
      create function auth.role() returns text language sql as $$select current_setting('request.jwt.claim.role',true)$$;
      create function public.normalize_catalog_product_code(text) returns text language sql as $$select upper(regexp_replace(btrim($1),'[[:space:]]+','','g'))$$;
      create table public.supplier_price_releases (
        id uuid primary key, organization_id uuid, supplier_id uuid, brand_id uuid, source_file_sha256 text,
        source_verification_required boolean, mode text, status text, total_rows bigint, accepted_rows bigint,
        rejected_rows bigint, conflict_rows bigint, warning_rows bigint, error_code text, source_file_path text, source_file_bytes bigint
      );
      create table public.supplier_price_release_rows (
        id bigint generated always as identity primary key, release_id uuid, product_code text, normalized_code text,
        row_status text, currency text, moq integer, order_multiple integer, buy_price numeric, valid_from date
      );
      create table public.supplier_current_price_pointers (
        organization_id uuid, supplier_id uuid, brand_id uuid, release_id uuid
      );
      create table supplier_manual_price_internal.entries (
        organization_id uuid, supplier_id uuid, brand_id uuid, active boolean, valid_from date, exact_code text
      );
      create table public.suppliers(id uuid, organization_id uuid, name text, is_active boolean, price_usage_enabled boolean);
      create table public.brands(id uuid, organization_id uuid, name text, normalized_name text);
      create schema supplier_price_validation_internal;
      create function supplier_price_validation_internal.canonical_automotive_brand_key(text,text) returns text language sql as $$select lower($1)$$;
      create function auth.uid() returns uuid language sql as $$select '10000000-0000-4000-8000-000000000010'::uuid$$;
      create function public.current_profile_org_id() returns uuid language sql as $$select '${org}'::uuid$$;
      create function public.reassign_purchase_order_supplier_atomic(jsonb) returns jsonb language plpgsql as $$
      declare v_org uuid; v_line jsonb; begin
        perform * from public.cloud_current_supplier_commercial_options_core(v_org,v_line->>'product_code',v_line->>'brand');
        return '{}';
      end $$;
      -- The existing options core is represented by its selected 1-unit offer.
      create table public.options_fixture (
        organization_id uuid, supplier_id uuid, supplier_name text, brand_id uuid, brand text, product_code text,
        description text, buy_price numeric, price_date date, notes text, moq integer, order_multiple integer,
        stock_qty integer, valid_to date
      );
      create function public.cloud_current_supplier_commercial_options_core(uuid,text,text)
        returns table(supplier_id uuid,supplier_name text,brand_id uuid,brand text,product_code text,
          description text,buy_price numeric,price_date date,notes text,moq integer,order_multiple integer,stock_qty integer,valid_to date)
        language sql as $$
          select f.supplier_id, f.supplier_name, f.brand_id, f.brand, f.product_code, f.description,
            f.buy_price, f.price_date, f.notes, f.moq, f.order_multiple, f.stock_qty, f.valid_to
          from public.options_fixture f where f.organization_id=$1 and f.product_code=$2 and f.brand=$3
        $$;
    `);
    await db.exec(await readFile('supabase/migrations/20261120141700_supplier_release_quantity_tiers.sql','utf8'));
    await db.exec(await readFile('supabase/migrations/20261120141900_quantity_tier_order_readers.sql','utf8'));
    await db.exec(await readFile('supabase/migrations/20261120142000_verified_wahler_quantity_upload.sql','utf8'));
    await db.exec(await readFile('supabase/migrations/20261120143946_wahler_quantity_price_curves.sql','utf8'));
    const original = process.env.WAHLER_QUANTITY_SOURCE ? await readFile(process.env.WAHLER_QUANTITY_SOURCE) : source;
    const file = await prepareSupplierQuantityRelease(original, date);
    const base = [];
    for await (const row of parseNormalizedSupplierPriceRows(Readable.from([file.baseCsv]), {commercialFields:true,sourceDate:date})) base.push(row);
    await db.query(`insert into supplier_price_releases values ($1,$2,$3,$4,$5,true,'replace','validated',$6,$6,0,0,0,null,null,null)`,
      [release,org,supplier,brand,file.baseSha256,base.length]);
    await db.query(`insert into supplier_price_release_rows(release_id,product_code,normalized_code,row_status,currency,moq,buy_price,valid_from)
       select $1,b.product_code,b.normalized_code,'accepted',b.currency,b.moq,b.buy_price,b.valid_from
       from jsonb_to_recordset($2::jsonb) b(product_code text,normalized_code text,currency text,moq integer,buy_price numeric,valid_from date)`,
      [release,JSON.stringify(base)]);
    await db.query(`insert into options_fixture values ($1,$2,'GroupAuto',$3,'Wahler','411471.103D',null,30.58,$4,null,1,null,null,null)`,[org,supplier,brand,date]);
    const args = [org,release,file.baseSha256,file.originalSha256,JSON.stringify(file.rows)];
    const stage = async (params=args) => (await db.query('select public.stage_verified_supplier_quantity_tiers($1,$2,$3,$4,$5::jsonb) n',params)).rows[0].n;
    await assert.rejects(stage(), /QUANTITY_TIERS_SERVICE_REQUIRED/);
    await db.exec("select set_config('request.jwt.claim.role','service_role',false)");
    await assert.rejects(stage([other,...args.slice(1)]), /QUANTITY_TIERS_RELEASE_MISMATCH/);
    await assert.rejects(stage([...args.slice(0,4), JSON.stringify(file.rows.map((row,i)=>i===0?{...row,price:41}:row))]), /QUANTITY_TIERS_INVALID_ROWS/);
    assert.equal(await stage(), file.rows.length);
    assert.equal(await stage(), file.rows.length);
    await assert.rejects(stage([...args.slice(0,3),'a'.repeat(64),args[4]]), /QUANTITY_TIERS_ALREADY_STAGED/);
    const quote = async qty => (await db.query('select * from public.cloud_current_supplier_quantity_options_service($1,$2,$3,$4)',[org,'411471.103D','Wahler',qty])).rows[0];
    assert.equal(Number((await quote(17)).buy_price),30.58);
    await db.query('insert into supplier_current_price_pointers values ($1,$2,$3,$4)',[org,supplier,brand,release]);
    await db.query("update supplier_price_releases set status='published' where id=$1",[release]);
    assert.equal(Number((await quote(15)).buy_price),30.58);
    assert.equal(Number((await quote(17)).buy_price),29.68);
    assert.equal((await quote(17)).applied_min_quantity,16);
    assert.equal(Number((await quote(256)).buy_price),28.82);
    assert.equal(await stage(),file.rows.length);
    await db.query("insert into suppliers values($1,$2,'GroupAuto',true,true)",[supplier,org]);
    await db.query("insert into brands values($1,$2,'Wahler','wahler')",[brand,org]);
    const batch = await db.query("select * from public.cloud_current_supplier_price_options_batch($1::jsonb)",[
      JSON.stringify([{code:'411471.103D',brand:'Wahler',quantity:17},{code:'411471.103D',brand:'Wahler'}]),
    ]);
    assert.equal(batch.rows[0].options[0].buy_price,29.68);
    assert.equal(batch.rows[1].options[0].buy_price,30.58);
    const sale = await db.query("select * from public.cloud_quote_supplier_quantity_options('411471.103D','Wahler','A',0.1,0.1,17)");
    assert.equal(Number(sale.rows[0].sell_price),32.65);
    const curve = () => db.query("select * from public.cloud_wahler_quantity_price_curves($1,$2,$3,$4)",[
      org,brand,['411471.103D','411471103D'],supplier,
    ]);
    assert.deepEqual((await curve()).rows.map(row=>[row.code,row.minimum_quantity,Number(row.unit_buy_price)]),[
      ['411471.103D',16,29.68],['411471.103D',256,28.82],
    ]);

    await db.query("insert into supplier_price_releases values($1,$2,$3,$4,$5,true,'replace','staged',$6,$6,0,0,0,null,'a/wahler-quantity-tiers-fixture.csv',$7)",
      [marked,org,supplier,brand,file.originalSha256,base.length,original.length]);
    const validate = () => db.query("update supplier_price_releases set status='validated' where id=$1",[marked]);
    await assert.rejects(validate(),/QUANTITY_TIERS_SOURCE_REQUIRED/);
    const sealArgs = [org,marked,file.originalSha256,JSON.stringify(file.rows)];
    const register = async () => (await db.query("select public.record_verified_wahler_quantity_source($1,$2,$3,$4::jsonb) n",sealArgs)).rows[0].n;
    const sessionId = '10000000-0000-4000-8000-000000000007';
    const objectId = '10000000-0000-4000-8000-000000000008';
    const handoffId = '10000000-0000-4000-8000-000000000009';
    const objectPath = `${org}/supplier-price/${sessionId}/wahler-quantity-tiers-fixture.csv`;
    const origin = 'https://supplier-upload.invalid';
    const fetchImpl = async url => {
      const {pathname} = new URL(url);
      if (pathname === '/storage/v1/object/supplier-price-imports/'+objectPath) return new Response(original);
      assert.equal(pathname,'/rest/v1/rpc/record_supplier_price_source_compatibility_v2');
      return Response.json({status:'recorded',release_id:marked,source_sha256:file.originalSha256,total_rows:base.length});
    };
    const rpc = async (name,input) => {
      if (name === 'begin_supplier_price_upload_verification') return {
        session_id:sessionId,organization_id:org,actor_id:supplier,release_id:marked,object_id:objectId,storage_bucket:'supplier-price-imports',
        source_file_bytes:original.length,source_file_sha256:file.originalSha256,source_file_path:objectPath,
        object_version:'v1',object_updated_at:date,source_date:date,
      };
      if (name === 'record_verified_wahler_quantity_source') {
        assert.deepEqual(input.input_rows,file.rows);
        return register();
      }
      assert.equal(name,'complete_supplier_price_verified_upload');
      assert.equal(input.input_total_rows,base.length);
      assert.equal(input.input_source_sha256,file.originalSha256);
      return {status:'verified',session_id:sessionId,release_id:marked,handoff_id:handoffId,
        workflow_id:`supplier-price-verified:v1:${marked}`,queue_name:'supplier-price-verified-shadow',
        source_bytes:original.length,source_sha256:file.originalSha256,total_rows:base.length,published:false};
    };
    const verification = {sessionId,organizationId:org,actorId:supplier,rpc,supabaseUrl:origin,serviceRoleKey:'test',fetchImpl,commercialFields:true};
    assert.equal((await verifySupplierPriceUpload(verification)).published,false);
    assert.equal((await verifySupplierPriceUpload(verification)).total_rows,base.length);
    const adapter = createLocalStreamSource({supabaseUrl:origin,serviceRoleKey:'test',fetchImpl,commercialFields:true});
    const manifest = {id:marked,handoff_id:handoffId,source_file_path:objectPath,source_file_sha256:file.originalSha256,
      source_file_bytes:original.length,source_date:date,total_rows:base.length};
    const batchSize = base.length;
    const prepared = await adapter.prepare({release:manifest,batchSize});
    const scan = await adapter.scan({release:manifest,batchSize,receipt:prepared,claim:{cursor_start:1,cursor_end:base.length}});
    assert.equal(scan.acceptedRows,base.length);
    assert.equal(scan.checksum,file.originalSha256);
    assert.deepEqual(scan.rows.map(x=>[x.product_code,x.buy_price]),base.map(x=>[x.product_code,x.buy_price]));
    await assert.rejects(validate(),/QUANTITY_TIERS_INVALID_ROWS/);
    await db.query(`insert into supplier_price_release_rows(release_id,product_code,normalized_code,row_status,currency,moq,buy_price,valid_from)
      select $1,product_code,normalized_code,row_status,currency,moq,buy_price,valid_from from supplier_price_release_rows where release_id=$2`,
      [marked,release]);
    await validate();
    assert.equal(await register(),file.rows.length);
    assert.equal((await db.query("select count(*)::int n from supplier_price_ingestion_internal.pending_wahler_quantity_sources")).rows[0].n,0);
    await db.query("insert into supplier_manual_price_internal.entries values ($1,$2,$3,true,$4,'411471.103D')",[org,supplier,brand,date]);
    assert.equal(Number((await quote(17)).buy_price),30.58);
    assert.deepEqual((await curve()).rows,[]);
    await db.exec('delete from supplier_manual_price_internal.entries');
    await db.query('update supplier_current_price_pointers set release_id=$1',[other]);
    assert.equal(Number((await quote(17)).buy_price),30.58);
    assert.equal((await db.query("select has_function_privilege('authenticated','public.cloud_current_supplier_quantity_options_service(uuid,text,text,integer)','EXECUTE') allowed")).rows[0].allowed,false);
  } finally { await clearLocalStreamSources(); await db.close(); }
});
