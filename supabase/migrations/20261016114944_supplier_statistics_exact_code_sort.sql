-- Exact brand/SKU counts with an eligibility index: avoid rereading and
-- renormalizing every published row on each dashboard request.
-- Keep authentication, tenant checks, current-pointer fences and date rules.
set lock_timeout = '2s';
set statement_timeout = '90s';
create index if not exists idx_release_rows_dashboard_eligible_code_c
 on public.supplier_price_release_rows(release_id,normalized_code collate "C")
 include(valid_from,valid_to)
 where row_status='accepted' and buy_price>0 and currency='EUR'
  and normalized_code=upper(pg_catalog.regexp_replace(product_code,'[[:space:]]+','','g'))
  and normalized_code<>'';
reset lock_timeout;
reset statement_timeout;

-- Read-only, tenant-scoped dashboard counts. A part is brand + exact supplier SKU,
-- counted once across suppliers. Current pointers suppress every legacy price in
-- that supplier/brand scope, including when a publication is unavailable.
create or replace function public.get_supplier_current_price_statistics()
returns jsonb
language plpgsql stable security definer
set search_path = ''
set statement_timeout = '8s'
as $$
declare
 v_org uuid;
 v_result jsonb;
begin
 if auth.uid() is null then raise exception 'Authentication required' using errcode='42501'; end if;
 v_org:=public.current_profile_org_id();
 if v_org is null or not coalesce(public.profile_has_permission('supplier_prices.manage'),false) then
  raise exception 'Supplier price access required' using errcode='42501';
 end if;
 with pointers as materialized (
  select ptr.* from public.supplier_current_price_pointers ptr where ptr.organization_id=v_org
 ), current_releases as materialized (
  select ptr.release_id,ptr.brand_id from pointers ptr
  join public.supplier_price_publications pub on pub.id=ptr.publication_id and pub.release_id=ptr.release_id
   and pub.organization_id=ptr.organization_id and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
 ), current_parts as (
  select p.brand_id,rr.normalized_code collate "C" as code
  from current_releases p join public.supplier_price_release_rows rr on rr.release_id=p.release_id
  join public.brands b on b.id=p.brand_id and b.organization_id=v_org
  where rr.row_status='accepted' and rr.buy_price>0 and rr.currency='EUR'
   and rr.valid_from<=current_date and (rr.valid_to is null or rr.valid_to>=current_date)
   and rr.normalized_code=upper(pg_catalog.regexp_replace(rr.product_code,'[[:space:]]+','','g'))
   and rr.normalized_code<>''
  union
  select sp.brand_id,upper(pg_catalog.regexp_replace(pg_catalog.btrim(sp.product_code),'[[:space:]]+','','g')) collate "C" as code
  from public.supplier_prices sp join public.brands b on b.id=sp.brand_id and b.organization_id=v_org
  where sp.organization_id=v_org and sp.is_active and sp.buy_price>0 and sp.currency='EUR'
   and sp.valid_from<=current_date and (sp.valid_to is null or sp.valid_to>=current_date)
   and pg_catalog.btrim(sp.product_code)<>''
   and not exists(select 1 from pointers ptr where ptr.supplier_id=sp.supplier_id and ptr.brand_id=sp.brand_id)
 )
 select jsonb_build_object(
  'totalBrands',(select count(*) from public.brands b where b.organization_id=v_org),
  'pricedBrands',count(distinct brand_id),'pricedParts',count(*),'asOf',statement_timestamp()
 ) into v_result from current_parts;
 return v_result;
end $$;
revoke all on function public.get_supplier_current_price_statistics() from public,anon,authenticated,service_role;
grant execute on function public.get_supplier_current_price_statistics() to authenticated;

