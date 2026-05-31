# Service Role Authorization Matrix

This project uses `SUPABASE_SERVICE_ROLE_KEY` in Netlify Functions for server-side reads and writes that must bypass RLS. Every such function must stay behind an explicit caller gate.

## Internal admin endpoints

| Endpoint | Caller gate | Allowed roles | Notes |
| --- | --- | --- | --- |
| `/api/admin-create-user` | `requireCallerProfile` | `superadmin` | Creates auth users and profile rows. |
| `/api/admin-update-user` | `requireCallerProfile` | `superadmin` | Updates auth user and profile. |
| `/api/admin-delete-user` | `requireCallerProfile` | `superadmin` | Deletes auth user and profile. |
| `/api/admin-reset-password` | `requireCallerProfile` | `superadmin` | Generates password reset flow for staff. |
| `/api/admin-sync-brand-catalog` | `requireCallerProfile` | `superadmin` | Triggers official-source catalog sync. |
| `/api/admin-sync-warehouse-stock` | `requireCallerProfile` | `superadmin`, `admin` | Pulls remote partner stock into internal tables. |
| `/api/admin-warehouse-stock-clients` | `requireCallerProfile` | `superadmin`, `admin` | Manages outbound warehouse API clients. |
| `/api/admin-test-email` | `requireCallerProfile` | `superadmin` | Sends diagnostics email through Resend. |
| `/api/admin-diagnostics` | `requireCallerProfile` | `superadmin` | Probes auth, DB, and email runtime state. |
| `/api/send-queued-emails` | `requireCallerProfile` | `admin`, `sales` | Sends queued outbound mail. |

## App session endpoints

| Endpoint | Caller gate | Allowed roles | Notes |
| --- | --- | --- | --- |
| `/api/app-session` | Supabase bearer token -> profile lookup | active profile | Returns current app session details. |
| `/api/app-rpc` | Supabase bearer token -> profile lookup in handler | role-scoped in handler | Central admin/app data gateway. |
| `/api/app-admin-records` | Supabase bearer token -> profile lookup in handler | role-scoped in handler | Record CRUD gateway for admin surfaces. |

## Portal endpoints

| Endpoint | Caller gate | Notes |
| --- | --- | --- |
| `/api/portal-login` | email + portal password OR signed portal session cookie | Cookie is `HttpOnly`, `Secure`, `SameSite=Lax`. |
| `/api/portal-data` | signed portal session cookie OR email + password | Refreshes and rotates portal session cookie. |
| `/api/portal-order-search` | signed portal session cookie OR email + password | Portal part search. |
| `/api/portal-order-prepare` | signed portal session cookie OR email + password | Basket pricing. |
| `/api/portal-order-submit` | signed portal session cookie OR email + password | Draft/confirm order submit. |
| `/api/portal-order-delete` | signed portal session cookie OR email + password | Draft delete. |
| `/api/portal-price-list` | signed portal session cookie OR email + password | Download scoped brand price list. |
| `/api/portal-branding` | email preview OR signed portal session token from request body | Used on login screen branding preview. |
| `/api/portal-password-reset-request` | rate-limited email request | Does not require active session. |
| `/api/portal-password-reset-confirm` | signed password reset token | On success, sets signed portal session cookie. |
| `/api/portal-logout` | no caller payload required | Clears signed portal session cookie only. |

## Partner / external API endpoints

| Endpoint | Caller gate | Notes |
| --- | --- | --- |
| `/api/warehouse-stock-feed` | API key + optional IP allowlist + optional HMAC | External partner stock feed. |
| `/api/warehouse-order-submit` | API key + optional IP allowlist + optional HMAC | Writes inbound partner order requests. |

## Audit rule

When adding a new function that uses `SUPABASE_SERVICE_ROLE_KEY`, do not ship it until these are true:

1. The function has one primary caller gate.
2. The caller gate is documented in this file.
3. The user-facing error path is sanitized.
4. The function scope is limited to one organization, portal invite, or partner client.
