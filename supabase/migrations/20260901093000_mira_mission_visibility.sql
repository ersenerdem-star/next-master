-- Keep completed MIRA history available for audit while allowing operators to
-- remove stale records from the desk view without deleting evidence.
do $$
begin
  if to_regclass('public.mira_missions') is null then
    raise exception 'public.mira_missions must exist before applying the MIRA visibility migration';
  end if;
end
$$;

alter table public.mira_missions
  add column if not exists hidden_at timestamptz;

create index if not exists idx_mira_missions_org_visible_created
  on public.mira_missions (organization_id, created_at desc)
  where hidden_at is null;

comment on column public.mira_missions.hidden_at is
  'Operator-only desk visibility marker. Hidden missions remain stored for audit and are never deleted.';
