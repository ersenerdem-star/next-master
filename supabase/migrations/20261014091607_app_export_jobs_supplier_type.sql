-- Supplier exports share the existing job lifecycle and storage contract.
-- Preserve the five deployed export types and admit the newly connected source.
alter table if exists public.app_export_jobs drop constraint if exists app_export_jobs_export_type_check;
alter table if exists public.app_export_jobs add constraint app_export_jobs_export_type_check
  check (export_type in ('admin_price_list','portal_price_list','catalog_master','catalog_export','supplier_report','supplier_price_list'));
