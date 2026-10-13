-- The published-price quote bridge uses a compact-code lookup only when an
-- exact SKU misses. Keep that bounded on large releases as well as in staging.
create index if not exists idx_release_rows_compact_identity
  on public.supplier_price_release_rows
  (release_id, public.normalize_part_code(product_code));
