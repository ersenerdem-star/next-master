-- Human decision gate for MIRA's staged catalog observations.
-- The worker result remains immutable; approval only authorizes the existing
-- Catalog Observation Review / guarded Apply flow to be used next.

alter table public.mira_missions
  add column if not exists catalog_review_status text not null default 'pending',
  add column if not exists catalog_reviewed_at timestamptz,
  add column if not exists catalog_reviewed_by uuid references public.profiles(id) on delete restrict,
  add column if not exists catalog_review_note text;

alter table public.mira_missions
  drop constraint if exists mira_missions_catalog_review_status_check;

alter table public.mira_missions
  add constraint mira_missions_catalog_review_status_check
  check (catalog_review_status in ('pending', 'approved', 'rejected'));

create index if not exists idx_mira_missions_catalog_review
  on public.mira_missions (organization_id, catalog_review_status, created_at desc)
  where hidden_at is null;

comment on column public.mira_missions.catalog_review_status is
  'Human gate for staged MIRA observations; approval does not directly mutate catalog_products.';
