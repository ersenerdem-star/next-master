-- Existing guarded OEM/model/dimensions/lifecycle writers need corresponding
-- conflict records. Keep the field allowlist explicit and preserve all rows.
set lock_timeout='250ms';set statement_timeout='3s';
alter table public.product_attribute_conflicts drop constraint product_attribute_conflicts_field_name_check;
alter table public.product_attribute_conflicts add constraint product_attribute_conflicts_field_name_check
 check(field_name=any(array['description','origin','hs_code','weight_kg','ean',
  'oem_no','vehicle','vehicle_model','market_segment','dimensions','lifecycle_status'])) not valid;
