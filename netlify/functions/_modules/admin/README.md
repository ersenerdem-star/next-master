# Admin Function Boundary

Admin-facing functions must verify a Supabase user session with `requireCallerProfile` or an equivalent explicit superadmin check before using service-role data.

Expected function families:
- `admin-*`
- authenticated `app-*` RPC/admin records
- admin-managed warehouse client configuration

Cross-module constraints:
- Do not read portal customer data without organization and party scoping.
- Do not expose warehouse partner API keys except on create/rotate responses.
