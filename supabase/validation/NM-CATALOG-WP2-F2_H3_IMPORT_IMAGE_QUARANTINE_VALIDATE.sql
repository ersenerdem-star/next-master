-- H3 local-only import image quarantine proof. All fixture state rolls back.
begin;

insert into public.organizations (id, name)
values ('40000000-0000-0000-0000-000000000001', 'F2 H3 local organization');
insert into public.profiles (id, organization_id, email, full_name, role, is_active)
values ('40000000-0000-0000-0000-000000000002', '40000000-0000-0000-0000-000000000001', 'f2-h3-admin@local.invalid', 'F2 H3 admin', 'admin', true);
insert into public.brands (id, organization_id, name)
values ('40000000-0000-0000-0000-000000000003', '40000000-0000-0000-0000-000000000001', 'F2 H3 Brand');
insert into public.catalog_products (id, organization_id, brand_id, product_code, description, image_url)
values ('40000000-0000-0000-0000-000000000004', '40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000003', 'F2-H3-EXISTING', 'before', 'https://cdn.local.invalid/existing.jpg');
insert into public.catalog_import_runs (id, organization_id, mode, status, created_by)
values ('40000000-0000-0000-0000-000000000005', '40000000-0000-0000-0000-000000000001', 'upsert', 'validated', '40000000-0000-0000-0000-000000000002');
insert into public.catalog_import_stage (id, organization_id, run_id, row_index, brand, product_code, normalized_code, description, image_url, validation_status, proposed_action, conflict_summary)
values
  ('40000000-0000-0000-0000-000000000006', '40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', 1, 'F2 H3 Brand', 'F2-H3-EXISTING', 'F2H3EXISTING', 'after', 'https://cdn.local.invalid/staged-replacement.jpg', 'valid', 'update', '{"image_url_quarantined":true}'),
  ('40000000-0000-0000-0000-000000000007', '40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000005', 2, 'F2 H3 Brand', 'F2-H3-NEW', 'F2H3NEW', 'new product', 'https://cdn.local.invalid/staged-new.jpg', 'valid', 'insert', '{"image_url_quarantined":true}');

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.finalize_catalog_import('40000000-0000-0000-0000-000000000005'::uuid) as h3_result \gset
reset role;

do $h3_assert$
declare
  v_existing_image text;
  v_existing_description text;
  v_new_image text;
  v_quarantined integer;
  v_apply_events integer;
begin
  select image_url, description into v_existing_image, v_existing_description from public.catalog_products where id = '40000000-0000-0000-0000-000000000004';
  select image_url into v_new_image from public.catalog_products where organization_id = '40000000-0000-0000-0000-000000000001' and product_code = 'F2-H3-NEW';
  select image_quarantined_count into v_quarantined from public.catalog_import_runs where id = '40000000-0000-0000-0000-000000000005';
  select count(*)::integer into v_apply_events from public.catalog_observation_review_apply_events where organization_id = '40000000-0000-0000-0000-000000000001';
  if v_existing_image <> 'https://cdn.local.invalid/existing.jpg' or v_existing_description <> 'after' or v_new_image is not null or v_quarantined <> 2 or v_apply_events <> 0 then
    raise exception 'BLOCKED: H3 quarantine did not preserve existing image, omit new image, retain permitted update, count two staged images, and avoid F2 events';
  end if;
end;
$h3_assert$;

do $h3_acl$
declare v_acl text;
begin
  select coalesce(array_to_string(proacl, ','), '') into v_acl
  from pg_proc where oid = 'public.finalize_catalog_import(uuid)'::regprocedure;
  if v_acl ~ '(^|,)=X/' or not has_function_privilege('authenticated', 'public.finalize_catalog_import(uuid)', 'execute') or has_function_privilege('anon', 'public.finalize_catalog_import(uuid)', 'execute') then
    raise exception 'BLOCKED: H3 finalizer ACL is not authenticated-only without PUBLIC/anon execute';
  end if;
end;
$h3_acl$;

insert into public.catalog_import_runs (id, organization_id, mode, status, created_by)
values ('40000000-0000-0000-0000-000000000008', '40000000-0000-0000-0000-000000000001', 'upsert', 'running', '40000000-0000-0000-0000-000000000002');
insert into public.catalog_import_stage (id, organization_id, run_id, row_index, brand, product_code, normalized_code, description, image_url, lifecycle_status)
values ('40000000-0000-0000-0000-000000000009', '40000000-0000-0000-0000-000000000001', '40000000-0000-0000-0000-000000000008', 1, 'F2 H3 Brand', 'F2-H3-EXISTING', 'F2H3EXISTING', 'after', 'https://cdn.local.invalid/validation-only.jpg', 'active');

select set_config('request.jwt.claim.sub', '40000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;
select public.validate_catalog_import('40000000-0000-0000-0000-000000000008'::uuid);
reset role;

do $h3_validation_assert$
declare
  v_action text;
  v_quarantined boolean;
  v_changed_count integer;
  v_count integer;
begin
  select proposed_action, coalesce((conflict_summary->>'image_url_quarantined')::boolean, false), jsonb_array_length(coalesce(conflict_summary->'changed_fields', '[]'::jsonb))
  into v_action, v_quarantined, v_changed_count
  from public.catalog_import_stage
  where id = '40000000-0000-0000-0000-000000000009';
  select image_quarantined_count into v_count from public.catalog_import_runs where id = '40000000-0000-0000-0000-000000000008';
  if v_action <> 'skip' or not v_quarantined or v_changed_count <> 0 or v_count <> 1 then
    raise exception 'BLOCKED: H3 validation did not quarantine image-only delta as a skip';
  end if;
end;
$h3_validation_assert$;

select 'H3_IMPORT_IMAGE_QUARANTINE_VERIFIED' as result;
rollback;
