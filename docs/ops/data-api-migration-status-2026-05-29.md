## Browser-to-Function Migration Status - 2026-05-29

### What moved behind Netlify functions in this pass

- Browser-side `profiles` / organization resolution
  - now uses `/api/app-session`
- Browser-side RPC calls for:
  - user list
  - presence heartbeat
  - catalog import
  - supplier import
  - quote list/detail
  - supplier cloud summary/page actions
  - quote resolve and supplier options
  - catalog page RPC
  - master page RPC

### New gateway endpoints

- `GET /api/app-session`
  - validates the caller's Supabase access token
  - returns `user.id`, `user.email`, `profile.organization_id`, `profile.role`
- `POST /api/app-rpc`
  - validates the caller's Supabase access token
  - only forwards an allowlisted set of RPC names
  - forwards with the caller JWT, not `service_role`, so RLS and grants still apply

### What still uses browser-side Supabase table access

These modules still call `supabaseClient.from(...)` directly from the browser:

- `catalogApi.ts`
- `codeReferencesApi.ts`
- `companyProfilesApi.ts`
- `customersApi.ts`
- `dashboardApi.ts`
- `emailTemplatesApi.ts`
- `inventoryApi.ts`
- `ordersApi.ts`
- `portalInvitesApi.ts`
- `vendorsApi.ts`

Some of those are read-heavy, some are full CRUD.

### Why Supabase Data API cannot be disabled yet

Data API shutdown is still blocked for two separate reasons:

1. Browser code still uses PostgREST table access in the modules listed above.
2. Netlify functions themselves still use Supabase REST/RPC internally.
   - Portal and admin server-side flows still call `/rest/v1` and `/rpc/...`

So the current state is:

- significantly less direct browser exposure than before
- but not enough to disable Data API safely

### Next migration slice

1. Move browser-side table CRUD behind Netlify functions for:
   - customers
   - vendors
   - company profiles
   - portal invites
   - email templates / outbound email actions
   - code references
2. Move browser-side order/document persistence behind Netlify functions:
   - sales orders
   - purchase orders
   - invoices
   - bills
3. Move inventory mutations behind Netlify functions:
   - receipts
   - movements
   - transfers
4. After browser-side table access is gone, audit server-side Netlify functions.
5. Only then evaluate disabling Supabase Data API.

### Operational rule

Do not disable Data API until both conditions are true:

- browser-side `supabaseClient.from(...)` is gone from app flows
- Netlify functions no longer depend on Supabase REST/RPC as their storage interface
