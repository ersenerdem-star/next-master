-- Publication refreshes the same cross-brand audit inside its locked transaction.
-- Give only the existing service-only publication RPC the matching bounded budget.
-- Actor, scope, source, review-revision and previous-publication fences are unchanged.
ALTER FUNCTION public.publish_supplier_price_release_production(text,uuid,uuid,uuid,uuid,uuid,uuid,bigint,uuid)
  SET statement_timeout = '45s';

NOTIFY pgrst, 'reload schema';
