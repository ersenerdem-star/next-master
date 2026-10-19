-- Catalog metadata writes touch existing catalog indexes and integrity triggers.
-- Allow occasional slower commits without changing global/client role limits.
-- Only the service-role-only write RPC gets this exception; it remains below
-- the background worker's 25-second request deadline and keeps 100-row commits.
alter function public.apply_supplier_catalog_enrichment_batch(uuid,uuid,text,bigint,jsonb)
 set statement_timeout='20s';
notify pgrst, 'reload schema';
