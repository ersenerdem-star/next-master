# System Restore Instructions

This archive is meant to recover the operational database state for Quote Desk if the live system is damaged or needs to be rebuilt.

## What the daily archive contains

- JSON snapshots for operational tables under `backups/daily/YYYY-MM-DD/run-HH-MM-SSZ/`
- `manifest.json` with row counts, git commit, and archive metadata
- this restore guide copied into the archive folder as `HELP-RESTORE.md`
- `package.json`
- `SUPABASE-MIGRATIONS-README.md`

## Fast recovery path

1. Restore the codebase
   - clone the repo again, or recover the repo folder
   - checkout the commit recorded in the archive `manifest.json`

2. Restore dependencies
   - run `npm install`

3. Restore environment variables
   - Netlify:
     - `SUPABASE_URL`
     - `SUPABASE_ANON_KEY`
     - `SUPABASE_SERVICE_ROLE_KEY`
     - `RESEND_API_KEY`
     - `EMAIL_FROM`

4. Rebuild database structure
   - open Supabase SQL Editor
   - run migrations in the order documented in `supabase/migrations/README.md`
   - confirm core tables and RPC functions exist before loading archive data

5. Rehydrate operational data
   - use the JSON files in the archive folder as the source of truth
   - restore in this order:
     1. `brands`
     2. `profiles`
     3. `company_profiles`
     4. `customers`
     5. `vendors`
     6. `warehouses`
     7. `catalog_products`
     8. `supplier_prices`
     9. `customer_price_lists`
     10. `customer_price_list_items`
     11. `item_code_references`
     12. `sales_orders`
     13. `purchase_orders`
     14. `invoices`
     15. `bills`
     16. `payments_received`
     17. `payments_made`
     18. `purchase_receives`
     19. `inventory_movements`
     20. `stock_transfers`
     21. `portal_invites`
     22. `outbound_emails`
     23. `email_templates`
     24. `user_presence`

6. Validate the app
   - log into admin
   - open:
     - `Items > Catalog`
     - `Sales > Sales Orders`
     - `Purchases > Purchase Orders`
     - `Reports > Item Transactions`
     - `Settings > Diagnostics`
   - confirm row counts and recent documents match expectations

## Operational notes

- The archive is data-first. It does not replace git or migration history.
- The archive is intended for disaster recovery, rollback investigation, and audit snapshots.
- If a restore is needed, keep the broken environment untouched until the recovered environment is validated.
