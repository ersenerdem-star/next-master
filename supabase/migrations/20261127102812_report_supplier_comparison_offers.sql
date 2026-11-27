-- Live supplier offers for a single row of the supplier comparison report.
-- Read the same published, legacy and manual sources as the report without
-- the quote reader's 25-supplier ceiling.  No pricing data is modified.
create or replace function public.report_supplier_comparison_offers(
  input_brand_id uuid, input_product_code text
)
returns table (
  supplier_id uuid, supplier_name text, buy_price numeric, price_date date,
  moq integer, order_multiple integer, stock_qty integer, valid_to date, notes text
)
language plpgsql stable security definer set search_path = '' as $function$
declare
  v_org_id uuid := public.current_profile_org_id();
  v_exact_code text := public.normalize_catalog_product_code(input_product_code);
begin
  if auth.uid() is null or v_org_id is null
     or not coalesce(public.is_superadmin() or public.profile_has_permission('reports.view'), false) then
    raise exception 'SUPPLIER_COMPARISON_ACCESS_DENIED' using errcode='42501';
  end if;
  if input_brand_id is null or nullif(v_exact_code,'') is null
     or length(input_product_code)>100 or v_exact_code !~ '[A-Z0-9]' then
    raise exception 'SUPPLIER_COMPARISON_INPUT_INVALID' using errcode='22023';
  end if;
  if not exists (select 1 from public.brands b where b.organization_id=v_org_id and b.id=input_brand_id) then
    raise exception 'SUPPLIER_COMPARISON_BRAND_INVALID' using errcode='22023';
  end if;
  return query
  with pointer_scope as materialized (
    select p.supplier_id,p.release_id,p.publication_id
    from public.supplier_current_price_pointers p
    where p.organization_id=v_org_id and p.brand_id=input_brand_id
  ), published as (
    select r.product_code,r.buy_price,r.valid_from,r.notes,r.moq,r.order_multiple,r.stock_qty,r.valid_to,
      p.supplier_id,s.name supplier_name,r.id::text source_id
    from pointer_scope p
    join public.supplier_price_publications pub
      on pub.id=p.publication_id and pub.release_id=p.release_id
      and pub.organization_id=v_org_id and pub.supplier_id=p.supplier_id and pub.brand_id=input_brand_id
      and pub.status='published' and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
    join public.supplier_price_release_rows r on r.release_id=p.release_id and r.normalized_code=v_exact_code
    join public.suppliers s on s.organization_id=v_org_id and s.id=p.supplier_id
    where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
      and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
      and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
      and not exists (select 1 from supplier_manual_price_internal.entries m
        where m.organization_id=v_org_id and m.brand_id=input_brand_id and m.supplier_id=p.supplier_id
          and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
  ), legacy as (
    select sp.product_code,sp.buy_price,sp.valid_from,sp.notes,sp.moq,sp.order_multiple,sp.stock_qty,sp.valid_to,
      sp.supplier_id,s.name supplier_name,sp.id::text source_id
    from public.supplier_prices sp
    join public.suppliers s on s.organization_id=v_org_id and s.id=sp.supplier_id and s.price_usage_enabled
    where sp.organization_id=v_org_id and sp.brand_id=input_brand_id and sp.is_active
      and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
      and (sp.valid_to is null or sp.valid_to>=current_date)
      and sp.normalized_code=public.normalize_part_code(input_product_code)
      and public.normalize_catalog_product_code(sp.product_code)=v_exact_code
      and not exists (select 1 from pointer_scope p where p.supplier_id=sp.supplier_id)
      and not exists (select 1 from supplier_manual_price_internal.entries m
        where m.organization_id=v_org_id and m.brand_id=input_brand_id and m.supplier_id=sp.supplier_id
          and m.exact_code=v_exact_code and m.active and m.valid_from<=current_date)
  ), manual as (
    select m.product_code,m.buy_price,m.valid_from,m.notes,m.moq,m.order_multiple,
      null::integer stock_qty,null::date valid_to,m.supplier_id,s.name supplier_name,m.id::text source_id
    from supplier_manual_price_internal.entries m
    join public.suppliers s on s.organization_id=v_org_id and s.id=m.supplier_id and s.price_usage_enabled
    where m.organization_id=v_org_id and m.brand_id=input_brand_id and m.exact_code=v_exact_code
      and m.active and m.valid_from<=current_date
  ), candidates as (
    select * from published union all select * from legacy union all select * from manual
  ), per_supplier as (
    select c.*,row_number() over (partition by c.supplier_id order by c.valid_from desc,c.source_id desc) as rn
    from candidates c
  )
  select p.supplier_id,p.supplier_name,p.buy_price,p.valid_from,p.moq,p.order_multiple,p.stock_qty,p.valid_to,p.notes
  from per_supplier p where p.rn=1
  order by p.buy_price,p.valid_from desc,p.supplier_id;
end;
$function$;
revoke all on function public.report_supplier_comparison_offers(uuid,text) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_comparison_offers(uuid,text) to authenticated,service_role;
notify pgrst, 'reload schema';
