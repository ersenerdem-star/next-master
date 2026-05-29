alter table public.warehouses
  add column if not exists fulfillment_model text not null default 'stocked';

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conrelid = 'public.warehouses'::regclass
      and conname = 'warehouses_fulfillment_model_check'
  ) then
    alter table public.warehouses
      add constraint warehouses_fulfillment_model_check
      check (fulfillment_model in ('stocked', 'dropship'));
  end if;
end $$;
