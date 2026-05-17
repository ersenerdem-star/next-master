# Next Master localStorage migration plan

The app still has several browser-only modules. These should move to Supabase so the system can replace the old app cleanly and behave consistently across machines.

## Current browser-only modules

1. `localCustomers`
   - file:
     - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/apps/web/src/shared/localCustomers.ts`
   - current use:
     - Sales > Customers
     - Sales Order customer lookup

2. `localOrders`
   - file:
     - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/apps/web/src/shared/localOrders.ts`
   - current use:
     - Sales Orders
     - Purchase Orders
     - Invoices

3. `companyProfile`
   - file:
     - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/apps/web/src/shared/companyProfile.ts`
   - current use:
     - Settings > Company Profile
     - Sales Order / Invoice PDF rendering

4. `localPortal`
   - file:
     - `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/apps/web/src/shared/localPortal.ts`
   - current use:
     - Settings > Customer & Vendor Portal Access

## Migration priority

### Phase 1

Move the highest-risk business records first:

1. `customers`
2. `sales_orders`
3. `sales_order_lines`
4. `purchase_orders`
5. `purchase_order_lines`
6. `invoices`
7. `invoice_lines`

Reason:
- these are core operational records
- they must survive browser changes and device changes

### Phase 2

Move supporting records:

1. `company_profiles`
2. `portal_invites`

Reason:
- these are important, but not as critical as orders and invoices

## Proposed tables

### customers
- id
- organization_id
- customer_number
- customer_type
- salutation
- first_name
- last_name
- company_name
- display_name
- email
- work_phone
- mobile_phone
- language
- tax_rate
- company_id
- currency
- payment_terms
- contract_nr
- price_list_type
- billing_address
- shipping_address
- contact_persons
- custom_fields
- reporting_tags
- remarks
- created_at
- updated_at

### company_profiles
- id
- organization_id
- company_name
- email
- phone
- website
- tax_office
- tax_number
- address
- bank_details
- footer_note
- logo_data_url
- created_at
- updated_at

### sales_orders
- id
- organization_id
- sales_order_no
- customer_id nullable
- customer_name snapshot
- seller_company_id nullable
- purchase_company_id nullable
- quote_date
- currency
- customer_type
- shipping_cost
- discount_amount
- supplier_mode
- delivery_term
- payment_terms
- packing_details
- contract_nr
- notes
- status
- purchase_total
- sales_total
- profit_total
- margin_percent
- confirmed_at nullable
- created_at
- updated_at

### sales_order_lines
- id
- sales_order_id
- line_no
- requested_code
- resolved_code
- brand
- description
- oem_no
- hs_code
- origin
- weight_kg
- qty
- supplier_name
- supplier_id nullable
- buy_price
- sell_price
- price_date
- notes
- code_changed
- replacement_reason
- buy_total
- line_total

### purchase_orders
- id
- organization_id
- supplier_id nullable
- supplier_name
- purchase_company_id nullable
- sales_order_id nullable
- sales_order_no nullable
- customer_name snapshot
- status
- currency
- total_amount
- line_count
- created_at
- updated_at

### purchase_order_lines
- id
- purchase_order_id
- line_no
- sales_order_line_id nullable
- product_code
- old_code
- brand
- description
- qty
- oem_no
- supplier_name
- buy_price
- line_total
- origin
- notes

### invoices
- id
- organization_id
- invoice_no
- sales_order_id nullable
- sales_order_no nullable
- customer_id nullable
- customer_name snapshot
- seller_company_id nullable
- quote_date
- due_date
- currency
- terms
- contract_nr
- packing_details
- discount_amount
- shipping_handling
- subtotal_amount
- total_amount
- notes
- status
- created_at
- updated_at

### invoice_lines
- id
- invoice_id
- line_no
- sales_order_line_id nullable
- product_code
- old_code
- brand
- description
- qty
- oem_no
- hs_code
- weight_kg
- supplier_name
- buy_price
- sell_price
- purchase_total
- sales_total
- profit_total
- margin_percent
- origin
- notes

### portal_invites
- id
- organization_id
- party_type
- party_name
- email
- contact_name
- status
- invite_token
- last_sent_at
- access_can_view_account
- access_can_view_invoices
- access_can_view_payments
- access_can_view_orders
- created_at
- updated_at

## Implementation rule

From this point:
- do not add new business-critical data to localStorage
- new persistence work should go directly to Supabase
