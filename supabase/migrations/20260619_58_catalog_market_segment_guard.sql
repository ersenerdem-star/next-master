create or replace function public.catalog_products_market_segment_guard()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  new.market_segment := public.normalize_catalog_market_segment(new.market_segment);
  return new;
end;
$$;

drop trigger if exists catalog_products_market_segment_guard on public.catalog_products;

create trigger catalog_products_market_segment_guard
before insert or update on public.catalog_products
for each row
execute function public.catalog_products_market_segment_guard();

update public.catalog_products
set market_segment = public.normalize_catalog_market_segment(market_segment)
where market_segment is not null
  and public.normalize_catalog_market_segment(market_segment) is distinct from market_segment;
