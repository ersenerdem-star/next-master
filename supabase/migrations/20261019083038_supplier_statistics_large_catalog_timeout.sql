-- Exact, read-only admin counts now cover more than two million effective SKUs.
-- Keep all tenant, date, deduplication and publication fences unchanged.
ALTER FUNCTION public.get_supplier_current_price_statistics()
  SET statement_timeout = '30s';

NOTIFY pgrst, 'reload schema';
