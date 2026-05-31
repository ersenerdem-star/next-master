alter table public.portal_invites
  add column if not exists allowed_brand_ids jsonb not null default '[]'::jsonb;

update public.portal_invites
set allowed_brand_ids = '[]'::jsonb
where allowed_brand_ids is null;
