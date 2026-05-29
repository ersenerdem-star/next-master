## Security Hardening Note - 2026-05-29

### Supabase grant status

- Existing `public` table grants are clean for app data.
  - `anon` does not retain table access on the current business tables.
- `public` schema has no live sequences.
- Business RPC access is clean.
  - `cloud_*`, `bulk_import_*`, `save_cloud_quote`, `touch_user_presence`, `admin_*` do not expose `anon`.
- `postgres` default ACLs for `public` were cleaned successfully.
- `supabase_admin` default ACL rows still show `anon` in `pg_default_acl`.
  - This remained because the SQL Editor role was not permitted to alter `supabase_admin` default privileges.
  - This is a platform-owner limitation, not an app migration gap.

### Why this is not currently a blocker

- The active application surface is already narrowed where it matters:
  - current business tables are not granted to `anon`
  - current business RPCs are not granted to `anon`
  - there are no `public` sequences to expose
- The remaining `supabase_admin` default ACL rows are only relevant for future objects created under that owner.

### New hardening added in this pass

1. Portal requests are now throttled server-side.
   - Backed by `private.portal_request_rate_limits`
   - Enforced through `public.check_portal_rate_limit(...)`
   - Callable only by `service_role`
2. Portal no longer reuses the invite token on every request after login.
   - Login upgrades to a short-lived portal session token
   - Subsequent portal requests use that short-lived session
3. Netlify response headers are tightened.
   - CSP
   - frame denial
   - no-store on `/api/*`
   - no-store on `/portal*`
   - noindex on API and portal routes

### Operational rule going forward

- Keep new app-facing objects on explicit grants only.
- Keep portal-sensitive flows behind Netlify/server-side functions when possible.
- After any new security-related migration, rerun:
  - schema usage audit
  - default ACL audit
  - public table grant audit
  - public routine privilege audit

### If a future object is created under `supabase_admin`

- Verify grants immediately.
- If it appears in `public`, explicitly revoke any unwanted `anon` access on that object.
- Do not assume `supabase_admin` default ACL cleanup can be enforced from the SQL Editor role.
