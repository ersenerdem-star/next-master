-- Bounded, tenant-scoped note indicators for report rows. The existing
-- service-only batch reader supplies exactly the same effective offers as the
-- Excel export. Return only a boolean per requested original part code.
create or replace function public.report_supplier_comparison_note_indicators(
  input_brand_id uuid, input_product_codes text[]
) returns jsonb
language plpgsql stable security definer set search_path = ''
set statement_timeout = '8s' as $function$
declare
  v_org uuid := public.current_profile_org_id();
  v_offers jsonb;
  v_result jsonb;
begin
  if auth.uid() is null or v_org is null
     or not coalesce(public.is_superadmin() or public.profile_has_permission('reports.view'), false) then
    raise exception 'SUPPLIER_COMPARISON_ACCESS_DENIED' using errcode = '42501';
  end if;
  if input_brand_id is null or not exists (
    select 1 from public.brands b where b.id=input_brand_id and b.organization_id=v_org
  ) then
    raise exception 'SUPPLIER_COMPARISON_BRAND_INVALID' using errcode = '22023';
  end if;
  if input_product_codes is null or cardinality(input_product_codes) not between 1 and 50
     or exists (select 1 from pg_catalog.unnest(input_product_codes) c(code)
       where code is null or length(pg_catalog.btrim(code)) not between 1 and 256) then
    raise exception 'SUPPLIER_COMPARISON_INPUT_INVALID' using errcode = '22023';
  end if;
  v_offers := public.cloud_catalog_master_export_offers(v_org,input_brand_id,input_product_codes);
  if pg_catalog.jsonb_typeof(v_offers) is distinct from 'array' then
    raise exception 'SUPPLIER_COMPARISON_OFFERS_INVALID';
  end if;
  select coalesce(pg_catalog.jsonb_object_agg(r.code,coalesce(n.has_notes,false)), '{}'::jsonb)
    into v_result
  from (select distinct x.code from pg_catalog.unnest(input_product_codes) x(code)) r
  left join (
    select o.product_code, pg_catalog.bool_or(nullif(pg_catalog.btrim(o.notes),'') is not null) has_notes
    from pg_catalog.jsonb_to_recordset(v_offers) as o(product_code text, notes text)
    group by o.product_code
  ) n on n.product_code=r.code;
  return v_result;
end;
$function$;
revoke all on function public.report_supplier_comparison_note_indicators(uuid,text[]) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_comparison_note_indicators(uuid,text[]) to authenticated;
notify pgrst, 'reload schema';
