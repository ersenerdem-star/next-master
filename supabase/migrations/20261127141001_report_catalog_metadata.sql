-- Read at most one visible report page of catalog details. Exact product
-- identity is retained: whitespace/case normalization never removes leading
-- zeroes or punctuation. Ambiguous catalog duplicates are intentionally not
-- projected, preventing an arbitrary product from being attached to a price.
create or replace function public.report_supplier_catalog_metadata(
  input_brand_id uuid, input_product_codes text[]
) returns jsonb language plpgsql stable security definer set search_path = '' as $function$
declare v_org_id uuid := public.current_profile_org_id();
begin
  if auth.uid() is null or v_org_id is null
     or not coalesce(public.is_superadmin() or public.profile_has_permission('reports.view'), false) then
    raise exception 'SUPPLIER_COMPARISON_ACCESS_DENIED' using errcode='42501';
  end if;
  if input_brand_id is null or not exists (
    select 1 from public.brands b where b.organization_id=v_org_id and b.id=input_brand_id
  ) then raise exception 'SUPPLIER_COMPARISON_BRAND_INVALID' using errcode='22023'; end if;
  if input_product_codes is null or cardinality(input_product_codes)>50
     or exists(select 1 from unnest(input_product_codes) x(code)
       where code is null or length(code)>256 or nullif(public.normalize_catalog_product_code(code),'') is null)
  then raise exception 'SUPPLIER_COMPARISON_INPUT_INVALID' using errcode='22023'; end if;
  return (
    with requested as materialized (
      select distinct code as input_code, public.normalize_catalog_product_code(code) as exact_code
      from unnest(input_product_codes) x(code)
    ), matches as materialized (
      select r.input_code,c.id,c.description,c.oem_no,c.hs_code,c.origin,c.weight_kg,
        count(*) over(partition by r.input_code) as match_count
      from requested r join public.catalog_products c
        on c.organization_id=v_org_id and c.brand_id=input_brand_id
        and public.normalize_catalog_product_code(c.product_code)=r.exact_code
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'input_code', m.input_code, 'product_id',m.id, 'description',m.description,
      'oem_no',m.oem_no,'hs_code',m.hs_code,'origin',m.origin,'weight_kg',m.weight_kg
    ) order by m.input_code collate "C"),'[]'::jsonb)
    from matches m where m.match_count=1
  );
end;
$function$;
revoke all on function public.report_supplier_catalog_metadata(uuid,text[]) from public,anon,authenticated,service_role;
grant execute on function public.report_supplier_catalog_metadata(uuid,text[]) to authenticated,service_role;
notify pgrst, 'reload schema';
