# NM-CATALOG-WP2-B1 Production Pilot Record

Status: `PILOT_OBSERVATIONS_LANDED`

Domain: `API / Catalog`

Work Package: `NM-CATALOG-WP2-B1 - ZF/SACHS Identifier Resolution and Pilot Landing`

Production-proven commit: `de1581bc74d8446f7d4f57e7b8988b6336c6a63c`

Production run ID: `11581bfd-3a12-43d5-bb39-d6aa09e3bd96`

Production run status: `succeeded`

Artifact directory:

`/Users/ersen/Developer/NextMaster/artifacts/wp2b-acquisition-2026-07-16T23-41-45-479Z/`

Identifier diagnostics artifact:

`/Users/ersen/Developer/NextMaster/artifacts/wp2b-id-resolution-2026-07-17T00-00-00Z/`

## Source Contract

Official source: ZF Aftermarket official catalog.

Client path:

`netlify/functions/_shared/catalog/zf-aftermarket-sync.mts`

Pilot runner:

`scripts/catalog/run-catalog-observation-pilot.mjs`

The production pilot used the official ZF source client only. No alternate provider and no open-web scraping were used.

## Identifier Resolution

Resolved path:

`normalized Catalog code -> official ZF search -> source_article_number -> official article detail`

The pilot keeps the existing Catalog Product code as the internal selection key, performs official ZF search with the normalized code, reads the source article identifier from the official search result, and then requests official article detail with that source article identifier.

The source article identifier is not written back to `catalog_products`.

## Selected Products

The pilot selected five existing SACHS Catalog Products:

| Catalog Product ID | Product Code | Normalized Code |
| --- | --- | --- |
| `3bc8720c-b9d7-41d9-8dfe-73d92bb197d9` | `000006` | `000006` |
| `a73ba233-5162-48c7-a70b-a1ef2dae6b3e` | `000366` | `000366` |
| `db2abfcd-0113-42d2-afff-dd97269a896e` | `007303` | `007303` |
| `5b67a391-61ae-43ec-8d76-5fa269cf739f` | `007304` | `007304` |
| `0c97dfd9-8f51-4add-920f-1899691d022d` | `030012` | `030012` |

## Observation Result

The dry-run planned 9 observations.

The confirmed production run appended 9 real observations:

- `supplemental_description`: 5
- `image_reference`: 4

Only these allowed field families were used:

- `image_reference`
- `supplemental_description`

No forbidden fields were captured or mapped.

## Production Safety Evidence

Safety proof from the production artifact:

| Evidence | Result |
| --- | --- |
| Product count before | `391582` |
| Product count after | `391582` |
| Selected Product snapshots unchanged | `true` |
| Candidate count | `0` |
| Review routed count | `0` |
| Apply event count | `0` |
| Selected Product integrity queue before | empty |
| Selected Product integrity queue after | empty |
| Catalog integrity backfill state before | empty |
| Catalog integrity backfill state after | empty |

Explicitly not performed:

- no Product create/update/delete
- no canonical apply
- no compare call
- no review routing
- no backfill
- no Supabase migration
- no Netlify deploy
- no broad supplier/catalog sync

## Release Boundary

The pilot implementation is bounded to observation acquisition. It does not change canonical Catalog Product truth and does not trigger downstream compare, review, apply, backfill, or integrity queue behavior.

The shared ZF client change is additive for the pilot: existing sync callers continue to call `syncBrandCatalogFromZfAftermarket`; the pilot uses the new `fetchZfAftermarketOfficialObservation` export.
