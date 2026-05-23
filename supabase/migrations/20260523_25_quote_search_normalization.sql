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
  with params as (
    select
      nullif(trim(coalesce(input_search, '')), '') as raw_search,
      normalize_part_code(input_search) as search_norm
  )
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
  cross join params s
  where q.organization_id = current_profile_org_id()
    and (
      s.raw_search is null
      or q.quote_no ilike '%' || s.raw_search || '%'
      or (s.search_norm <> '' and normalize_part_code(q.quote_no) like '%' || s.search_norm || '%')
      or q.customer_name ilike '%' || s.raw_search || '%'
      or exists (
        select 1
        from quote_lines ql
        where ql.quote_id = q.id
          and (
            (s.search_norm <> '' and normalize_part_code(ql.product_code) like '%' || s.search_norm || '%')
            or coalesce(ql.description, '') ilike '%' || s.raw_search || '%'
          )
      )
    )
    and (
      coalesce(input_customer, '') = ''
      or q.customer_name ilike '%' || input_customer || '%'
      or normalize_part_code(q.customer_name) like '%' || normalize_part_code(input_customer) || '%'
    )
    and (
      coalesce(input_status, '') = ''
      or q.status = input_status
    )
  order by q.updated_at desc, q.created_at desc
  limit least(greatest(input_limit, 1), 200);
$$;

grant execute on function list_cloud_quotes(integer, text, text, text) to authenticated;
