-- NM-CATALOG-ZF-GROUP-CATALOG-BOUNDARY
--
-- ZF, SACHS, LEMFÖRDER, TRW, WABCO and BOGE use whitespace-only
-- product-code display normalization. Punctuation remains identity-bearing.
-- TRW Engine Components is a separate Motorservice brand and is intentionally
-- not included in the ZF/TRW boundary.

set lock_timeout = '5s';
set statement_timeout = '60s';

insert into public.product_code_normalization_policies as existing (
  brand_key,
  canonical_brand,
  policy,
  is_alias,
  active,
  updated_at
)
values
  ('ZF', 'ZF', 'compact_space', false, true, now()),
  ('SACHS', 'Sachs', 'compact_space', false, true, now()),
  ('LEMFORDER', 'Lemforder', 'compact_space', false, true, now()),
  ('WABCO', 'Wabco', 'compact_space', false, true, now()),
  ('BOGE', 'Boge', 'compact_space', false, true, now()),
  ('TRW', 'TRW', 'compact_space', false, true, now())
on conflict (brand_key) do update
set canonical_brand = excluded.canonical_brand,
    policy = excluded.policy,
    is_alias = excluded.is_alias,
    active = true,
    updated_at = now()
where existing.canonical_brand is distinct from excluded.canonical_brand
   or existing.policy is distinct from excluded.policy
   or existing.is_alias is distinct from excluded.is_alias
   or not existing.active;

do $$
begin
  if public.normalize_catalog_brand_key('TRW')
     = public.normalize_catalog_brand_key('TRW Engine Components') then
    raise exception 'ZF TRW and Motorservice TRW Engine Components identities must remain distinct';
  end if;

  if public.normalize_catalog_display_code_for_brand(' 12. 34-5 ', 'ZF')
     <> '12.34-5' then
    raise exception 'ZF product-code normalization must remove whitespace only';
  end if;
end;
$$;

comment on table public.product_code_normalization_policies is
  'Canonical product-code display policies. ZF Group and Motorservice TRW identities remain separate.';
