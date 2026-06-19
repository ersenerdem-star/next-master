alter table public.invoices
  add column if not exists sales_order_ids text[] not null default '{}';

update public.invoices
set sales_order_ids = array[sales_order_id]
where coalesce(array_length(sales_order_ids, 1), 0) = 0
  and coalesce(sales_order_id, '') <> '';

create index if not exists idx_invoices_org_sales_order_ids
  on public.invoices using gin (sales_order_ids);
