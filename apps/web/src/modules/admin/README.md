# Admin Module Boundary

Purpose: authenticated back-office operations for internal users.

Owns:
- Admin login/session, diagnostics, users, company settings, portal settings.
- Catalog/search/import/export controls used by internal staff.
- Sales, purchasing, and price-list management screens.

Must not own:
- Customer portal session or portal customer data isolation.
- External warehouse partner API authentication.
- Long-running catalog sync internals outside an explicit admin action.

Rules:
- Frontend entry remains routed through `app/App.tsx`, but admin-only UI should move here in small slices.
- API calls must go through admin/app APIs that validate Supabase user session and role.
- Service-role access is allowed only after caller profile and role are verified.
