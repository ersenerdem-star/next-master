-- NM-CATALOG-WP2-F2-H2 local-only behavior validation.
-- Run after 20260724_003... in a disposable local database only.
-- The complete fixture and all checks are rolled back.

begin;

insert into public.organizations (id, name)
values ('30000000-0000-0000-0000-000000000001', 'F2 H2 local organization');

insert into public.profiles (id, organization_id, email, full_name, role, is_active)
values ('30000000-0000-0000-0000-000000000002', '30000000-0000-0000-0000-000000000001', 'f2-h2-admin@local.invalid', 'F2 H2 admin', 'admin', true);

insert into public.brands (id, organization_id, name)
values ('30000000-0000-0000-0000-000000000003', '30000000-0000-0000-0000-000000000001', 'F2 H2 Brand');

insert into public.catalog_products (id, organization_id, brand_id, product_code, description)
values ('30000000-0000-0000-0000-000000000004', '30000000-0000-0000-0000-000000000001', '30000000-0000-0000-0000-000000000003', 'F2-H2-PRODUCT', 'before');

do $h2_grant_check$
begin
  if not has_column_privilege('authenticated', 'public.catalog_products', 'description', 'update') then
    raise exception 'BLOCKED: authenticated editor description update is not granted';
  end if;
  if has_column_privilege('authenticated', 'public.catalog_products', 'image_url', 'update') then
    raise exception 'BLOCKED: authenticated image_url update remains granted';
  end if;
end;
$h2_grant_check$;

select set_config('request.jwt.claim.sub', '30000000-0000-0000-0000-000000000002', true);
select set_config('request.jwt.claim.role', 'authenticated', true);
set local role authenticated;

update public.catalog_products
set description = 'permitted editor field'
where id = '30000000-0000-0000-0000-000000000004';

do $h2_direct_image_block$
begin
  update public.catalog_products
  set image_url = 'https://cdn.local.invalid/direct-write.jpg'
  where id = '30000000-0000-0000-0000-000000000004';
  raise exception 'BLOCKED: authenticated direct image_url update was accepted';
exception
  when insufficient_privilege then
    null;
end;
$h2_direct_image_block$;

reset role;

do $h2_result_check$
declare
  v_description text;
  v_image_url text;
begin
  select description, image_url into v_description, v_image_url
  from public.catalog_products
  where id = '30000000-0000-0000-0000-000000000004';
  if v_description <> 'permitted editor field' or v_image_url is not null then
    raise exception 'BLOCKED: H2 Product write result was not preserved';
  end if;
end;
$h2_result_check$;

select 'IMAGE_URL_WRITE_HARDENING_BEHAVIOR_VERIFIED' as result;

rollback;
