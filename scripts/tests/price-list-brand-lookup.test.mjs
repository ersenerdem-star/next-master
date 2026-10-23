import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { PGlite } from '@electric-sql/pglite';

const migration = readFileSync(new URL('../../supabase/migrations/20261023140230_price_list_brand_lookup_bounded.sql', import.meta.url), 'utf8');
const previous = readFileSync(new URL('../../supabase/migrations/20261014193456_supplier_commercial_fields_v2_readers.sql', import.meta.url), 'utf8');
const oldFunction = previous.slice(previous.indexOf('create or replace function public.cloud_admin_price_list_brands(')).split('$function$;')[0] + '$function$;';
const org = '00000000-0000-4000-8000-000000000001';

test('bounded brand lookup preserves eligibility, tenant scope, fallback and service-only access', async () => {
  const db = new PGlite();
  try {
    await db.exec(readFileSync(new URL('./catalog-export-source-pg.setup.sql', import.meta.url), 'utf8'));
    await db.exec(`alter table supplier_prices add valid_to date;
      alter table supplier_price_release_rows add valid_to date;
      create index on supplier_current_price_pointers(organization_id,brand_id);
      create index on supplier_prices(organization_id,brand_id) where is_active;
      create index on supplier_price_release_rows(release_id) where row_status='accepted' and buy_price>0 and currency='EUR';`);
    // All release/legacy combinations use the real previous production rules as
    // the oracle. A pointer must suppress legacy rows only for its own supplier.
    await db.exec(`insert into brands select md5(i::text)::uuid,'${org}', 'Brand '||i from generate_series(1,18)i;
      insert into brands values(md5('foreign')::uuid,md5('other-org')::uuid,'Other tenant');
      insert into supplier_current_price_pointers
        select '${org}',md5(i::text)::uuid,md5('supplier')::uuid,md5('release'||i)::uuid,md5('pub'||i)::uuid from generate_series(1,12)i;
      insert into supplier_price_publications(id,organization_id,brand_id,supplier_id,release_id,status)
        select md5('pub'||i)::uuid,'${org}',md5(i::text)::uuid,md5('supplier')::uuid,md5('release'||i)::uuid,
        case when i=2 then 'revoked' else 'published' end from generate_series(1,12)i;
      insert into supplier_price_release_rows(id,release_id,product_code,normalized_code,buy_price,currency,valid_from,valid_to,row_status)
        select i,md5('release'||i)::uuid,case when i=9 then '---' else 'SKU'||i end,
          case when i=8 then 'WRONG' when i=9 then '---' else 'SKU'||i end,
          case when i=3 then 0 else 10 end,case when i=4 then 'USD' else 'EUR' end,
          current_date+case when i=5 then 1 else 0 end,
          case when i=6 then current_date-1 when i=10 then current_date else null end,
          case when i=7 then 'rejected' else 'accepted' end from generate_series(1,11)i;
      insert into supplier_prices(id,organization_id,brand_id,supplier_id,product_code,buy_price,currency,valid_from,valid_to,is_active)
        select md5('sp'||i)::uuid,'${org}',md5(i::text)::uuid,
          md5(case when i=2 then 'supplier' else 'other-supplier' end)::uuid,
          case when i=17 then '---' else 'LEGACY'||i end,case when i=15 then 0 else 20 end,
          'EUR',current_date,case when i=16 then current_date-1 else null end,i<>18
        from unnest(array[2,12,13,14,15,16,17,18])i;
      insert into supplier_prices(id,organization_id,brand_id,supplier_id,product_code,buy_price,currency,valid_from,is_active)
        values(md5('foreign-price')::uuid,md5('other-org')::uuid,md5('foreign')::uuid,md5('supplier')::uuid,'X',10,'EUR',current_date,true);`);
    await db.exec(oldFunction);
    const before = (await db.query('select * from cloud_admin_price_list_brands($1)', [org])).rows;
    const protectedBefore = (await db.query(`select md5(string_agg(to_jsonb(p)::text,'' order by id)) digest from supplier_price_publications p`)).rows;
    await db.exec(migration);
    const after = (await db.query('select * from cloud_admin_price_list_brands($1)', [org])).rows;
    assert.deepEqual(after, before);
    assert.deepEqual(after.map(x => x.name).sort(), ['Brand 1','Brand 10','Brand 11','Brand 12','Brand 13','Brand 14'].sort());
    assert.deepEqual((await db.query(`select md5(string_agg(to_jsonb(p)::text,'' order by id)) digest from supplier_price_publications p`)).rows, protectedBefore);
    assert.deepEqual((await db.query('select * from cloud_admin_price_list_brands($1)', [crypto.randomUUID()])).rows, []);
    for (const role of ['anon','authenticated']) {
      assert.equal((await db.query("select has_function_privilege($1,'cloud_admin_price_list_brands(uuid)','execute') allowed", [role])).rows[0].allowed, false);
    }
    assert.equal((await db.query("select has_function_privilege('service_role','cloud_admin_price_list_brands(uuid)','execute') allowed")).rows[0].allowed, true);
    // Guard the performance property that caused the incident: an EXISTS under
    // OR must not become a hashed SubPlan over all published release rows.
    const body = migration.split('as $function$')[1].split('$function$')[0].replaceAll('input_organization_id', `'${org}'::uuid`);
    const plan = (await db.query('explain (format json) ' + body)).rows;
    assert.doesNotMatch(JSON.stringify(plan), /hashed SubPlan/i);
  } finally {
    await db.close();
  }
});
