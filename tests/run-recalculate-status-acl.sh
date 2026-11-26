#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
container="nm-recalc-acl-test-$$"
tmp="$(mktemp -d)"
trap 'docker rm -f "$container" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT INT TERM
docker run -d --rm --name "$container" -e POSTGRES_PASSWORD=localtest postgres:17-alpine >/dev/null
for n in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29 30; do docker exec "$container" pg_isready -U postgres >/dev/null 2>&1 && break; sleep 1; done
psqlrun() { docker exec -i "$container" psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres "$@"; }
psqlrun < tests/sql/payment_integrity_setup.sql >/dev/null
psqlrun <<'SQL' >/dev/null
alter table invoices add column status text default 'confirmed', add column total_amount numeric default 100, add column updated_at timestamptz default now();
alter table invoices add column sales_order_id text, add column sales_order_ids text[], add column warehouse_id uuid, add column warehouse_code text, add column warehouse_name text, add column sales_order_no text, add column seller_company text, add column purchase_company text, add column quote_date text, add column delivery_term text, add column payment_terms text, add column due_date text, add column contract_nr text, add column packing_details text, add column notes text, add column subtotal numeric, add column discount_amount numeric, add column shipping_cost numeric, add column purchase_total numeric, add column profit_total numeric, add column margin_percent numeric, add column created_at timestamptz, add column lines jsonb;
create table sales_orders (id text primary key, organization_id uuid, currency text);
insert into sales_orders values ('SO','00000000-0000-0000-0000-000000000001','EUR');
create table warehouses (id uuid primary key, organization_id uuid);
alter table bills add column status text default 'confirmed', add column total_amount numeric default 100, add column updated_at timestamptz default now(), add column purchase_order_id text, add column purchase_order_no text, add column bill_date text, add column due_date text, add column payment_terms text, add column notes text, add column subtotal numeric, add column shipping_cost numeric, add column discount_amount numeric, add column created_at timestamptz, add column lines jsonb;
create table purchase_orders (id text primary key, organization_id uuid, currency text);
insert into purchase_orders values ('PO','00000000-0000-0000-0000-000000000001','EUR');
grant select on invoices,bills,payments_received,payments_made to authenticated;
SQL
psqlrun < supabase/migrations/20260707_94_payment_atomic_status_boundary.sql >/dev/null
sed -n '/^create or replace function public.save_invoice_atomic(/,/^create or replace function public.save_bill_atomic(/p' supabase/migrations/20260707_95_invoice_bill_guarded_boundary.sql | sed '$d' | psqlrun >/dev/null
psqlrun < supabase/migrations/20261126134915_invoice_edit_versions.sql >/dev/null
sed -n '/^create or replace function public.save_bill_atomic(/,/^grant execute on function public.save_invoice_atomic/p' supabase/migrations/20260707_95_invoice_bill_guarded_boundary.sql | sed '$d' | psqlrun >/dev/null
psqlrun < supabase/migrations/20261126133711_payment_integrity_guard.sql >/dev/null
psqlrun < supabase/migrations/20261126140500_payment_version_guard.sql >/dev/null
psqlrun < supabase/migrations/20261126141700_payment_delete_version_guard.sql >/dev/null
psqlrun < supabase/migrations/20261126143500_bill_version_guard.sql >/dev/null
psqlrun < supabase/migrations/20261126144500_recalculate_status_acl.sql >/dev/null
psqlrun <<'SQL' >/dev/null
DO $$ BEGIN
 if has_function_privilege('authenticated','public.recalculate_invoice_paid_status_for_org(uuid,text)','execute') or has_function_privilege('authenticated','public.recalculate_bill_paid_status_for_org(uuid,text)','execute') or has_function_privilege('anon','public.recalculate_bill_paid_status_for_org(uuid,text)','execute') then raise exception 'untrusted helper access'; end if;
 if not has_function_privilege('service_role','public.recalculate_invoice_paid_status_for_org(uuid,text)','execute') or not has_function_privilege('service_role','public.recalculate_bill_paid_status_for_org(uuid,text)','execute') then raise exception 'service access lost'; end if;
END $$;
set role authenticated;
DO $$ DECLARE
 r jsonb; v text; st text;
BEGIN
 r := public.save_payment_received_atomic('{"id":"R","invoice_id":"A","amount":100,"currency":"EUR","status":"confirmed"}'::jsonb,null);
 select status into st from invoices where id='A'; if st <> 'paid' then raise exception 'receipt did not recalculate'; end if;
 v := r->'payment'->>'updated_at';
 r := public.delete_payment_received_guarded('R',v);
 select status into st from invoices where id='A'; if st <> 'confirmed' then raise exception 'receipt delete did not recalculate'; end if;
 r := public.save_payment_made_atomic('{"id":"M","bill_id":"A","amount":100,"currency":"EUR","status":"confirmed"}'::jsonb,null);
 select status into st from bills where id='A'; if st <> 'paid' then raise exception 'payment did not recalculate'; end if;
 v := r->'payment'->>'updated_at';
 r := public.delete_payment_made_guarded('M',v);
 select status into st from bills where id='A'; if st <> 'confirmed' then raise exception 'payment delete did not recalculate'; end if;
 r := public.save_bill_atomic('{"id":"B","purchase_order_id":"PO","currency":"EUR","status":"draft","lines":[{"qty":1,"buy_price":10}]}'::jsonb,null);
 if r->'bill'->>'id' <> 'B' then raise exception 'bill save failed'; end if;
 r := public.save_invoice_atomic('{"id":"I","sales_order_id":"SO","currency":"EUR","status":"draft","lines":[{"qty":1,"sell_price":10,"buy_price":5}]}'::jsonb,null);
 if r->'invoice'->>'id' <> 'I' then raise exception 'invoice save failed'; end if;
END $$;
SQL
for fn in recalculate_invoice_paid_status_for_org recalculate_bill_paid_status_for_org; do
  if psqlrun -c "set role authenticated; select public.$fn('00000000-0000-0000-0000-000000000001','A')" >"$tmp/denied" 2>&1; then echo "$fn: direct access unexpectedly allowed" >&2; exit 1; fi
  grep -q 'permission denied' "$tmp/denied" || { cat "$tmp/denied" >&2; exit 1; }
done
echo 'PASS: helper ACL; authenticated payment create/delete and bill/invoice save recalculate correctly'
