## Warehouse Stock Sharing API

This project now supports exposing selected warehouse stock to external partner firms through a token-based API.

### Scope

- Each API client is limited to selected warehouses
- Dropship warehouses are excluded
- API keys are stored as hashes
- Plain API keys are shown only once on create or rotate
- Response can optionally include:
  - zero-stock rows
  - unit cost and stock value

### Required SQL

Run:

- `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260530_37_outbound_warehouse_stock_api.sql`
- `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/supabase/migrations/20260530_38_warehouse_partner_security_and_snapshot.sql`

### Admin setup

Go to:

- `Inventory > Warehouses > Partner API Clients`

For each partner:

1. Add API client
2. Set:
   - `Client Name`
   - `Partner Name`
   - `Status`
   - optional `Expires At`
3. Select allowed stocked warehouses
4. Optionally enable:
   - `Include zero-stock rows`
   - `Expose unit cost and stock value`
   - `Require HMAC signed requests`
   - `Open separate order submit endpoint`
5. Optionally enter allowlisted public IPs
   - one per line
   - exact IP or IPv4 CIDR
   - examples:
     - `203.0.113.10`
     - `203.0.113.0/24`
6. Save
7. Copy the generated API key immediately

### Endpoint

- `GET /api/warehouse-stock-feed`

Auth:

- Header: `x-api-key: <generated-key>`

Alternative:

- `Authorization: Bearer <generated-key>`

Signed request headers:

- `x-timestamp`
- `x-signature`

HMAC rule:

- use the generated API key itself as the HMAC secret
- canonical string:
  - `METHOD`
  - `PATH`
  - sorted query string
  - timestamp
  - sha256 hex of raw body

### Query parameters

- `warehouse_code`
- `brand`
- `code`
- `include_zero=true`

Examples:

- `/api/warehouse-stock-feed`
- `/api/warehouse-stock-feed?warehouse_code=WH-01`
- `/api/warehouse-stock-feed?brand=Bosch`
- `/api/warehouse-stock-feed?code=0004771302`

### Separate order endpoint

- `POST /api/warehouse-order-submit`

This endpoint is separate from the stock feed and is disabled by default.

It only accepts requests when:

- the API client is active
- the API key is valid
- the IP is allowlisted
- HMAC signature is valid
- `Open separate order submit endpoint` is enabled

### Response shape

```json
{
  "ok": true,
  "generated_at": "2026-05-30T12:00:00.000Z",
  "client_name": "Partner Feed 1",
  "partner_name": "Outside Firm",
  "warehouse_count": 1,
  "item_count": 245,
  "warehouses": [
    {
      "id": "uuid",
      "warehouse_code": "WH-01",
      "warehouse_name": "Main Warehouse",
      "warehouse_kind": "internal"
    }
  ],
  "items": [
    {
      "warehouse_id": "uuid",
      "warehouse_code": "WH-01",
      "warehouse_name": "Main Warehouse",
      "brand": "Bosch",
      "product_code": "0 986 020 131",
      "old_code": "",
      "description": "Oil filter",
      "origin": "DE",
      "on_hand_qty": 12,
      "available_qty": 12,
      "unit_cost": 4.2,
      "stock_value": 50.4,
      "last_moved_at": "2026-05-30T10:22:00.000Z"
    }
  ]
}
```

### Security model

- Only active API clients can read
- Expired keys are rejected
- IP allowlist is enforced when configured
- HMAC signed requests are enforced by default
- Only assigned warehouses are exposed
- `dropship` warehouses are never exposed
- API key values are not stored in plain text
- Each successful request updates:
  - `last_used_at`
  - `last_used_ip`
- Requests are logged in:
  - `warehouse_api_request_logs`
- External order submissions are stored in:
  - `warehouse_api_order_requests`

### Notes

- This is a stock snapshot API, not an order API
- Stock feed now reads from precomputed `warehouse_stock_snapshots`
- Snapshot rows are maintained from `inventory_movements`
- Order submit is intentionally separate from stock feed and currently writes into a request inbox table instead of creating live sales orders directly
