-- Return only brands with a current published supplier-price pointer.
-- The source pointer/publication tables are intentionally not REST-readable;
-- keep that least-privilege boundary and expose this narrow read-only shape
-- to the server-side admin endpoint through a service-role-only RPC.
create or replace function public.cloud_admin_price_list_brands(input_organization_id uuid)
returns table(id uuid, name text)
language sql
stable
security definer
set search_path to 'public'
as $$
  select distinct b.id, b.name
  from public.supplier_current_price_pointers ptr
  join public.supplier_price_publications pub
    on pub.id = ptr.publication_id
   and pub.status = 'published'
  join public.brands b
    on b.id = ptr.brand_id
   and b.organization_id = ptr.organization_id
  where ptr.organization_id = input_organization_id
  order by b.name;
$$;

revoke all on function public.cloud_admin_price_list_brands(uuid) from public, anon, authenticated;
grant execute on function public.cloud_admin_price_list_brands(uuid) to service_role;

create or replace function public.cloud_admin_price_list_setting_upsert(
  input_organization_id uuid,
  input_list_type text,
  input_margin_percent numeric,
  input_name text default null,
  input_is_manual boolean default false
)
returns table(
  id uuid,
  name text,
  list_type text,
  margin_percent numeric,
  is_manual boolean,
  is_active boolean,
  updated_at timestamptz
)
language plpgsql
volatile
security definer
set search_path to 'public'
as $$
declare
  normalized_type text := upper(trim(coalesce(input_list_type, '')));
  target_id uuid;
  target_name text := coalesce(nullif(trim(input_name), ''), normalized_type || ' Price List');
begin
  if normalized_type not in ('A', 'B') then
    raise exception 'PRICE_LIST_TYPE_MUST_BE_A_OR_B';
  end if;
  if input_organization_id is null or input_margin_percent is null then
    raise exception 'PRICE_LIST_SETTING_INPUT_REQUIRED';
  end if;

  select l.id into target_id
  from public.customer_price_lists l
  where l.organization_id = input_organization_id
    and l.list_type = normalized_type
    and l.is_active = true
  order by l.updated_at desc
  limit 1
  for update;

  if target_id is null then
    insert into public.customer_price_lists(
      organization_id, name, list_type, margin_percent, is_manual, is_active, updated_at)
    values(
      input_organization_id, target_name, normalized_type, input_margin_percent,
      coalesce(input_is_manual, false), true, now())
    returning customer_price_lists.id into target_id;
  else
    update public.customer_price_lists
    set name = target_name,
        margin_percent = input_margin_percent,
        is_manual = coalesce(input_is_manual, false),
        is_active = true,
        updated_at = now()
    where customer_price_lists.id = target_id;
  end if;

  return query
    select l.id, l.name, l.list_type, l.margin_percent, l.is_manual, l.is_active, l.updated_at
    from public.customer_price_lists l
    where l.id = target_id;
end;
$$;

revoke all on function public.cloud_admin_price_list_setting_upsert(uuid, text, numeric, text, boolean) from public, anon, authenticated;
grant execute on function public.cloud_admin_price_list_setting_upsert(uuid, text, numeric, text, boolean) to service_role;
