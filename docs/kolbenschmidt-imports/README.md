# Kolbenschmidt official-source onboarding

Status: source mapping prepared; no Catalog row has been imported by this package.

## Source

- Official guest catalog: <https://onlineshop.ms-motorservice.com/msi/MSICD?page=checkUser&vko=0001&usertype=guest&app=shop>
- Source owner: MS Motorservice International GmbH
- Observed catalog data version: `3.0.0 / 2416`
- Observed source date: `2026-07-22 0001`
- Access mode: guest catalog after the site security query; no password or credential is stored here.

## Verified sample mapping

Product `40 448 601` (displayed as `40448601` in the source URL):

| Catalog field | Official source value |
| --- | --- |
| Brand | Kolbenschmidt |
| Product type | Piston |
| EAN | 4028977704116 |
| Description | Piston |
| Vehicle | IHC-CASE (CNH), MERCEDES-BENZ, NEOPLAN Bus GmbH, SETRA |
| Vehicle model / engine | 1,207 source fitment rows available through the vehicle and engine drill-down |
| OEM / old reference | Source shows `Replaced 99 378...`; the complete replacement/reference relation must be captured from the related source record, not inferred from the truncated label |
| Weight | Not shown on the inspected guest product detail; leave empty until a first-party source supplies it |
| HS code | Not shown on the inspected guest product detail; leave empty until a first-party source supplies it |
| Product photo | Official product images are present on the product detail; canonical `image_url` remains governed by the existing observation/review/controlled-Apply path |
| Fallback image | `/brand-logos/kolbenschmidt_logo.jpeg` when no approved product image exists |

## Import rules

The import template now accepts EAN/GTIN, vehicle model, product type, source URL, source-as-of, retrieval timestamp, and SHA-256 payload fingerprint. Large source structures must not be flattened into one field:

- vehicle/engine fitments go to `catalog_product_fitments`;
- OEM, EAN, casting and old references go to `catalog_product_identifiers`;
- alternatives, replacements, tools and related products go to `catalog_product_relations`;
- dimensions and other technical specifications go to `catalog_product_attributes`;
- provenance goes to the append-only `catalog_product_source_records`.

The package intentionally does not invent weight or HS code values, does not bypass image quarantine, and does not apply production migrations or import live Catalog rows.
