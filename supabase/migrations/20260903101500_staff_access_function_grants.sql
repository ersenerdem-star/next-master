-- Keep staff access helpers callable only through authenticated application paths.
revoke all on function public.current_profile_department() from public;
revoke all on function public.profile_has_permission(text) from public;
revoke all on function public.can_access_customer(uuid) from public;
revoke all on function public.admin_list_org_users_with_access() from public;

grant execute on function public.current_profile_department() to authenticated, service_role;
grant execute on function public.profile_has_permission(text) to authenticated, service_role;
grant execute on function public.can_access_customer(uuid) to authenticated, service_role;
grant execute on function public.admin_list_org_users_with_access() to authenticated;
