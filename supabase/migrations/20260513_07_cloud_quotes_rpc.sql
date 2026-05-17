-- List and load saved cloud quotes.
-- Run this in Supabase SQL Editor.

alter table quotes add column if not exists revision_no integer not null default 0;
alter table quotes add column if not exists parent_quote_id uuid references quotes(id) on delete set null;

create or replace function list_cloud_quotes(
  input_limit integer default 50,
  input_search text default '',
  input_customer text default '',
  input_status text default ''
)
returns table (
  quote_id uuid,
  parent_quote_id uuid,
  quote_no text,
  revision_no integer,
  quote_date date,
  customer_name text,
  currency text,
  status text,
  total_quantity numeric,
  purchase_total numeric,
  sales_total numeric,
  profit_total numeric,
  general_amount numeric,
  created_by_name text,
  created_by_email text,
  updated_at timestamptz
)
language sql
stable
security definer
set search_path = public
as $$
  select
    q.id,
    q.parent_quote_id,
    q.quote_no,
    q.revision_no,
    q.quote_date,
    q.customer_name,
    q.currency,
    q.status,
    coalesce(qt.total_quantity, 0),
    coalesce(qt.purchase_total, 0),
    coalesce(qt.sales_total, 0),
    coalesce(qt.profit_total, 0),
    coalesce(qt.general_amount, 0),
    coalesce(p.full_name, p.email, 'Unknown user'),
    p.email,
    q.updated_at
  from quotes q
  left join quote_totals qt on qt.quote_id = q.id
  left join profiles p on p.id = q.created_by
  where q.organization_id = current_profile_org_id()
    and (
      coalesce(input_search, '') = ''
      or q.quote_no ilike '%' || input_search || '%'
      or q.customer_name ilike '%' || input_search || '%'
      or exists (
        select 1
        from quote_lines ql
        where ql.quote_id = q.id
          and (
            ql.product_code ilike '%' || input_search || '%'
            or coalesce(ql.description, '') ilike '%' || input_search || '%'
          )
      )
    )
    and (
      coalesce(input_customer, '') = ''
      or q.customer_name ilike '%' || input_customer || '%'
    )
    and (
      coalesce(input_status, '') = ''
      or q.status = input_status
    )
  order by q.updated_at desc, q.created_at desc
  limit least(greatest(input_limit, 1), 200);
$$;

create or replace function get_cloud_quote(input_quote_id uuid)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  select jsonb_build_object(
    'quote', to_jsonb(q),
    'lines', coalesce(
      (
        select jsonb_agg(to_jsonb(ql) order by ql.line_no)
        from quote_lines ql
        where ql.quote_id = q.id
      ),
      '[]'::jsonb
    )
  )
  from quotes q
  where q.id = input_quote_id
    and q.organization_id = current_profile_org_id();
$$;

create or replace function update_cloud_quote_status(
  input_quote_id uuid,
  input_status text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can update quote status';
  end if;
  if input_status not in ('draft', 'sent', 'accepted', 'rejected', 'archived') then
    raise exception 'Invalid quote status';
  end if;

  update quotes
  set status = input_status,
      updated_at = now()
  where id = input_quote_id
    and organization_id = org_id;

  return jsonb_build_object('status', 'ok', 'quote_id', input_quote_id, 'quote_status', input_status);
end;
$$;

create or replace function archive_cloud_quote(
  input_quote_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can archive quotes';
  end if;

  update quotes
  set status = 'archived',
      updated_at = now()
  where id = input_quote_id
    and organization_id = org_id;

  return jsonb_build_object('status', 'ok', 'quote_id', input_quote_id, 'quote_status', 'archived');
end;
$$;

create or replace function delete_cloud_quote(
  input_quote_id uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  deleted_count integer := 0;
begin
  org_id := current_profile_org_id();
  if org_id is null or current_profile_role() not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can delete quotes';
  end if;

  delete from quotes
  where id = input_quote_id
    and organization_id = org_id;

  get diagnostics deleted_count = row_count;

  return jsonb_build_object('status', 'ok', 'quote_id', input_quote_id, 'deleted', deleted_count > 0);
end;
$$;

create or replace function copy_cloud_quote(
  input_quote_id uuid,
  input_as_revision boolean default true
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  org_id uuid;
  profile_id uuid;
  source_quote quotes%rowtype;
  root_quote_id uuid;
  next_revision integer := 0;
  new_quote_id uuid;
  new_quote_no text;
begin
  org_id := current_profile_org_id();
  profile_id := auth.uid();
  if org_id is null or current_profile_role() not in ('admin', 'sales') then
    raise exception 'Only active admin or sales users can copy quotes';
  end if;

  select * into source_quote
  from quotes
  where id = input_quote_id
    and organization_id = org_id;

  if source_quote.id is null then
    raise exception 'Quote not found';
  end if;

  root_quote_id := coalesce(source_quote.parent_quote_id, source_quote.id);

  if input_as_revision then
    select coalesce(max(revision_no), 0) + 1 into next_revision
    from quotes
    where organization_id = org_id
      and (id = root_quote_id or parent_quote_id = root_quote_id);
    new_quote_no := regexp_replace(source_quote.quote_no, '-R[0-9]+$', '') || '-R' || next_revision;
  else
    next_revision := 0;
    new_quote_no := source_quote.quote_no || '-COPY-' || to_char(now(), 'HH24MISS');
  end if;

  insert into quotes (
    organization_id,
    created_by,
    parent_quote_id,
    revision_no,
    quote_no,
    quote_date,
    currency,
    customer_name,
    seller_info,
    buyer_info,
    delivery_term,
    payment_terms,
    packing_details,
    notes,
    shipping_cost,
    status
  )
  values (
    org_id,
    profile_id,
    case when input_as_revision then root_quote_id else null end,
    next_revision,
    new_quote_no,
    current_date,
    source_quote.currency,
    source_quote.customer_name,
    source_quote.seller_info,
    source_quote.buyer_info,
    source_quote.delivery_term,
    source_quote.payment_terms,
    source_quote.packing_details,
    source_quote.notes,
    source_quote.shipping_cost,
    'draft'
  )
  returning id into new_quote_id;

  insert into quote_lines (
    quote_id,
    line_no,
    product_code,
    brand_text,
    description,
    hs_code,
    qty,
    weight_kg,
    origin,
    supplier_name,
    price_date,
    buy_unit_price,
    sell_unit_price,
    status
  )
  select
    new_quote_id,
    line_no,
    product_code,
    brand_text,
    description,
    hs_code,
    qty,
    weight_kg,
    origin,
    supplier_name,
    price_date,
    buy_unit_price,
    sell_unit_price,
    status
  from quote_lines
  where quote_id = source_quote.id;

  return jsonb_build_object('status', 'ok', 'quote_id', new_quote_id, 'quote_no', new_quote_no, 'revision_no', next_revision);
end;
$$;

grant execute on function list_cloud_quotes(integer, text, text, text) to authenticated;
grant execute on function get_cloud_quote(uuid) to authenticated;
grant execute on function update_cloud_quote_status(uuid, text) to authenticated;
grant execute on function archive_cloud_quote(uuid) to authenticated;
grant execute on function delete_cloud_quote(uuid) to authenticated;
grant execute on function copy_cloud_quote(uuid, boolean) to authenticated;
