create table if not exists public.item_code_references (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  brand_id uuid not null references public.brands(id) on delete cascade,
  old_code text not null,
  normalized_old_code text generated always as (public.normalize_part_code(old_code)) stored,
  new_code text not null,
  normalized_new_code text generated always as (public.normalize_part_code(new_code)) stored,
  original_number text,
  normalized_original_number text generated always as (public.normalize_part_code(original_number)) stored,
  reason text,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, brand_id, normalized_old_code)
);

create index if not exists idx_item_code_references_old_code
  on public.item_code_references (organization_id, normalized_old_code);

create index if not exists idx_item_code_references_brand_old_code
  on public.item_code_references (organization_id, brand_id, normalized_old_code);

create index if not exists idx_item_code_references_brand_original_number
  on public.item_code_references (organization_id, brand_id, normalized_original_number)
  where normalized_original_number <> '';

alter table public.item_code_references enable row level security;

drop policy if exists "item_code_references_select_own_org" on public.item_code_references;
create policy "item_code_references_select_own_org"
on public.item_code_references
for select
using (organization_id = public.current_profile_org_id());

drop policy if exists "item_code_references_admin_manage_own_org" on public.item_code_references;
create policy "item_code_references_admin_manage_own_org"
on public.item_code_references
for all
using (public.is_admin() and organization_id = public.current_profile_org_id())
with check (public.is_admin() and organization_id = public.current_profile_org_id());
