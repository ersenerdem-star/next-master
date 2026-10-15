-- Three bounded read capabilities. No table grants, backfill or global refresh.
-- Apply first ONLY to full V3 staging. Production is an independent gate.
set local lock_timeout='5s';
create schema financial_report_private;
revoke all on schema financial_report_private from public,anon,authenticated,service_role;
grant usage on schema financial_report_private to authenticated;

create function financial_report_private.permission(p public.profiles, permission_key text)
returns boolean language sql stable security invoker set search_path='' as $$
  select case when p.role in ('admin','superadmin') then true
    when (p.permissions ? $2 and p.permissions->$2 is distinct from 'true'::jsonb)
      or exists(select 1 from public.profile_permissions x where x.profile_id=p.id and x.organization_id=p.organization_id and x.permission_key=$2 and not x.allowed) then false
    when p.permissions ? $2 then true
    when exists(select 1 from public.profile_permissions x where x.profile_id=p.id and x.organization_id=p.organization_id and x.permission_key=$2 and x.allowed) then true
    else case when permission_key='reports.view' then p.department in ('sales','purchasing','accounting','management')
      when permission_key='customers.view' then p.department in ('sales','accounting','management')
      when permission_key='finance.view' then p.department in ('accounting','management') else false end end;
$$;
revoke all on function financial_report_private.permission(public.profiles,text) from public,anon,authenticated,service_role;

create function financial_report_private.read_report(kind text,p_organization_id uuid,p_start_date date,p_end_date date,
  p_brand_id uuid,p_product_query text,p_party_query text,p_limit integer)
returns jsonb language plpgsql stable security definer set search_path='' as $$
declare p public.profiles; result jsonb; admin boolean; scoped boolean; sid uuid; issued numeric;
begin
  if auth.uid() is null then raise exception 'Report access requires an active staff session.' using errcode='42501'; end if;
  select * into p from public.profiles x where x.id=auth.uid() and x.is_active;
  if not found or p.organization_id is distinct from p_organization_id then
    raise exception 'Report organization or active profile is not authorized.' using errcode='42501'; end if;
  sid:=nullif(auth.jwt()->>'session_id','')::uuid;
  issued:=nullif(auth.jwt()->>'iat','')::numeric;
  if sid is null or issued is null or not exists(select 1 from auth.sessions s where s.id=sid and s.user_id=p.id)
    or (p.session_revoked_at is not null and issued<=extract(epoch from p.session_revoked_at)) then
    raise exception 'Your session has expired. Sign in again.' using errcode='42501'; end if;
  admin:=p.role in ('admin','superadmin');
  if kind not in ('customer','supplier','margin') or kind is null
    or (not admin and p.department not in ('sales','purchasing','accounting','management'))
    or not financial_report_private.permission(p,'reports.view') then
    raise exception 'This report is not enabled for your user.' using errcode='42501'; end if;
  if kind in ('supplier','margin') and not financial_report_private.permission(p,'finance.view') then
    raise exception 'Financial report permission is required; purchase costs are restricted.' using errcode='42501'; end if;
  if kind in ('customer','margin') and not financial_report_private.permission(p,'customers.view') then
    raise exception 'Customer report permission is required.' using errcode='42501'; end if;
  if p_limit is null or p_limit<1 or p_limit>2500 or (p_start_date is not null and p_end_date is not null and p_start_date>p_end_date)
    or length(coalesce(p_product_query,''))>150 or length(coalesce(p_party_query,''))>150 then
    raise exception 'Invalid report filters or row limit.' using errcode='22023'; end if;
  -- Payment/fee rows are not allocated arbitrarily to brands or products.
  if kind in ('customer','supplier') and (p_brand_id is not null or nullif(trim(p_product_query),'') is not null) then
    raise exception 'Balance reports support account and date filters only; payments are not allocated to brands or products.' using errcode='22023'; end if;
  scoped:=not admin and p.customer_scope_mode='assigned';
  if kind='margin' then
    select coalesce(jsonb_agg(to_jsonb(r)),'[]') into result from (
      select f.organization_id,f.customer_id,f.party_id,f.party_name as customer_name,f.brand_id,f.brand,
        f.product_id,f.product_code,f.normalized_code,f.currency,sum(f.quantity) as quantity,
        sum(f.total_amount) as revenue_amount,sum(f.cost_amount) as cost_amount,sum(f.margin_amount) as margin_amount,
        case when sum(f.total_amount)=0 then 0 else round(sum(f.margin_amount)/sum(f.total_amount)*100,4) end as margin_percent,count(*) as line_count
      from public.commercial_line_facts f
      where f.organization_id=p.organization_id and f.direction='sales' and f.document_type='invoice' and f.status in ('confirmed','open','paid')
        and (p_start_date is null or f.transaction_date>=p_start_date) and (p_end_date is null or f.transaction_date<=p_end_date)
        and (p_brand_id is null or f.brand_id=p_brand_id)
        and (nullif(trim(p_product_query),'') is null or f.product_code ilike '%'||trim(p_product_query)||'%' or f.description ilike '%'||trim(p_product_query)||'%')
        and (nullif(trim(p_party_query),'') is null or f.party_name ilike '%'||trim(p_party_query)||'%')
        and (not scoped or exists(select 1 from public.customers c where c.id=f.customer_id and c.organization_id=p.organization_id
          and (c.owner_profile_id=p.id or exists(select 1 from public.profile_customer_access a where a.profile_id=p.id and a.organization_id=p.organization_id and a.customer_id=c.id))))
      group by f.organization_id,f.customer_id,f.party_id,f.party_name,f.brand_id,f.brand,f.product_id,f.product_code,f.normalized_code,f.currency
      order by f.party_name,f.brand,f.product_code,f.currency,f.party_id,f.brand_id,f.product_id limit p_limit+1
    ) r;
  else
    select coalesce(jsonb_agg(to_jsonb(r)),'[]') into result from (
      select a.organization_id,a.customer_id,a.supplier_id,a.vendor_id,a.party_id,
        a.party_name as customer_name,a.party_name as supplier_name,a.brand_id,
        case when a.line_role='payment' then 'Unallocated payments' else a.brand end as brand,
        a.product_id,a.product_code,a.normalized_code,a.currency,
        sum(a.debit_amount) as debit_amount,sum(a.credit_amount) as credit_amount,
        sum(case when kind='customer' then a.debit_amount-a.credit_amount else a.credit_amount-a.debit_amount end) as balance_amount,
        max(a.due_date) as latest_due_date,count(*) as line_count
      from public.account_transactions a
      where a.organization_id=p.organization_id and a.direction=case when kind='customer' then 'receivable' else 'payable' end
        and a.source_type in (case when kind='customer' then 'invoice' else 'bill' end,case when kind='customer' then 'payment_received' else 'payment_made' end)
        and a.status in ('confirmed','open','paid')
        and (p_start_date is null or a.transaction_date>=p_start_date) and (p_end_date is null or a.transaction_date<=p_end_date)
        and (nullif(trim(p_party_query),'') is null or a.party_name ilike '%'||trim(p_party_query)||'%')
        and (kind='supplier' or not scoped or exists(select 1 from public.customers c where c.id=a.customer_id and c.organization_id=p.organization_id
          and (c.owner_profile_id=p.id or exists(select 1 from public.profile_customer_access x where x.profile_id=p.id and x.organization_id=p.organization_id and x.customer_id=c.id))))
      group by a.organization_id,a.customer_id,a.supplier_id,a.vendor_id,a.party_id,a.party_name,a.brand_id,
        case when a.line_role='payment' then 'Unallocated payments' else a.brand end,a.product_id,a.product_code,a.normalized_code,a.currency
      order by a.party_name,case when a.line_role='payment' then 'Unallocated payments' else a.brand end,a.product_code,a.currency,a.party_id,a.brand_id,a.product_id limit p_limit+1
    ) r;
  end if;
  if jsonb_array_length(result)>p_limit then
    raise exception 'Report exceeds the selected row limit. Narrow the filters or increase the limit; incomplete totals are not shown.' using errcode='22023'; end if;
  return result;
end $$;
revoke all on function financial_report_private.read_report(text,uuid,date,date,uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function financial_report_private.read_report(text,uuid,date,date,uuid,text,text,integer) to authenticated;

create function public.reporting_customer_balance_by_brand_product(p_organization_id uuid,p_start_date date default null,p_end_date date default null,p_brand_id uuid default null,p_product_query text default null,p_party_query text default null,p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path='' as $$ select financial_report_private.read_report('customer',$1,$2,$3,$4,$5,$6,$7) $$;
create function public.reporting_supplier_balance_by_brand_product(p_organization_id uuid,p_start_date date default null,p_end_date date default null,p_brand_id uuid default null,p_product_query text default null,p_party_query text default null,p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path='' as $$ select financial_report_private.read_report('supplier',$1,$2,$3,$4,$5,$6,$7) $$;
create function public.reporting_sales_margin_report(p_organization_id uuid,p_start_date date default null,p_end_date date default null,p_brand_id uuid default null,p_product_query text default null,p_party_query text default null,p_limit integer default 500)
returns jsonb language sql stable security invoker set search_path='' as $$ select financial_report_private.read_report('margin',$1,$2,$3,$4,$5,$6,$7) $$;
revoke all on function public.reporting_customer_balance_by_brand_product(uuid,date,date,uuid,text,text,integer),public.reporting_supplier_balance_by_brand_product(uuid,date,date,uuid,text,text,integer),public.reporting_sales_margin_report(uuid,date,date,uuid,text,text,integer) from public,anon,authenticated,service_role;
grant execute on function public.reporting_customer_balance_by_brand_product(uuid,date,date,uuid,text,text,integer),public.reporting_supplier_balance_by_brand_product(uuid,date,date,uuid,text,text,integer),public.reporting_sales_margin_report(uuid,date,date,uuid,text,text,integer) to authenticated;
