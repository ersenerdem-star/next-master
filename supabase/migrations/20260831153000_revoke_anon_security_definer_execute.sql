-- SECURITY DEFINER functions in public are application RPCs or internal helpers.
-- Anonymous callers must not inherit EXECUTE through PUBLIC. Explicit
-- authenticated/service_role grants are preserved for functions that need them.
do $$
declare
  fn record;
begin
  for fn in
    select p.oid::regprocedure as identity
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.prosecdef = true
  loop
    execute format(
      'revoke execute on function %s from public, anon',
      fn.identity
    );
  end loop;
end;
$$;
