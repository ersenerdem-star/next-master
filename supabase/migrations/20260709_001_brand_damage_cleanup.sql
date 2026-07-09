-- Brand damage cleanup for approved legacy sanitizer outputs only.
--
-- PRE-CHECK:
-- select organization_id, id, name, normalized_name
-- from public.brands
-- where upper(trim(name)) in ('MANNFILTER', 'KNORRBREMSE', 'BOSCHDIESEL', 'LEMFOERDER')
--    or public.normalize_part_code(name) in ('MANNFILTER', 'KNORRBREMSE', 'BOSCHDIESEL', 'LEMFOERDER', 'LEMFORDER')
-- order by organization_id, normalized_name, name;
--
-- POST-CHECK:
-- select organization_id, id, name, normalized_name
-- from public.brands
-- where upper(trim(name)) in ('MANNFILTER', 'KNORRBREMSE', 'BOSCHDIESEL', 'LEMFOERDER')
--    or name in ('MANN-FILTER', 'KNORR-BREMSE', 'BOSCH/DIESEL', 'Lemforder')
-- order by organization_id, normalized_name, name;
--
-- Scope:
-- - Only the four approved damaged brand mappings are handled.
-- - Sales Order / Invoice / Bill snapshots are intentionally not modified.
-- - Reference merges are conservative: rows that would conflict with an existing
--   target reference are left on the source brand and reported with NOTICE.

do $$
declare
  v_mapping record;
  v_source record;
  v_target_id uuid;
  v_target_name text;
  v_updated integer;
  v_remaining integer;
  v_count integer;
begin
  if to_regclass('public.brands') is null then
    raise notice 'Brand damage cleanup skipped: public.brands does not exist';
    return;
  end if;

  for v_mapping in
    select *
    from (
      values
        ('MANNFILTER', 'MANN-FILTER', 'MANNFILTER'),
        ('KNORRBREMSE', 'KNORR-BREMSE', 'KNORRBREMSE'),
        ('BOSCHDIESEL', 'BOSCH/DIESEL', 'BOSCHDIESEL'),
        ('LEMFOERDER', 'Lemforder', 'LEMFORDER')
    ) as mappings(source_key, target_name, target_key)
  loop
    for v_source in
      select b.id, b.organization_id, b.name
      from public.brands b
      where (
          upper(trim(b.name)) = v_mapping.source_key
          or coalesce(b.normalized_name, public.normalize_part_code(b.name)) = v_mapping.source_key
        )
        and b.name is distinct from v_mapping.target_name
      order by b.organization_id, b.name, b.id
    loop
      select b.id, b.name
      into v_target_id, v_target_name
      from public.brands b
      where b.organization_id = v_source.organization_id
        and b.id <> v_source.id
        and upper(trim(b.name)) <> v_mapping.source_key
        and (
          coalesce(b.normalized_name, public.normalize_part_code(b.name)) = v_mapping.target_key
          or public.normalize_part_code(b.name) = v_mapping.target_key
        )
      order by
        case when b.name = v_mapping.target_name then 0 else 1 end,
        b.name,
        b.id
      limit 1;

      if v_target_id is null then
        update public.brands
        set name = v_mapping.target_name
        where id = v_source.id
          and name is distinct from v_mapping.target_name;

        get diagnostics v_updated = row_count;
        raise notice
          'Brand damage cleanup renamed source brand org=%, id=%, from=% to=%, rows=%',
          v_source.organization_id,
          v_source.id,
          v_source.name,
          v_mapping.target_name,
          v_updated;
      else
        raise notice
          'Brand damage cleanup merging source brand org=%, source_id=%, source_name=%, target_id=%, target_name=%',
          v_source.organization_id,
          v_source.id,
          v_source.name,
          v_target_id,
          v_target_name;

        if to_regclass('public.catalog_products') is not null then
          update public.catalog_products cp
          set brand_id = v_target_id
          where cp.brand_id = v_source.id
            and not exists (
              select 1
              from public.catalog_products target_cp
              where target_cp.organization_id = cp.organization_id
                and target_cp.brand_id = v_target_id
                and target_cp.normalized_code is not distinct from cp.normalized_code
            );

          get diagnostics v_updated = row_count;
          raise notice 'Brand damage cleanup catalog_products refs updated=%', v_updated;
        end if;

        if to_regclass('public.supplier_prices') is not null then
          update public.supplier_prices sp
          set brand_id = v_target_id
          where sp.brand_id = v_source.id
            and not exists (
              select 1
              from public.supplier_prices target_sp
              where target_sp.organization_id = sp.organization_id
                and target_sp.supplier_id = sp.supplier_id
                and target_sp.brand_id = v_target_id
                and target_sp.normalized_code is not distinct from sp.normalized_code
                and target_sp.valid_from is not distinct from sp.valid_from
            );

          get diagnostics v_updated = row_count;
          raise notice 'Brand damage cleanup supplier_prices refs updated=%', v_updated;
        end if;

        if to_regclass('public.customer_price_list_items') is not null then
          update public.customer_price_list_items cpi
          set brand_id = v_target_id
          where cpi.brand_id = v_source.id
            and not exists (
              select 1
              from public.customer_price_list_items target_cpi
              where target_cpi.organization_id = cpi.organization_id
                and target_cpi.price_list_id = cpi.price_list_id
                and target_cpi.brand_id = v_target_id
                and target_cpi.normalized_code is not distinct from cpi.normalized_code
            );

          get diagnostics v_updated = row_count;
          raise notice 'Brand damage cleanup customer_price_list_items refs updated=%', v_updated;
        end if;

        if to_regclass('public.item_code_references') is not null then
          update public.item_code_references icr
          set brand_id = v_target_id
          where icr.brand_id = v_source.id
            and not exists (
              select 1
              from public.item_code_references target_icr
              where target_icr.organization_id = icr.organization_id
                and target_icr.brand_id = v_target_id
                and target_icr.normalized_old_code is not distinct from icr.normalized_old_code
            );

          get diagnostics v_updated = row_count;
          raise notice 'Brand damage cleanup item_code_references refs updated=%', v_updated;
        end if;

        if to_regclass('public.supplier_price_rollups') is not null then
          update public.supplier_price_rollups spr
          set brand_id = v_target_id
          where spr.brand_id = v_source.id
            and not exists (
              select 1
              from public.supplier_price_rollups target_spr
              where target_spr.organization_id = spr.organization_id
                and target_spr.brand_id = v_target_id
                and target_spr.normalized_code is not distinct from spr.normalized_code
            );

          get diagnostics v_updated = row_count;
          raise notice 'Brand damage cleanup supplier_price_rollups refs updated=%', v_updated;
        end if;

        v_remaining := 0;

        if to_regclass('public.catalog_products') is not null then
          select count(*)::integer into v_count from public.catalog_products where brand_id = v_source.id;
          v_remaining := v_remaining + v_count;
        end if;

        if to_regclass('public.supplier_prices') is not null then
          select count(*)::integer into v_count from public.supplier_prices where brand_id = v_source.id;
          v_remaining := v_remaining + v_count;
        end if;

        if to_regclass('public.customer_price_list_items') is not null then
          select count(*)::integer into v_count from public.customer_price_list_items where brand_id = v_source.id;
          v_remaining := v_remaining + v_count;
        end if;

        if to_regclass('public.item_code_references') is not null then
          select count(*)::integer into v_count from public.item_code_references where brand_id = v_source.id;
          v_remaining := v_remaining + v_count;
        end if;

        if to_regclass('public.supplier_price_rollups') is not null then
          select count(*)::integer into v_count from public.supplier_price_rollups where brand_id = v_source.id;
          v_remaining := v_remaining + v_count;
        end if;

        if v_remaining = 0 then
          begin
            delete from public.brands
            where id = v_source.id;

            get diagnostics v_updated = row_count;
            raise notice
              'Brand damage cleanup deleted duplicate source brand id=%, rows=%',
              v_source.id,
              v_updated;
          exception
            when foreign_key_violation then
              raise notice
                'Brand damage cleanup kept source brand id=% because it is referenced outside the safe cleanup scope',
                v_source.id;
          end;
        else
          raise notice
            'Brand damage cleanup kept source brand id=% because % safe references remain after non-conflicting merge',
            v_source.id,
            v_remaining;
        end if;
      end if;

      v_target_id := null;
      v_target_name := null;
    end loop;
  end loop;
end $$;
