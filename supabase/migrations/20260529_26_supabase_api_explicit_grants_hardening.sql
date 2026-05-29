grant usage on schema public to authenticated;
grant usage on schema public to service_role;

grant select, insert, update, delete
on all tables in schema public
to authenticated;

grant select, insert, update, delete
on all tables in schema public
to service_role;

grant usage, select
on all sequences in schema public
to authenticated;

grant usage, select
on all sequences in schema public
to service_role;

grant execute
on all functions in schema public
to authenticated;

grant execute
on all functions in schema public
to service_role;

alter default privileges for role postgres in schema public
grant select, insert, update, delete on tables to authenticated;

alter default privileges for role postgres in schema public
grant select, insert, update, delete on tables to service_role;

alter default privileges for role postgres in schema public
grant usage, select on sequences to authenticated;

alter default privileges for role postgres in schema public
grant usage, select on sequences to service_role;

alter default privileges for role postgres in schema public
grant execute on functions to authenticated;

alter default privileges for role postgres in schema public
grant execute on functions to service_role;
