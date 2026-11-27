-- A bounded, service-role-only batch reader for the existing master export.
-- JSON avoids PostgREST's row limit silently truncating offers for large batches.
create or replace function public.cloud_catalog_master_export_offers(
  input_organization_id uuid, input_brand_id uuid, input_product_codes text[]
) returns jsonb
language plpgsql stable security definer set search_path = ''
set statement_timeout = '35s' as $function$
begin
  if input_organization_id is null or input_brand_id is null
    or not exists (select 1 from public.brands b where b.id=input_brand_id and b.organization_id=input_organization_id) then
    raise exception 'SUPPLIER_EXPORT_BRAND_INVALID' using errcode='22023';
  end if;
  if input_product_codes is null or cardinality(input_product_codes)>200
    or exists (select 1 from unnest(input_product_codes) x(code) where code is null or length(code)>256) then
    raise exception 'SUPPLIER_EXPORT_INPUT_INVALID' using errcode='22023';
  end if;
  return (
    with requested as materialized (
      select distinct x.code product_code,public.normalize_catalog_product_code(x.code) exact_code,
        public.normalize_part_code(x.code) compact_code
      from unnest(input_product_codes) x(code)
      where nullif(public.normalize_catalog_product_code(x.code),'') is not null
    ), codes as materialized (
      select distinct exact_code,compact_code from requested
    ), pointers as materialized (
      select p.supplier_id,p.release_id,p.publication_id
      from public.supplier_current_price_pointers p
      where p.organization_id=input_organization_id and p.brand_id=input_brand_id
    ), published as (
      select c.exact_code,r.buy_price,r.valid_from,p.supplier_id,s.name supplier_name,r.id::text source_id
      from codes c cross join pointers p
      join public.supplier_price_publications pub on pub.id=p.publication_id and pub.release_id=p.release_id
        and pub.organization_id=input_organization_id and pub.supplier_id=p.supplier_id
        and pub.brand_id=input_brand_id and pub.status='published'
        and public.supplier_price_usage_enabled(pub.organization_id,pub.supplier_id)
      join public.supplier_price_release_rows r on r.release_id=p.release_id and r.normalized_code=c.exact_code
      join public.suppliers s on s.organization_id=input_organization_id and s.id=p.supplier_id
      where r.row_status='accepted' and r.buy_price>0 and r.currency='EUR'
        and r.valid_from<=current_date and (r.valid_to is null or r.valid_to>=current_date)
        and r.normalized_code=public.normalize_catalog_product_code(r.product_code)
        and not exists (select 1 from supplier_manual_price_internal.entries m
          where m.organization_id=input_organization_id and m.brand_id=input_brand_id and m.supplier_id=p.supplier_id
            and m.exact_code=r.normalized_code and m.active and m.valid_from<=current_date)
    ), legacy as (
      select c.exact_code,sp.buy_price,sp.valid_from,sp.supplier_id,s.name supplier_name,sp.id::text source_id
      from codes c join public.supplier_prices sp
        on sp.organization_id=input_organization_id and sp.brand_id=input_brand_id and sp.normalized_code=c.compact_code
      join public.suppliers s on s.organization_id=input_organization_id and s.id=sp.supplier_id and s.price_usage_enabled
      where sp.is_active and sp.buy_price>0 and sp.currency='EUR' and sp.valid_from<=current_date
        and (sp.valid_to is null or sp.valid_to>=current_date)
        and public.normalize_catalog_product_code(sp.product_code)=c.exact_code
        and not exists (select 1 from pointers p where p.supplier_id=sp.supplier_id)
        and not exists (select 1 from supplier_manual_price_internal.entries m
          where m.organization_id=input_organization_id and m.brand_id=input_brand_id and m.supplier_id=sp.supplier_id
            and m.exact_code=c.exact_code and m.active and m.valid_from<=current_date)
    ), manual as (
      select c.exact_code,m.buy_price,m.valid_from,m.supplier_id,s.name supplier_name,m.id::text source_id
      from codes c join supplier_manual_price_internal.entries m on m.organization_id=input_organization_id
        and m.brand_id=input_brand_id and m.exact_code=c.exact_code and m.active and m.valid_from<=current_date
      join public.suppliers s on s.organization_id=input_organization_id and s.id=m.supplier_id and s.price_usage_enabled
    ), candidates as (
      select * from published union all select * from legacy union all select * from manual
    ), per_supplier as (
      select c.*,row_number() over(partition by c.exact_code,c.supplier_id order by c.valid_from desc,c.source_id desc) rn
      from candidates c
    )
    select coalesce(jsonb_agg(jsonb_build_object(
      'product_code',r.product_code,'supplier_id',p.supplier_id,'supplier_name',p.supplier_name,
      'buy_price',p.buy_price,'price_date',p.valid_from
    ) order by r.product_code collate "C",p.buy_price,p.valid_from desc,p.supplier_id),'[]'::jsonb)
    from requested r join per_supplier p on p.exact_code=r.exact_code and p.rn=1
  );
end;
$function$;
revoke all on function public.cloud_catalog_master_export_offers(uuid,uuid,text[]) from public,anon,authenticated,service_role;
grant execute on function public.cloud_catalog_master_export_offers(uuid,uuid,text[]) to service_role;

-- Supplier availability affects all offers, including manual-only suppliers
-- whose brand is absent from the existing supplier-usage trigger's scope.
create or replace function public.get_catalog_master_export_version(
  input_organization_id uuid,input_brand_id uuid,input_scope text default 'priced'
) returns text language sql stable security definer set search_path = '' as $function$
  select pg_catalog.md5('mixed-supplier-master-v3:' || coalesce(input_scope,'priced') || ':'
    || public.get_admin_price_list_export_version(input_organization_id,input_brand_id) || ':'
    || coalesce((select pg_catalog.string_agg(
      pg_catalog.jsonb_build_array(s.id,s.name,s.price_usage_enabled)::text,',' order by s.id)
      from public.suppliers s where s.organization_id=input_organization_id),'')
  );
$function$;
revoke all on function public.get_catalog_master_export_version(uuid,uuid,text) from public,anon,authenticated;
grant execute on function public.get_catalog_master_export_version(uuid,uuid,text) to service_role;
notify pgrst, 'reload schema';
