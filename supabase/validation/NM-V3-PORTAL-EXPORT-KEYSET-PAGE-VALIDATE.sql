-- Read-only V3 staging regression check for the Clevite 999,998-row snapshot.
-- The sealed snapshot predates the optimized RPC and supplies independent
-- expected rows at the beginning, middle and final quarter of the export.
-- Re-run after applying 20261013130003; all four counts should be
-- 15000, 15000, 0, 0 respectively, and both execute flags must be false.

with cases(start_ordinal) as (
  values (1::bigint), (500001::bigint), (750001::bigint)
),
expected as materialized (
  select c.start_ordinal, r.ordinal,
    r.source_key as normalized_code,
    r.payload->>'code' as product_code,
    (r.payload->>'price')::numeric as sales_price,
    r.payload->>'priceDate' as price_date
  from cases c
  join export_snapshot_private.rows r
    on r.snapshot_id = 'dfeb4622-aae0-4387-9076-f108300d2f8a'::uuid
   and r.ordinal between c.start_ordinal and c.start_ordinal + 4999
),
actual as materialized (
  select c.start_ordinal,
    c.start_ordinal - 1
      + row_number() over (partition by c.start_ordinal order by a.normalized_code) as ordinal,
    a.normalized_code, a.product_code, a.sales_price, a.price_date::text as price_date
  from cases c
  cross join lateral public.cloud_portal_customer_price_list_page_fast(
    'b0000000-0000-4000-8000-000000000001'::uuid,
    '0e9fa984-fbbf-45d2-9a60-e7aa633dc928'::uuid,
    'A', 10, null,
    (
      select source_key
      from export_snapshot_private.rows
      where snapshot_id = 'dfeb4622-aae0-4387-9076-f108300d2f8a'::uuid
        and ordinal = c.start_ordinal - 1
    ),
    5000
  ) a
)
select
  (select count(*) from expected) as expected_count,
  (select count(*) from actual) as actual_count,
  (select count(*) from (select * from expected except all select * from actual) missing) as missing,
  (select count(*) from (select * from actual except all select * from expected) extra) as extra;

select
  has_function_privilege(
    'anon',
    'public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)',
    'EXECUTE'
  ) as anon_can_execute,
  has_function_privilege(
    'authenticated',
    'public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)',
    'EXECUTE'
  ) as authenticated_can_execute,
  has_function_privilege(
    'service_role',
    'public.cloud_portal_customer_price_list_page_fast(uuid,uuid,text,numeric,text,text,integer)',
    'EXECUTE'
  ) as service_role_can_execute;
