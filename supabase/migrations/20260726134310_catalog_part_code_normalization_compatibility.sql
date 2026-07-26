-- NM-CATALOG-PART-CODE-NORMALIZATION-COMPATIBILITY-FIX
--
-- Canonical catalog product codes remove whitespace only and preserve
-- meaningful punctuation such as dots, hyphens, slashes and plus signs.
--
-- public.normalize_part_code(text) intentionally remains the legacy compact
-- lookup normalizer. It is shared by brands, OEM identifiers, supplier prices,
-- quotes and historical search paths, so changing it would silently break
-- existing joins across the current catalog.
--
-- The canonical display/identity boundary is:
--   public.normalize_catalog_product_code(text)
-- The compatibility lookup boundary remains:
--   public.normalize_part_code(text)

set lock_timeout = '5s';
set statement_timeout = '300s';

create table if not exists public.product_code_normalization_policies (
  brand_key text primary key,
  canonical_brand text not null,
  policy text not null,
  is_alias boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint product_code_normalization_policies_policy_check
    check (policy in ('compact_alnum', 'compact_space', 'compact_space_dot', 'upper_trim'))
);

do $$
begin
  if not exists (
    select 1
    from pg_constraint
    where conname = 'product_code_normalization_policies_policy_check'
      and conrelid = 'public.product_code_normalization_policies'::regclass
  ) then
    alter table public.product_code_normalization_policies
      add constraint product_code_normalization_policies_policy_check
      check (policy in ('compact_alnum', 'compact_space', 'compact_space_dot', 'upper_trim'))
      not valid;

    alter table public.product_code_normalization_policies
      validate constraint product_code_normalization_policies_policy_check;
  end if;
end
$$;

-- Preserve the already established legacy policies when bootstrapping a fresh
-- checkout. Existing environments retain any explicit local decision.
insert into public.product_code_normalization_policies (
  brand_key,
  canonical_brand,
  policy,
  is_alias
)
values
  ('BOSCH', 'Bosch', 'compact_alnum', false),
  ('HENGST', 'Hengst', 'compact_alnum', false),
  ('KNORR', 'Knorr-Bremse', 'compact_alnum', true),
  ('KNORRBREMSE', 'Knorr-Bremse', 'compact_alnum', false),
  ('LEMFORDER', 'Lemforder', 'compact_alnum', false),
  ('MANN', 'Mann', 'compact_alnum', false),
  ('MANNFILTER', 'Mann', 'compact_alnum', true),
  ('SACHS', 'Sachs', 'compact_alnum', false),
  ('WABCO', 'Wabco', 'compact_alnum', false)
on conflict (brand_key) do nothing;

-- The Motorservice family uses whitespace-only normalization. Punctuation is
-- identity-bearing and must never be removed by the canonical code boundary.
insert into public.product_code_normalization_policies as existing (
  brand_key,
  canonical_brand,
  policy,
  is_alias,
  active,
  updated_at
)
values
  ('BF', 'BF', 'compact_space', false, true, now()),
  ('KOLBENSCHMIDT', 'Kolbenschmidt', 'compact_space', false, true, now()),
  ('PIERBURG', 'Pierburg', 'compact_space', false, true, now()),
  ('TRWENGINECOMPONENT', 'TRW Engine Components', 'compact_space', true, true, now()),
  ('TRWENGINECOMPONENTS', 'TRW Engine Components', 'compact_space', false, true, now())
on conflict (brand_key) do update
set canonical_brand = excluded.canonical_brand,
    policy = excluded.policy,
    is_alias = excluded.is_alias,
    active = true,
    updated_at = now()
where existing.canonical_brand is distinct from excluded.canonical_brand
   or existing.policy is distinct from excluded.policy
   or existing.is_alias is distinct from excluded.is_alias
   or not existing.active;

create or replace function public.normalize_catalog_compact_alnum(input_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(upper(coalesce(input_value, '')), '[^A-Z0-9]+', '', 'g');
$$;

create or replace function public.normalize_catalog_product_code(input_value text)
returns text
language sql
immutable
set search_path = pg_catalog
as $$
  select regexp_replace(upper(coalesce(input_value, '')), '[[:space:]]+', '', 'g');
$$;

comment on function public.normalize_catalog_product_code(text) is
  'Canonical catalog product-code identity: removes whitespace only and preserves punctuation. public.normalize_part_code remains the legacy punctuation-insensitive compatibility key.';

create or replace function public.resolve_product_code_normalization_policy(input_brand text)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select coalesce(
    (
      select p.policy
      from public.product_code_normalization_policies p
      where p.brand_key = public.normalize_catalog_brand_key(input_brand)
        and p.active
      limit 1
    ),
    'upper_trim'
  );
$$;

create or replace function public.normalize_catalog_display_code_for_brand(
  input_value text,
  input_brand text
)
returns text
language sql
stable
set search_path = public, pg_temp
as $$
  select case public.resolve_product_code_normalization_policy(input_brand)
    when 'compact_alnum'
      then public.normalize_catalog_compact_alnum(input_value)
    when 'compact_space'
      then public.normalize_catalog_product_code(input_value)
    when 'compact_space_dot'
      then regexp_replace(upper(coalesce(input_value, '')), '[[:space:].]+', '', 'g')
    else
      regexp_replace(trim(upper(coalesce(input_value, ''))), '[[:space:]]+', ' ', 'g')
  end;
$$;

-- Fresh and historical checkouts differ on whether normalized_code is a
-- generated column. Resolve that schema difference once at migration time,
-- rather than querying information_schema for every affected catalog row.
do $migration$
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'catalog_products'
      and c.column_name = 'normalized_code'
      and coalesce(c.is_generated, 'NEVER') <> 'ALWAYS'
  ) then
    execute $ddl$
      create or replace function public.set_catalog_product_canonical_code()
      returns trigger
      language plpgsql
      set search_path = public, pg_temp
      as $body$
      declare
        v_brand_name text := '';
      begin
        select coalesce(b.name, '')
          into v_brand_name
        from public.brands b
        where b.id = new.brand_id;

        new.product_code := public.normalize_catalog_display_code_for_brand(
          new.product_code,
          v_brand_name
        );

        if new.product_code is not null and new.product_code <> '' then
          new.normalized_code := public.normalize_part_code(new.product_code);
        end if;

        return new;
      end;
      $body$;
    $ddl$;
  else
    execute $ddl$
      create or replace function public.set_catalog_product_canonical_code()
      returns trigger
      language plpgsql
      set search_path = public, pg_temp
      as $body$
      declare
        v_brand_name text := '';
      begin
        select coalesce(b.name, '')
          into v_brand_name
        from public.brands b
        where b.id = new.brand_id;

        new.product_code := public.normalize_catalog_display_code_for_brand(
          new.product_code,
          v_brand_name
        );

        return new;
      end;
      $body$;
    $ddl$;
  end if;
end
$migration$;

drop trigger if exists trg_catalog_products_canonical_code
  on public.catalog_products;

-- Fail before touching canonical rows if whitespace-only normalization would
-- collide inside one tenant and brand.
do $$
declare
  collision_count integer;
begin
  select count(*)::integer
    into collision_count
  from (
    select
      p.organization_id,
      p.brand_id,
      public.normalize_catalog_product_code(p.product_code) as canonical_code
    from public.catalog_products p
    join public.brands b on b.id = p.brand_id
    where public.normalize_catalog_brand_key(b.name) in (
      'BF',
      'KOLBENSCHMIDT',
      'PIERBURG',
      'TRWENGINECOMPONENT',
      'TRWENGINECOMPONENTS'
    )
    group by
      p.organization_id,
      p.brand_id,
      public.normalize_catalog_product_code(p.product_code)
    having count(*) > 1
  ) collisions;

  if collision_count > 0 then
    raise exception using
      errcode = '23505',
      message = format(
        'Catalog product-code normalization blocked: %s whitespace-only identity collision group(s)',
        collision_count
      );
  end if;
end
$$;

-- The update is deliberately restricted to the approved Motorservice-family
-- brands. It never changes dots, hyphens, slashes or plus signs.
update public.catalog_products p
set product_code = public.normalize_catalog_product_code(p.product_code),
    updated_at = now()
from public.brands b
where b.id = p.brand_id
  and public.normalize_catalog_brand_key(b.name) in (
    'BF',
    'KOLBENSCHMIDT',
    'PIERBURG',
    'TRWENGINECOMPONENT',
    'TRWENGINECOMPONENTS'
  )
  and p.product_code is distinct from public.normalize_catalog_product_code(p.product_code);

-- A writable legacy normalized_code column does not derive from product_code.
-- Synchronize it once after the trigger-free backfill. Production and current
-- local schemas use a generated column and skip this block.
do $migration$
begin
  if exists (
    select 1
    from information_schema.columns c
    where c.table_schema = 'public'
      and c.table_name = 'catalog_products'
      and c.column_name = 'normalized_code'
      and coalesce(c.is_generated, 'NEVER') <> 'ALWAYS'
  ) then
    execute $sql$
      update public.catalog_products p
      set normalized_code = public.normalize_part_code(p.product_code)
      from public.brands b
      where b.id = p.brand_id
        and public.normalize_catalog_brand_key(b.name) in (
          'BF',
          'KOLBENSCHMIDT',
          'PIERBURG',
          'TRWENGINECOMPONENT',
          'TRWENGINECOMPONENTS'
        )
        and p.normalized_code is distinct from public.normalize_part_code(p.product_code)
    $sql$;
  end if;
end
$migration$;

do $$
begin
  if exists (
    select 1
    from public.catalog_products p
    join public.brands b on b.id = p.brand_id
    where public.normalize_catalog_brand_key(b.name) in (
      'BF',
      'KOLBENSCHMIDT',
      'PIERBURG',
      'TRWENGINECOMPONENT',
      'TRWENGINECOMPONENTS'
    )
      and p.product_code is distinct from public.normalize_catalog_product_code(p.product_code)
  ) then
    raise exception using
      errcode = '23514',
      message = 'Catalog product-code normalization postcondition failed';
  end if;
end
$$;

create trigger trg_catalog_products_canonical_code
before insert or update of product_code, brand_id
on public.catalog_products
for each row
execute function public.set_catalog_product_canonical_code();

alter table public.product_code_normalization_policies enable row level security;

drop policy if exists product_code_normalization_policies_read
  on public.product_code_normalization_policies;

create policy product_code_normalization_policies_read
on public.product_code_normalization_policies
for select
to authenticated
using (true);

revoke all on table public.product_code_normalization_policies
  from public, anon, authenticated, service_role;
grant select on table public.product_code_normalization_policies
  to authenticated, service_role;

revoke all on function public.set_catalog_product_canonical_code()
  from public, anon;
grant execute on function public.set_catalog_product_canonical_code()
  to authenticated, service_role;

revoke all on function public.normalize_catalog_compact_alnum(text)
  from public, anon;
grant execute on function public.normalize_catalog_compact_alnum(text)
  to authenticated, service_role;

revoke all on function public.normalize_catalog_product_code(text)
  from public, anon;
grant execute on function public.normalize_catalog_product_code(text)
  to authenticated, service_role;

revoke all on function public.resolve_product_code_normalization_policy(text)
  from public, anon;
grant execute on function public.resolve_product_code_normalization_policy(text)
  to authenticated, service_role;

revoke all on function public.normalize_catalog_display_code_for_brand(text, text)
  from public, anon;
grant execute on function public.normalize_catalog_display_code_for_brand(text, text)
  to authenticated, service_role;
