-- All current and future brands are enabled unless explicitly excluded.
-- allowed_brand_ids remains a derived compatibility field for all existing
-- search, order, export and notification readers. [] retains its all meaning.
alter table public.portal_invites add column excluded_brand_ids jsonb not null default '[]'::jsonb;
alter table public.portal_invites add constraint portal_invite_exclusions_array
 check (jsonb_typeof(excluded_brand_ids) = 'array');

create function public.sync_portal_brand_exclusions() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if exists(select 1 from jsonb_array_elements(new.excluded_brand_ids) x
   where jsonb_typeof(x) <> 'string' or not exists(
     select 1 from public.brands b where b.organization_id=new.organization_id and to_jsonb(b.id::text)=x))
 then raise exception 'PORTAL_EXCLUDED_BRAND_SCOPE_INVALID'; end if;
 select coalesce(jsonb_agg(id order by id),'[]'::jsonb) into new.excluded_brand_ids
 from (select distinct value #>> '{}' id from jsonb_array_elements(new.excluded_brand_ids)) ids;
 if new.excluded_brand_ids='[]'::jsonb then new.allowed_brand_ids:='[]'::jsonb;
 else
   -- Empty allow-list means all in legacy readers, so deny every brand with a
   -- reserved non-brand UUID when the admin has excluded every existing brand.
   select coalesce(jsonb_agg(b.id::text order by b.id),'["00000000-0000-0000-0000-000000000000"]'::jsonb)
    into new.allowed_brand_ids from public.brands b
    where b.organization_id=new.organization_id
      and not(new.excluded_brand_ids @> jsonb_build_array(b.id::text));
 end if;
 return new;
end $$;
revoke all on function public.sync_portal_brand_exclusions() from public,anon,authenticated,service_role;
create trigger portal_invite_brand_exclusions before insert or update of organization_id,excluded_brand_ids,allowed_brand_ids
 on public.portal_invites for each row execute function public.sync_portal_brand_exclusions();

-- Existing accounts start with all brands, as explicitly requested. This does
-- not touch credentials, status, seller/customer bindings or session versions.
update public.portal_invites set excluded_brand_ids='[]'::jsonb,allowed_brand_ids='[]'::jsonb;

create function public.refresh_portal_brand_exclusions() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 -- Rebuild only explicit exceptions. Unrestricted invites already include any
 -- future brand through the [] compatibility contract. Do not revoke sessions.
 update public.portal_invites i set excluded_brand_ids=(
   select coalesce(jsonb_agg(b.id::text order by b.id),'[]'::jsonb) from public.brands b
   where b.organization_id=i.organization_id and i.excluded_brand_ids @> jsonb_build_array(b.id::text)
 ) where i.organization_id=case when tg_op='DELETE' then old.organization_id else new.organization_id end
   and i.excluded_brand_ids<>'[]'::jsonb;
 return null;
end $$;
revoke all on function public.refresh_portal_brand_exclusions() from public,anon,authenticated,service_role;
-- Runs before portal_brand_added_notification, so notifications share the scope.
create trigger a_portal_brand_exclusions_refresh after insert or delete on public.brands
 for each row execute function public.refresh_portal_brand_exclusions();
comment on column public.portal_invites.excluded_brand_ids is
 'Explicit brand exclusions. Empty means all current/future brands; allowed_brand_ids is derived by triggers.';
