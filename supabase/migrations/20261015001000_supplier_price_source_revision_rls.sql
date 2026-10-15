-- Revision metadata is server-side state. Keep the public-schema tables
-- unreachable through browser roles even if a future grant is added.
alter table public.supplier_price_source_versions enable row level security;
alter table public.supplier_price_source_global_version enable row level security;

revoke all on table public.supplier_price_source_versions from public, anon, authenticated;
revoke all on table public.supplier_price_source_global_version from public, anon, authenticated;
grant select on table public.supplier_price_source_versions, public.supplier_price_source_global_version to service_role;
