-- Generated from captured PostgreSQL schema metadata; no business rows or secrets.
-- Production preparation only: this migration has not been applied remotely.
-- Apply FIRST in the reviewed price-engine manifest, before dependent feature migrations.
-- Reproduce with scripts/ops/generate-price-engine-foundation-bootstrap.mjs.
-- Metadata SHA-256: 6dc03e71e7a04fe2ef280ba8052e69c9497472b3778fff2c88394caa1c6ef44a
-- Legacy anonymous/authenticated TRUNCATE/TRIGGER/REFERENCES grants are intentionally excluded.
BEGIN;
SET LOCAL search_path = public, extensions, pg_catalog;
DO $foundation_baseline$
DECLARE required text; BEGIN
  FOREACH required IN ARRAY ARRAY['public.organizations','public.brands','public.suppliers','public.profiles','public.catalog_products','public.supplier_prices','public.supplier_price_import_runs','storage.objects','storage.buckets','auth.users','auth.sessions','public.profile_permissions'] LOOP
    IF to_regclass(required) IS NULL THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_RELATION_MISSING: %',required; END IF;
  END LOOP;
  FOREACH required IN ARRAY ARRAY['auth.role()','auth.uid()','public.current_profile_org_id()','public.current_profile_role()','public.profile_has_permission(text)','public.normalize_part_code(text)','public.normalize_catalog_product_code(text)','public.current_profile_department()','public.raw_profile_role(uuid)'] LOOP
    IF to_regprocedure(required) IS NULL THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_MISSING: %',required; END IF;
  END LOOP;
END $foundation_baseline$;
DO $foundation_storage_rls$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_class WHERE oid='storage.objects'::regclass AND relrowsecurity) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_STORAGE_RLS_REQUIRED'; END IF; END $foundation_storage_rls$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='user_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.user_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='factor_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.factor_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='aal' AND NOT a.attisdropped AND a.atttypid=to_regtype('auth.aal_level')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.aal'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='not_after' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.not_after'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='refreshed_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamp')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.refreshed_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='user_agent' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.user_agent'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='ip' AND NOT a.attisdropped AND a.atttypid=to_regtype('inet')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.ip'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='tag' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.tag'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='oauth_client_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.oauth_client_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='refresh_token_hmac_key' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.refresh_token_hmac_key'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='refresh_token_counter' AND NOT a.attisdropped AND a.atttypid=to_regtype('int8')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.refresh_token_counter'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.sessions') AND a.attname='scopes' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.sessions.scopes'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='instance_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.instance_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='aud' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.aud'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='role' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.role'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='encrypted_password' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.encrypted_password'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_confirmed_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_confirmed_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='invited_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.invited_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='confirmation_token' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.confirmation_token'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='confirmation_sent_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.confirmation_sent_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='recovery_token' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.recovery_token'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='recovery_sent_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.recovery_sent_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_change_token_new' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_change_token_new'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_change' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_change'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_change_sent_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_change_sent_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='last_sign_in_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.last_sign_in_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='raw_app_meta_data' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.raw_app_meta_data'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='raw_user_meta_data' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.raw_user_meta_data'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='is_super_admin' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.is_super_admin'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='phone' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.phone'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='phone_confirmed_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.phone_confirmed_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='phone_change' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.phone_change'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='phone_change_token' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.phone_change_token'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='phone_change_sent_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.phone_change_sent_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='confirmed_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.confirmed_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_change_token_current' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_change_token_current'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='email_change_confirm_status' AND NOT a.attisdropped AND a.atttypid=to_regtype('int2')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.email_change_confirm_status'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='banned_until' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.banned_until'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='reauthentication_token' AND NOT a.attisdropped AND a.atttypid=to_regtype('varchar')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.reauthentication_token'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='reauthentication_sent_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.reauthentication_sent_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='is_sso_user' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.is_sso_user'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='deleted_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.deleted_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('auth.users') AND a.attname='is_anonymous' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: auth.users.is_anonymous'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='organization_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.organization_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='normalized_name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.normalized_name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.brands') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.brands.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='organization_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.organization_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='brand_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.brand_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='product_code' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.product_code'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='normalized_code' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.normalized_code'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='description' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.description'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='oem_no' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.oem_no'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='normalized_oem' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.normalized_oem'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='hs_code' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.hs_code'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='origin' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.origin'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='weight_kg' AND NOT a.attisdropped AND a.atttypid=to_regtype('numeric')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.weight_kg'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='notes' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.notes'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='lifecycle_status' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.lifecycle_status'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='lifecycle_note' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.lifecycle_note'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='image_url' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.image_url'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='vehicle' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.vehicle'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='ean' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.ean'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='normalized_ean' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.normalized_ean'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='market_segment' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.market_segment'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='vehicle_model' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.vehicle_model'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='search_text' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.search_text'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='product_group_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.product_group_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='description_tr' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.description_tr'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.catalog_products') AND a.attname='dimensions' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.catalog_products.dimensions'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.organizations') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.organizations.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.organizations') AND a.attname='name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.organizations.name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.organizations') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.organizations.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='organization_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.organization_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='email' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.email'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='full_name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.full_name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='role' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.role'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='is_active' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.is_active'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='department' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.department'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='permissions' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.permissions'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='customer_scope_mode' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.customer_scope_mode'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profiles') AND a.attname='session_revoked_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profiles.session_revoked_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='organization_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.organization_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='normalized_name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.normalized_name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='contact_info' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.contact_info'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='is_active' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.is_active'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.suppliers') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.suppliers.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='bucket_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.bucket_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='name' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.name'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='owner' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.owner'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='last_accessed_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.last_accessed_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='metadata' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.metadata'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='path_tokens' AND NOT a.attisdropped AND a.atttypid=to_regtype('text[]')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.path_tokens'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='version' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.version'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='owner_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.owner_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='user_metadata' AND NOT a.attisdropped AND a.atttypid=to_regtype('jsonb')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.user_metadata'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='archived_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamptz')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.archived_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='is_delete_marker' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.is_delete_marker'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('storage.objects') AND a.attname='is_versioned' AND NOT a.attisdropped AND a.atttypid=to_regtype('bool')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: storage.objects.is_versioned'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='organization_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.organization_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='profile_id' AND NOT a.attisdropped AND a.atttypid=to_regtype('uuid')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.profile_id'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='permission_key' AND NOT a.attisdropped AND a.atttypid=to_regtype('text')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.permission_key'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='allowed' AND NOT a.attisdropped AND a.atttypid=to_regtype('boolean')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.allowed'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='created_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamp with time zone')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.created_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.profile_permissions') AND a.attname='updated_at' AND NOT a.attisdropped AND a.atttypid=to_regtype('timestamp with time zone')) THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_COLUMN_DRIFT: public.profile_permissions.updated_at'; END IF; END $foundation_baseline_column$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.current_profile_org_id()'))) IS DISTINCT FROM 'a25e504553d64d38e795258e2f453292' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.current_profile_org_id()'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.current_profile_role()'))) IS DISTINCT FROM 'ae3a4585671153b8ff77ba6997d66737' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.current_profile_role()'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.normalize_catalog_product_code(text)'))) IS DISTINCT FROM 'be15cebd4bce2b1a79a3bf544984069a' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.normalize_catalog_product_code(text)'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.normalize_part_code(text)'))) IS DISTINCT FROM 'edd1f94d3b82843d747cca74856c64e9' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.normalize_part_code(text)'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.profile_has_permission(text)'))) IS DISTINCT FROM 'aa3d95a792407467f85d257318040039' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.profile_has_permission(text)'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.current_profile_department()'))) IS DISTINCT FROM '3aa181f9dda6cd940d20910e33d6b04e' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.current_profile_department()'; END IF; END $foundation_baseline_function$;
DO $foundation_baseline_function$ BEGIN IF md5(pg_get_functiondef(to_regprocedure('public.raw_profile_role(uuid)'))) IS DISTINCT FROM '3aebfe1bf4f51ae0d098c8972533c49a' THEN RAISE EXCEPTION 'PRICE_ENGINE_BASELINE_FUNCTION_DRIFT: public.raw_profile_role(uuid)'; END IF; END $foundation_baseline_function$;
CREATE SCHEMA IF NOT EXISTS "supplier_price_ingestion_internal";
REVOKE ALL ON SCHEMA "supplier_price_ingestion_internal" FROM PUBLIC, anon, authenticated, service_role;
CREATE SCHEMA IF NOT EXISTS "supplier_price_validation_internal";
REVOKE ALL ON SCHEMA "supplier_price_validation_internal" FROM PUBLIC, anon, authenticated, service_role;
CREATE TABLE IF NOT EXISTS "public"."supplier_current_price_pointers" (
  "organization_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "publication_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_current_price_pointers_pkey" PRIMARY KEY (organization_id, supplier_id, brand_id)
);
REVOKE ALL ON TABLE "public"."supplier_current_price_pointers" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_current_price_pointers" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_current_price_pointers" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_publications" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "release_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "status" text DEFAULT 'pending'::text NOT NULL,
  "publication_version" bigint NOT NULL,
  "published_at" timestamp with time zone,
  "superseded_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_price_publications_pkey" PRIMARY KEY (id),
  CONSTRAINT "supplier_price_publications_release_unique" UNIQUE (release_id),
  CONSTRAINT "supplier_price_publications_scope_version_unique" UNIQUE (organization_id, supplier_id, brand_id, publication_version),
  CONSTRAINT "supplier_price_publications_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'published'::text, 'superseded'::text, 'rolled_back'::text]))
);
REVOKE ALL ON TABLE "public"."supplier_price_publications" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_publications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_publications" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_release_batches" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "release_id" uuid NOT NULL,
  "batch_number" integer NOT NULL,
  "cursor_start" bigint DEFAULT 0 NOT NULL,
  "cursor_end" bigint DEFAULT 0 NOT NULL,
  "row_count" integer DEFAULT 0 NOT NULL,
  "accepted_count" integer DEFAULT 0 NOT NULL,
  "rejected_count" integer DEFAULT 0 NOT NULL,
  "warning_count" integer DEFAULT 0 NOT NULL,
  "checksum" text,
  "status" text DEFAULT 'queued'::text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "worker_version" text,
  "error_code" text,
  "error_message" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "last_heartbeat_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "lease_owner" text,
  "lease_expires_at" timestamp with time zone,
  CONSTRAINT "supplier_price_release_batches_counts_check" CHECK (batch_number > 0 AND cursor_start >= 0 AND cursor_end >= cursor_start AND row_count >= 0),
  CONSTRAINT "supplier_price_release_batches_pkey" PRIMARY KEY (id),
  CONSTRAINT "supplier_price_release_batches_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'retrying'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text])),
  CONSTRAINT "supplier_price_release_batches_unique" UNIQUE (release_id, batch_number)
);
REVOKE ALL ON TABLE "public"."supplier_price_release_batches" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_release_batches" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_release_batches" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_release_events" (
  "id" bigint GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1 NO CYCLE) NOT NULL,
  "release_id" uuid NOT NULL,
  "event_type" text NOT NULL,
  "stage" text,
  "status" text,
  "cursor" bigint,
  "processed_rows" bigint,
  "total_rows" bigint,
  "attempt" integer,
  "worker_version" text,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_price_release_events_pkey" PRIMARY KEY (id)
);
REVOKE ALL ON TABLE "public"."supplier_price_release_events" FROM PUBLIC, anon, authenticated, service_role;
DO $foundation_sequence$ DECLARE name text; BEGIN name:=pg_get_serial_sequence('public.supplier_price_release_events','id'); EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',name); END $foundation_sequence$;
ALTER TABLE "public"."supplier_price_release_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_release_events" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_release_rows" (
  "id" bigint GENERATED ALWAYS AS IDENTITY (START WITH 1 INCREMENT BY 1 MINVALUE 1 CACHE 1 NO CYCLE) NOT NULL,
  "release_id" uuid NOT NULL,
  "source_row_number" bigint NOT NULL,
  "normalized_code" text NOT NULL,
  "product_code" text NOT NULL,
  "description" text,
  "oem_no" text,
  "ean" text,
  "vehicle" text,
  "vehicle_model" text,
  "market_segment" text,
  "dimensions" text,
  "weight" numeric,
  "description_tr" text,
  "origin" text,
  "tariff" text,
  "image_url" text,
  "buy_price" numeric,
  "currency" text,
  "moq" integer,
  "lead_time_days" integer,
  "notes" text,
  "valid_from" date,
  "row_hash" text,
  "row_status" text DEFAULT 'staged'::text NOT NULL,
  "error_code" text,
  "error_message" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_price_release_rows_pkey" PRIMARY KEY (id),
  CONSTRAINT "supplier_price_release_rows_row_check" CHECK (source_row_number > 0 AND normalized_code <> ''::text AND product_code <> ''::text),
  CONSTRAINT "supplier_price_release_rows_status_check" CHECK (row_status = ANY (ARRAY['staged'::text, 'accepted'::text, 'rejected'::text, 'warning'::text, 'conflict'::text]))
);
REVOKE ALL ON TABLE "public"."supplier_price_release_rows" FROM PUBLIC, anon, authenticated, service_role;
DO $foundation_sequence$ DECLARE name text; BEGIN name:=pg_get_serial_sequence('public.supplier_price_release_rows','id'); EXECUTE format('REVOKE ALL ON SEQUENCE %s FROM PUBLIC, anon, authenticated, service_role',name); END $foundation_sequence$;
ALTER TABLE "public"."supplier_price_release_rows" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_release_rows" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_release_validation_code_counts" (
  "release_id" uuid NOT NULL,
  "normalized_code" text NOT NULL,
  "row_count" bigint DEFAULT 0 NOT NULL,
  CONSTRAINT "supplier_price_release_validation_code_counts_pkey" PRIMARY KEY (release_id, normalized_code)
);
REVOKE ALL ON TABLE "public"."supplier_price_release_validation_code_counts" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_release_validation_code_counts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_release_validation_code_counts" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_release_validation_runs" (
  "release_id" uuid NOT NULL,
  "status" text DEFAULT 'queued'::text NOT NULL,
  "cursor" bigint DEFAULT 0 NOT NULL,
  "total_rows" bigint DEFAULT 0 NOT NULL,
  "accepted_rows" bigint DEFAULT 0 NOT NULL,
  "warning_rows" bigint DEFAULT 0 NOT NULL,
  "rejected_rows" bigint DEFAULT 0 NOT NULL,
  "conflict_rows" bigint DEFAULT 0 NOT NULL,
  "missing_price_rows" bigint DEFAULT 0 NOT NULL,
  "duplicate_rows" bigint DEFAULT 0 NOT NULL,
  "currency_count" integer DEFAULT 0 NOT NULL,
  "last_error" text,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_price_release_validation_runs_pkey" PRIMARY KEY (release_id),
  CONSTRAINT "supplier_price_release_validation_runs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'validated'::text, 'review_required'::text, 'failed'::text]))
);
REVOKE ALL ON TABLE "public"."supplier_price_release_validation_runs" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_release_validation_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_release_validation_runs" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_releases" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "supplier_id" uuid NOT NULL,
  "brand_id" uuid NOT NULL,
  "import_run_id" uuid,
  "source_file_path" text NOT NULL,
  "source_file_sha256" text NOT NULL,
  "mode" text DEFAULT 'replace'::text NOT NULL,
  "status" text DEFAULT 'received'::text NOT NULL,
  "source_date" date,
  "total_rows" bigint DEFAULT 0 NOT NULL,
  "accepted_rows" bigint DEFAULT 0 NOT NULL,
  "rejected_rows" bigint DEFAULT 0 NOT NULL,
  "warning_rows" bigint DEFAULT 0 NOT NULL,
  "conflict_rows" bigint DEFAULT 0 NOT NULL,
  "processed_rows" bigint DEFAULT 0 NOT NULL,
  "current_cursor" bigint DEFAULT 0 NOT NULL,
  "worker_version" text,
  "error_code" text,
  "error_message" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "uploaded_at" timestamp with time zone,
  "validated_at" timestamp with time zone,
  "published_at" timestamp with time zone,
  "superseded_at" timestamp with time zone,
  "archived_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "brand_identity_audit" jsonb,
  "review_revision" bigint DEFAULT 0 NOT NULL,
  "source_verification_required" boolean DEFAULT false NOT NULL,
  CONSTRAINT "supplier_price_releases_counts_check" CHECK (total_rows >= 0 AND accepted_rows >= 0 AND rejected_rows >= 0 AND warning_rows >= 0 AND conflict_rows >= 0 AND processed_rows >= 0 AND current_cursor >= 0),
  CONSTRAINT "supplier_price_releases_mode_check" CHECK (mode = ANY (ARRAY['replace'::text, 'merge'::text])),
  CONSTRAINT "supplier_price_releases_pkey" PRIMARY KEY (id),
  CONSTRAINT "supplier_price_releases_review_revision_check" CHECK (review_revision >= 0),
  CONSTRAINT "supplier_price_releases_status_check" CHECK (status = ANY (ARRAY['received'::text, 'uploaded'::text, 'parsing'::text, 'staged'::text, 'validating'::text, 'validated'::text, 'publishing'::text, 'catalog_enriching'::text, 'rollup_refreshing'::text, 'published'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'archived'::text]))
);
REVOKE ALL ON TABLE "public"."supplier_price_releases" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_releases" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_releases" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "public"."supplier_price_upload_sessions" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "idempotency_key" text NOT NULL,
  "storage_bucket" text DEFAULT 'supplier-price-imports'::text NOT NULL,
  "storage_object_path" text NOT NULL,
  "file_name" text NOT NULL,
  "content_type" text NOT NULL,
  "total_bytes" bigint NOT NULL,
  "uploaded_bytes" bigint DEFAULT 0 NOT NULL,
  "checksum_sha256" text,
  "tus_upload_url" text,
  "status" text DEFAULT 'created'::text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "last_heartbeat_at" timestamp with time zone,
  "expires_at" timestamp with time zone NOT NULL,
  "uploaded_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "error_code" text,
  "error_message" text,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "supplier_price_upload_sessions_attempt_check" CHECK (attempt >= 0),
  CONSTRAINT "supplier_price_upload_sessions_bytes_check" CHECK (total_bytes > 0 AND uploaded_bytes >= 0 AND uploaded_bytes <= total_bytes),
  CONSTRAINT "supplier_price_upload_sessions_idempotency_check" CHECK (length(TRIM(BOTH FROM idempotency_key)) > 0),
  CONSTRAINT "supplier_price_upload_sessions_path_check" CHECK (length(TRIM(BOTH FROM storage_object_path)) > 0),
  CONSTRAINT "supplier_price_upload_sessions_pkey" PRIMARY KEY (id),
  CONSTRAINT "supplier_price_upload_sessions_status_check" CHECK (status = ANY (ARRAY['created'::text, 'uploading'::text, 'uploaded'::text, 'aborted'::text, 'expired'::text, 'failed'::text]))
);
REVOKE ALL ON TABLE "public"."supplier_price_upload_sessions" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "public"."supplier_price_upload_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "public"."supplier_price_upload_sessions" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "supplier_price_ingestion_internal"."handoffs" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "storage_bucket" text NOT NULL,
  "source_path" text NOT NULL,
  "source_sha256" text NOT NULL,
  "source_bytes" bigint NOT NULL,
  "total_rows" bigint NOT NULL,
  "object_id" uuid NOT NULL,
  "object_version" text NOT NULL,
  "object_updated_at" timestamp with time zone NOT NULL,
  "workflow_id" text NOT NULL,
  "queue_name" text DEFAULT 'supplier-price-verified-shadow'::text NOT NULL,
  "status" text DEFAULT 'queued'::text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "lease_owner" text,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "enqueued_at" timestamp with time zone,
  CONSTRAINT "handoffs_attempt_check" CHECK (attempt >= 0),
  CONSTRAINT "handoffs_object_version_check" CHECK (length(object_version) > 0),
  CONSTRAINT "handoffs_pkey" PRIMARY KEY (id),
  CONSTRAINT "handoffs_queue_name_check" CHECK (queue_name = 'supplier-price-verified-shadow'::text),
  CONSTRAINT "handoffs_release_id_key" UNIQUE (release_id),
  CONSTRAINT "handoffs_session_id_key" UNIQUE (session_id),
  CONSTRAINT "handoffs_source_bytes_check" CHECK (source_bytes >= 1 AND source_bytes <= 1073741824),
  CONSTRAINT "handoffs_source_sha256_check" CHECK (source_sha256 ~ '^[0-9a-f]{64}$'::text),
  CONSTRAINT "handoffs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'dispatching'::text, 'enqueued'::text])),
  CONSTRAINT "handoffs_total_rows_check" CHECK (total_rows > 0),
  CONSTRAINT "handoffs_workflow_id_key" UNIQUE (workflow_id)
);
REVOKE ALL ON TABLE "supplier_price_ingestion_internal"."handoffs" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_price_ingestion_internal"."handoffs" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "supplier_price_ingestion_internal"."verification_requests" (
  "id" uuid DEFAULT gen_random_uuid() NOT NULL,
  "session_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "accepted_auth_session_id" uuid NOT NULL,
  "accepted_token_iat" bigint NOT NULL,
  "status" text DEFAULT 'queued'::text NOT NULL,
  "attempt" integer DEFAULT 0 NOT NULL,
  "worker_id" text,
  "lease_token" uuid,
  "lease_expires_at" timestamp with time zone,
  "next_attempt_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "last_error" text,
  "handoff_id" uuid,
  "created_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT clock_timestamp() NOT NULL,
  CONSTRAINT "verification_requests_pkey" PRIMARY KEY (id),
  CONSTRAINT "verification_requests_release_id_key" UNIQUE (release_id),
  CONSTRAINT "verification_requests_session_id_key" UNIQUE (session_id),
  CONSTRAINT "verification_requests_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'verifying'::text, 'verified'::text, 'failed'::text]))
);
REVOKE ALL ON TABLE "supplier_price_ingestion_internal"."verification_requests" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" NO FORCE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS "supplier_price_validation_internal"."review_decisions" (
  "id" uuid NOT NULL,
  "organization_id" uuid NOT NULL,
  "release_id" uuid NOT NULL,
  "actor_id" uuid NOT NULL,
  "request" jsonb NOT NULL,
  "receipt" jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "review_decisions_pkey" PRIMARY KEY (id)
);
REVOKE ALL ON TABLE "supplier_price_validation_internal"."review_decisions" FROM PUBLIC, anon, authenticated, service_role;
ALTER TABLE "supplier_price_validation_internal"."review_decisions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "supplier_price_validation_internal"."review_decisions" NO FORCE ROW LEVEL SECURITY;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='supplier_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.supplier_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='brand_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.brand_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='publication_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.publication_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_current_price_pointers') AND a.attname='updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_current_price_pointers.updated_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_current_price_pointers') AND conname='supplier_current_price_pointers_brand_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_current_price_pointers" ADD CONSTRAINT "supplier_current_price_pointers_brand_id_fkey" FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_brand_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_current_price_pointers') AND conname='supplier_current_price_pointers_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_current_price_pointers" ADD CONSTRAINT "supplier_current_price_pointers_pkey" PRIMARY KEY (organization_id, supplier_id, brand_id); ELSIF found_definition<>'PRIMARY KEY (organization_id, supplier_id, brand_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_current_price_pointers') AND conname='supplier_current_price_pointers_publication_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_current_price_pointers" ADD CONSTRAINT "supplier_current_price_pointers_publication_id_fkey" FOREIGN KEY (publication_id) REFERENCES public.supplier_price_publications(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (publication_id) REFERENCES supplier_price_publications(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_publication_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_current_price_pointers') AND conname='supplier_current_price_pointers_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_current_price_pointers" ADD CONSTRAINT "supplier_current_price_pointers_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_current_price_pointers') AND conname='supplier_current_price_pointers_supplier_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_current_price_pointers" ADD CONSTRAINT "supplier_current_price_pointers_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_supplier_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='supplier_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.supplier_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='brand_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.brand_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='publication_version' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.publication_version'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='published_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.published_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='superseded_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.superseded_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_publications') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_publications.created_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_brand_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_brand_id_fkey" FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_brand_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_release_unique'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_release_unique" UNIQUE (release_id); ELSIF found_definition<>'UNIQUE (release_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_release_unique'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_scope_version_unique'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_scope_version_unique" UNIQUE (organization_id, supplier_id, brand_id, publication_version); ELSIF found_definition<>'UNIQUE (organization_id, supplier_id, brand_id, publication_version)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_scope_version_unique'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_status_check" CHECK (status = ANY (ARRAY['pending'::text, 'published'::text, 'superseded'::text, 'rolled_back'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''pending''::text, ''published''::text, ''superseded''::text, ''rolled_back''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_status_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_publications') AND conname='supplier_price_publications_supplier_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_publications" ADD CONSTRAINT "supplier_price_publications_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_publications.supplier_price_publications_supplier_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='batch_number' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.batch_number'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='cursor_start' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.cursor_start'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='cursor_end' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.cursor_end'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='row_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.row_count'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='accepted_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.accepted_count'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='rejected_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.rejected_count'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='warning_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.warning_count'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='checksum' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.checksum'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='attempt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.attempt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='worker_version' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.worker_version'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='error_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.error_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='error_message' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.error_message'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='started_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.started_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='completed_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.completed_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='last_heartbeat_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.last_heartbeat_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.created_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='lease_owner' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.lease_owner'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_batches') AND a.attname='lease_expires_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_batches.lease_expires_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_batches') AND conname='supplier_price_release_batches_counts_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_batches" ADD CONSTRAINT "supplier_price_release_batches_counts_check" CHECK (batch_number > 0 AND cursor_start >= 0 AND cursor_end >= cursor_start AND row_count >= 0); ELSIF found_definition<>'CHECK (batch_number > 0 AND cursor_start >= 0 AND cursor_end >= cursor_start AND row_count >= 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_counts_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_batches') AND conname='supplier_price_release_batches_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_batches" ADD CONSTRAINT "supplier_price_release_batches_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_batches') AND conname='supplier_price_release_batches_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_batches" ADD CONSTRAINT "supplier_price_release_batches_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_batches') AND conname='supplier_price_release_batches_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_batches" ADD CONSTRAINT "supplier_price_release_batches_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'retrying'::text, 'completed'::text, 'failed'::text, 'dead_letter'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''queued''::text, ''running''::text, ''retrying''::text, ''completed''::text, ''failed''::text, ''dead_letter''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_status_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_batches') AND conname='supplier_price_release_batches_unique'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_batches" ADD CONSTRAINT "supplier_price_release_batches_unique" UNIQUE (release_id, batch_number); ELSIF found_definition<>'UNIQUE (release_id, batch_number)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_unique'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='a') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='event_type' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.event_type'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='stage' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.stage'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='cursor' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.cursor'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='processed_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.processed_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='total_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.total_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='attempt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.attempt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='worker_version' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.worker_version'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='error_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.error_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='error_message' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.error_message'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_events') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_events.created_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_events') AND conname='supplier_price_release_events_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_events" ADD CONSTRAINT "supplier_price_release_events_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_events.supplier_price_release_events_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_events') AND conname='supplier_price_release_events_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_events" ADD CONSTRAINT "supplier_price_release_events_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_events.supplier_price_release_events_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='a') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='source_row_number' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.source_row_number'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='normalized_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.normalized_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='product_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.product_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='description' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.description'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='oem_no' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.oem_no'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='ean' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.ean'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='vehicle' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.vehicle'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='vehicle_model' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.vehicle_model'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='market_segment' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.market_segment'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='dimensions' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.dimensions'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='weight' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='numeric' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.weight'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='description_tr' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.description_tr'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='origin' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.origin'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='tariff' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.tariff'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='image_url' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.image_url'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='buy_price' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='numeric' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.buy_price'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='currency' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.currency'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='moq' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.moq'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='lead_time_days' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.lead_time_days'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='notes' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.notes'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='valid_from' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='date' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.valid_from'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='row_hash' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.row_hash'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='row_status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.row_status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='error_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.error_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='error_message' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.error_message'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_rows') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_rows.created_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_rows') AND conname='supplier_price_release_rows_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_rows" ADD CONSTRAINT "supplier_price_release_rows_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_rows.supplier_price_release_rows_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_rows') AND conname='supplier_price_release_rows_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_rows" ADD CONSTRAINT "supplier_price_release_rows_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_rows.supplier_price_release_rows_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_rows') AND conname='supplier_price_release_rows_row_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_rows" ADD CONSTRAINT "supplier_price_release_rows_row_check" CHECK (source_row_number > 0 AND normalized_code <> ''::text AND product_code <> ''::text); ELSIF found_definition<>'CHECK (source_row_number > 0 AND normalized_code <> ''''::text AND product_code <> ''''::text)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_rows.supplier_price_release_rows_row_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_rows') AND conname='supplier_price_release_rows_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_rows" ADD CONSTRAINT "supplier_price_release_rows_status_check" CHECK (row_status = ANY (ARRAY['staged'::text, 'accepted'::text, 'rejected'::text, 'warning'::text, 'conflict'::text])); ELSIF found_definition<>'CHECK (row_status = ANY (ARRAY[''staged''::text, ''accepted''::text, ''rejected''::text, ''warning''::text, ''conflict''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_rows.supplier_price_release_rows_status_check'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_code_counts') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_code_counts.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_code_counts') AND a.attname='normalized_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_code_counts.normalized_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_code_counts') AND a.attname='row_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_code_counts.row_count'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_validation_code_counts') AND conname='supplier_price_release_validation_code_counts_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_validation_code_counts" ADD CONSTRAINT "supplier_price_release_validation_code_counts_pkey" PRIMARY KEY (release_id, normalized_code); ELSIF found_definition<>'PRIMARY KEY (release_id, normalized_code)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_validation_code_counts.supplier_price_release_validation_code_counts_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_validation_code_counts') AND conname='supplier_price_release_validation_code_counts_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_validation_code_counts" ADD CONSTRAINT "supplier_price_release_validation_code_counts_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_validation_code_counts.supplier_price_release_validation_code_counts_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='cursor' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.cursor'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='total_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.total_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='accepted_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.accepted_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='warning_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.warning_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='rejected_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.rejected_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='conflict_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.conflict_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='missing_price_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.missing_price_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='duplicate_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.duplicate_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='currency_count' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.currency_count'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='last_error' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.last_error'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='started_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.started_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='completed_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.completed_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_release_validation_runs') AND a.attname='updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_release_validation_runs.updated_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_validation_runs') AND conname='supplier_price_release_validation_runs_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_validation_runs" ADD CONSTRAINT "supplier_price_release_validation_runs_pkey" PRIMARY KEY (release_id); ELSIF found_definition<>'PRIMARY KEY (release_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_validation_runs.supplier_price_release_validation_runs_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_validation_runs') AND conname='supplier_price_release_validation_runs_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_validation_runs" ADD CONSTRAINT "supplier_price_release_validation_runs_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_validation_runs.supplier_price_release_validation_runs_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_release_validation_runs') AND conname='supplier_price_release_validation_runs_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_release_validation_runs" ADD CONSTRAINT "supplier_price_release_validation_runs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'running'::text, 'validated'::text, 'review_required'::text, 'failed'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''queued''::text, ''running''::text, ''validated''::text, ''review_required''::text, ''failed''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_release_validation_runs.supplier_price_release_validation_runs_status_check'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='supplier_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.supplier_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='brand_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.brand_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='import_run_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.import_run_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='source_file_path' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.source_file_path'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='source_file_sha256' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.source_file_sha256'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='mode' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.mode'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='source_date' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='date' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.source_date'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='total_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.total_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='accepted_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.accepted_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='rejected_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.rejected_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='warning_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.warning_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='conflict_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.conflict_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='processed_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.processed_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='current_cursor' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.current_cursor'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='worker_version' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.worker_version'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='error_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.error_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='error_message' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.error_message'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='created_by' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.created_by'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.created_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='uploaded_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.uploaded_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='validated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.validated_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='published_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.published_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='superseded_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.superseded_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='archived_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.archived_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.updated_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='brand_identity_audit' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='jsonb' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.brand_identity_audit'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='review_revision' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.review_revision'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_releases') AND a.attname='source_verification_required' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='boolean' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_releases.source_verification_required'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_brand_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_brand_id_fkey" FOREIGN KEY (brand_id) REFERENCES public.brands(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (brand_id) REFERENCES brands(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_brand_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_counts_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_counts_check" CHECK (total_rows >= 0 AND accepted_rows >= 0 AND rejected_rows >= 0 AND warning_rows >= 0 AND conflict_rows >= 0 AND processed_rows >= 0 AND current_cursor >= 0); ELSIF found_definition<>'CHECK (total_rows >= 0 AND accepted_rows >= 0 AND rejected_rows >= 0 AND warning_rows >= 0 AND conflict_rows >= 0 AND processed_rows >= 0 AND current_cursor >= 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_counts_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_import_run_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_import_run_id_fkey" FOREIGN KEY (import_run_id) REFERENCES public.supplier_price_import_runs(id) ON DELETE SET NULL; ELSIF found_definition<>'FOREIGN KEY (import_run_id) REFERENCES supplier_price_import_runs(id) ON DELETE SET NULL' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_import_run_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_mode_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_mode_check" CHECK (mode = ANY (ARRAY['replace'::text, 'merge'::text])); ELSIF found_definition<>'CHECK (mode = ANY (ARRAY[''replace''::text, ''merge''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_mode_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_review_revision_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_review_revision_check" CHECK (review_revision >= 0); ELSIF found_definition<>'CHECK (review_revision >= 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_review_revision_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_status_check" CHECK (status = ANY (ARRAY['received'::text, 'uploaded'::text, 'parsing'::text, 'staged'::text, 'validating'::text, 'validated'::text, 'publishing'::text, 'catalog_enriching'::text, 'rollup_refreshing'::text, 'published'::text, 'failed'::text, 'cancelled'::text, 'superseded'::text, 'archived'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''received''::text, ''uploaded''::text, ''parsing''::text, ''staged''::text, ''validating''::text, ''validated''::text, ''publishing''::text, ''catalog_enriching''::text, ''rollup_refreshing''::text, ''published''::text, ''failed''::text, ''cancelled''::text, ''superseded''::text, ''archived''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_status_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_releases') AND conname='supplier_price_releases_supplier_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_releases" ADD CONSTRAINT "supplier_price_releases_supplier_id_fkey" FOREIGN KEY (supplier_id) REFERENCES public.suppliers(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (supplier_id) REFERENCES suppliers(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_releases.supplier_price_releases_supplier_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='idempotency_key' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.idempotency_key'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='storage_bucket' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.storage_bucket'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='storage_object_path' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.storage_object_path'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='file_name' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.file_name'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='content_type' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.content_type'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='total_bytes' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.total_bytes'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='uploaded_bytes' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.uploaded_bytes'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='checksum_sha256' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.checksum_sha256'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='tus_upload_url' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.tus_upload_url'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='attempt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.attempt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='last_heartbeat_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.last_heartbeat_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='expires_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.expires_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='uploaded_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.uploaded_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='completed_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.completed_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='error_code' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.error_code'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='error_message' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.error_message'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='created_by' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.created_by'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.created_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('public.supplier_price_upload_sessions') AND a.attname='updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: public.supplier_price_upload_sessions.updated_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_attempt_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_attempt_check" CHECK (attempt >= 0); ELSIF found_definition<>'CHECK (attempt >= 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_attempt_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_bytes_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_bytes_check" CHECK (total_bytes > 0 AND uploaded_bytes >= 0 AND uploaded_bytes <= total_bytes); ELSIF found_definition<>'CHECK (total_bytes > 0 AND uploaded_bytes >= 0 AND uploaded_bytes <= total_bytes)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_bytes_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_idempotency_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_idempotency_check" CHECK (length(TRIM(BOTH FROM idempotency_key)) > 0); ELSIF found_definition<>'CHECK (length(TRIM(BOTH FROM idempotency_key)) > 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_idempotency_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_path_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_path_check" CHECK (length(TRIM(BOTH FROM storage_object_path)) > 0); ELSIF found_definition<>'CHECK (length(TRIM(BOTH FROM storage_object_path)) > 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_path_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_pkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE CASCADE; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE CASCADE' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('public.supplier_price_upload_sessions') AND conname='supplier_price_upload_sessions_status_check'; IF NOT FOUND THEN ALTER TABLE "public"."supplier_price_upload_sessions" ADD CONSTRAINT "supplier_price_upload_sessions_status_check" CHECK (status = ANY (ARRAY['created'::text, 'uploading'::text, 'uploaded'::text, 'aborted'::text, 'expired'::text, 'failed'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''created''::text, ''uploading''::text, ''uploaded''::text, ''aborted''::text, ''expired''::text, ''failed''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_status_check'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='session_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.session_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='storage_bucket' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.storage_bucket'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='source_path' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.source_path'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='source_sha256' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.source_sha256'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='source_bytes' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.source_bytes'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='total_rows' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.total_rows'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='object_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.object_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='object_version' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.object_version'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='object_updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.object_updated_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='workflow_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.workflow_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='queue_name' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.queue_name'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='attempt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.attempt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='lease_owner' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.lease_owner'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='lease_token' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.lease_token'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='lease_expires_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.lease_expires_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.created_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND a.attname='enqueued_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.handoffs.enqueued_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_attempt_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_attempt_check" CHECK (attempt >= 0); ELSIF found_definition<>'CHECK (attempt >= 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_attempt_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_object_version_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_object_version_check" CHECK (length(object_version) > 0); ELSIF found_definition<>'CHECK (length(object_version) > 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_object_version_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_pkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_queue_name_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_queue_name_check" CHECK (queue_name = 'supplier-price-verified-shadow'::text); ELSIF found_definition<>'CHECK (queue_name = ''supplier-price-verified-shadow''::text)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_queue_name_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id); ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_release_id_key'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_release_id_key" UNIQUE (release_id); ELSIF found_definition<>'UNIQUE (release_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_release_id_key'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_session_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.supplier_price_upload_sessions(id); ELSIF found_definition<>'FOREIGN KEY (session_id) REFERENCES supplier_price_upload_sessions(id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_session_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_session_id_key'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_session_id_key" UNIQUE (session_id); ELSIF found_definition<>'UNIQUE (session_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_session_id_key'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_source_bytes_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_source_bytes_check" CHECK (source_bytes >= 1 AND source_bytes <= 1073741824); ELSIF found_definition<>'CHECK (source_bytes >= 1 AND source_bytes <= 1073741824)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_source_bytes_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_source_sha256_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_source_sha256_check" CHECK (source_sha256 ~ '^[0-9a-f]{64}$'::text); ELSIF found_definition<>'CHECK (source_sha256 ~ ''^[0-9a-f]{64}$''::text)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_source_sha256_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_status_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'dispatching'::text, 'enqueued'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''queued''::text, ''dispatching''::text, ''enqueued''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_status_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_total_rows_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_total_rows_check" CHECK (total_rows > 0); ELSIF found_definition<>'CHECK (total_rows > 0)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_total_rows_check'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.handoffs') AND conname='handoffs_workflow_id_key'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."handoffs" ADD CONSTRAINT "handoffs_workflow_id_key" UNIQUE (workflow_id); ELSIF found_definition<>'UNIQUE (workflow_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.handoffs.handoffs_workflow_id_key'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='session_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.session_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='actor_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.actor_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='accepted_auth_session_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.accepted_auth_session_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='accepted_token_iat' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='bigint' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.accepted_token_iat'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='status' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.status'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='attempt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='integer' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.attempt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='worker_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.worker_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='lease_token' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.lease_token'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='lease_expires_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.lease_expires_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='next_attempt_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.next_attempt_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='last_error' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='text' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.last_error'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='handoff_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=false AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.handoff_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.created_at'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND a.attname='updated_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_ingestion_internal.verification_requests.updated_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_handoff_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_handoff_id_fkey" FOREIGN KEY (handoff_id) REFERENCES supplier_price_ingestion_internal.handoffs(id); ELSIF found_definition<>'FOREIGN KEY (handoff_id) REFERENCES supplier_price_ingestion_internal.handoffs(id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_handoff_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_pkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id); ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_release_id_key'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_release_id_key" UNIQUE (release_id); ELSIF found_definition<>'UNIQUE (release_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_release_id_key'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_session_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_session_id_fkey" FOREIGN KEY (session_id) REFERENCES public.supplier_price_upload_sessions(id); ELSIF found_definition<>'FOREIGN KEY (session_id) REFERENCES supplier_price_upload_sessions(id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_session_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_session_id_key'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_session_id_key" UNIQUE (session_id); ELSIF found_definition<>'UNIQUE (session_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_session_id_key'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_ingestion_internal.verification_requests') AND conname='verification_requests_status_check'; IF NOT FOUND THEN ALTER TABLE "supplier_price_ingestion_internal"."verification_requests" ADD CONSTRAINT "verification_requests_status_check" CHECK (status = ANY (ARRAY['queued'::text, 'verifying'::text, 'verified'::text, 'failed'::text])); ELSIF found_definition<>'CHECK (status = ANY (ARRAY[''queued''::text, ''verifying''::text, ''verified''::text, ''failed''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_ingestion_internal.verification_requests.verification_requests_status_check'; END IF; END $foundation_constraint$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='organization_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.organization_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='release_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.release_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='actor_id' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='uuid' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.actor_id'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='request' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='jsonb' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.request'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='receipt' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='jsonb' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.receipt'; END IF; END $foundation_column$;
DO $foundation_column$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_attribute a WHERE a.attrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND a.attname='created_at' AND NOT a.attisdropped AND format_type(a.atttypid,a.atttypmod)='timestamp with time zone' AND a.attnotnull=true AND a.attidentity='') THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_COLUMN_DRIFT: supplier_price_validation_internal.review_decisions.created_at'; END IF; END $foundation_column$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND conname='review_decisions_pkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_validation_internal"."review_decisions" ADD CONSTRAINT "review_decisions_pkey" PRIMARY KEY (id); ELSIF found_definition<>'PRIMARY KEY (id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_validation_internal.review_decisions.review_decisions_pkey'; END IF; END $foundation_constraint$;
DO $foundation_constraint$ DECLARE found_definition text; BEGIN SELECT pg_get_constraintdef(oid,true) INTO found_definition FROM pg_constraint WHERE conrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND conname='review_decisions_release_id_fkey'; IF NOT FOUND THEN ALTER TABLE "supplier_price_validation_internal"."review_decisions" ADD CONSTRAINT "review_decisions_release_id_fkey" FOREIGN KEY (release_id) REFERENCES public.supplier_price_releases(id) ON DELETE RESTRICT; ELSIF found_definition<>'FOREIGN KEY (release_id) REFERENCES supplier_price_releases(id) ON DELETE RESTRICT' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_CONSTRAINT_DRIFT: supplier_price_validation_internal.review_decisions.review_decisions_release_id_fkey'; END IF; END $foundation_constraint$;
DO $foundation_function$ BEGIN IF to_regprocedure('supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION supplier_price_validation_internal.check_publication_identity(input_release_id uuid, input_organization_id uuid, input_supplier_id uuid, input_brand_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_audit jsonb;
  v_error text;
  v_allowed boolean;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'PUBLICATION_IDENTITY_SERVICE_REQUIRED'; end if;
  if input_release_id is null or input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'PUBLICATION_IDENTITY_INPUT_REQUIRED'; end if;
  if current_setting('transaction_isolation')<>'read committed' then
    raise exception 'PUBLICATION_IDENTITY_REQUIRES_READ_COMMITTED'; end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-identity:'||input_organization_id::text,0));
  select r.* into v_release from public.supplier_price_releases r where r.id=input_release_id for update;
  if not found then raise exception 'PUBLICATION_IDENTITY_RELEASE_MISSING'; end if;
  if v_release.organization_id is distinct from input_organization_id or v_release.supplier_id is distinct from input_supplier_id
    or v_release.brand_id is distinct from input_brand_id then raise exception 'PUBLICATION_IDENTITY_SCOPE_MISMATCH'; end if;
  begin
    v_audit:=supplier_price_validation_internal.cross_brand_audit(input_release_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    v_audit:=jsonb_build_object('policy','cross-brand-v1','checked',false,'review_required',true,
      'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
  end;
  if coalesce((v_audit->>'review_required')::boolean,true) then
    v_error:=case when v_audit->>'checked'<>'true' then 'BRAND_IDENTITY_COMPARISON_UNAVAILABLE'
      when v_audit->>'distinct_incoming_codes'='0' then 'BRAND_IDENTITY_EMPTY_CODES' else 'CROSS_BRAND_BULK_OVERLAP' end;
  else v_error:=v_release.error_code; end if;
  v_allowed:=v_error is null and v_audit->>'checked'='true' and v_audit->>'review_required'='false';
  update public.supplier_price_releases set brand_identity_audit=v_audit,
    error_code=v_error,error_message=case when v_error is null then error_message
      when v_error=v_release.error_code then error_message
      else 'Publication held: review current brand identity evidence. Existing prices remain unchanged.' end
    where id=input_release_id;
  if not v_allowed then
    insert into public.supplier_price_release_events(release_id,event_type,stage,status,error_code,worker_version)
      values(input_release_id,'publication_identity_held','publication','review_required',v_error,'publication-identity-v1');
  end if;
  return jsonb_build_object('status',case when v_allowed then 'identity_checked' else 'review_required' end,
    'publication_allowed',v_allowed,'release_id',input_release_id,'error_code',v_error,'brand_identity_audit',v_audit);
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid)')))<>'d17f7e9327f65d55f4ca11343bb2f6df' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION supplier_price_validation_internal.check_publication_identity(uuid,uuid,uuid,uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('supplier_price_validation_internal.cross_brand_audit(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION supplier_price_validation_internal.cross_brand_audit(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_result jsonb;
begin
  select r.* into strict v_release from public.supplier_price_releases r where r.id=input_release_id;
  if not exists(select 1 from public.brands b where b.id=v_release.brand_id and b.organization_id=v_release.organization_id)
     or not exists(select 1 from public.suppliers s where s.id=v_release.supplier_id and s.organization_id=v_release.organization_id) then
    raise exception 'BRAND_IDENTITY_SCOPE_INVALID';
  end if;
  if pg_catalog.to_regclass('public.catalog_products') is null
     or pg_catalog.to_regclass('public.supplier_prices') is null then
    return jsonb_build_object('policy','cross-brand-v1','checked',false,'review_required',true,
      'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
  end if;
  with incoming as materialized (
    select distinct public.normalize_part_code(rr.product_code) code
    from public.supplier_price_release_rows rr where rr.release_id=input_release_id
      and public.normalize_part_code(rr.product_code) <> ''
  ), matches as (
    select c.brand_id, i.code
    from incoming i join public.catalog_products c on c.normalized_code=i.code
      and c.organization_id=v_release.organization_id and c.brand_id<>v_release.brand_id
    union
    select p.brand_id, i.code
    from incoming i join public.supplier_prices p on p.normalized_code=i.code
      and p.organization_id=v_release.organization_id and p.brand_id<>v_release.brand_id and p.is_active=true
    union
    select r.brand_id, i.code
    from public.supplier_current_price_pointers ptr
    join public.supplier_price_publications pub on pub.id=ptr.publication_id
      and pub.release_id=ptr.release_id and pub.organization_id=ptr.organization_id
      and pub.supplier_id=ptr.supplier_id and pub.brand_id=ptr.brand_id and pub.status='published'
    join public.supplier_price_releases r on r.id=ptr.release_id
      and r.organization_id=ptr.organization_id and r.supplier_id=ptr.supplier_id
      and r.brand_id=ptr.brand_id and r.status='published'
    join public.supplier_price_release_rows rr on rr.release_id=r.id and rr.row_status='accepted'
    join incoming i on i.code=public.normalize_part_code(rr.product_code)
    where ptr.organization_id=v_release.organization_id and ptr.brand_id<>v_release.brand_id
  ), ranked as (
    select m.brand_id, m.code, row_number() over(partition by m.brand_id order by m.code collate "C") sample_rank
    from matches m
    join public.brands b on b.id=m.brand_id and b.organization_id=v_release.organization_id
  ), grouped as (
    select x.brand_id, count(*) matching_codes,
      jsonb_agg(x.code order by x.code collate "C") filter(where x.sample_rank<=10) sample_codes
    from ranked x group by x.brand_id
  ), counts as (select count(*) n from incoming), evidence as (
    select g.*, b.name brand_name, round(100.0*g.matching_codes/nullif(c.n,0),2) incoming_percent
    from grouped g join public.brands b on b.id=g.brand_id cross join counts c
    order by g.matching_codes desc, g.brand_id
  )
  select jsonb_build_object('policy','cross-brand-v1','checked',true,'checked_at',clock_timestamp(),
    'selected_brand_id',v_release.brand_id,'selected_brand_name',(select b.name from public.brands b where b.id=v_release.brand_id),
    'threshold_codes',5000,'ratio_min_codes',100,'ratio_threshold_percent',80,
    'distinct_incoming_codes',(select n from counts),
    'review_required',(select n=0 from counts) or coalesce((select bool_or(matching_codes>=5000
      or (matching_codes>=100 and matching_codes::numeric*100 >= (select n from counts)*80)) from evidence),false),
    'matching_brand_count',(select count(*) from evidence),
    'brands',coalesce((select jsonb_agg(to_jsonb(e)) from (select * from evidence limit 10) e),'[]'::jsonb))
  into v_result;
  return v_result;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('supplier_price_validation_internal.cross_brand_audit(uuid)')))<>'4748945d77ee1240e8f877359cab662c' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: supplier_price_validation_internal.cross_brand_audit(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.cross_brand_audit(uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('supplier_price_validation_internal.historical_rows_valid(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION supplier_price_validation_internal.historical_rows_valid(input_release_id uuid)
 RETURNS boolean
 LANGUAGE sql
 SET search_path TO ''
AS $function$
  with rows as (
    select count(*) n,count(distinct rr.normalized_code) codes,
      min(rr.source_row_number) first_row,max(rr.source_row_number) last_row,
      count(distinct rr.currency) currencies,
      count(*) filter(where rr.row_status is distinct from 'accepted'
        or rr.buy_price is null or rr.buy_price<0 or nullif(trim(rr.currency),'') is null
        or rr.valid_from is null or rr.error_code is not null or rr.error_message is not null
        or rr.row_hash is null or rr.row_hash !~ '^[a-f0-9]{64}$') bad
    from public.supplier_price_release_rows rr where rr.release_id=input_release_id
  ), batches as (
    select coalesce(sum(b.row_count),0) n,count(*) filter(where b.status is distinct from 'completed'
      or b.cursor_start is distinct from b.expected_start or b.cursor_end<>b.cursor_start+b.row_count-1) bad
    from (select bb.*,coalesce(lag(bb.cursor_end) over(order by bb.cursor_start)+1,1) expected_start
      from public.supplier_price_release_batches bb where bb.release_id=input_release_id) b
  )
  select coalesce(r.total_rows>0 and r.processed_rows=r.total_rows and r.current_cursor=r.total_rows
    and r.accepted_rows=r.total_rows and r.warning_rows=0 and r.rejected_rows=0 and r.conflict_rows=0
    and r.validated_at is not null and r.source_date is not null
    and x.n=r.total_rows and x.codes=x.n and x.first_row=1 and x.last_row=x.n
    and x.bad=0 and x.currencies=1 and b.n=x.n and b.bad=0,false)
  from public.supplier_price_releases r cross join rows x cross join batches b where r.id=input_release_id;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('supplier_price_validation_internal.historical_rows_valid(uuid)')))<>'aa426b4d6a1a159b0a91a6319855ce14' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: supplier_price_validation_internal.historical_rows_valid(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.historical_rows_valid(uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION supplier_price_validation_internal.review_release(input_decision_id uuid, input_actor_id uuid, input_organization_id uuid, input_release_id uuid, input_action text, input_reason text, input_expected_revision bigint, input_expected_status text, input_expected_error text, input_expected_audit jsonb)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_actor public.profiles%rowtype;
  v_release public.supplier_price_releases%rowtype;
  v_saved record; v_request jsonb; v_receipt jsonb; v_validation jsonb; v_identity jsonb;
  v_clear boolean:=false; v_outcome text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'REVIEW_SERVICE_REQUIRED'; end if;
  if input_decision_id is null or input_actor_id is null or input_organization_id is null or input_release_id is null
    or input_expected_revision is null or input_expected_revision<0 or input_expected_status is null
    or input_action is null or input_action not in ('reject','recheck')
    or input_reason is null
    or (input_action='reject' and input_reason not in ('wrong_brand_file','wrong_source_file'))
    or (input_action='recheck' and input_reason<>'comparison_repaired')
    or length(input_expected_status)>40 or length(input_expected_error)>100
    or pg_catalog.pg_column_size(input_expected_audit)>16384 then raise exception 'REVIEW_INPUT_INVALID'; end if;
  if current_setting('transaction_isolation')<>'read committed' then raise exception 'REVIEW_REQUIRES_READ_COMMITTED'; end if;
  -- Same organization fence before decision, actor and release row locks.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-identity:'||input_organization_id::text,0));
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended('supplier-price-review:'||input_decision_id::text,0));
  select p.* into v_actor from public.profiles p where p.id=input_actor_id for share;
  if not found or v_actor.is_active is distinct from true or coalesce(v_actor.role,'') not in ('admin','superadmin')
    or v_actor.organization_id is distinct from input_organization_id then raise exception 'REVIEW_ACTOR_DENIED'; end if;
  select r.* into v_release from public.supplier_price_releases r where r.id=input_release_id for update;
  if not found or v_release.organization_id is distinct from input_organization_id then raise exception 'REVIEW_SCOPE_DENIED'; end if;
  if not exists(select 1 from public.brands b where b.id=v_release.brand_id and b.organization_id=input_organization_id)
    or not exists(select 1 from public.suppliers s where s.id=v_release.supplier_id and s.organization_id=input_organization_id)
    then raise exception 'REVIEW_SCOPE_DENIED'; end if;
  v_request:=jsonb_build_object('actor',input_actor_id,'organization',input_organization_id,'release',input_release_id,
    'action',input_action,'reason',input_reason,'revision',input_expected_revision,'status',input_expected_status,
    'error',input_expected_error,'audit',input_expected_audit);
  select d.request,d.receipt into v_saved from supplier_price_validation_internal.review_decisions d where d.id=input_decision_id;
  if found then
    if v_saved.request is distinct from v_request then raise exception 'REVIEW_DECISION_REUSE_MISMATCH'; end if;
    return v_saved.receipt||jsonb_build_object('replayed',true);
  end if;
  if v_release.review_revision<>input_expected_revision or v_release.status is distinct from input_expected_status
    or v_release.error_code is distinct from input_expected_error or v_release.brand_identity_audit is distinct from input_expected_audit
    then raise exception 'REVIEW_STALE_EVIDENCE'; end if;
  if exists(select 1 from public.supplier_current_price_pointers p where p.release_id=input_release_id)
    then raise exception 'REVIEW_CURRENT_RELEASE_PROTECTED'; end if;
  if v_release.error_code is null and coalesce(v_release.brand_identity_audit->>'review_required','false')<>'true'
    then raise exception 'REVIEW_HOLD_REQUIRED'; end if;
  if input_action='reject' then
    if v_release.status not in ('staged','validated')
      or exists(select 1 from public.supplier_price_publications p where p.release_id=input_release_id)
      then raise exception 'REVIEW_PUBLISHED_HISTORY_PROTECTED'; end if;
    update public.supplier_price_releases set status='cancelled',error_code='REVIEW_REJECTED',
      error_message='Source rejected by authorized reviewer. Submit a corrected file through normal admission.',updated_at=now()
      where id=input_release_id;
    v_outcome:='rejected';
  elsif v_release.status in ('staged','validated') then
    -- Calls existing complete row validator + fresh brand gate. No waive path.
    v_validation:=public.validate_supplier_price_release(input_release_id);
    v_clear:=v_validation->>'publishable'='true';
    v_outcome:=case when v_clear then 'rechecked_clear' else 'review_required' end;
  elsif v_release.status='superseded' and v_release.error_code='BRAND_IDENTITY_COMPARISON_UNAVAILABLE' then
    -- Only transient comparison repair on a historical publication, never an
    -- override of bulk overlap/price conflicts. Keep commercial state immutable.
    if not exists(select 1 from public.supplier_price_publications p where p.release_id=input_release_id
      and p.organization_id=input_organization_id and p.supplier_id=v_release.supplier_id and p.brand_id=v_release.brand_id
      and p.status='superseded') then raise exception 'REVIEW_HISTORY_INVALID'; end if;
    if not coalesce(supplier_price_validation_internal.historical_rows_valid(input_release_id),false)
      then raise exception 'REVIEW_HISTORY_ROWS_INVALID'; end if;
    v_identity:=supplier_price_validation_internal.check_publication_identity(input_release_id,input_organization_id,v_release.supplier_id,v_release.brand_id);
    v_clear:=v_identity->'brand_identity_audit'->>'checked'='true'
      and v_identity->'brand_identity_audit'->>'review_required'='false';
    if v_clear then
      update public.supplier_price_releases set error_code=null,error_message=null,updated_at=now() where id=input_release_id;
    end if;
    v_outcome:=case when v_clear then 'rechecked_clear' else 'review_required' end;
  else raise exception 'REVIEW_STATE_NOT_ELIGIBLE'; end if;
  update public.supplier_price_releases set review_revision=review_revision+1,updated_at=now() where id=input_release_id
    returning * into v_release;
  insert into public.supplier_price_release_events(release_id,event_type,stage,status,error_code,worker_version)
    values(input_release_id,'release_review_'||input_action,'review',v_outcome,v_release.error_code,'review-v1');
  v_receipt:=jsonb_build_object('status',v_outcome,'decision_id',input_decision_id,'release_id',input_release_id,
    'action',input_action,'review_revision',v_release.review_revision,'error_code',v_release.error_code,
    'published',false,'replayed',false);
  insert into supplier_price_validation_internal.review_decisions(id,organization_id,release_id,actor_id,request,receipt)
    values(input_decision_id,input_organization_id,input_release_id,input_actor_id,v_request,v_receipt);
  return v_receipt;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb)')))<>'708573fea2256c32e8e9debc5a2b6fb0' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION supplier_price_validation_internal.review_release(uuid,uuid,uuid,uuid,text,text,bigint,text,text,jsonb) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('supplier_price_validation_internal.validate_supplier_price_release(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION supplier_price_validation_internal.validate_supplier_price_release(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_persisted bigint;
  v_total bigint;
  v_accepted bigint;
  v_warning bigint;
  v_rejected bigint;
  v_conflict bigint;
  v_missing_price bigint;
  v_currency_count bigint;
  v_duplicate_codes bigint;
  v_publishable boolean;
  v_message text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Supplier release validation requires service role';
  end if;
  if input_release_id is null then
    raise exception 'input_release_id is required';
  end if;
  select r.* into v_release
    from public.supplier_price_releases as r
    where r.id = input_release_id
    for update;
  if not found then raise exception 'Supplier release not found'; end if;
  if v_release.status not in ('staged', 'validated') then
    raise exception 'Release must be staged before validation';
  end if;

  select count(*) into v_persisted
    from public.supplier_price_release_rows as rr
    where rr.release_id = v_release.id;
  if v_persisted <> v_release.total_rows then
    raise exception 'Persisted row count does not match release total';
  end if;

  -- Conflicts are explicit and idempotent: repeated previews do not stack a
  -- new error on an already-classified row.
  with duplicate_codes as (
    select rr.normalized_code
    from public.supplier_price_release_rows as rr
    where rr.release_id = v_release.id
    group by rr.normalized_code
    having count(*) > 1
  )
  update public.supplier_price_release_rows as rr
     set row_status = 'conflict',
         error_code = 'DUPLICATE_NORMALIZED_CODE',
         error_message = 'Normalized product code occurs more than once in this release.'
   where rr.release_id = v_release.id
     and rr.normalized_code in (select d.normalized_code from duplicate_codes as d)
     and rr.row_status <> 'rejected';

  update public.supplier_price_release_rows as rr
     set row_status = 'conflict',
         error_code = 'MISSING_PRICE_OR_CURRENCY',
         error_message = 'Buy price and currency are required before publication.'
   where rr.release_id = v_release.id
     and rr.row_status not in ('rejected', 'conflict')
     and (rr.buy_price is null or nullif(trim(rr.currency), '') is null);

  select count(*) into v_total
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id;
  select count(*) into v_accepted
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id and rr.row_status = 'accepted';
  select count(*) into v_warning
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id and rr.row_status = 'warning';
  select count(*) into v_rejected
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id and rr.row_status = 'rejected';
  select count(*) into v_conflict
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id and rr.row_status = 'conflict';
  select count(*) into v_missing_price
    from public.supplier_price_release_rows as rr
    where rr.release_id = v_release.id and (rr.buy_price is null or nullif(trim(rr.currency), '') is null);
  select count(distinct nullif(trim(rr.currency), '')) into v_currency_count
    from public.supplier_price_release_rows as rr where rr.release_id = v_release.id;
  select count(*) into v_duplicate_codes
    from (
      select rr.normalized_code
      from public.supplier_price_release_rows as rr
      where rr.release_id = v_release.id
      group by rr.normalized_code
      having count(*) > 1
    ) as duplicates;

  v_publishable := v_total = v_release.total_rows
    and v_rejected = 0 and v_conflict = 0 and v_missing_price = 0
    and v_currency_count <= 1;
  v_message := case when v_publishable
    then 'Validation passed; release is eligible for a separate publication decision.'
    else 'Validation completed; review conflicts before publication.' end;

  update public.supplier_price_releases as r
     set status = 'validated', validated_at = now(),
         accepted_rows = v_accepted, warning_rows = v_warning,
         rejected_rows = v_rejected, conflict_rows = v_conflict,
         error_code = case when v_publishable then null else 'VALIDATION_REVIEW_REQUIRED' end,
         error_message = case when v_publishable then null else v_message end,
         updated_at = now()
   where r.id = v_release.id;
  insert into public.supplier_price_release_events
    (release_id, event_type, stage, status, processed_rows, total_rows, worker_version)
  values (v_release.id, 'release_validated', 'validation',
          case when v_publishable then 'passed' else 'review_required' end,
          v_total, v_release.total_rows, 'shadow-validation-v1');

  return jsonb_build_object(
    'status', 'validated', 'release_id', v_release.id,
    'total_rows', v_total, 'accepted_rows', v_accepted,
    'warning_rows', v_warning, 'rejected_rows', v_rejected,
    'conflict_rows', v_conflict, 'missing_price_or_currency', v_missing_price,
    'duplicate_codes', v_duplicate_codes, 'currency_count', v_currency_count,
    'publishable', v_publishable, 'message', v_message
  );
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('supplier_price_validation_internal.validate_supplier_price_release(uuid)')))<>'591b3271795869c1a7208b496d9529ce' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: supplier_price_validation_internal.validate_supplier_price_release(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION supplier_price_validation_internal.validate_supplier_price_release(uuid) FROM PUBLIC, anon, authenticated, service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.ack_supplier_price_verified_handoff(uuid,text,uuid,text)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.ack_supplier_price_verified_handoff(input_handoff_id uuid, input_worker_id text, input_lease_token uuid, input_workflow_id text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare h supplier_price_ingestion_internal.handoffs%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  select x.* into h from supplier_price_ingestion_internal.handoffs x where x.id=input_handoff_id for update;
  if not found or h.workflow_id is distinct from input_workflow_id or h.lease_owner is distinct from trim(input_worker_id)
     or h.lease_token is distinct from input_lease_token then raise exception 'UPLOAD_HANDOFF_STALE';end if;
  if h.status='enqueued' then return jsonb_build_object('status','enqueued','handoff_id',h.id,'workflow_id',h.workflow_id,'published',false);end if;
  if h.status <> 'dispatching' or h.lease_expires_at <= clock_timestamp() then raise exception 'UPLOAD_HANDOFF_STALE';end if;
  update supplier_price_ingestion_internal.handoffs x set status='enqueued',enqueued_at=clock_timestamp(),lease_expires_at=null where x.id=h.id;
  return jsonb_build_object('status','enqueued','handoff_id',h.id,'workflow_id',h.workflow_id,'published',false);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.ack_supplier_price_verified_handoff(uuid,text,uuid,text)')))<>'1b43ce42f966864b9175174222126762' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.ack_supplier_price_verified_handoff(uuid,text,uuid,text)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.ack_supplier_price_verified_handoff(uuid,text,uuid,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.ack_supplier_price_verified_handoff(uuid,text,uuid,text) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.begin_supplier_price_upload_verification(uuid,uuid,uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.begin_supplier_price_upload_verification(input_session_id uuid, input_organization_id uuid, input_actor_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  u public.supplier_price_upload_sessions%rowtype;
  r public.supplier_price_releases%rowtype;
  o storage.objects%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UPLOAD_VERIFY_ISOLATION';end if;
  select s.* into u from public.supplier_price_upload_sessions s where s.id=input_session_id for update;
  if not found or u.organization_id is distinct from input_organization_id
     or u.created_by is distinct from input_actor_id then raise exception 'UPLOAD_VERIFY_SCOPE';end if;
  if not exists(select 1 from public.profiles p where p.id=input_actor_id and p.organization_id=input_organization_id
    and p.is_active is true and p.role in ('admin','superadmin')) then raise exception 'UPLOAD_VERIFY_ACTOR';end if;
  select x.* into r from public.supplier_price_releases x where x.id=u.release_id for update;
  if not found or r.organization_id is distinct from u.organization_id or r.created_by is distinct from u.created_by
     or r.source_file_path is distinct from u.storage_object_path or r.source_file_sha256 is distinct from u.checksum_sha256
     or u.storage_bucket <> 'supplier-price-imports'
     or u.storage_object_path is distinct from u.organization_id::text||'/supplier-price/'||u.id::text||'/'||u.file_name
     or u.checksum_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'UPLOAD_VERIFY_BINDING';end if;
  if u.status not in ('created','uploading','uploaded') or (u.status <> 'uploaded' and u.expires_at <= clock_timestamp())
     or r.status not in ('received','uploaded','parsing','staged','validated') then raise exception 'UPLOAD_VERIFY_STATE';end if;
  if not r.source_verification_required then raise exception 'UPLOAD_VERIFY_NOT_ENROLLED';end if;
  select x.* into o from storage.objects x where x.bucket_id=u.storage_bucket and x.name=u.storage_object_path for share;
  if not found then raise exception 'UPLOAD_VERIFY_OBJECT_MISSING';end if;
  if nullif(o.version,'') is null or o.updated_at is null
     or coalesce(o.metadata->>'size','') !~ '^[0-9]{1,10}$' then raise exception 'UPLOAD_VERIFY_OBJECT_METADATA';end if;
  if (o.metadata->>'size')::bigint <> u.total_bytes then raise exception 'UPLOAD_VERIFY_OBJECT_SIZE';end if;
  return jsonb_build_object('session_id',u.id,'release_id',r.id,'organization_id',u.organization_id,'actor_id',u.created_by,
    'storage_bucket',u.storage_bucket,'source_file_path',u.storage_object_path,'source_file_sha256',u.checksum_sha256,
    'source_file_bytes',u.total_bytes,'source_date',r.source_date,'object_id',o.id,'object_version',o.version,'object_updated_at',o.updated_at);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.begin_supplier_price_upload_verification(uuid,uuid,uuid)')))<>'6f8cb4f18c7623b660969a64d2d53c4c' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.begin_supplier_price_upload_verification(uuid,uuid,uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.begin_supplier_price_upload_verification(uuid,uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.begin_supplier_price_upload_verification(uuid,uuid,uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.claim_supplier_price_release_batch(uuid,text,integer,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.claim_supplier_price_release_batch(input_release_id uuid, input_worker_id text, input_batch_size integer DEFAULT 1000, input_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(status text, batch_id uuid, release_id uuid, batch_number integer, cursor_start bigint, cursor_end bigint, attempt integer, lease_expires_at timestamp with time zone, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_batch public.supplier_price_release_batches%rowtype;
  v_committed bigint; v_end bigint; v_batch_number integer;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Supplier release worker requires service role';
  end if;
  if input_release_id is null or nullif(trim(input_worker_id),'') is null
     or input_batch_size is null or input_batch_size not between 1 and 10000
     or input_lease_seconds is null or input_lease_seconds not between 30 and 3600 then
    raise exception 'Invalid supplier release claim input';
  end if;
  select r.* into v_release from public.supplier_price_releases r
    where r.id=input_release_id for update skip locked;
  if not found then
    return query select 'lock_waiting'::text,null::uuid,input_release_id,null::integer,
      null::bigint,null::bigint,null::integer,null::timestamptz,'Release absent or locked.'::text;
    return;
  end if;
  if v_release.source_verification_required and (v_release.uploaded_at is null or not exists(
      select 1 from supplier_price_ingestion_internal.handoffs h where h.release_id=v_release.id
        and h.source_sha256=v_release.source_file_sha256 and h.source_path=v_release.source_file_path
        and h.total_rows=v_release.total_rows)) then
      return query select 'not_ready'::text,null::uuid,v_release.id,null::integer,
        null::bigint,null::bigint,null::integer,null::timestamptz,'Verified upload completion required.'::text;
      return;
    end if;
  if v_release.status not in ('received','uploaded','parsing','staged','validated') then
    return query select 'not_claimable'::text,null::uuid,v_release.id,null::integer,
      null::bigint,null::bigint,null::integer,null::timestamptz,'Release is not claimable.'::text;
    return;
  end if;
  if v_release.total_rows < 1 then
    return query select 'not_ready'::text,null::uuid,v_release.id,null::integer,
      null::bigint,null::bigint,null::integer,null::timestamptz,'Release total unknown.'::text;
    return;
  end if;

  -- Committed progress comes from finalized batches, never from heartbeat.
  select coalesce(sum(b.row_count),0)::bigint into v_committed
    from public.supplier_price_release_batches b
    where b.release_id=v_release.id and b.status='completed';
  if v_release.status in ('staged','validated') then
    if v_committed <> v_release.total_rows then
      raise exception 'Finished release has incomplete batch accounting';
    end if;
    return query select 'complete'::text,null::uuid,v_release.id,null::integer,
      v_committed+1,v_committed,null::integer,null::timestamptz,'All batches finalized.'::text;
    return;
  end if;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.release_id=v_release.id and b.status in ('running','retrying','queued')
    order by b.cursor_start,b.batch_number limit 1 for update;
  if found then
    if v_batch.lease_expires_at > clock_timestamp() then
      return query select 'busy'::text,v_batch.id,v_release.id,v_batch.batch_number,
        v_batch.cursor_start,v_batch.cursor_end,v_batch.attempt,v_batch.lease_expires_at,
        'Another worker owns an active lease.'::text;
      return;
    end if;
    if v_batch.cursor_start <> v_committed+1
       or v_batch.row_count <> v_batch.cursor_end-v_batch.cursor_start+1 then
      raise exception 'Unfinished batch does not follow finalized progress';
    end if;
    update public.supplier_price_release_batches b
      set status='running',lease_owner=trim(input_worker_id),
          lease_expires_at=clock_timestamp()+make_interval(secs=>input_lease_seconds),
          attempt=b.attempt+1,last_heartbeat_at=clock_timestamp()
      where b.id=v_batch.id returning b.* into v_batch;
    insert into public.supplier_price_release_events
      (release_id,event_type,stage,status,cursor,total_rows,attempt,worker_version)
      values(v_release.id,'batch_reclaimed','parsing','running',v_batch.cursor_start,
        v_release.total_rows,v_batch.attempt,'shadow-recovery-v3');
    return query select 'claimed'::text,v_batch.id,v_release.id,v_batch.batch_number,
      v_batch.cursor_start,v_batch.cursor_end,v_batch.attempt,v_batch.lease_expires_at,
      'Unfinished batch reacquired without skipping rows.'::text;
    return;
  end if;
  if v_committed <> v_release.current_cursor or v_committed > v_release.total_rows then
    raise exception 'Finalized progress and release cursor disagree';
  end if;
  if v_committed=v_release.total_rows then
    return query select 'complete'::text,null::uuid,v_release.id,null::integer,
      v_committed+1,v_committed,null::integer,null::timestamptz,'All batches finalized.'::text;
    return;
  end if;
  select coalesce(max(b.batch_number),0)+1 into v_batch_number
    from public.supplier_price_release_batches b where b.release_id=v_release.id;
  v_end:=least(v_release.total_rows,v_committed+input_batch_size);
  insert into public.supplier_price_release_batches
    (release_id,batch_number,cursor_start,cursor_end,row_count,status,attempt,
     lease_owner,lease_expires_at,started_at,last_heartbeat_at,worker_version)
    values(v_release.id,v_batch_number,v_committed+1,v_end,(v_end-v_committed)::integer,
      'running',1,trim(input_worker_id),
      clock_timestamp()+make_interval(secs=>input_lease_seconds),
      clock_timestamp(),clock_timestamp(),'shadow-recovery-v3')
    returning * into v_batch;
  update public.supplier_price_releases r set status='parsing',updated_at=clock_timestamp()
    where r.id=v_release.id;
  insert into public.supplier_price_release_events
    (release_id,event_type,stage,status,cursor,total_rows,attempt,worker_version)
    values(v_release.id,'batch_claimed','parsing','running',v_batch.cursor_start,
      v_release.total_rows,1,'shadow-recovery-v3');
  return query select 'claimed'::text,v_batch.id,v_release.id,v_batch.batch_number,
    v_batch.cursor_start,v_batch.cursor_end,v_batch.attempt,v_batch.lease_expires_at,
    'Batch lease acquired.'::text;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.claim_supplier_price_release_batch(uuid,text,integer,integer)')))<>'63c7aef8bccb07cc3a700e5aa629f021' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.claim_supplier_price_release_batch(uuid,text,integer,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.claim_supplier_price_release_batch(uuid,text,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_supplier_price_release_batch(uuid,text,integer,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.claim_supplier_price_upload_verification(text,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.claim_supplier_price_upload_verification(input_worker_id text, input_lease_seconds integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r supplier_price_ingestion_internal.verification_requests%rowtype;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_REQUEST_SERVICE_REQUIRED'; end if;
 if input_worker_id is null or length(input_worker_id) not between 1 and 200 or btrim(input_worker_id)<>input_worker_id
  or input_lease_seconds is null or input_lease_seconds not between 30 and 3600 then raise exception 'UPLOAD_REQUEST_CONFIG'; end if;
 select a.* into r from supplier_price_ingestion_internal.verification_requests a
 where (a.status='queued' and a.next_attempt_at<=clock_timestamp())
  or (a.status='verifying' and a.lease_expires_at<=clock_timestamp())
 order by a.next_attempt_at,a.created_at,a.id limit 1 for update skip locked;
 if not found then return jsonb_build_object('status','empty','published',false); end if;
 if r.attempt>=5 then
  update supplier_price_ingestion_internal.verification_requests a set status='failed',last_error='ATTEMPTS_EXHAUSTED',
   worker_id=null,lease_token=null,lease_expires_at=null,updated_at=clock_timestamp() where a.id=r.id;
  return jsonb_build_object('status','exhausted','request_id',r.id,'published',false);
 end if;
 update supplier_price_ingestion_internal.verification_requests a set status='verifying',attempt=a.attempt+1,
  worker_id=input_worker_id,lease_token=gen_random_uuid(),lease_expires_at=clock_timestamp()+make_interval(secs=>input_lease_seconds),
  updated_at=clock_timestamp() where a.id=r.id returning a.* into r;
 return jsonb_build_object('status','claimed','request_id',r.id,'session_id',r.session_id,'release_id',r.release_id,
  'organization_id',r.organization_id,'actor_id',r.actor_id,'attempt',r.attempt,'lease_token',r.lease_token,'published',false);
end; $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.claim_supplier_price_upload_verification(text,integer)')))<>'17ab4a3cc1926960a5d84f1b7bd73967' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.claim_supplier_price_upload_verification(text,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.claim_supplier_price_upload_verification(text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_supplier_price_upload_verification(text,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.claim_supplier_price_verified_handoff(text,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.claim_supplier_price_verified_handoff(input_worker_id text, input_lease_seconds integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare h supplier_price_ingestion_internal.handoffs%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  if nullif(trim(input_worker_id),'') is null or length(input_worker_id)>200
     or input_lease_seconds is null or input_lease_seconds not between 30 and 3600 then raise exception 'UPLOAD_HANDOFF_INPUT';end if;
  select x.* into h from supplier_price_ingestion_internal.handoffs x
    where x.status='queued' or (x.status='dispatching' and x.lease_expires_at <= clock_timestamp())
    order by x.created_at,x.id for update skip locked limit 1;
  if not found then return jsonb_build_object('status','empty');end if;
  update supplier_price_ingestion_internal.handoffs x set status='dispatching',attempt=x.attempt+1,
    lease_owner=trim(input_worker_id),lease_token=pg_catalog.gen_random_uuid(),
    lease_expires_at=clock_timestamp()+make_interval(secs=>input_lease_seconds)
    where x.id=h.id returning * into h;
  return jsonb_build_object('status','claimed','handoff_id',h.id,'release_id',h.release_id,'workflow_id',h.workflow_id,
    'queue_name',h.queue_name,'lease_token',h.lease_token,'lease_expires_at',h.lease_expires_at,'attempt',h.attempt);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.claim_supplier_price_verified_handoff(text,integer)')))<>'6d77ef1d1f56db756880d4ca149c4e82' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.claim_supplier_price_verified_handoff(text,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.claim_supplier_price_verified_handoff(text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_supplier_price_verified_handoff(text,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.claim_supplier_price_verified_release_batch(uuid,uuid,text,integer,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.claim_supplier_price_verified_release_batch(input_release_id uuid, input_handoff_id uuid, input_worker_id text, input_batch_size integer DEFAULT 1000, input_lease_seconds integer DEFAULT 120)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UPLOAD_VERIFY_ISOLATION';end if;
  perform 1 from public.supplier_price_releases r where r.id=input_release_id for update skip locked;
  if not found then return jsonb_build_object('status','lock_waiting');end if;
  perform public.get_supplier_price_verified_manifest(input_release_id,input_handoff_id);
  return (select to_jsonb(c) from public.claim_supplier_price_release_batch(input_release_id,input_worker_id,input_batch_size,input_lease_seconds)c);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.claim_supplier_price_verified_release_batch(uuid,uuid,text,integer,integer)')))<>'20ba51109c4ab4f6facbe7f3afe87a36' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.claim_supplier_price_verified_release_batch(uuid,uuid,text,integer,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.claim_supplier_price_verified_release_batch(uuid,uuid,text,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.claim_supplier_price_verified_release_batch(uuid,uuid,text,integer,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.complete_supplier_price_verified_upload(uuid,uuid,uuid,uuid,text,timestamp with time zone,bigint,text,bigint)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.complete_supplier_price_verified_upload(input_session_id uuid, input_organization_id uuid, input_actor_id uuid, input_object_id uuid, input_object_version text, input_object_updated_at timestamp with time zone, input_source_bytes bigint, input_source_sha256 text, input_total_rows bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  u public.supplier_price_upload_sessions%rowtype; r public.supplier_price_releases%rowtype;
  o storage.objects%rowtype; h supplier_price_ingestion_internal.handoffs%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UPLOAD_VERIFY_ISOLATION';end if;
  if input_source_bytes is null or input_source_bytes not between 1 and 1073741824
     or input_source_sha256 is null or input_source_sha256 !~ '^[0-9a-f]{64}$'
     or input_total_rows is null or input_total_rows < 1 or input_object_id is null
     or nullif(input_object_version,'') is null or input_object_updated_at is null then raise exception 'UPLOAD_VERIFY_INPUT';end if;
  select x.* into u from public.supplier_price_upload_sessions x where x.id=input_session_id for update;
  if not found or u.organization_id is distinct from input_organization_id
     or u.created_by is distinct from input_actor_id then raise exception 'UPLOAD_VERIFY_SCOPE';end if;
  if not exists(select 1 from public.profiles p where p.id=input_actor_id and p.organization_id=input_organization_id
    and p.is_active is true and p.role in ('admin','superadmin')) then raise exception 'UPLOAD_VERIFY_ACTOR';end if;
  select x.* into r from public.supplier_price_releases x where x.id=u.release_id for update;
  if not found or not r.source_verification_required
     or r.organization_id is distinct from u.organization_id or r.created_by is distinct from u.created_by
     or r.source_file_path is distinct from u.storage_object_path or r.source_file_sha256 is distinct from u.checksum_sha256
     or u.storage_bucket <> 'supplier-price-imports' or input_source_bytes <> u.total_bytes
     or input_source_sha256 is distinct from u.checksum_sha256 then raise exception 'UPLOAD_VERIFY_BINDING';end if;
  if u.status not in ('created','uploading','uploaded') or (u.status <> 'uploaded' and u.expires_at <= clock_timestamp())
     or r.status not in ('received','uploaded','parsing','staged','validated') then raise exception 'UPLOAD_VERIFY_STATE';end if;
  select x.* into o from storage.objects x where x.bucket_id=u.storage_bucket and x.name=u.storage_object_path for share;
  if not found or o.id is distinct from input_object_id or o.version is distinct from input_object_version
     or o.updated_at is distinct from input_object_updated_at then raise exception 'UPLOAD_VERIFY_OBJECT_CHANGED';end if;
  if coalesce(o.metadata->>'size','') !~ '^[0-9]{1,10}$'
     or (o.metadata->>'size')::bigint <> input_source_bytes then raise exception 'UPLOAD_VERIFY_OBJECT_SIZE';end if;
  select x.* into h from supplier_price_ingestion_internal.handoffs x where x.session_id=u.id for update;
  if found then
    if h.release_id <> r.id or h.organization_id <> u.organization_id or h.storage_bucket <> u.storage_bucket
       or h.source_path <> u.storage_object_path or h.source_sha256 <> input_source_sha256
       or h.source_bytes <> input_source_bytes or h.total_rows <> input_total_rows or h.object_id <> input_object_id
       or h.object_version <> input_object_version or h.object_updated_at <> input_object_updated_at
       or r.total_rows <> h.total_rows or u.status <> 'uploaded' then raise exception 'UPLOAD_VERIFY_REPLAY_CONFLICT';end if;
  else
    if r.status <> 'received' or r.current_cursor <> 0 or r.processed_rows <> 0
       or exists(select 1 from public.supplier_price_release_batches b where b.release_id=r.id) then raise exception 'UPLOAD_VERIFY_ALREADY_STARTED';end if;
    insert into supplier_price_ingestion_internal.handoffs(session_id,release_id,organization_id,storage_bucket,source_path,
      source_sha256,source_bytes,total_rows,object_id,object_version,object_updated_at,workflow_id)
      values(u.id,r.id,u.organization_id,u.storage_bucket,u.storage_object_path,input_source_sha256,input_source_bytes,
        input_total_rows,input_object_id,input_object_version,input_object_updated_at,'supplier-price-verified:v1:'||r.id::text)
      returning * into h;
    update public.supplier_price_upload_sessions x set status='uploaded',uploaded_bytes=x.total_bytes,
      uploaded_at=clock_timestamp(),completed_at=clock_timestamp(),updated_at=clock_timestamp() where x.id=u.id;
    update public.supplier_price_releases x set status='uploaded',total_rows=input_total_rows,
      uploaded_at=clock_timestamp(),updated_at=clock_timestamp(),worker_version='verified-handoff-v1' where x.id=r.id;
    insert into public.supplier_price_release_events(release_id,event_type,stage,status,total_rows,worker_version)
      values(r.id,'source_verified','upload','uploaded',input_total_rows,'verified-handoff-v1');
  end if;
  return jsonb_build_object('status','verified','session_id',u.id,'release_id',r.id,'handoff_id',h.id,
    'workflow_id',h.workflow_id,'queue_name',h.queue_name,'source_bytes',h.source_bytes,'source_sha256',h.source_sha256,
    'total_rows',h.total_rows,'published',false);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.complete_supplier_price_verified_upload(uuid,uuid,uuid,uuid,text,timestamp with time zone,bigint,text,bigint)')))<>'01d4b7f466f2c73e98b4c0adf2fa92f3' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.complete_supplier_price_verified_upload(uuid,uuid,uuid,uuid,text,timestamp with time zone,bigint,text,bigint)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.complete_supplier_price_verified_upload(uuid,uuid,uuid,uuid,text,timestamp with time zone,bigint,text,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.complete_supplier_price_verified_upload(uuid,uuid,uuid,uuid,text,timestamp with time zone,bigint,text,bigint) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.finalize_supplier_price_release_shadow_batch(uuid,text,integer,bigint,integer,integer,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.finalize_supplier_price_release_shadow_batch(input_batch_id uuid, input_worker_id text, input_processed_rows integer, input_cursor bigint, input_accepted_rows integer DEFAULT 0, input_warning_rows integer DEFAULT 0, input_rejected_rows integer DEFAULT 0)
 RETURNS TABLE(status text, batch_id uuid, release_id uuid, release_status text, processed_rows bigint, current_cursor bigint, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch public.supplier_price_release_batches%rowtype;
  v_release public.supplier_price_releases%rowtype;
  v_release_id uuid;
  v_processed bigint;
  v_accepted bigint;
  v_warning bigint;
  v_rejected bigint;
  v_cursor bigint;
  v_status text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Supplier release finalization requires service role';
  end if;
  if input_batch_id is null or nullif(trim(input_worker_id), '') is null
     or input_processed_rows is null or input_cursor is null
     or input_accepted_rows is null or input_warning_rows is null or input_rejected_rows is null
     or input_processed_rows < 0 or input_accepted_rows < 0
     or input_warning_rows < 0 or input_rejected_rows < 0 then
    raise exception 'Invalid shadow finalization input';
  end if;
  select b.release_id into v_release_id from public.supplier_price_release_batches b
    where b.id = input_batch_id;
  if not found then raise exception 'Supplier release batch not found'; end if;
  -- Every mutating lease path locks release before batch.
  select r.* into v_release from public.supplier_price_releases r
    where r.id = v_release_id for update;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.id = input_batch_id for update;

  if input_processed_rows <> v_batch.row_count or input_cursor <> v_batch.cursor_end
     or input_accepted_rows::bigint + input_warning_rows + input_rejected_rows <> input_processed_rows
     or v_batch.row_count <> v_batch.cursor_end - v_batch.cursor_start + 1 then
    raise exception 'Shadow scan counts or cursor do not cover the complete batch';
  end if;
  if v_batch.status = 'completed' then
    if v_batch.accepted_count <> input_accepted_rows or v_batch.warning_count <> input_warning_rows
       or v_batch.rejected_count <> input_rejected_rows then
      raise exception 'Shadow replay counts differ from completed batch';
    end if;
    return query select 'finalized'::text, v_batch.id, v_batch.release_id,
      v_release.status, v_release.processed_rows, v_release.current_cursor,
      'Shadow batch already finalized; replay made no changes.'::text;
    return;
  end if;
  if v_batch.status <> 'running' or v_batch.lease_owner is distinct from trim(input_worker_id)
     or v_batch.lease_expires_at is null or v_batch.lease_expires_at <= now() then
    return query select 'stale'::text, v_batch.id, v_batch.release_id,
      v_release.status, v_release.processed_rows, v_release.current_cursor,
      'Batch lease is expired or owned by another worker.'::text;
    return;
  end if;
  if v_release.status <> 'parsing' then
    raise exception 'Release is not in the shadow parsing phase';
  end if;
  if exists (
    select 1 from public.supplier_price_release_batches b
    where b.release_id = v_batch.release_id and b.status = 'completed'
      and b.cursor_start <= v_batch.cursor_end and b.cursor_end >= v_batch.cursor_start
  ) then raise exception 'Completed shadow batches overlap'; end if;
  select coalesce(sum(b.row_count), 0)::bigint into v_processed
    from public.supplier_price_release_batches b
    where b.release_id = v_batch.release_id and b.status = 'completed';
  if v_batch.cursor_start <> v_processed + 1 then
    raise exception 'Shadow finalization would skip an unfinished batch';
  end if;

  update public.supplier_price_release_batches as b
    set status = 'completed', accepted_count = input_accepted_rows,
        warning_count = input_warning_rows, rejected_count = input_rejected_rows,
        completed_at = now(), last_heartbeat_at = now(), lease_owner = null,
        lease_expires_at = null, checksum = v_release.source_file_sha256
    where b.id = v_batch.id;
  select sum(b.row_count)::bigint, sum(b.accepted_count)::bigint,
         sum(b.warning_count)::bigint, sum(b.rejected_count)::bigint, max(b.cursor_end)
    into v_processed, v_accepted, v_warning, v_rejected, v_cursor
    from public.supplier_price_release_batches b
    where b.release_id = v_batch.release_id and b.status = 'completed';
  v_status := case when v_processed = v_release.total_rows and v_cursor = v_release.total_rows
                   then 'staged' else 'parsing' end;
  update public.supplier_price_releases as r
    set processed_rows = v_processed, current_cursor = v_cursor,
        accepted_rows = v_accepted, warning_rows = v_warning, rejected_rows = v_rejected,
        status = v_status, updated_at = now()
    where r.id = v_batch.release_id;
  insert into public.supplier_price_release_events
    (release_id, event_type, stage, status, cursor, processed_rows, total_rows, attempt, worker_version)
    values (v_batch.release_id, 'shadow_batch_finalized', 'shadow_scan', 'completed',
            v_cursor, v_processed, v_release.total_rows, v_batch.attempt, 'shadow-finalize-v2');
  return query select 'finalized'::text, v_batch.id, v_batch.release_id, v_status,
    v_processed, v_cursor, 'Shadow scan finalized; row persistence and publication remain pending.'::text;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.finalize_supplier_price_release_shadow_batch(uuid,text,integer,bigint,integer,integer,integer)')))<>'d047ede87467080c109981875888fc50' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.finalize_supplier_price_release_shadow_batch(uuid,text,integer,bigint,integer,integer,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.finalize_supplier_price_release_shadow_batch(uuid,text,integer,bigint,integer,integer,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.finalize_supplier_price_release_shadow_batch(uuid,text,integer,bigint,integer,integer,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.get_supplier_price_release_manifest(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.get_supplier_price_release_manifest(input_release_id uuid)
 RETURNS TABLE(id uuid, source_file_path text, source_file_sha256 text, total_rows bigint, source_date date)
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
  select r.id, r.source_file_path, r.source_file_sha256, r.total_rows, r.source_date
    from public.supplier_price_releases as r
   where r.id = input_release_id;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.get_supplier_price_release_manifest(uuid)')))<>'9ace9f93d0073967f645ccf0af070b8a' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.get_supplier_price_release_manifest(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_release_manifest(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_release_manifest(uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.get_supplier_price_upload_status(input_session_id uuid, input_actor_id uuid, input_organization_id uuid, input_auth_session_id uuid, input_token_iat bigint, input_token_exp bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare u public.supplier_price_upload_sessions%rowtype; r public.supplier_price_releases%rowtype;
 v supplier_price_ingestion_internal.verification_requests%rowtype; p public.profiles%rowtype;
 s auth.sessions%rowtype; ready boolean;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 if input_actor_id is null or input_organization_id is null or input_auth_session_id is null
  or input_token_iat is null or input_token_exp is null or input_token_iat<=0
  or input_token_iat>extract(epoch from clock_timestamp())+30
  or input_token_exp<=extract(epoch from clock_timestamp()) or input_token_exp<=input_token_iat
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into s from auth.sessions a where a.id=input_auth_session_id;
 if not found or s.user_id is distinct from input_actor_id
  or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into p from public.profiles a where a.id=input_actor_id;
 if not found or p.is_active is distinct from true or coalesce(p.role,'') not in ('admin','superadmin')
  or p.organization_id is distinct from input_organization_id
  or (p.session_revoked_at is not null and input_token_iat<=extract(epoch from p.session_revoked_at))
  then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into u from public.supplier_price_upload_sessions a where a.id=input_session_id
  and a.created_by=input_actor_id and a.organization_id=input_organization_id;
 if not found then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into r from public.supplier_price_releases a where a.id=u.release_id
  and a.organization_id=u.organization_id and a.created_by=u.created_by;
 if not found or not r.source_verification_required then raise exception 'UPLOAD_STATUS_DENIED'; end if;
 select a.* into v from supplier_price_ingestion_internal.verification_requests a where a.session_id=u.id;
 -- Presence/size only permits verification submission; it is NOT hash proof.
 select exists(select 1 from storage.objects o where o.bucket_id=u.storage_bucket and o.name=u.storage_object_path
  and nullif(o.version,'') is not null and o.updated_at is not null
  and o.metadata->>'size'=u.total_bytes::text) into ready;
 return jsonb_build_object('session_id',u.id,'release_id',r.id,'upload_status',u.status,
  'verification_status',coalesce(v.status,'not_requested'),'transfer_ready',ready,
  'total_bytes',u.total_bytes,'total_rows',r.total_rows,'processed_rows',r.processed_rows,
  'release_status',r.status,'expires_at',u.expires_at,'updated_at',coalesce(v.updated_at,u.updated_at),
  'published',false);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint)')))<>'e94309e2dd775581fb178a5a143f92f4' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_upload_status(uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.get_supplier_price_verified_manifest(uuid,uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.get_supplier_price_verified_manifest(input_release_id uuid, input_handoff_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.supplier_price_releases%rowtype; h supplier_price_ingestion_internal.handoffs%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  select x.* into r from public.supplier_price_releases x where x.id=input_release_id;
  select x.* into h from supplier_price_ingestion_internal.handoffs x where x.id=input_handoff_id and x.release_id=input_release_id;
  if r.id is null or h.id is null or not r.source_verification_required or r.uploaded_at is null
     or r.source_file_path <> h.source_path or r.source_file_sha256 <> h.source_sha256 or r.total_rows <> h.total_rows
     or r.organization_id <> h.organization_id or r.status not in ('uploaded','parsing','staged','validated')
     or not exists(select 1 from public.supplier_price_upload_sessions u where u.id=h.session_id and u.status='uploaded')
     or not exists(select 1 from storage.objects o where o.id=h.object_id and o.bucket_id=h.storage_bucket and o.name=h.source_path
       and o.version=h.object_version and o.updated_at=h.object_updated_at
       and o.metadata->>'size'=h.source_bytes::text) then raise exception 'UPLOAD_HANDOFF_NOT_READY';end if;
  return jsonb_build_object('id',r.id,'source_file_path',r.source_file_path,'source_file_sha256',r.source_file_sha256,
    'source_file_bytes',h.source_bytes,'total_rows',r.total_rows,'source_date',r.source_date,'handoff_id',h.id);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.get_supplier_price_verified_manifest(uuid,uuid)')))<>'b3d88c87f2866b3b3bc1a5b32cd4d0e8' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.get_supplier_price_verified_manifest(uuid,uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.get_supplier_price_verified_manifest(uuid,uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_supplier_price_verified_manifest(uuid,uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.heartbeat_supplier_price_release_batch(uuid,text,integer,bigint,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.heartbeat_supplier_price_release_batch(input_batch_id uuid, input_worker_id text, input_processed_rows integer DEFAULT 0, input_cursor bigint DEFAULT NULL::bigint, input_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(status text, batch_id uuid, release_id uuid, processed_rows bigint, current_cursor bigint, lease_expires_at timestamp with time zone, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch public.supplier_price_release_batches%rowtype;
  v_release_id uuid; v_cursor bigint; v_expires timestamptz;
begin
  if coalesce(auth.role(),'') <> 'service_role' then
    raise exception 'Supplier release worker requires service role';
  end if;
  if input_batch_id is null or nullif(trim(input_worker_id),'') is null
     or input_processed_rows is null or input_processed_rows<0
     or input_lease_seconds is null or input_lease_seconds not between 30 and 3600 then
    raise exception 'Invalid supplier release heartbeat input';
  end if;
  select b.release_id into v_release_id from public.supplier_price_release_batches b
    where b.id=input_batch_id;
  if not found then raise exception 'Supplier release batch not found'; end if;
  -- Consistent release-before-batch locking prevents lease-path deadlocks.
  perform 1 from public.supplier_price_releases r where r.id=v_release_id for update;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.id=input_batch_id for update;
  if v_batch.status<>'running' or v_batch.lease_owner is distinct from trim(input_worker_id)
     or v_batch.lease_expires_at is null or v_batch.lease_expires_at<=clock_timestamp() then
    return query select 'stale'::text,v_batch.id,v_batch.release_id,0::bigint,
      null::bigint,v_batch.lease_expires_at,'Lease expired or belongs to another worker.'::text;
    return;
  end if;
  v_cursor:=coalesce(input_cursor,v_batch.cursor_start-1);
  if input_processed_rows>v_batch.row_count or v_cursor<v_batch.cursor_start-1
     or v_cursor>v_batch.cursor_end
     or input_processed_rows<>v_cursor-v_batch.cursor_start+1 then
    raise exception 'Heartbeat counts and cursor disagree with claimed batch';
  end if;
  v_expires:=clock_timestamp()+make_interval(secs=>input_lease_seconds);
  update public.supplier_price_release_batches b
    set last_heartbeat_at=clock_timestamp(),lease_expires_at=v_expires
    where b.id=v_batch.id;
  -- Heartbeat reports liveness only. Finalizer owns release cursor/counters.
  return query select 'heartbeat'::text,v_batch.id,v_batch.release_id,
    input_processed_rows::bigint,v_cursor,v_expires,'Batch heartbeat recorded.'::text;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.heartbeat_supplier_price_release_batch(uuid,text,integer,bigint,integer)')))<>'166d387d0aa7c9984631e9f5784ccfa6' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.heartbeat_supplier_price_release_batch(uuid,text,integer,bigint,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.heartbeat_supplier_price_release_batch(uuid,text,integer,bigint,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.heartbeat_supplier_price_release_batch(uuid,text,integer,bigint,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.recover_expired_supplier_price_release_batches(integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.recover_expired_supplier_price_release_batches(input_limit integer DEFAULT 100)
 RETURNS integer
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
declare v_count integer := 0;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Supplier release worker requires service role';
  end if;
  if input_limit < 1 or input_limit > 1000 then
    raise exception 'input_limit must be between 1 and 1000';
  end if;
  with expired as (
    select id from public.supplier_price_release_batches
     where status = 'running' and lease_expires_at is not null and lease_expires_at <= now()
     order by lease_expires_at asc limit input_limit for update skip locked
  )
  update public.supplier_price_release_batches batch
     set status = 'retrying', attempt = batch.attempt + 1, lease_owner = null,
         lease_expires_at = null, error_code = 'LEASE_EXPIRED',
         error_message = 'Worker lease expired; batch is retryable.'
    from expired where batch.id = expired.id;
  get diagnostics v_count = row_count;
  return v_count;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.recover_expired_supplier_price_release_batches(integer)')))<>'b1c4ccf4b07a35b3a127ee8221df362a' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.recover_expired_supplier_price_release_batches(integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.recover_expired_supplier_price_release_batches(integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.recover_expired_supplier_price_release_batches(integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.request_supplier_price_upload_verification(input_session_id uuid, input_actor_id uuid, input_organization_id uuid, input_auth_session_id uuid, input_token_iat bigint, input_token_exp bigint)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare s auth.sessions%rowtype; p public.profiles%rowtype; c jsonb;
 r supplier_price_ingestion_internal.verification_requests%rowtype;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_REQUEST_SERVICE_REQUIRED'; end if;
 if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UPLOAD_REQUEST_REQUIRES_READ_COMMITTED'; end if;
 if input_actor_id is null or input_organization_id is null or input_auth_session_id is null
  or input_token_iat is null or input_token_exp is null or input_token_iat <= 0
  or input_token_iat > extract(epoch from clock_timestamp())+30
  or input_token_exp <= extract(epoch from clock_timestamp()) or input_token_exp <= input_token_iat
  then raise exception 'UPLOAD_REQUEST_SESSION_DENIED'; end if;
 select a.* into s from auth.sessions a where a.id=input_auth_session_id for share;
 if not found or s.user_id is distinct from input_actor_id
  or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'UPLOAD_REQUEST_SESSION_DENIED'; end if;
 select a.* into p from public.profiles a where a.id=input_actor_id for share;
 if not found or p.is_active is distinct from true or coalesce(p.role,'') not in ('admin','superadmin')
  or p.organization_id is distinct from input_organization_id then raise exception 'UPLOAD_REQUEST_ACTOR_DENIED'; end if;
 if p.session_revoked_at is not null and input_token_iat<=extract(epoch from p.session_revoked_at)
  then raise exception 'UPLOAD_REQUEST_SESSION_DENIED'; end if;
 -- Metadata-only check and same upload/release locks as trusted completion.
 -- This rejects legacy admission, nonexistent object, wrong scope and expiry.
 c:=public.begin_supplier_price_upload_verification(input_session_id,input_organization_id,input_actor_id);
 if input_token_exp<=extract(epoch from clock_timestamp())
  or (s.not_after is not null and s.not_after<=clock_timestamp()) then raise exception 'UPLOAD_REQUEST_SESSION_DENIED'; end if;
 insert into supplier_price_ingestion_internal.verification_requests(session_id,release_id,organization_id,actor_id,accepted_auth_session_id,accepted_token_iat)
 values(input_session_id,(c->>'release_id')::uuid,input_organization_id,input_actor_id,input_auth_session_id,input_token_iat)
 on conflict(session_id) do nothing;
 select a.* into r from supplier_price_ingestion_internal.verification_requests a where a.session_id=input_session_id;
 if r.actor_id is distinct from input_actor_id or r.organization_id is distinct from input_organization_id
  or r.release_id is distinct from (c->>'release_id')::uuid then raise exception 'UPLOAD_REQUEST_BINDING'; end if;
 return jsonb_build_object('request_id',r.id,'session_id',r.session_id,'release_id',r.release_id,'status',r.status,'published',false);
end; $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint)')))<>'9d25def82ad8634a22526414f96eae8c' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.request_supplier_price_upload_verification(uuid,uuid,uuid,uuid,bigint,bigint) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.resume_supplier_price_shadow_finalization(uuid,text,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.resume_supplier_price_shadow_finalization(input_release_id uuid, input_worker_id text, input_lease_seconds integer DEFAULT 120)
 RETURNS TABLE(status text, batch_id uuid, release_id uuid, batch_number integer, cursor_start bigint, cursor_end bigint, attempt integer, lease_expires_at timestamp with time zone, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_batch public.supplier_price_release_batches%rowtype;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'Supplier shadow recovery requires service role';
  end if;
  if input_release_id is null or nullif(trim(input_worker_id), '') is null
     or input_lease_seconds is null or input_lease_seconds not between 30 and 3600 then
    raise exception 'Invalid shadow recovery input';
  end if;
  select r.* into v_release from public.supplier_price_releases r
    where r.id = input_release_id for update skip locked;
  if not found then
    return query select 'lock_waiting'::text, null::uuid, input_release_id,
      null::integer, null::bigint, null::bigint, null::integer, null::timestamptz,
      'Release not found or locked.'::text;
    return;
  end if;
  if v_release.status <> 'parsing' or v_release.current_cursor <> v_release.total_rows
     or v_release.total_rows < 1 then
    return query select 'not_claimable'::text, null::uuid, v_release.id,
      null::integer, null::bigint, null::bigint, null::integer, null::timestamptz,
      'Release does not have a pending shadow finalization.'::text;
    return;
  end if;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.release_id = v_release.id and b.status in ('running', 'retrying')
      and b.cursor_end = v_release.total_rows
    order by b.batch_number desc limit 1 for update skip locked;
  if not found then
    return query select 'not_claimable'::text, null::uuid, v_release.id,
      null::integer, null::bigint, null::bigint, null::integer, null::timestamptz,
      'No unfinished final batch found.'::text;
    return;
  end if;
  if v_batch.lease_expires_at > now() then
    return query select 'busy'::text, v_batch.id, v_release.id, v_batch.batch_number,
      v_batch.cursor_start, v_batch.cursor_end, v_batch.attempt,
      v_batch.lease_expires_at, 'Final batch still has an active lease.'::text;
    return;
  end if;
  update public.supplier_price_release_batches as b
    set status = 'running', lease_owner = trim(input_worker_id),
        lease_expires_at = now() + make_interval(secs => input_lease_seconds),
        attempt = b.attempt + 1, last_heartbeat_at = now()
    where b.id = v_batch.id returning b.* into v_batch;
  return query select 'claimed'::text, v_batch.id, v_release.id, v_batch.batch_number,
    v_batch.cursor_start, v_batch.cursor_end, v_batch.attempt,
    v_batch.lease_expires_at, 'Expired shadow batch reacquired for rescan and finalization.'::text;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.resume_supplier_price_shadow_finalization(uuid,text,integer)')))<>'cb866a6200474d70a1975b0d9a84bf29' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.resume_supplier_price_shadow_finalization(uuid,text,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.resume_supplier_price_shadow_finalization(uuid,text,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resume_supplier_price_shadow_finalization(uuid,text,integer) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.settle_supplier_price_upload_verification(uuid,text,uuid,text,integer,text)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.settle_supplier_price_upload_verification(input_request_id uuid, input_worker_id text, input_lease_token uuid, input_action text, input_lease_seconds integer DEFAULT 120, input_error_code text DEFAULT NULL::text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r supplier_price_ingestion_internal.verification_requests%rowtype; h uuid;
begin
 if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_REQUEST_SERVICE_REQUIRED'; end if;
 if input_action is null or input_action not in ('heartbeat','verified','retry','failed')
  or input_lease_seconds is null or input_lease_seconds not between 30 and 3600
  or (input_action in ('retry','failed') and (input_error_code is null or input_error_code !~ '^[A-Z0-9_]{1,80}$'))
  then raise exception 'UPLOAD_REQUEST_CONFIG'; end if;
 select a.* into r from supplier_price_ingestion_internal.verification_requests a where a.id=input_request_id for update;
 if not found or r.status<>'verifying' or r.worker_id is distinct from input_worker_id
  or r.lease_token is distinct from input_lease_token or r.lease_expires_at<=clock_timestamp()
  then raise exception 'UPLOAD_REQUEST_LEASE_LOST'; end if;
 if input_action='verified' then
  select a.id into h from supplier_price_ingestion_internal.handoffs a where a.session_id=r.session_id
   and a.release_id=r.release_id and a.organization_id=r.organization_id;
  if not found then raise exception 'UPLOAD_REQUEST_PROOF_MISSING'; end if;
 end if;
 update supplier_price_ingestion_internal.verification_requests a set
  status=case input_action when 'heartbeat' then 'verifying' when 'verified' then 'verified'
   when 'failed' then 'failed' else case when a.attempt>=5 then 'failed' else 'queued' end end,
  lease_expires_at=case when input_action='heartbeat' then clock_timestamp()+make_interval(secs=>input_lease_seconds) else null end,
  worker_id=case when input_action='heartbeat' then a.worker_id else null end,
  lease_token=case when input_action='heartbeat' then a.lease_token else null end,
  next_attempt_at=case when input_action='retry' then clock_timestamp()+make_interval(secs=>least(300,5*a.attempt*a.attempt)) else a.next_attempt_at end,
  last_error=case when input_action in ('failed','retry') then input_error_code else null end,
  handoff_id=coalesce(h,a.handoff_id),updated_at=clock_timestamp() where a.id=r.id returning a.* into r;
 return jsonb_build_object('request_id',r.id,'session_id',r.session_id,'release_id',r.release_id,'status',r.status,'published',false);
end; $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.settle_supplier_price_upload_verification(uuid,text,uuid,text,integer,text)')))<>'a21dfae2cf7c837bcaad1e3a879b20da' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.settle_supplier_price_upload_verification(uuid,text,uuid,text,integer,text)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.settle_supplier_price_upload_verification(uuid,text,uuid,text,integer,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.settle_supplier_price_upload_verification(uuid,text,uuid,text,integer,text) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.stage_supplier_price_release_batch(uuid,text,jsonb)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.stage_supplier_price_release_batch(input_batch_id uuid, input_worker_id text, input_rows jsonb)
 RETURNS TABLE(status text, batch_id uuid, release_id_result uuid, staged_rows bigint, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_batch public.supplier_price_release_batches%rowtype;
  v_release_id uuid; v_count bigint; v_unique bigint; v_min bigint; v_max bigint;
begin
  if coalesce(auth.role(),'')<>'service_role' then
    raise exception 'Supplier shadow staging requires service role';
  end if;
  if input_batch_id is null or nullif(trim(input_worker_id),'') is null
     or input_rows is null or jsonb_typeof(input_rows)<>'array' then
    raise exception 'Invalid supplier shadow staging input';
  end if;
  select b.release_id into v_release_id from public.supplier_price_release_batches b
    where b.id=input_batch_id;
  if not found then raise exception 'Supplier release batch not found'; end if;
  perform 1 from public.supplier_price_releases r where r.id=v_release_id for update;
  select b.* into v_batch from public.supplier_price_release_batches b
    where b.id=input_batch_id for update;
  if v_batch.status<>'running' or v_batch.lease_owner is distinct from trim(input_worker_id)
     or v_batch.lease_expires_at is null or v_batch.lease_expires_at<=clock_timestamp() then
    return query select 'stale'::text,v_batch.id,v_batch.release_id,0::bigint,
      'Lease expired or belongs to another worker.'::text;
    return;
  end if;
  select count(*),count(distinct x.source_row_number),min(x.source_row_number),max(x.source_row_number)
    into v_count,v_unique,v_min,v_max
    from jsonb_to_recordset(input_rows) x(source_row_number bigint);
  if v_count<>v_batch.row_count or v_unique<>v_count
     or v_min<>v_batch.cursor_start or v_max<>v_batch.cursor_end then
    raise exception 'Shadow rows must exactly cover the claimed batch';
  end if;
  if exists(select 1 from jsonb_array_elements(input_rows) j
      where coalesce(length(j->>'row_hash'),0)<>64) then
    raise exception 'Shadow row hash missing or malformed';
  end if;
  if exists(
    select 1 from jsonb_array_elements(input_rows) j
    join public.supplier_price_release_rows rr
      on rr.release_id=v_batch.release_id and rr.source_row_number=(j->>'source_row_number')::bigint
    where (to_jsonb(rr)-'id'-'release_id'-'created_at') is distinct from
      (to_jsonb(jsonb_populate_record(null::public.supplier_price_release_rows,j))-'id'-'release_id'-'created_at')
  ) then raise exception 'Shadow retry payload differs from persisted rows'; end if;
  insert into public.supplier_price_release_rows
    (release_id,source_row_number,normalized_code,product_code,description,oem_no,ean,
     vehicle,vehicle_model,market_segment,dimensions,weight,description_tr,origin,tariff,
     image_url,buy_price,currency,moq,lead_time_days,notes,valid_from,row_hash,
     row_status,error_code,error_message)
  select v_batch.release_id,x.source_row_number,x.normalized_code,x.product_code,
    x.description,x.oem_no,x.ean,x.vehicle,x.vehicle_model,x.market_segment,x.dimensions,
    x.weight,x.description_tr,x.origin,x.tariff,x.image_url,x.buy_price,x.currency,
    x.moq,x.lead_time_days,x.notes,x.valid_from,x.row_hash,x.row_status,x.error_code,x.error_message
  from jsonb_populate_recordset(null::public.supplier_price_release_rows,input_rows) x
  on conflict (release_id,source_row_number) do nothing;
  select count(*) into v_count from public.supplier_price_release_rows rr
    where rr.release_id=v_batch.release_id
      and rr.source_row_number between v_batch.cursor_start and v_batch.cursor_end;
  if v_count<>v_batch.row_count then raise exception 'Shadow staged row count mismatch'; end if;
  return query select 'staged'::text,v_batch.id,v_batch.release_id,v_count,
    'Shadow rows persisted; exact replay is immutable; publication disabled.'::text;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.stage_supplier_price_release_batch(uuid,text,jsonb)')))<>'5dac6c7cd844153a293f311653fb34da' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.stage_supplier_price_release_batch(uuid,text,jsonb)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.stage_supplier_price_release_batch(uuid,text,jsonb) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.stage_supplier_price_release_batch(uuid,text,jsonb) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.start_supplier_price_release_batch_validation(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.start_supplier_price_release_batch_validation(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare r public.supplier_price_releases%rowtype; v public.supplier_price_release_validation_runs%rowtype;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'VALIDATION_ROLE'; end if;
 select * into r from public.supplier_price_releases where id=input_release_id for update;
 if not found then raise exception 'Supplier release not found'; end if;
 if r.status not in ('staged','validated') then raise exception 'Release must be staged before batch validation'; end if;
 insert into public.supplier_price_release_validation_runs(release_id,total_rows,status,started_at,updated_at)
 values(r.id,r.total_rows,'running',coalesce(now(),now()),now())
 on conflict (release_id) do update set updated_at=now()
 returning * into v;
 return jsonb_build_object('release_id',v.release_id,'status',v.status,'cursor',v.cursor,'total_rows',v.total_rows,'completed',v.completed_at is not null);
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.start_supplier_price_release_batch_validation(uuid)')))<>'11cb3b9dfe52f5e6715fbf52642065dc' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.start_supplier_price_release_batch_validation(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.start_supplier_price_release_batch_validation(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_supplier_price_release_batch_validation(uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.start_supplier_price_upload_session(input_organization_id uuid, input_actor_id uuid, input_supplier_id uuid, input_brand_id uuid, input_file_name text, input_content_type text, input_total_bytes bigint, input_checksum_sha256 text, input_idempotency_key text, input_mode text DEFAULT 'replace'::text, input_source_date date DEFAULT NULL::date)
 RETURNS TABLE(session_id uuid, release_id uuid, status text, storage_bucket text, storage_object_path text, total_bytes bigint, uploaded_bytes bigint, expires_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_existing public.supplier_price_upload_sessions%rowtype;
  v_release public.supplier_price_releases%rowtype;
  v_session_id uuid;
  v_release_id uuid;
  v_file_name text;
  v_content_type text;
  v_path text;
  v_checksum text;
  v_mode text;
  v_key text;
  v_expires timestamptz;
  v_constraint text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception using errcode = '42501', message = 'Supplier upload session requires service role';
  end if;
  if input_organization_id is null or input_actor_id is null
     or input_supplier_id is null or input_brand_id is null then
    raise exception using errcode = '22023', message = 'Organization, actor, supplier and brand are required';
  end if;
  if input_total_bytes is null or input_total_bytes < 1 or input_total_bytes > 1073741824 then
    raise exception using errcode = '22023', message = 'File size must be between 1 byte and 1 GiB';
  end if;
  v_key := trim(coalesce(input_idempotency_key, ''));
  if length(v_key) < 8 or length(v_key) > 200 then
    raise exception using errcode = '22023', message = 'A stable idempotency key of 8 to 200 characters is required';
  end if;
  v_checksum := lower(trim(coalesce(input_checksum_sha256, '')));
  if v_checksum !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = '22023', message = 'checksum_sha256 must be a SHA-256 hex digest';
  end if;
  v_mode := lower(trim(coalesce(input_mode, 'replace')));
  if v_mode not in ('replace', 'merge') then
    raise exception using errcode = '22023', message = 'input_mode must be replace or merge';
  end if;
  v_file_name := regexp_replace(left(trim(coalesce(input_file_name, 'supplier-prices.csv')), 180), '[^A-Za-z0-9._-]+', '_', 'g');
  if v_file_name = '' then v_file_name := 'supplier-prices.csv'; end if;
  if v_file_name in ('.', '..') then
    raise exception using errcode = '22023', message = 'Select a valid file name';
  end if;
  v_content_type := coalesce(nullif(trim(input_content_type), ''), 'application/octet-stream');
  if length(v_content_type) > 160 then
    raise exception using errcode = '22023', message = 'Content type must not exceed 160 characters';
  end if;

  -- Validate tenant ownership even when a replay key already exists.
  if not exists (select 1 from public.suppliers s
                 where s.id = input_supplier_id and s.organization_id = input_organization_id) then
    raise exception using errcode = 'PT403', message = 'Supplier is not in this organization';
  end if;
  if not exists (select 1 from public.brands b
                 where b.id = input_brand_id and b.organization_id = input_organization_id) then
    raise exception using errcode = 'PT403', message = 'Brand is not in this organization';
  end if;

  -- A short transaction lock serializes identical keys, including the initial
  -- absent-row case. Hash collisions can only delay an unrelated request.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    'supplier-upload:' || input_organization_id::text || ':' || v_key, 0));
  select u.* into v_existing from public.supplier_price_upload_sessions u
   where u.organization_id = input_organization_id and u.idempotency_key = v_key
   for update;
  if found then
    select r.* into v_release from public.supplier_price_releases r
     where r.id = v_existing.release_id for update;
    if not found then
      raise exception using errcode = 'PT409', message = 'UPLOAD_SESSION_INTEGRITY_CONFLICT';
    end if;
    if v_existing.created_by is distinct from input_actor_id
       or v_existing.checksum_sha256 is distinct from v_checksum
       or v_existing.total_bytes is distinct from input_total_bytes
       or v_existing.file_name is distinct from v_file_name
       or v_existing.content_type is distinct from v_content_type
       or v_release.organization_id is distinct from input_organization_id
       or v_release.created_by is distinct from input_actor_id
       or v_release.supplier_id is distinct from input_supplier_id
       or v_release.brand_id is distinct from input_brand_id
       or v_release.source_file_sha256 is distinct from v_checksum
       or v_release.source_file_path is distinct from v_existing.storage_object_path
       or v_release.mode is distinct from v_mode
       or v_release.source_date is distinct from input_source_date then
      raise exception using errcode = 'PT409', message = 'UPLOAD_REQUEST_CONFLICT: This upload key belongs to a different request';
    end if;
    if v_existing.status not in ('created', 'uploading', 'uploaded')
       or v_existing.expires_at <= clock_timestamp()
       or v_release.status in ('failed', 'cancelled', 'superseded', 'archived') then
      raise exception using errcode = 'PT409', message = 'UPLOAD_SESSION_NOT_RESUMABLE: Existing upload is closed or expired';
    end if;
    return query select v_existing.id, v_existing.release_id, v_existing.status,
      v_existing.storage_bucket, v_existing.storage_object_path,
      v_existing.total_bytes, v_existing.uploaded_bytes, v_existing.expires_at;
    return;
  end if;

  v_session_id := pg_catalog.gen_random_uuid();
  v_release_id := pg_catalog.gen_random_uuid();
  v_path := format('%s/supplier-price/%s/%s', input_organization_id::text, v_session_id::text, v_file_name);
  v_expires := clock_timestamp() + interval '24 hours';
  begin
    insert into public.supplier_price_releases (
      id, organization_id, supplier_id, brand_id, source_file_path,
      source_file_sha256, mode, status, source_date, worker_version, created_by
    ) values (
      v_release_id, input_organization_id, input_supplier_id, input_brand_id, v_path,
      v_checksum, v_mode, 'received', input_source_date, 'upload-session-v2', input_actor_id
    );
    insert into public.supplier_price_upload_sessions (
      id, organization_id, release_id, idempotency_key, storage_bucket,
      storage_object_path, file_name, content_type, total_bytes, checksum_sha256,
      status, expires_at, created_by
    ) values (
      v_session_id, input_organization_id, v_release_id, v_key,
      'supplier-price-imports', v_path, v_file_name, v_content_type,
      input_total_bytes, v_checksum, 'created', v_expires, input_actor_id
    );
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name;
    if v_constraint = 'uq_supplier_price_releases_idempotency' then
      raise exception using errcode = 'PT409', message = 'UPLOAD_SOURCE_ALREADY_REGISTERED: Review the existing upload before starting another';
    end if;
    raise;
  end;
  return query select v_session_id, v_release_id, 'created'::text,
    'supplier-price-imports'::text, v_path, input_total_bytes, 0::bigint, v_expires;
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)')))<>'8aac96a01421418f9a5b8ef052ff3e1d' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_supplier_price_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.start_supplier_price_verified_upload_session(input_organization_id uuid, input_actor_id uuid, input_supplier_id uuid, input_brand_id uuid, input_file_name text, input_content_type text, input_total_bytes bigint, input_checksum_sha256 text, input_idempotency_key text, input_mode text DEFAULT 'replace'::text, input_source_date date DEFAULT NULL::date)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare receipt jsonb; r public.supplier_price_releases%rowtype;
begin
  if coalesce(auth.role(),'') <> 'service_role' then raise exception 'UPLOAD_VERIFY_ROLE';end if;
  if current_setting('transaction_isolation') <> 'read committed' then raise exception 'UPLOAD_VERIFY_ISOLATION';end if;
  if not exists(select 1 from public.profiles p where p.id=input_actor_id and p.organization_id=input_organization_id
    and p.is_active is true and p.role in ('admin','superadmin')) then raise exception 'UPLOAD_VERIFY_ACTOR';end if;
  select to_jsonb(s) into receipt from public.start_supplier_price_upload_session(input_organization_id,input_actor_id,
    input_supplier_id,input_brand_id,input_file_name,input_content_type,input_total_bytes,input_checksum_sha256,
    input_idempotency_key,input_mode,input_source_date) s;
  select x.* into r from public.supplier_price_releases x where x.id=(receipt->>'release_id')::uuid for update;
  if not found then raise exception 'UPLOAD_VERIFY_BINDING';end if;
  if not r.source_verification_required and (r.status <> 'received' or r.processed_rows <> 0 or r.current_cursor <> 0
    or exists(select 1 from public.supplier_price_release_batches b where b.release_id=r.id)) then raise exception 'UPLOAD_VERIFY_ALREADY_STARTED';end if;
  update public.supplier_price_releases x set source_verification_required=true where x.id=r.id;
  return receipt;
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)')))<>'3c904c3493eef530b13df189e01ce30a' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.start_supplier_price_verified_upload_session(uuid,uuid,uuid,uuid,text,text,bigint,text,text,text,date) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.supplier_price_current_snapshot(uuid,uuid,uuid,text[])') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.supplier_price_current_snapshot(input_organization_id uuid, input_supplier_id uuid, input_brand_id uuid, input_codes text[])
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_pointer public.supplier_current_price_pointers%rowtype;
  v_publication public.supplier_price_publications%rowtype;
  v_release public.supplier_price_releases%rowtype;
  v_prices jsonb;
  v_code_count integer;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_SERVICE_REQUIRED';
  end if;

  if input_organization_id is null or input_supplier_id is null or input_brand_id is null then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_SCOPE_REQUIRED';
  end if;

  if input_codes is null or coalesce(array_length(input_codes, 1), 0) < 1
     or array_length(input_codes, 1) > 20 then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_CODES_INVALID';
  end if;

  select count(distinct code)::integer
    into v_code_count
    from unnest(input_codes) as codes(code)
   where code is not null and btrim(code) <> '' and btrim(code) = code and length(code) <= 128;
  if v_code_count <> array_length(input_codes, 1) then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_CODES_INVALID';
  end if;

  select ptr.*
    into v_pointer
    from public.supplier_current_price_pointers ptr
   where ptr.organization_id = input_organization_id
     and ptr.supplier_id = input_supplier_id
     and ptr.brand_id = input_brand_id;

  if not found then
    return jsonb_build_object(
      'status', 'unpublished',
      'organization_id', input_organization_id,
      'supplier_id', input_supplier_id,
      'brand_id', input_brand_id,
      'release_id', null,
      'publication_id', null,
      'version', null,
      'prices', '[]'::jsonb
    );
  end if;

  select pub.*
    into v_publication
    from public.supplier_price_publications pub
   where pub.id = v_pointer.publication_id
     and pub.release_id = v_pointer.release_id
     and pub.organization_id = input_organization_id
     and pub.supplier_id = input_supplier_id
     and pub.brand_id = input_brand_id
     and pub.status = 'published';
  if not found then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_PUBLICATION_INVALID';
  end if;

  select rel.*
    into v_release
    from public.supplier_price_releases rel
   where rel.id = v_pointer.release_id
     and rel.organization_id = input_organization_id
     and rel.supplier_id = input_supplier_id
     and rel.brand_id = input_brand_id
     and rel.status = 'published';
  if not found then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_RELEASE_INVALID';
  end if;

  if exists (
    select 1
      from public.supplier_price_release_rows rr
     where rr.release_id = v_release.id
       and rr.row_status = 'accepted'
       and public.normalize_part_code(rr.normalized_code) = any(input_codes)
       and (rr.currency is null or btrim(rr.currency) = ''
            or coalesce(rr.valid_from, v_release.source_date) is null)
  ) then
    raise exception 'SUPPLIER_PRICE_SNAPSHOT_ROW_INVALID';
  end if;

  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'normalized_code', public.normalize_part_code(rr.normalized_code),
        'product_code', rr.product_code,
        'buy_price', rr.buy_price::text,
        'currency', upper(btrim(rr.currency)),
        'valid_from', to_char(coalesce(rr.valid_from, v_release.source_date), 'YYYY-MM-DD')
      ) order by public.normalize_part_code(rr.normalized_code)
    ),
    '[]'::jsonb
  )
    into v_prices
    from public.supplier_price_release_rows rr
   where rr.release_id = v_release.id
     and rr.row_status = 'accepted'
     and rr.buy_price is not null
     and public.normalize_part_code(rr.normalized_code) = any(input_codes);

  return jsonb_build_object(
    'status', 'current',
    'organization_id', input_organization_id,
    'supplier_id', input_supplier_id,
    'brand_id', input_brand_id,
    'release_id', v_release.id,
    'publication_id', v_publication.id,
    'version', v_publication.publication_version::text,
    'prices', v_prices
  );
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.supplier_price_current_snapshot(uuid,uuid,uuid,text[])')))<>'1c4038bfcf92f1df8ea116b7d29f2e39' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.supplier_price_current_snapshot(uuid,uuid,uuid,text[])'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.supplier_price_current_snapshot(uuid,uuid,uuid,text[]) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supplier_price_current_snapshot(uuid,uuid,uuid,text[]) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.supplier_price_upload_object_is_sealed(text,text)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.supplier_price_upload_object_is_sealed(input_bucket text, input_path text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO ''
AS $function$
  select input_bucket='supplier-price-imports' and
    (split_part(input_path,'/',1) is distinct from public.current_profile_org_id()::text or exists(
      select 1 from public.supplier_price_upload_sessions u join public.supplier_price_releases r on r.id=u.release_id
      where u.storage_bucket=input_bucket and u.storage_object_path=input_path and r.source_verification_required and u.status='uploaded'));
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.supplier_price_upload_object_is_sealed(text,text)')))<>'2957e13e4db880be6dd2f0afbe9c25fe' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.supplier_price_upload_object_is_sealed(text,text)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.supplier_price_upload_object_is_sealed(text,text) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.supplier_price_upload_object_is_sealed(text,text) TO authenticated;
DO $foundation_function$ BEGIN IF to_regprocedure('public.validate_supplier_price_release(uuid)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.validate_supplier_price_release(input_release_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_result jsonb;
  v_audit jsonb;
  v_release public.supplier_price_releases%rowtype;
  v_event_floor bigint;
  v_blocked boolean;
  v_error text;
  v_message text;
begin
  if coalesce(auth.role(),'')<>'service_role' then raise exception 'Supplier release validation requires service role'; end if;
  if input_release_id is null then raise exception 'input_release_id is required'; end if;
  select r.* into v_release from public.supplier_price_releases r where r.id=input_release_id for update;
  if not found then raise exception 'Supplier release not found'; end if;
  begin
    v_audit:=supplier_price_validation_internal.cross_brand_audit(input_release_id);
  exception when undefined_table or undefined_column or insufficient_privilege then
    -- Dependency/schema drift must not accidentally return a green preview.
    -- Do not expose SQL diagnostics/table names to the caller.
    v_audit:=jsonb_build_object('policy','cross-brand-v1','checked',false,'review_required',true,
      'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
  end;
  select coalesce(max(e.id),0) into v_event_floor from public.supplier_price_release_events e where e.release_id=input_release_id;
  v_result:=supplier_price_validation_internal.validate_supplier_price_release(input_release_id);
  v_blocked:=coalesce((v_audit->>'review_required')::boolean,true);
  if v_blocked then
    v_error:=case when v_audit->>'checked'<>'true' then 'BRAND_IDENTITY_COMPARISON_UNAVAILABLE'
      when v_audit->>'distinct_incoming_codes'='0' then 'BRAND_IDENTITY_EMPTY_CODES'
      else 'CROSS_BRAND_BULK_OVERLAP' end;
    v_message:=case when v_error='BRAND_IDENTITY_EMPTY_CODES'
      then 'No usable product codes were found. Publication is blocked.'
      when v_audit->>'checked'='true'
      then 'Bulk product-code overlap with another brand. Review the selected brand and source file; existing prices remain unchanged.'
      else 'Brand identity comparison unavailable. Publication is blocked until comparison succeeds.' end;
    update public.supplier_price_releases set error_code=v_error,error_message=v_message where id=input_release_id;
    update public.supplier_price_release_events set status='review_required',error_code=v_error,error_message=v_message,
      worker_version='shadow-validation-cross-brand-v1' where release_id=input_release_id and id>v_event_floor;
    v_result:=v_result||jsonb_build_object('publishable',false,'message',v_message,'error_code',v_error);
  end if;
  update public.supplier_price_releases set brand_identity_audit=v_audit where id=input_release_id;
  return v_result||jsonb_build_object('brand_identity_audit',v_audit);
end;
$function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.validate_supplier_price_release(uuid)')))<>'aa2271dabd68e1c988393800efa68b21' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.validate_supplier_price_release(uuid)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.validate_supplier_price_release(uuid) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_supplier_price_release(uuid) TO service_role;
DO $foundation_function$ BEGIN IF to_regprocedure('public.validate_supplier_price_release_batch(uuid,integer)') IS NULL THEN EXECUTE $captured_function$CREATE OR REPLACE FUNCTION public.validate_supplier_price_release_batch(input_release_id uuid, input_batch_size integer DEFAULT 10000)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare v public.supplier_price_release_validation_runs%rowtype; r public.supplier_price_releases%rowtype; b record; n bigint; next_cursor bigint; dup bigint; currencies integer; final_status text; publishable boolean;
begin
 if coalesce(auth.role(),'')<>'service_role' then raise exception 'VALIDATION_ROLE'; end if;
 if input_batch_size is null or input_batch_size<1 or input_batch_size>50000 then raise exception 'VALIDATION_BATCH_SIZE'; end if;
 select * into r from public.supplier_price_releases where id=input_release_id for update;
 if not found then raise exception 'Supplier release not found'; end if;
 insert into public.supplier_price_release_validation_runs(release_id,total_rows,status,started_at) values(r.id,r.total_rows,'running',now()) on conflict do nothing;
 select * into v from public.supplier_price_release_validation_runs where release_id=r.id for update;
 if v.completed_at is not null then return jsonb_build_object('release_id',r.id,'status',v.status,'cursor',v.cursor,'total_rows',v.total_rows,'completed',true); end if;
 select max(source_row_number) into next_cursor from (select source_row_number from public.supplier_price_release_rows where release_id=r.id and source_row_number>v.cursor order by source_row_number limit input_batch_size) q;
 if next_cursor is null then next_cursor=v.cursor; end if;
 with batch as (select * from public.supplier_price_release_rows where release_id=r.id and source_row_number>v.cursor and source_row_number<=next_cursor)
 select count(*) filter(where row_status='accepted') as accepted_count,count(*) filter(where row_status='warning') as warning_count,count(*) filter(where row_status='rejected') as rejected_count,count(*) filter(where row_status='conflict') as conflict_count,count(*) filter(where buy_price is null or nullif(trim(currency),'') is null) as missing_count into b from batch;
 insert into public.supplier_price_release_validation_code_counts(release_id,normalized_code,row_count)
 select r.id,normalized_code,count(*) from public.supplier_price_release_rows where release_id=r.id and source_row_number>v.cursor and source_row_number<=next_cursor and normalized_code<>'' group by normalized_code
 on conflict (release_id,normalized_code) do update set row_count=public.supplier_price_release_validation_code_counts.row_count+excluded.row_count;
 update public.supplier_price_release_validation_runs set cursor=next_cursor,accepted_rows=accepted_rows+coalesce(b.accepted_count,0),warning_rows=warning_rows+coalesce(b.warning_count,0),rejected_rows=rejected_rows+coalesce(b.rejected_count,0),conflict_rows=conflict_rows+coalesce(b.conflict_count,0),missing_price_rows=missing_price_rows+coalesce(b.missing_count,0),updated_at=now() where release_id=r.id returning * into v;
 if v.cursor>=v.total_rows then
   select coalesce(sum(greatest(row_count-1,0)),0) into dup from public.supplier_price_release_validation_code_counts where release_id=r.id;
   select count(distinct nullif(trim(currency),''))::integer into currencies from public.supplier_price_release_rows where release_id=r.id;
   publishable:=v.rejected_rows=0 and v.conflict_rows=0 and v.missing_price_rows=0 and dup=0 and currencies<=1;
   final_status:=case when publishable then 'validated' else 'review_required' end;
   update public.supplier_price_release_validation_runs set status=final_status,duplicate_rows=dup,currency_count=currencies,completed_at=now(),updated_at=now() where release_id=r.id returning * into v;
   update public.supplier_price_releases set status='validated',validated_at=now(),accepted_rows=v.accepted_rows,warning_rows=v.warning_rows,rejected_rows=v.rejected_rows,conflict_rows=v.conflict_rows,error_code=case when publishable then null else 'VALIDATION_REVIEW_REQUIRED' end,error_message=case when publishable then null else 'Validation completed; review conflicts before publication.' end,updated_at=now() where id=r.id;
 end if;
 return jsonb_build_object('release_id',r.id,'status',v.status,'cursor',v.cursor,'total_rows',v.total_rows,'accepted_rows',v.accepted_rows,'duplicate_rows',v.duplicate_rows,'completed',v.completed_at is not null,'publishable',v.status='validated');
end $function$
$captured_function$; ELSIF md5(pg_get_functiondef(to_regprocedure('public.validate_supplier_price_release_batch(uuid,integer)')))<>'e6d06fb2c0a3aac5d9758286d7557af2' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_FUNCTION_DRIFT: public.validate_supplier_price_release_batch(uuid,integer)'; END IF; END $foundation_function$;
REVOKE ALL ON FUNCTION public.validate_supplier_price_release_batch(uuid,integer) FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.validate_supplier_price_release_batch(uuid,integer) TO service_role;
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_current_price_pointers_org_brand') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_current_price_pointers_org_brand'))<>'CREATE INDEX idx_supplier_current_price_pointers_org_brand ON public.supplier_current_price_pointers USING btree (organization_id, brand_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_current_price_pointers_org_brand'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_current_price_pointers_org_brand ON public.supplier_current_price_pointers USING btree (organization_id, brand_id);
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_current_price_pointers_release') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_current_price_pointers_release'))<>'CREATE INDEX idx_supplier_current_price_pointers_release ON public.supplier_current_price_pointers USING btree (release_id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_current_price_pointers_release'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_current_price_pointers_release ON public.supplier_current_price_pointers USING btree (release_id);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_current_price_pointers') AND polname='supplier_current_price_pointers_admin_select') THEN CREATE POLICY "supplier_current_price_pointers_admin_select" ON "public"."supplier_current_price_pointers" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])) AND (organization_id = current_profile_org_id()))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_current_price_pointers') AND polname='supplier_current_price_pointers_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '((current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])) AND (organization_id = current_profile_org_id()))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_current_price_pointers.supplier_current_price_pointers_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_current_price_pointers" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_publications_scope_status') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_publications_scope_status'))<>'CREATE INDEX idx_supplier_price_publications_scope_status ON public.supplier_price_publications USING btree (organization_id, supplier_id, brand_id, status, publication_version DESC)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_publications_scope_status'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_publications_scope_status ON public.supplier_price_publications USING btree (organization_id, supplier_id, brand_id, status, publication_version DESC);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_publications') AND polname='supplier_price_publications_admin_select') THEN CREATE POLICY "supplier_price_publications_admin_select" ON "public"."supplier_price_publications" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])) AND (organization_id = current_profile_org_id()))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_publications') AND polname='supplier_price_publications_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '((current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])) AND (organization_id = current_profile_org_id()))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_publications.supplier_price_publications_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_publications" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_batches_lease') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_batches_lease'))<>'CREATE INDEX idx_supplier_price_release_batches_lease ON public.supplier_price_release_batches USING btree (status, lease_expires_at, release_id, batch_number)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_batches_lease'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_batches_lease ON public.supplier_price_release_batches USING btree (status, lease_expires_at, release_id, batch_number);
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_batches_status') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_batches_status'))<>'CREATE INDEX idx_supplier_price_release_batches_status ON public.supplier_price_release_batches USING btree (release_id, status, batch_number)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_batches_status'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_batches_status ON public.supplier_price_release_batches USING btree (release_id, status, batch_number);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_batches') AND polname='supplier_price_release_batches_admin_select') THEN CREATE POLICY "supplier_price_release_batches_admin_select" ON "public"."supplier_price_release_batches" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_batches.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])))))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_batches') AND polname='supplier_price_release_batches_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '(EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_batches.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])))))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_release_batches.supplier_price_release_batches_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_release_batches" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_events_release_time') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_events_release_time'))<>'CREATE INDEX idx_supplier_price_release_events_release_time ON public.supplier_price_release_events USING btree (release_id, created_at DESC, id DESC)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_events_release_time'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_events_release_time ON public.supplier_price_release_events USING btree (release_id, created_at DESC, id DESC);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_events') AND polname='supplier_price_release_events_admin_select') THEN CREATE POLICY "supplier_price_release_events_admin_select" ON "public"."supplier_price_release_events" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_events.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])))))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_events') AND polname='supplier_price_release_events_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '(EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_events.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])))))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_release_events.supplier_price_release_events_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_release_events" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_compact_identity') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_compact_identity'))<>'CREATE INDEX idx_release_rows_compact_identity ON public.supplier_price_release_rows USING btree (release_id, normalize_part_code(product_code))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_compact_identity'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_compact_identity ON public.supplier_price_release_rows USING btree (release_id, normalize_part_code(product_code));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_export_exact_eligible_count') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_export_exact_eligible_count'))<>'CREATE INDEX idx_release_rows_export_exact_eligible_count ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C") INCLUDE (valid_from) WHERE ((row_status = ''accepted''::text) AND (buy_price > (0)::numeric) AND (currency = ''EUR''::text) AND (normalized_code = normalize_catalog_product_code(product_code)) AND (normalized_code ~ ''[A-Z0-9]''::text))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_export_exact_eligible_count'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_export_exact_eligible_count ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C") INCLUDE (valid_from) WHERE ((row_status = 'accepted'::text) AND (buy_price > (0)::numeric) AND (currency = 'EUR'::text) AND (normalized_code = normalize_catalog_product_code(product_code)) AND (normalized_code ~ '[A-Z0-9]'::text));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_export_future_eligibility') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_export_future_eligibility'))<>'CREATE INDEX idx_release_rows_export_future_eligibility ON public.supplier_price_release_rows USING btree (release_id, valid_from) WHERE ((row_status = ''accepted''::text) AND (buy_price > (0)::numeric) AND (currency = ''EUR''::text))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_export_future_eligibility'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_export_future_eligibility ON public.supplier_price_release_rows USING btree (release_id, valid_from) WHERE ((row_status = 'accepted'::text) AND (buy_price > (0)::numeric) AND (currency = 'EUR'::text));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_master_export_code_c') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_master_export_code_c'))<>'CREATE INDEX idx_release_rows_master_export_code_c ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C", id) WHERE ((row_status = ''accepted''::text) AND (buy_price > (0)::numeric) AND (currency = ''EUR''::text))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_master_export_code_c'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_master_export_code_c ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C", id) WHERE ((row_status = 'accepted'::text) AND (buy_price > (0)::numeric) AND (currency = 'EUR'::text));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_supplier_export_code_c') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_supplier_export_code_c'))<>'CREATE INDEX idx_release_rows_supplier_export_code_c ON public.supplier_price_release_rows USING btree (release_id, product_code COLLATE "C", ((md5((id)::text))::uuid)) WHERE ((row_status = ''accepted''::text) AND (buy_price > (0)::numeric) AND (currency = ''EUR''::text))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_supplier_export_code_c'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_supplier_export_code_c ON public.supplier_price_release_rows USING btree (release_id, product_code COLLATE "C", ((md5((id)::text))::uuid)) WHERE ((row_status = 'accepted'::text) AND (buy_price > (0)::numeric) AND (currency = 'EUR'::text));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_release_rows_supplier_export_keyset') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_release_rows_supplier_export_keyset'))<>'CREATE INDEX idx_release_rows_supplier_export_keyset ON public.supplier_price_release_rows USING btree (release_id, product_code, ((md5((id)::text))::uuid)) WHERE ((row_status = ''accepted''::text) AND (buy_price > (0)::numeric) AND (currency = ''EUR''::text))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_release_rows_supplier_export_keyset'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_release_rows_supplier_export_keyset ON public.supplier_price_release_rows USING btree (release_id, product_code, ((md5((id)::text))::uuid)) WHERE ((row_status = 'accepted'::text) AND (buy_price > (0)::numeric) AND (currency = 'EUR'::text));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_rows_portal_prefix') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_rows_portal_prefix'))<>'CREATE INDEX idx_supplier_price_release_rows_portal_prefix ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C", id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_rows_portal_prefix'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_rows_portal_prefix ON public.supplier_price_release_rows USING btree (release_id, normalized_code COLLATE "C", id);
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_rows_release_code') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_rows_release_code'))<>'CREATE INDEX idx_supplier_price_release_rows_release_code ON public.supplier_price_release_rows USING btree (release_id, normalized_code, id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_rows_release_code'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_rows_release_code ON public.supplier_price_release_rows USING btree (release_id, normalized_code, id);
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_release_rows_release_status') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_release_rows_release_status'))<>'CREATE INDEX idx_supplier_price_release_rows_release_status ON public.supplier_price_release_rows USING btree (release_id, row_status, id)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_release_rows_release_status'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_release_rows_release_status ON public.supplier_price_release_rows USING btree (release_id, row_status, id);
DO $foundation_index$ BEGIN IF to_regclass('public.uq_supplier_price_release_rows_number') IS NOT NULL AND pg_get_indexdef(to_regclass('public.uq_supplier_price_release_rows_number'))<>'CREATE UNIQUE INDEX uq_supplier_price_release_rows_number ON public.supplier_price_release_rows USING btree (release_id, source_row_number)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.uq_supplier_price_release_rows_number'; END IF; END $foundation_index$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_release_rows_number ON public.supplier_price_release_rows USING btree (release_id, source_row_number);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_rows') AND polname='supplier_price_release_rows_admin_select') THEN CREATE POLICY "supplier_price_release_rows_admin_select" ON "public"."supplier_price_release_rows" AS PERMISSIVE FOR SELECT TO "authenticated" USING ((EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_rows.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])))))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_release_rows') AND polname='supplier_price_release_rows_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '(EXISTS ( SELECT 1
   FROM supplier_price_releases release
  WHERE ((release.id = supplier_price_release_rows.release_id) AND (release.organization_id = current_profile_org_id()) AND (current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])))))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_release_rows.supplier_price_release_rows_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_release_rows" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_validation_counts_release_count') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_validation_counts_release_count'))<>'CREATE INDEX idx_supplier_price_validation_counts_release_count ON public.supplier_price_release_validation_code_counts USING btree (release_id, row_count DESC)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_validation_counts_release_count'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_validation_counts_release_count ON public.supplier_price_release_validation_code_counts USING btree (release_id, row_count DESC);
GRANT DELETE ON TABLE "public"."supplier_price_release_validation_code_counts" TO "service_role";
GRANT INSERT ON TABLE "public"."supplier_price_release_validation_code_counts" TO "service_role";
GRANT SELECT ON TABLE "public"."supplier_price_release_validation_code_counts" TO "service_role";
GRANT UPDATE ON TABLE "public"."supplier_price_release_validation_code_counts" TO "service_role";
GRANT DELETE ON TABLE "public"."supplier_price_release_validation_runs" TO "service_role";
GRANT INSERT ON TABLE "public"."supplier_price_release_validation_runs" TO "service_role";
GRANT SELECT ON TABLE "public"."supplier_price_release_validation_runs" TO "service_role";
GRANT UPDATE ON TABLE "public"."supplier_price_release_validation_runs" TO "service_role";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_releases_scope_status') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_releases_scope_status'))<>'CREATE INDEX idx_supplier_price_releases_scope_status ON public.supplier_price_releases USING btree (organization_id, supplier_id, brand_id, status, created_at DESC)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_releases_scope_status'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_releases_scope_status ON public.supplier_price_releases USING btree (organization_id, supplier_id, brand_id, status, created_at DESC);
DO $foundation_index$ BEGIN IF to_regclass('public.uq_supplier_price_releases_idempotency') IS NOT NULL AND pg_get_indexdef(to_regclass('public.uq_supplier_price_releases_idempotency'))<>'CREATE UNIQUE INDEX uq_supplier_price_releases_idempotency ON public.supplier_price_releases USING btree (organization_id, supplier_id, brand_id, source_file_sha256, mode)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.uq_supplier_price_releases_idempotency'; END IF; END $foundation_index$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_releases_idempotency ON public.supplier_price_releases USING btree (organization_id, supplier_id, brand_id, source_file_sha256, mode);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_releases') AND polname='supplier_price_releases_admin_select') THEN CREATE POLICY "supplier_price_releases_admin_select" ON "public"."supplier_price_releases" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])) AND (organization_id = current_profile_org_id()))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_releases') AND polname='supplier_price_releases_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '((current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])) AND (organization_id = current_profile_org_id()))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_releases.supplier_price_releases_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_releases" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_upload_sessions_expiry') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_upload_sessions_expiry'))<>'CREATE INDEX idx_supplier_price_upload_sessions_expiry ON public.supplier_price_upload_sessions USING btree (status, expires_at) WHERE (status = ANY (ARRAY[''created''::text, ''uploading''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_upload_sessions_expiry'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_upload_sessions_expiry ON public.supplier_price_upload_sessions USING btree (status, expires_at) WHERE (status = ANY (ARRAY['created'::text, 'uploading'::text]));
DO $foundation_index$ BEGIN IF to_regclass('public.idx_supplier_price_upload_sessions_release_status') IS NOT NULL AND pg_get_indexdef(to_regclass('public.idx_supplier_price_upload_sessions_release_status'))<>'CREATE INDEX idx_supplier_price_upload_sessions_release_status ON public.supplier_price_upload_sessions USING btree (release_id, status, updated_at DESC)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.idx_supplier_price_upload_sessions_release_status'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS idx_supplier_price_upload_sessions_release_status ON public.supplier_price_upload_sessions USING btree (release_id, status, updated_at DESC);
DO $foundation_index$ BEGIN IF to_regclass('public.uq_supplier_price_upload_sessions_idempotency') IS NOT NULL AND pg_get_indexdef(to_regclass('public.uq_supplier_price_upload_sessions_idempotency'))<>'CREATE UNIQUE INDEX uq_supplier_price_upload_sessions_idempotency ON public.supplier_price_upload_sessions USING btree (organization_id, idempotency_key)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.uq_supplier_price_upload_sessions_idempotency'; END IF; END $foundation_index$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_upload_sessions_idempotency ON public.supplier_price_upload_sessions USING btree (organization_id, idempotency_key);
DO $foundation_index$ BEGIN IF to_regclass('public.uq_supplier_price_upload_sessions_storage_path') IS NOT NULL AND pg_get_indexdef(to_regclass('public.uq_supplier_price_upload_sessions_storage_path'))<>'CREATE UNIQUE INDEX uq_supplier_price_upload_sessions_storage_path ON public.supplier_price_upload_sessions USING btree (storage_bucket, storage_object_path)' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: public.uq_supplier_price_upload_sessions_storage_path'; END IF; END $foundation_index$;
CREATE UNIQUE INDEX IF NOT EXISTS uq_supplier_price_upload_sessions_storage_path ON public.supplier_price_upload_sessions USING btree (storage_bucket, storage_object_path);
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_upload_sessions') AND polname='supplier_price_upload_sessions_admin_select') THEN CREATE POLICY "supplier_price_upload_sessions_admin_select" ON "public"."supplier_price_upload_sessions" AS PERMISSIVE FOR SELECT TO "authenticated" USING (((current_profile_role() = ANY (ARRAY['admin'::text, 'superadmin'::text])) AND (organization_id = current_profile_org_id()))); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('public.supplier_price_upload_sessions') AND polname='supplier_price_upload_sessions_admin_select' AND (polcmd<>'r' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM '((current_profile_role() = ANY (ARRAY[''admin''::text, ''superadmin''::text])) AND (organization_id = current_profile_org_id()))' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM NULL)) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: public.supplier_price_upload_sessions.supplier_price_upload_sessions_admin_select'; END IF; END $foundation_policy_drift$;
GRANT SELECT ON TABLE "public"."supplier_price_upload_sessions" TO "authenticated";
DO $foundation_index$ BEGIN IF to_regclass('supplier_price_ingestion_internal.handoffs_dispatch_idx') IS NOT NULL AND pg_get_indexdef(to_regclass('supplier_price_ingestion_internal.handoffs_dispatch_idx'))<>'CREATE INDEX handoffs_dispatch_idx ON supplier_price_ingestion_internal.handoffs USING btree (created_at, id) WHERE (status = ANY (ARRAY[''queued''::text, ''dispatching''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: supplier_price_ingestion_internal.handoffs_dispatch_idx'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS handoffs_dispatch_idx ON supplier_price_ingestion_internal.handoffs USING btree (created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'dispatching'::text]));
DO $foundation_index$ BEGIN IF to_regclass('supplier_price_ingestion_internal.supplier_upload_verify_queue') IS NOT NULL AND pg_get_indexdef(to_regclass('supplier_price_ingestion_internal.supplier_upload_verify_queue'))<>'CREATE INDEX supplier_upload_verify_queue ON supplier_price_ingestion_internal.verification_requests USING btree (next_attempt_at, created_at, id) WHERE (status = ANY (ARRAY[''queued''::text, ''verifying''::text]))' THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_INDEX_DRIFT: supplier_price_ingestion_internal.supplier_upload_verify_queue'; END IF; END $foundation_index$;
CREATE INDEX IF NOT EXISTS supplier_upload_verify_queue ON supplier_price_ingestion_internal.verification_requests USING btree (next_attempt_at, created_at, id) WHERE (status = ANY (ARRAY['queued'::text, 'verifying'::text]));
DO $foundation_policy$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND polname='review_decisions_no_direct_access') THEN CREATE POLICY "review_decisions_no_direct_access" ON "supplier_price_validation_internal"."review_decisions" AS PERMISSIVE FOR ALL TO PUBLIC USING (false) WITH CHECK (false); END IF; END $foundation_policy$;
DO $foundation_policy_drift$ BEGIN IF EXISTS (SELECT 1 FROM pg_policy WHERE polrelid=to_regclass('supplier_price_validation_internal.review_decisions') AND polname='review_decisions_no_direct_access' AND (polcmd<>'*' OR polpermissive<>true OR pg_get_expr(polqual,polrelid) IS DISTINCT FROM 'false' OR pg_get_expr(polwithcheck,polrelid) IS DISTINCT FROM 'false')) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_POLICY_DRIFT: supplier_price_validation_internal.review_decisions.review_decisions_no_direct_access'; END IF; END $foundation_policy_drift$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES ('supplier-price-imports','supplier-price-imports',false,1073741824,ARRAY['text/csv','text/plain','application/csv','application/vnd.ms-excel','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/octet-stream']::text[]) ON CONFLICT(id) DO NOTHING;
DO $foundation_bucket$ BEGIN IF EXISTS (SELECT 1 FROM storage.buckets WHERE id='supplier-price-imports' AND (public OR (file_size_limit IS NOT NULL AND file_size_limit<1073741824))) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_BUCKET_DRIFT: supplier-price-imports'; END IF; END $foundation_bucket$;
INSERT INTO storage.buckets(id,name,public,file_size_limit,allowed_mime_types) VALUES ('supplier-price-prepared','supplier-price-prepared',false,NULL,NULL) ON CONFLICT(id) DO NOTHING;
DO $foundation_bucket$ BEGIN IF EXISTS (SELECT 1 FROM storage.buckets WHERE id='supplier-price-prepared' AND (public OR (file_size_limit IS NOT NULL AND file_size_limit<33554432))) THEN RAISE EXCEPTION 'PRICE_ENGINE_FOUNDATION_BUCKET_DRIFT: supplier-price-prepared'; END IF; END $foundation_bucket$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_delete') THEN CREATE POLICY "supplier_price_import_objects_delete" ON storage.objects AS PERMISSIVE FOR DELETE TO "authenticated" USING (((bucket_id = 'supplier-price-imports'::text) AND (split_part(name, '/'::text, 1) = (current_profile_org_id())::text) AND profile_has_permission('supplier_prices.manage'::text))); END IF; END $foundation_storage$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_insert') THEN CREATE POLICY "supplier_price_import_objects_insert" ON storage.objects AS PERMISSIVE FOR INSERT TO "authenticated" WITH CHECK (((bucket_id = 'supplier-price-imports'::text) AND (split_part(name, '/'::text, 1) = (current_profile_org_id())::text) AND profile_has_permission('supplier_prices.manage'::text))); END IF; END $foundation_storage$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_select') THEN CREATE POLICY "supplier_price_import_objects_select" ON storage.objects AS PERMISSIVE FOR SELECT TO "authenticated" USING (((bucket_id = 'supplier-price-imports'::text) AND (split_part(name, '/'::text, 1) = (current_profile_org_id())::text) AND profile_has_permission('supplier_prices.manage'::text))); END IF; END $foundation_storage$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_update') THEN CREATE POLICY "supplier_price_import_objects_update" ON storage.objects AS PERMISSIVE FOR UPDATE TO "authenticated" USING (((bucket_id = 'supplier-price-imports'::text) AND (split_part(name, '/'::text, 1) = (current_profile_org_id())::text) AND profile_has_permission('supplier_prices.manage'::text))) WITH CHECK (((bucket_id = 'supplier-price-imports'::text) AND (split_part(name, '/'::text, 1) = (current_profile_org_id())::text) AND profile_has_permission('supplier_prices.manage'::text))); END IF; END $foundation_storage$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_verified_no_delete') THEN CREATE POLICY "supplier_price_verified_no_delete" ON storage.objects AS RESTRICTIVE FOR DELETE TO "authenticated" USING ((NOT supplier_price_upload_object_is_sealed(bucket_id, name))); END IF; END $foundation_storage$;
DO $foundation_storage$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_verified_no_overwrite') THEN CREATE POLICY "supplier_price_verified_no_overwrite" ON storage.objects AS RESTRICTIVE FOR UPDATE TO "authenticated" USING ((NOT supplier_price_upload_object_is_sealed(bucket_id, name))) WITH CHECK ((NOT supplier_price_upload_object_is_sealed(bucket_id, name))); END IF; END $foundation_storage$;
DO $foundation_prepared_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_prepared_browser_fence') THEN CREATE POLICY supplier_price_prepared_browser_fence ON storage.objects AS RESTRICTIVE FOR ALL TO anon,authenticated USING (bucket_id<>'supplier-price-prepared') WITH CHECK (bucket_id<>'supplier-price-prepared'); END IF; END $foundation_prepared_fence$;
DO $foundation_upload_anon_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_anon_fence') THEN CREATE POLICY supplier_price_import_objects_anon_fence ON storage.objects AS RESTRICTIVE FOR ALL TO anon USING (bucket_id<>'supplier-price-imports') WITH CHECK (bucket_id<>'supplier-price-imports'); END IF; END $foundation_upload_anon_fence$;
DO $foundation_upload_scope_fence$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_policy WHERE polrelid='storage.objects'::regclass AND polname='supplier_price_import_objects_scope_fence') THEN CREATE POLICY supplier_price_import_objects_scope_fence ON storage.objects AS RESTRICTIVE FOR ALL TO authenticated USING (bucket_id<>'supplier-price-imports' OR (split_part(name,'/',1)=public.current_profile_org_id()::text AND public.profile_has_permission('supplier_prices.manage'))) WITH CHECK (bucket_id<>'supplier-price-imports' OR (split_part(name,'/',1)=public.current_profile_org_id()::text AND public.profile_has_permission('supplier_prices.manage'))); END IF; END $foundation_upload_scope_fence$;
COMMIT;
