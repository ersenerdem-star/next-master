alter table customers
add column if not exists price_list_margin_percent numeric(10,2) null;
