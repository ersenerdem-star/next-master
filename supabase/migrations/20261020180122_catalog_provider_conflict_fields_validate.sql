set lock_timeout='250ms';set statement_timeout='5s';
alter table public.product_attribute_conflicts validate constraint product_attribute_conflicts_field_name_check;
