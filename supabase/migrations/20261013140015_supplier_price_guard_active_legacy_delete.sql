-- An active legacy price row is still a commercial fallback for suppliers
-- without a V3 pointer. Block its deletion in a brand that has a published
-- V3 pointer, while allowing retention to purge inactive historical rows.
create or replace function public.reject_legacy_supplier_price_published_write()
returns trigger
language plpgsql
security definer
set search_path to ''
as $function$
begin
  if tg_op = 'DELETE' then
    if old.is_active is true and exists (
      select 1
      from public.supplier_current_price_pointers ptr
      where ptr.organization_id = old.organization_id
        and ptr.brand_id = old.brand_id
    ) then
      raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';
    end if;
    return old;
  end if;

  if exists (
    select 1
    from public.supplier_current_price_pointers ptr
    where ptr.organization_id = new.organization_id
      and ptr.brand_id = new.brand_id
  ) or (
    tg_op = 'UPDATE'
    and (old.organization_id is distinct from new.organization_id
      or old.brand_id is distinct from new.brand_id)
    and exists (
      select 1
      from public.supplier_current_price_pointers ptr
      where ptr.organization_id = old.organization_id
        and ptr.brand_id = old.brand_id
    )
  ) then
    raise exception 'LEGACY_SUPPLIER_PRICE_WRITE_BLOCKED';
  end if;
  return new;
end;
$function$;

revoke all on function public.reject_legacy_supplier_price_published_write()
  from public, anon, authenticated;

drop trigger if exists supplier_prices_reject_published_legacy_write on public.supplier_prices;
create trigger supplier_prices_reject_published_legacy_write
before insert or update of organization_id, supplier_id, brand_id,
  product_code, normalized_code, buy_price, currency, valid_from, valid_to,
  is_active, moq, order_multiple, lead_time_days or delete
on public.supplier_prices
for each row execute function public.reject_legacy_supplier_price_published_write();
