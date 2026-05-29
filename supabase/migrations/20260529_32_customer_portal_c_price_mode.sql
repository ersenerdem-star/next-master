alter table customers
add column if not exists portal_c_price_mode text not null default 'standard';

alter table customers
drop constraint if exists customers_portal_c_price_mode_check;

alter table customers
add constraint customers_portal_c_price_mode_check
check (portal_c_price_mode in ('standard', 'prefer_c_when_available'));
