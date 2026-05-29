alter default privileges for role postgres in schema public
revoke select, insert, update, delete, truncate, references, trigger, maintain
on tables
from anon;

alter default privileges for role postgres in schema public
revoke usage, select, update
on sequences
from anon;

alter default privileges for role postgres in schema public
revoke execute
on functions
from anon;

do $$
begin
  begin
    alter default privileges for role supabase_admin in schema public
    revoke select, insert, update, delete, truncate, references, trigger, maintain
    on tables
    from anon;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin table default ACL cleanup for anon: insufficient privilege';
  end;

  begin
    alter default privileges for role supabase_admin in schema public
    revoke usage, select, update
    on sequences
    from anon;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin sequence default ACL cleanup for anon: insufficient privilege';
  end;

  begin
    alter default privileges for role supabase_admin in schema public
    revoke execute
    on functions
    from anon;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin function default ACL cleanup for anon: insufficient privilege';
  end;
end;
$$;
