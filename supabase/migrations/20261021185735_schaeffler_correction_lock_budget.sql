-- Catalogue summary triggers share an organization row with existing imports.
-- Allow a short bounded wait for their transaction without skipping triggers,
-- releasing source identity checks or increasing another worker's budget.
set local lock_timeout='2s';
alter function public.apply_catalog_spareto_correction_item(uuid,uuid,uuid,integer)
 set lock_timeout='2s';
alter function public.apply_catalog_spareto_correction_item(uuid,uuid,uuid,integer)
 set statement_timeout='8s';
