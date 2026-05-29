## Next Master backend source of truth

This folder is now the active SQL source for the `Next Master` app.

Rule:
- frontend work happens only in:
  - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp`
- new database changes are stored only in:
  - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations`
- the old repo is reference-only from this point forward:
  - `/Users/ersen/Documents/Codex/2026-04-17-make-an-app-for-following-file`

### Current migration set

These files were copied into this project because the app actively depends on them:

1. `20260511_item_code_references.sql`
   - old/new code mapping table used by Items and Sales Orders
2. `20260513_01_performance_indexes.sql`
   - performance indexes for supplier/master queries
3. `20260513_02_cloud_admin_rpc.sql`
   - admin/user RPCs
4. `20260513_03_cloud_catalog_rpc.sql`
   - cloud catalog paging
5. `20260513_04_cloud_suppliers_rpc.sql`
   - supplier list, supplier prices, brand summary
6. `20260513_05_cloud_master_rpc.sql`
   - master comparison/report RPC
7. `20260513_06_cloud_quote_rpc.sql`
   - quote line resolve and supplier options
8. `20260513_07_cloud_quotes_rpc.sql`
   - quote list/detail RPCs
9. `20260513_08_bulk_import_rpc.sql`
   - fast catalog and supplier imports
10. `20260513_09_cloud_save_quote_rpc.sql`
   - quote save RPC for cloud-side persistence work
11. `20260513_10_business_records_phase1.sql`
   - customers, company profiles, portal invites
12. `20260513_11_orders_phase2.sql`
   - sales orders, purchase orders, invoices
13. `20260513_12_documents_phase3.sql`
   - bills
14. `20260513_13_email_templates.sql`
   - email templates and outbound mail queue
15. `20260513_14_vendors_phase4.sql`
   - vendors
16. `20260513_15_payments_phase5.sql`
   - payments received and payments made
17. `20260513_16_customer_margin.sql`
   - customer-level price list margin extension
18. `20260513_17_inventory_phase1.sql`
   - warehouses
19. `20260513_18_public_schema_data_api_grants.sql`
   - Data API compatibility grants for current and future public tables
20. `20260513_19_inventory_phase2.sql`
   - purchase receives, inventory movements, and user_presence RLS/grants hardening
21. `20260529_26_supabase_api_explicit_grants_hardening.sql`
   - explicit Data API and RPC default grants for future `public` tables, sequences, and functions

### Run order in Supabase SQL Editor

Use this order when the target project is missing or outdated:

1. `20260511_item_code_references.sql`
2. `20260513_01_performance_indexes.sql`
3. `20260513_02_cloud_admin_rpc.sql`
4. `20260513_03_cloud_catalog_rpc.sql`
5. `20260513_04_cloud_suppliers_rpc.sql`
6. `20260513_05_cloud_master_rpc.sql`
7. `20260513_06_cloud_quote_rpc.sql`
8. `20260513_07_cloud_quotes_rpc.sql`
9. `20260513_08_bulk_import_rpc.sql`
10. `20260513_09_cloud_save_quote_rpc.sql`
11. `20260513_10_business_records_phase1.sql`
12. `20260513_11_orders_phase2.sql`
13. `20260513_12_documents_phase3.sql`
14. `20260513_13_email_templates.sql`
15. `20260513_14_vendors_phase4.sql`
16. `20260513_15_payments_phase5.sql`
17. `20260513_16_customer_margin.sql`
18. `20260513_17_inventory_phase1.sql`
19. `20260513_18_public_schema_data_api_grants.sql`
20. `20260513_19_inventory_phase2.sql`
21. `20260529_26_supabase_api_explicit_grants_hardening.sql`

### Public table standard

Starting with the Supabase Data API grant change, every new table in `public` must be created with this checklist in mind:

1. `create table`
2. explicit `grant`
3. `alter table ... enable row level security`
4. `create policy`
5. any required indexes

Do not rely on implicit access.

Current project-wide safety net:
- `20260513_18_public_schema_data_api_grants.sql`
  - grants current `public` tables to `authenticated` and `service_role`
  - sets default privileges for future `public` tables and sequences
- `20260529_26_supabase_api_explicit_grants_hardening.sql`
  - repeats the safety net with `for role postgres`
  - adds default privileges for future `public` functions
  - keeps RPC access from breaking when Supabase tightens Data API defaults

Still required per table:
- RLS enablement
- correct policies
- any additional role narrowing beyond the global grants

### Copy-paste table pattern

Use this pattern for any new business table exposed through `supabase-js` / PostgREST:

```sql
create table if not exists public.your_table (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

grant select, insert, update, delete
on public.your_table
to authenticated;

grant select, insert, update, delete
on public.your_table
to service_role;

alter table public.your_table enable row level security;

drop policy if exists your_table_select_org on public.your_table;
create policy your_table_select_org on public.your_table
for select
using (
  organization_id = current_profile_org_id()
);

drop policy if exists your_table_write_org on public.your_table;
create policy your_table_write_org on public.your_table
for all
using (
  organization_id = current_profile_org_id()
)
with check (
  organization_id = current_profile_org_id()
);
```

### Important scope note

These SQL files do not change Supabase auth users or their passwords by themselves.

What they do change:
- RPC functions
- indexes
- item code reference table
- import behavior

What they do not change:
- existing user login names
- existing user passwords
- existing auth accounts
