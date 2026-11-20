import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import { PGlite } from '@electric-sql/pglite';
import { prepareSupplierQuantityRelease } from '../../apps/engine/supplier-price-shadow/src/prepare-supplier-quantity-release.mjs';
import { parseNormalizedSupplierPriceRows } from '../../apps/engine/supplier-price-shadow/src/streaming-csv.mjs';

const date = '2026-11-12';
const org = '10000000-0000-4000-8000-000000000001';
const supplier = '10000000-0000-4000-8000-000000000002';
const brand = '10000000-0000-4000-8000-000000000003';
const release = '10000000-0000-4000-8000-000000000004';
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
        rejected_rows bigint, conflict_rows bigint, warning_rows bigint, error_code text
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
    const original = process.env.WAHLER_QUANTITY_SOURCE ? await readFile(process.env.WAHLER_QUANTITY_SOURCE) : source;
    const file = await prepareSupplierQuantityRelease(original, date);
    const base = [];
    for await (const row of parseNormalizedSupplierPriceRows(Readable.from([file.baseCsv]), {commercialFields:true,sourceDate:date})) base.push(row);
    await db.query(`insert into supplier_price_releases values ($1,$2,$3,$4,$5,true,'replace','validated',$6,$6,0,0,0,null)`,
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
    await db.query("insert into supplier_manual_price_internal.entries values ($1,$2,$3,true,$4,'411471.103D')",[org,supplier,brand,date]);
    assert.equal(Number((await quote(17)).buy_price),30.58);
    await db.exec('delete from supplier_manual_price_internal.entries');
    await db.query('update supplier_current_price_pointers set release_id=$1',[other]);
    assert.equal(Number((await quote(17)).buy_price),30.58);
    assert.equal((await db.query("select has_function_privilege('authenticated','public.cloud_current_supplier_quantity_options_service(uuid,text,text,integer)','EXECUTE') allowed")).rows[0].allowed,false);
  } finally { await db.close(); }
});
