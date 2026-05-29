-- 1. Public schema usage grants
-- Expected:
-- - authenticated = true
-- - service_role = true
-- - anon = false
select
  n.nspname as schema_name,
  r.rolname as grantee,
  has_schema_privilege(r.rolname, n.oid, 'USAGE') as has_usage
from pg_namespace n
cross join pg_roles r
where n.nspname = 'public'
  and r.rolname in ('anon', 'authenticated', 'service_role')
order by r.rolname;

-- 2. Default privileges for future public tables / sequences / functions
-- Expected:
-- - rows for postgres and supabase_admin
-- - object_type includes r, S, f
-- - acl includes authenticated and service_role
-- - acl does not include anon
select
  pg_get_userbyid(defaclrole) as default_privilege_owner,
  defaclnamespace::regnamespace as schema_name,
  defaclobjtype as object_type,
  defaclacl as acl
from pg_default_acl
where defaclnamespace = 'public'::regnamespace
order by defaclobjtype;

-- 3. Existing public table grants
-- Expected:
-- - authenticated and service_role rows only
-- - no anon rows
select
  grantee,
  table_name,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.role_table_grants
where table_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, table_name
order by table_name, grantee;

-- 4. Existing public sequence grants
-- Expected:
-- - authenticated and service_role rows only
-- - no anon rows
select
  grantee,
  object_name as sequence_name,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.usage_privileges
where object_schema = 'public'
  and object_type = 'SEQUENCE'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, object_name
order by object_name, grantee;

-- 5. Existing public function execute grants
-- Expected:
-- - authenticated and service_role rows only
-- - no anon rows
-- - if anon rows still remain, they are most likely extension-owned functions where revoke was not permitted
select
  grantee,
  routine_name,
  string_agg(privilege_type, ', ' order by privilege_type) as privileges
from information_schema.routine_privileges
where routine_schema = 'public'
  and grantee in ('anon', 'authenticated', 'service_role')
group by grantee, routine_name
order by routine_name, grantee;
