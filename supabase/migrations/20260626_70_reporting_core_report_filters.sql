-- Parameterized reporting-core report APIs.
-- These keep the existing views intact while allowing date and party filters
-- to be applied before aggregation.

create or replace function public.reporting_supplier_balance_by_brand_product(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  supplier_id uuid,
  party_id uuid,
  supplier_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  normalized_code text,
  currency text,
  debit_amount numeric,
  credit_amount numeric,
  balance_amount numeric,
  latest_due_date date,
  line_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    atx.organization_id,
    atx.supplier_id,
    atx.party_id,
    atx.party_name as supplier_name,
    atx.brand_id,
    atx.brand,
    atx.product_id,
    atx.product_code,
    atx.normalized_code,
    atx.currency,
    sum(atx.debit_amount) as debit_amount,
    sum(atx.credit_amount) as credit_amount,
    sum(atx.credit_amount - atx.debit_amount) as balance_amount,
    max(atx.due_date) as latest_due_date,
    count(*) as line_count
  from public.account_transactions atx
  where atx.organization_id = p_organization_id
    and atx.direction = 'payable'
    and (p_start_date is null or atx.transaction_date >= p_start_date)
    and (p_end_date is null or atx.transaction_date <= p_end_date)
    and (p_brand_id is null or atx.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or atx.product_code ilike '%' || trim(p_product_query) || '%'
      or atx.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
      or atx.description ilike '%' || trim(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or atx.party_name ilike '%' || trim(p_party_query) || '%'
    )
  group by
    atx.organization_id,
    atx.supplier_id,
    atx.party_id,
    atx.party_name,
    atx.brand_id,
    atx.brand,
    atx.product_id,
    atx.product_code,
    atx.normalized_code,
    atx.currency
  order by abs(sum(atx.credit_amount - atx.debit_amount)) desc, atx.party_name, atx.brand, atx.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_customer_balance_by_brand_product(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  customer_id uuid,
  party_id uuid,
  customer_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  normalized_code text,
  currency text,
  debit_amount numeric,
  credit_amount numeric,
  balance_amount numeric,
  latest_due_date date,
  line_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    atx.organization_id,
    atx.customer_id,
    atx.party_id,
    atx.party_name as customer_name,
    atx.brand_id,
    atx.brand,
    atx.product_id,
    atx.product_code,
    atx.normalized_code,
    atx.currency,
    sum(atx.debit_amount) as debit_amount,
    sum(atx.credit_amount) as credit_amount,
    sum(atx.debit_amount - atx.credit_amount) as balance_amount,
    max(atx.due_date) as latest_due_date,
    count(*) as line_count
  from public.account_transactions atx
  where atx.organization_id = p_organization_id
    and atx.direction = 'receivable'
    and (p_start_date is null or atx.transaction_date >= p_start_date)
    and (p_end_date is null or atx.transaction_date <= p_end_date)
    and (p_brand_id is null or atx.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or atx.product_code ilike '%' || trim(p_product_query) || '%'
      or atx.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
      or atx.description ilike '%' || trim(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or atx.party_name ilike '%' || trim(p_party_query) || '%'
    )
  group by
    atx.organization_id,
    atx.customer_id,
    atx.party_id,
    atx.party_name,
    atx.brand_id,
    atx.brand,
    atx.product_id,
    atx.product_code,
    atx.normalized_code,
    atx.currency
  order by abs(sum(atx.debit_amount - atx.credit_amount)) desc, atx.party_name, atx.brand, atx.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_open_purchase_orders_by_brand_product(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  supplier_id uuid,
  party_id uuid,
  supplier_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  normalized_code text,
  sales_order_id text,
  sales_order_no text,
  purchase_order_id text,
  purchase_order_no text,
  currency text,
  status text,
  transaction_date date,
  ordered_qty numeric,
  received_qty numeric,
  open_qty numeric,
  unit_price numeric,
  open_amount numeric
)
language sql
stable
set search_path = public
as $$
  with base as (
    select clf.*
    from public.commercial_line_facts clf
    where clf.organization_id = p_organization_id
      and clf.direction = 'purchase'
      and clf.document_type in ('purchase_order', 'purchase_receive')
      and (p_start_date is null or clf.transaction_date >= p_start_date)
      and (p_end_date is null or clf.transaction_date <= p_end_date)
      and (p_brand_id is null or clf.brand_id = p_brand_id)
      and (
        nullif(trim(coalesce(p_product_query, '')), '') is null
        or clf.product_code ilike '%' || trim(p_product_query) || '%'
        or clf.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
        or clf.description ilike '%' || trim(p_product_query) || '%'
      )
      and (
        nullif(trim(coalesce(p_party_query, '')), '') is null
        or clf.party_name ilike '%' || trim(p_party_query) || '%'
      )
  ),
  ordered as (
    select
      base.organization_id,
      base.supplier_id,
      base.party_id,
      base.party_name as supplier_name,
      base.brand_id,
      base.brand,
      base.product_id,
      base.product_code,
      base.normalized_code,
      base.sales_order_id,
      base.sales_order_no,
      base.purchase_order_id,
      base.purchase_order_no,
      base.currency,
      base.status,
      sum(base.quantity) as ordered_qty,
      sum(base.total_amount) as ordered_amount,
      max(base.transaction_date) as transaction_date
    from base
    where base.document_type = 'purchase_order'
      and lower(coalesce(base.status, '')) not in ('void', 'closed')
    group by
      base.organization_id,
      base.supplier_id,
      base.party_id,
      base.party_name,
      base.brand_id,
      base.brand,
      base.product_id,
      base.product_code,
      base.normalized_code,
      base.sales_order_id,
      base.sales_order_no,
      base.purchase_order_id,
      base.purchase_order_no,
      base.currency,
      base.status
  ),
  received as (
    select
      base.organization_id,
      base.brand_id,
      base.normalized_code,
      base.purchase_order_id,
      sum(base.quantity) as received_qty
    from base
    where base.document_type = 'purchase_receive'
      and lower(coalesce(base.status, '')) <> 'void'
    group by
      base.organization_id,
      base.brand_id,
      base.normalized_code,
      base.purchase_order_id
  )
  select
    ordered.organization_id,
    ordered.supplier_id,
    ordered.party_id,
    ordered.supplier_name,
    ordered.brand_id,
    ordered.brand,
    ordered.product_id,
    ordered.product_code,
    ordered.normalized_code,
    ordered.sales_order_id,
    ordered.sales_order_no,
    ordered.purchase_order_id,
    ordered.purchase_order_no,
    ordered.currency,
    ordered.status,
    ordered.transaction_date,
    ordered.ordered_qty,
    coalesce(received.received_qty, 0) as received_qty,
    greatest(ordered.ordered_qty - coalesce(received.received_qty, 0), 0) as open_qty,
    round(case when ordered.ordered_qty = 0 then 0 else ordered.ordered_amount / nullif(ordered.ordered_qty, 0) end, 4) as unit_price,
    round(greatest(ordered.ordered_qty - coalesce(received.received_qty, 0), 0) * case when ordered.ordered_qty = 0 then 0 else ordered.ordered_amount / nullif(ordered.ordered_qty, 0) end, 2) as open_amount
  from ordered
  left join received
    on received.organization_id = ordered.organization_id
   and received.purchase_order_id = ordered.purchase_order_id
   and received.normalized_code = ordered.normalized_code
   and received.brand_id is not distinct from ordered.brand_id
  where greatest(ordered.ordered_qty - coalesce(received.received_qty, 0), 0) > 0
  order by ordered.transaction_date desc, ordered.supplier_name, ordered.brand, ordered.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_open_sales_orders_by_brand_product(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  customer_id uuid,
  party_id uuid,
  customer_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  normalized_code text,
  sales_order_id text,
  sales_order_no text,
  currency text,
  status text,
  transaction_date date,
  ordered_qty numeric,
  invoiced_qty numeric,
  open_qty numeric,
  unit_price numeric,
  open_amount numeric
)
language sql
stable
set search_path = public
as $$
  with base as (
    select clf.*
    from public.commercial_line_facts clf
    where clf.organization_id = p_organization_id
      and clf.direction = 'sales'
      and clf.document_type in ('sales_order', 'invoice')
      and (p_start_date is null or clf.transaction_date >= p_start_date)
      and (p_end_date is null or clf.transaction_date <= p_end_date)
      and (p_brand_id is null or clf.brand_id = p_brand_id)
      and (
        nullif(trim(coalesce(p_product_query, '')), '') is null
        or clf.product_code ilike '%' || trim(p_product_query) || '%'
        or clf.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
        or clf.description ilike '%' || trim(p_product_query) || '%'
      )
      and (
        nullif(trim(coalesce(p_party_query, '')), '') is null
        or clf.party_name ilike '%' || trim(p_party_query) || '%'
      )
  ),
  ordered as (
    select
      base.organization_id,
      base.customer_id,
      base.party_id,
      base.party_name as customer_name,
      base.brand_id,
      base.brand,
      base.product_id,
      base.product_code,
      base.normalized_code,
      base.sales_order_id,
      base.sales_order_no,
      base.currency,
      base.status,
      sum(base.quantity) as ordered_qty,
      sum(base.total_amount) as ordered_amount,
      max(base.transaction_date) as transaction_date
    from base
    where base.document_type = 'sales_order'
      and lower(coalesce(base.status, '')) <> 'void'
    group by
      base.organization_id,
      base.customer_id,
      base.party_id,
      base.party_name,
      base.brand_id,
      base.brand,
      base.product_id,
      base.product_code,
      base.normalized_code,
      base.sales_order_id,
      base.sales_order_no,
      base.currency,
      base.status
  ),
  invoiced as (
    select
      base.organization_id,
      base.brand_id,
      base.normalized_code,
      base.sales_order_id,
      sum(base.quantity) as invoiced_qty
    from base
    where base.document_type = 'invoice'
      and lower(coalesce(base.status, '')) <> 'void'
    group by
      base.organization_id,
      base.brand_id,
      base.normalized_code,
      base.sales_order_id
  )
  select
    ordered.organization_id,
    ordered.customer_id,
    ordered.party_id,
    ordered.customer_name,
    ordered.brand_id,
    ordered.brand,
    ordered.product_id,
    ordered.product_code,
    ordered.normalized_code,
    ordered.sales_order_id,
    ordered.sales_order_no,
    ordered.currency,
    ordered.status,
    ordered.transaction_date,
    ordered.ordered_qty,
    coalesce(invoiced.invoiced_qty, 0) as invoiced_qty,
    greatest(ordered.ordered_qty - coalesce(invoiced.invoiced_qty, 0), 0) as open_qty,
    round(case when ordered.ordered_qty = 0 then 0 else ordered.ordered_amount / nullif(ordered.ordered_qty, 0) end, 4) as unit_price,
    round(greatest(ordered.ordered_qty - coalesce(invoiced.invoiced_qty, 0), 0) * case when ordered.ordered_qty = 0 then 0 else ordered.ordered_amount / nullif(ordered.ordered_qty, 0) end, 2) as open_amount
  from ordered
  left join invoiced
    on invoiced.organization_id = ordered.organization_id
   and invoiced.sales_order_id = ordered.sales_order_id
   and invoiced.normalized_code = ordered.normalized_code
   and invoiced.brand_id is not distinct from ordered.brand_id
  where greatest(ordered.ordered_qty - coalesce(invoiced.invoiced_qty, 0), 0) > 0
  order by ordered.transaction_date desc, ordered.customer_name, ordered.brand, ordered.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_purchase_price_variance_report(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns setof public.price_variance_checks
language sql
stable
set search_path = public
as $$
  select pvc.*
  from public.price_variance_checks pvc
  where pvc.organization_id = p_organization_id
    and pvc.direction = 'purchase'
    and (p_start_date is null or pvc.transaction_date >= p_start_date)
    and (p_end_date is null or pvc.transaction_date <= p_end_date)
    and (p_brand_id is null or pvc.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or pvc.product_code ilike '%' || trim(p_product_query) || '%'
      or pvc.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or pvc.party_name ilike '%' || trim(p_party_query) || '%'
    )
  order by
    case pvc.severity when 'critical' then 0 when 'warn' then 1 else 2 end,
    abs(coalesce(pvc.variance_amount, 0)) desc,
    pvc.transaction_date desc
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_sales_margin_report(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  customer_id uuid,
  party_id uuid,
  customer_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  normalized_code text,
  currency text,
  quantity numeric,
  revenue_amount numeric,
  cost_amount numeric,
  margin_amount numeric,
  margin_percent numeric,
  line_count bigint
)
language sql
stable
set search_path = public
as $$
  select
    clf.organization_id,
    clf.customer_id,
    clf.party_id,
    clf.party_name as customer_name,
    clf.brand_id,
    clf.brand,
    clf.product_id,
    clf.product_code,
    clf.normalized_code,
    clf.currency,
    sum(clf.quantity) as quantity,
    sum(clf.total_amount) as revenue_amount,
    sum(clf.cost_amount) as cost_amount,
    sum(clf.margin_amount) as margin_amount,
    case when sum(clf.total_amount) = 0 then 0 else round((sum(clf.margin_amount) / nullif(sum(clf.total_amount), 0)) * 100, 4) end as margin_percent,
    count(*) as line_count
  from public.commercial_line_facts clf
  where clf.organization_id = p_organization_id
    and clf.direction = 'sales'
    and clf.document_type in ('invoice', 'sales_order')
    and (p_start_date is null or clf.transaction_date >= p_start_date)
    and (p_end_date is null or clf.transaction_date <= p_end_date)
    and (p_brand_id is null or clf.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or clf.product_code ilike '%' || trim(p_product_query) || '%'
      or clf.normalized_code ilike '%' || public.normalize_part_code(p_product_query) || '%'
      or clf.description ilike '%' || trim(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or clf.party_name ilike '%' || trim(p_party_query) || '%'
    )
  group by
    clf.organization_id,
    clf.customer_id,
    clf.party_id,
    clf.party_name,
    clf.brand_id,
    clf.brand,
    clf.product_id,
    clf.product_code,
    clf.normalized_code,
    clf.currency
  order by sum(clf.margin_amount) desc, clf.party_name, clf.brand, clf.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

create or replace function public.reporting_inventory_by_brand_product_warehouse(
  p_organization_id uuid,
  p_start_date date default null,
  p_end_date date default null,
  p_brand_id uuid default null,
  p_product_query text default null,
  p_party_query text default null,
  p_limit integer default 500
)
returns table (
  organization_id uuid,
  warehouse_id uuid,
  warehouse_code text,
  warehouse_name text,
  brand_id uuid,
  brand text,
  product_id uuid,
  product_code text,
  description text,
  origin text,
  qty_in numeric,
  qty_out numeric,
  on_hand_qty numeric,
  total_cost numeric,
  last_moved_at timestamptz
)
language sql
stable
set search_path = public
as $$
  with enriched as (
    select
      im.organization_id,
      im.warehouse_id,
      im.warehouse_code,
      im.warehouse_name,
      brand_match.brand_id,
      coalesce(brand_match.brand, im.brand, '') as brand,
      product_match.product_id,
      coalesce(product_match.product_code, im.product_code, '') as product_code,
      coalesce(product_match.description, '') as description,
      coalesce(product_match.origin, '') as origin,
      im.qty_in,
      im.qty_out,
      im.total_cost,
      im.moved_at,
      im.related_party
    from public.inventory_movements im
    left join lateral (
      select br.id as brand_id, br.name as brand
      from public.brands br
      where br.organization_id = im.organization_id
        and (
          br.id = im.brand_id
          or (
            im.brand_id is null
            and br.normalized_name = public.normalize_part_code(coalesce(im.brand, ''))
          )
        )
      order by br.name
      limit 1
    ) brand_match on true
    left join lateral (
      select cp.id as product_id, cp.product_code, cp.description, cp.origin
      from public.catalog_products cp
      where cp.organization_id = im.organization_id
        and (
          cp.id = im.product_id
          or (
            im.product_id is null
            and cp.brand_id is not distinct from brand_match.brand_id
            and cp.normalized_code = public.normalize_part_code(coalesce(im.product_code, ''))
          )
        )
      order by cp.product_code
      limit 1
    ) product_match on true
    where im.organization_id = p_organization_id
      and (p_start_date is null or im.moved_at::date >= p_start_date)
      and (p_end_date is null or im.moved_at::date <= p_end_date)
  )
  select
    enriched.organization_id,
    enriched.warehouse_id,
    enriched.warehouse_code,
    enriched.warehouse_name,
    enriched.brand_id,
    enriched.brand,
    enriched.product_id,
    enriched.product_code,
    enriched.description,
    enriched.origin,
    sum(enriched.qty_in) as qty_in,
    sum(enriched.qty_out) as qty_out,
    sum(enriched.qty_in - enriched.qty_out) as on_hand_qty,
    sum(enriched.total_cost) as total_cost,
    max(enriched.moved_at) as last_moved_at
  from enriched
  where (p_brand_id is null or enriched.brand_id = p_brand_id)
    and (
      nullif(trim(coalesce(p_product_query, '')), '') is null
      or enriched.product_code ilike '%' || trim(p_product_query) || '%'
      or enriched.description ilike '%' || trim(p_product_query) || '%'
    )
    and (
      nullif(trim(coalesce(p_party_query, '')), '') is null
      or enriched.related_party ilike '%' || trim(p_party_query) || '%'
    )
  group by
    enriched.organization_id,
    enriched.warehouse_id,
    enriched.warehouse_code,
    enriched.warehouse_name,
    enriched.brand_id,
    enriched.brand,
    enriched.product_id,
    enriched.product_code,
    enriched.description,
    enriched.origin
  order by enriched.warehouse_code, enriched.brand, enriched.product_code
  limit greatest(1, least(coalesce(p_limit, 500), 5000));
$$;

grant execute on function public.reporting_supplier_balance_by_brand_product(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_customer_balance_by_brand_product(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_open_purchase_orders_by_brand_product(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_open_sales_orders_by_brand_product(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_purchase_price_variance_report(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_sales_margin_report(uuid, date, date, uuid, text, text, integer) to authenticated;
grant execute on function public.reporting_inventory_by_brand_product_warehouse(uuid, date, date, uuid, text, text, integer) to authenticated;

grant execute on function public.reporting_supplier_balance_by_brand_product(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_customer_balance_by_brand_product(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_open_purchase_orders_by_brand_product(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_open_sales_orders_by_brand_product(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_purchase_price_variance_report(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_sales_margin_report(uuid, date, date, uuid, text, text, integer) to service_role;
grant execute on function public.reporting_inventory_by_brand_product_warehouse(uuid, date, date, uuid, text, text, integer) to service_role;
