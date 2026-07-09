# Brand Data Cleanup Assessment

Status: read-only assessment for Sales Order upload brand validation fix.

Scope: existing brand text damage only. No data cleanup is applied by this document.

## Runtime Finding

The runtime now has a shared brand text normalizer for future brand names:

- trims leading/trailing spaces
- collapses multiple spaces to one
- removes spaces around `/` and `-`
- preserves `/` and `-`

This prevents new inputs like `Bosch / Diesel` and `MANN - FILTER` from entering runtime paths as damaged spacing variants.

## Existing Damage Candidates

The following compact brand strings are risk candidates because they may have been produced by earlier sanitizer behavior or treated as normalized keys in legacy standardization code:

| Damaged / Risk Candidate | Likely Manual Mapping | Confidence | Manual Review Required |
| --- | --- | --- | --- |
| `MANNFILTER` | `MANN-FILTER` | High | Yes, verify canonical brand row and downstream references first |
| `KNORRBREMSE` | `Knorr-Bremse` | High | Yes, verify canonical brand row and downstream references first |
| `BOSCHDIESEL` | `Bosch/Diesel` if that exact brand exists and is operationally intended | Medium | Yes, do not auto-map without business confirmation |
| `LEMFOERDER` | `Lemförder` or `Lemforder`, depending on current canonical DB value | Medium | Yes, spelling is commercially sensitive |

Repository evidence:

- `apps/web/src/domain/shared/catalogFormatting.ts`
- `scripts/shared/brand/brand-standardization.mjs`
- `scripts/shared/catalog/catalog-standardization.mjs`
- `scripts/_shared/brand-standardization.mjs`
- `scripts/_shared/catalog-standardization.mjs`
- `supabase/migrations/20260619_59_catalog_brand_code_standardization.sql`
- `supabase/migrations/20260621_61_knorr_bremse_code_standardization.sql`
- `supabase/migrations/20260622_62_mann_filter_space_only_standardization.sql`
- `supabase/migrations/20260622_63_brand_display_code_punctuation_guard.sql`

## Production Verification Query

Run this read-only query before any cleanup:

```sql
select
  id,
  name,
  public.normalize_part_code(name) as compact_key,
  created_at,
  updated_at
from public.brands
where public.normalize_part_code(name) in (
  'MANNFILTER',
  'KNORRBREMSE',
  'BOSCHDIESEL',
  'LEMFOERDER',
  'LEMFORDER'
)
or upper(name) in (
  'MANNFILTER',
  'KNORRBREMSE',
  'BOSCHDIESEL',
  'LEMFOERDER',
  'LEMFORDER'
)
order by compact_key, name;
```

Then check downstream references before any rename or merge:

```sql
select
  b.id,
  b.name,
  count(distinct cp.id) as catalog_products,
  count(distinct sp.id) as supplier_prices,
  count(distinct cpi.id) as customer_price_list_items,
  count(distinct icr.id) as item_code_references
from public.brands b
left join public.catalog_products cp on cp.brand_id = b.id
left join public.supplier_prices sp on sp.brand_id = b.id
left join public.customer_price_list_items cpi on cpi.brand_id = b.id
left join public.item_code_references icr on icr.brand_id = b.id
where public.normalize_part_code(b.name) in (
  'MANNFILTER',
  'KNORRBREMSE',
  'BOSCHDIESEL',
  'LEMFOERDER',
  'LEMFORDER'
)
group by b.id, b.name
order by b.name;
```

## Cleanup Rule

Do not auto-fix any existing brand row unless all are true:

1. There is exactly one damaged row.
2. There is exactly one canonical target row or an approved new canonical name.
3. The mapping is commercially unambiguous.
4. Downstream references are reviewed.
5. The cleanup is executed through a guarded, reversible migration or operator-approved SQL package.

## Recommended Manual Mapping Plan

1. Verify current canonical rows in `brands`.
2. For `MANNFILTER`, prefer `MANN-FILTER` only if that is the existing business-facing brand.
3. For `KNORRBREMSE`, prefer `Knorr-Bremse` only if that is the existing business-facing brand.
4. For `BOSCHDIESEL`, do not map automatically; confirm whether the business uses a combined brand `Bosch/Diesel`.
5. For `LEMFOERDER`, do not map automatically; confirm whether canonical runtime value is `Lemförder` or `Lemforder`.
6. Only after confirmation, prepare a separate data cleanup migration/package.

## Current Decision

No data cleanup is safe to apply automatically from repository evidence alone.

The correct immediate fix is runtime prevention:

- normalize brand spacing on Sales Order upload
- validate upload brands against existing `brands`
- block unknown brand text before sales-order lines are created
