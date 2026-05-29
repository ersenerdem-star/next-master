revoke usage on schema public from anon;

revoke all privileges
on all tables in schema public
from anon;

revoke all privileges
on all sequences in schema public
from anon;

revoke execute
on all functions in schema public
from anon;

alter default privileges for role postgres in schema public
revoke select, insert, update, delete on tables from anon;

alter default privileges for role postgres in schema public
revoke usage, select on sequences from anon;

alter default privileges for role postgres in schema public
revoke execute on functions from anon;

alter default privileges for role supabase_admin in schema public
revoke select, insert, update, delete on tables from anon;

alter default privileges for role supabase_admin in schema public
revoke usage, select on sequences from anon;

alter default privileges for role supabase_admin in schema public
revoke execute on functions from anon;
