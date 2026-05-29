do $$
declare
  function_signature text;
begin
  for function_signature in
    select format(
      '%I.%I(%s)',
      n.nspname,
      p.proname,
      pg_get_function_identity_arguments(p.oid)
    )
    from pg_proc p
    join pg_namespace n
      on n.oid = p.pronamespace
    where n.nspname = 'public'
  loop
    begin
      execute format('revoke execute on function %s from public', function_signature);
    exception
      when insufficient_privilege then
        raise notice 'Skipping public execute revoke for %: insufficient privilege', function_signature;
    end;
  end loop;
end;
$$;

grant execute
on all functions in schema public
to authenticated;

grant execute
on all functions in schema public
to service_role;

alter default privileges for role postgres in schema public
revoke execute on functions from public;

alter default privileges for role postgres in schema public
grant execute on functions to authenticated;

alter default privileges for role postgres in schema public
grant execute on functions to service_role;

do $$
begin
  begin
    alter default privileges for role supabase_admin in schema public
    revoke execute on functions from public;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin function execute revoke from public: insufficient privilege';
  end;

  begin
    alter default privileges for role supabase_admin in schema public
    grant execute on functions to authenticated;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin function execute grant to authenticated: insufficient privilege';
  end;

  begin
    alter default privileges for role supabase_admin in schema public
    grant execute on functions to service_role;
  exception
    when insufficient_privilege then
      raise notice 'Skipping supabase_admin function execute grant to service_role: insufficient privilege';
  end;
end;
$$;
