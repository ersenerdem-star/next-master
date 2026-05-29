## Supabase Explicit Grants Audit

Date:
- 2026-05-29

Reason:
- Supabase is changing the default exposure behavior for new `public` tables and functions.
- This audit checks which existing migrations are self-contained and which ones rely on the later global grant safety-net migration.

Reference:
- [20260513_18_public_schema_data_api_grants.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_18_public_schema_data_api_grants.sql)
- [20260529_26_supabase_api_explicit_grants_hardening.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260529_26_supabase_api_explicit_grants_hardening.sql)

### Summary

Current production safety:
- Existing app behavior is protected by the project-wide grant migrations:
  - `20260513_18_public_schema_data_api_grants.sql`
  - `20260529_26_supabase_api_explicit_grants_hardening.sql`

What is still weak:
- Several older table-creation migrations are not self-contained.
- They create tables and RLS policies, but do not add explicit per-table `grant` statements inside the same file.
- They work only because a later migration grants access to all public tables.

Practical risk:
- Existing project: low, after running the hardening migration.
- Fresh rebuild from scratch: still works if the run order is respected.
- Engineering quality: medium issue, because the migrations are order-dependent instead of self-contained.

### Migrations Missing Explicit Per-Table Grants

These files create public tables but do not grant table privileges inside the same migration:

1. [20260511_item_code_references.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260511_item_code_references.sql)
   - table: `item_code_references`

2. [20260513_02_cloud_admin_rpc.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_02_cloud_admin_rpc.sql)
   - table: `user_presence`
   - note: later hardened in `20260513_19_inventory_phase2.sql`

3. [20260513_10_business_records_phase1.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_10_business_records_phase1.sql)
   - tables:
   - `customers`
   - `company_profiles`
   - `portal_invites`

4. [20260513_11_orders_phase2.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_11_orders_phase2.sql)
   - tables:
   - `sales_orders`
   - `purchase_orders`
   - `invoices`

5. [20260513_12_documents_phase3.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_12_documents_phase3.sql)
   - table: `bills`

6. [20260513_13_email_templates.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_13_email_templates.sql)
   - tables:
   - `email_templates`
   - `outbound_emails`

7. [20260513_14_vendors_phase4.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_14_vendors_phase4.sql)
   - table: `vendors`

8. [20260513_15_payments_phase5.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_15_payments_phase5.sql)
   - tables:
   - `payments_received`
   - `payments_made`

9. [20260513_17_inventory_phase1.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_17_inventory_phase1.sql)
   - table: `warehouses`

### Migrations Already Self-Contained for Table Grants

These already include explicit table grants:

1. [20260513_19_inventory_phase2.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260513_19_inventory_phase2.sql)
   - `purchase_receives`
   - `inventory_movements`
   - `user_presence`

2. [20260518_22_inventory_transfers.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260518_22_inventory_transfers.sql)
   - `stock_transfers`

### RPC / Function Status

Observed:
- Most RPC migrations already include explicit `grant execute on function ... to authenticated;`
- The new hardening migration also adds default `execute` grants for future public functions.

Practical conclusion:
- Function exposure risk is lower than table exposure risk in this repo.

### Recommended Next Step

Recommended engineering cleanup:
- patch the older table migrations so each one becomes self-contained:
  - `create table`
  - explicit `grant`
  - `enable row level security`
  - `create policy`

Why:
- safer for clean-room rebuilds
- less order-sensitive
- easier to reason about during incident recovery

### Current Decision

No urgent production outage is indicated.

Immediate action required:
1. run [20260529_26_supabase_api_explicit_grants_hardening.sql](/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260529_26_supabase_api_explicit_grants_hardening.sql) in Supabase SQL Editor

Recommended follow-up:
2. patch the older migrations listed above to make them self-contained
