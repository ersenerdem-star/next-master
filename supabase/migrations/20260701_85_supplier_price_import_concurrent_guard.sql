-- Guard supplier price imports so the same organization/supplier/brand scope
-- cannot start a second staged run while another run is still active.

create or replace function public.begin_supplier_price_import(
  input_supplier_name text,
  input_brand text,
  input_mode text default 'replace'
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_supplier_name text := nullif(trim(coalesce(input_supplier_name, '')), '');
  v_brand_name text := nullif(trim(coalesce(input_brand, '')), '');
  v_mode text := lower(nullif(trim(coalesce(input_mode, '')), ''));
  v_supplier_id uuid;
  v_brand_id uuid;
  v_run_id uuid;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can import supplier prices';
  end if;

  if v_supplier_name is null then
    raise exception 'Supplier is required';
  end if;

  if v_brand_name is null then
    raise exception 'Brand is required';
  end if;

  if v_mode not in ('replace', 'merge') then
    raise exception 'Import mode must be replace or merge';
  end if;

  insert into public.suppliers (organization_id, name)
  values (v_org_id, v_supplier_name)
  on conflict (organization_id, normalized_name) do nothing;

  select s.id
  into v_supplier_id
  from public.suppliers s
  where s.organization_id = v_org_id
    and s.normalized_name = public.normalize_part_code(v_supplier_name)
  limit 1;

  insert into public.brands (organization_id, name)
  values (v_org_id, coalesce(v_brand_name, 'Unbranded'))
  on conflict (organization_id, normalized_name) do nothing;

  select b.id
  into v_brand_id
  from public.brands b
  where b.organization_id = v_org_id
    and b.normalized_name = public.normalize_part_code(coalesce(v_brand_name, 'Unbranded'))
  limit 1;

  if v_supplier_id is null or v_brand_id is null then
    raise exception 'Supplier or brand could not be resolved';
  end if;

  perform pg_advisory_xact_lock(
    hashtextextended(v_org_id::text || ':' || v_supplier_id::text || ':' || v_brand_id::text, 0)
  );

  if exists (
    select 1
    from public.supplier_price_import_runs r
    where r.organization_id = v_org_id
      and r.supplier_id = v_supplier_id
      and r.brand_id = v_brand_id
      and r.status in ('running', 'finalizing')
  ) then
    raise exception 'Another import is already running for this supplier and brand.';
  end if;

  insert into public.supplier_price_import_runs (
    organization_id,
    supplier_id,
    brand_id,
    mode,
    status
  )
  values (
    v_org_id,
    v_supplier_id,
    v_brand_id,
    v_mode,
    'running'
  )
  returning id into v_run_id;

  return jsonb_build_object(
    'status', 'running',
    'run_id', v_run_id,
    'organization_id', v_org_id,
    'supplier_id', v_supplier_id,
    'brand_id', v_brand_id,
    'mode', v_mode
  );
end;
$$;

grant execute on function public.begin_supplier_price_import(text, text, text) to authenticated;
