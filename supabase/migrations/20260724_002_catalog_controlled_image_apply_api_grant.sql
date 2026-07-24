-- NM-CATALOG-WP2-F2-API: permit the authenticated server command to invoke
-- the bounded F2 transaction. This grants no table mutation privilege.

grant execute on function public.apply_catalog_observation_review_image(text, uuid, integer, text, text, text)
to authenticated;

comment on function public.apply_catalog_observation_review_image(text, uuid, integer, text, text, text) is
  'WP2-F2 controlled image Apply transaction. The F2-API command route validates the request and caller; this DB function remains the tenant, authorization, idempotency, provenance, and mutation authority. No direct table mutation grant is provided.';
