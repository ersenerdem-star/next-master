-- Turkish descriptions are enrichment data: never overwrite a value that is
-- already present in the canonical catalog.
create or replace function public.finalize_catalog_import(input_run_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
set statement_timeout = '300s'
as $$
declare
  v_result jsonb;
  v_org_id uuid := public.current_profile_org_id();
  v_updated integer := 0;
begin
  v_result := public.finalize_catalog_import_pre_description_tr(input_run_id);

  with staged_products as (
    select distinct on (cp.id)
      cp.id as catalog_product_id,
      nullif(trim(s.description_tr), '') as description_tr
    from public.catalog_import_stage s
    join public.brands b
      on b.organization_id = v_org_id
     and public.normalize_catalog_brand_key(b.name) = public.normalize_catalog_brand_key(s.brand)
    join public.catalog_products cp
      on cp.organization_id = v_org_id
     and cp.brand_id = b.id
     and cp.normalized_code = s.normalized_code
    where s.run_id = input_run_id
      and s.organization_id = v_org_id
      and s.validation_status = 'valid'
      and s.proposed_action in ('insert', 'update')
      and nullif(trim(s.description_tr), '') is not null
    order by cp.id, s.created_at desc, s.row_index desc
  ), updated as (
    update public.catalog_products cp
    set description_tr = sp.description_tr,
        updated_at = now()
    from staged_products sp
    where cp.id = sp.catalog_product_id
      and nullif(trim(cp.description_tr), '') is null
    returning cp.id
  )
  select count(*)::integer into v_updated from updated;

  return v_result || jsonb_build_object('description_tr_updated_count', v_updated);
end;
$$;

revoke all on function public.finalize_catalog_import(uuid) from public, anon;
grant execute on function public.finalize_catalog_import(uuid) to authenticated;
grant execute on function public.finalize_catalog_import(uuid) to service_role;
