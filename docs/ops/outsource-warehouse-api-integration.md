## Outsourced Warehouse API Integration

This project now supports a warehouse type of `outsourced`.

### What the integration does

- Marks a warehouse as externally managed
- Stores API connection metadata on the warehouse record
- Allows a manual `Sync API Stock` action from the warehouse setup screen
- Converts the external stock snapshot into internal `inventory_movements` adjustment rows
- Updates the normal `On Hand` and `Stock Movements` screens without a separate stock model
- Logs each sync run in `warehouse_external_sync_runs`

### Required SQL

Run:

- `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260530_35_outsourced_warehouse_api_sync.sql`

### Supported warehouse settings

- `Warehouse Type`
  - `Internal Warehouse`
  - `Outsourced Warehouse`
- `Outsource Partner`
- `API Provider`
- `API URL`
- `Location Code`
- `Auth Type`
  - `No Auth`
  - `Bearer Token from Env`
- `Token Env Name`
- `Sync Mode`
  - `Manual API Sync Enabled`
  - `Disabled`

### URL placeholders

The API URL supports:

- `{{location_code}}`
- `{{warehouse_code}}`
- `{{warehouse_name}}`
- `{{partner_name}}`

Example:

`https://partner.example/api/stock?location={{location_code}}`

### Expected external payload

The sync endpoint accepts either:

1. A raw JSON array
2. An object with one of these array keys:
   - `items`
   - `data`
   - `rows`
   - `stock`
   - `results`

Supported field names per item:

- Brand:
  - `brand`
  - `brand_name`
  - `manufacturer`
- Product code:
  - `product_code`
  - `code`
  - `sku`
  - `item_code`
  - `part_no`
- Quantity:
  - `qty_on_hand`
  - `on_hand_qty`
  - `qty`
  - `quantity`
  - `stock`
  - `available_qty`
- Optional:
  - `old_code`
  - `reference_code`
  - `legacy_code`
  - `description`
  - `name`
  - `product_name`
  - `origin`
  - `country_of_origin`
  - `unit_cost`
  - `cost`
  - `average_cost`

### Auth

If the partner requires bearer auth:

1. Set warehouse `Auth Type = Bearer Token from Env`
2. Enter a Netlify environment variable name in `Token Env Name`
3. Add that env var in Netlify site settings

The value itself is not stored in the database. Only the env var name is stored.

### Sync behavior

- The external API is treated as the source of truth for that outsourced warehouse
- Sync compares current on-hand stock with the external snapshot
- Differences are written as `adjustment` movements with:
  - `document_type = warehouse_api_sync`
- Missing items in the external snapshot are zeroed out through negative adjustments

### Current scope

- Manual sync is implemented
- Automatic scheduled sync is not implemented yet
- Custom per-partner adapters are not implemented yet

If a partner API does not fit the generic JSON shape above, add a provider-specific adapter in:

- `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/netlify/functions/admin-sync-warehouse-stock.mts`
