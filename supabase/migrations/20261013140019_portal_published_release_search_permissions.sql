-- The portal service has EXECUTE on this narrow search RPC but no direct
-- SELECT grants on the published release tables. Preserve the service-only
-- EXECUTE grants from 140018 and execute the scoped read as the function owner.
alter function public.cloud_portal_published_price_search_page_v3(uuid,uuid,text,integer)
  security definer;
alter function public.cloud_portal_published_price_search_page_v3(uuid,uuid,text,integer)
  set search_path to '';
