-- Keep one permissive policy per write action while preserving admin/self
-- tenant boundaries.
drop policy if exists user_presence_admin_insert_own_org on public.user_presence;
drop policy if exists user_presence_admin_update_own_org on public.user_presence;
drop policy if exists user_presence_admin_delete_own_org on public.user_presence;
drop policy if exists user_presence_self_insert on public.user_presence;
drop policy if exists user_presence_self_update on public.user_presence;
drop policy if exists user_presence_self_delete on public.user_presence;
drop policy if exists user_presence_write_insert on public.user_presence;
drop policy if exists user_presence_write_update on public.user_presence;
drop policy if exists user_presence_write_delete on public.user_presence;

create policy user_presence_write_insert on public.user_presence for insert to public
  with check ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));
create policy user_presence_write_update on public.user_presence for update to public
  using ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()))
  with check ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));
create policy user_presence_write_delete on public.user_presence for delete to public
  using ((current_profile_role() = 'admin' and organization_id = current_profile_org_id())
    or (auth.uid() = user_id and organization_id = current_profile_org_id()));
