# Catalog Source Policy

## Purpose

This repo now treats brand sync as an authority pipeline, not just a scraper list.
The rule is mandatory for every new brand sync, re-sync, or source migration:

1. Use the official brand catalog as the primary authority.
2. If the official stack is TecAlliance-backed, treat that TecAlliance session as the technical backbone for article, OEM, vehicle, tariff, weight, and related metadata.
3. Use public helper sources only for enrichment where the official source is incomplete.
4. Use Spareto exact-detail only as completion fallback, never as the long-term authority when an official source exists.
5. Leave unresolved conflicts for manual review instead of letting weaker data overwrite stronger technical fields.

The live policy object is generated in `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/netlify/functions/_shared/catalog-source-policy.mts` and returned by `/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp/netlify/functions/_shared/catalog-sync-provider.mts`.

## Source Roles

`official_provider`
: Default primary authority for brands with a stable official catalog.

`tecalliance_official_session`
: Trusted technical backbone when the official brand session itself runs on TecAlliance. Current live example in the registry: Mahle.

`martex_public_tecdoc`
: Public helper source confirmed for OEM tables, vehicle fitment, vehicle type, engine code, EAN, and images.

`wilmink_browser_assisted`
: Browser-assisted helper for manufacturer and vehicle taxonomy. Direct raw API access is protected, so this is not a simple backend source.

`spareto_exact_detail`
: Completion-only fallback. Acceptable for missing text or residual fields, but not the main authority.

`manual_review`
: Last stop when sources disagree or the official path is blocked.

## Field Priority

Default official-first priority:

- `brand`: official -> TecAlliance -> manual
- `description`: official -> TecAlliance -> Wilmink browser helper -> Spareto -> manual
- `oem_no`: official -> TecAlliance -> Martex -> Spareto -> manual
- `vehicle`: official -> TecAlliance -> Martex -> Wilmink browser helper -> Spareto -> manual
- `vehicle_model`: official -> TecAlliance -> Martex -> Wilmink browser helper -> manual
- `engine_code`: official -> TecAlliance -> Martex -> Wilmink browser helper -> manual
- `lifecycle_status`: official -> TecAlliance -> Spareto -> manual
- `lifecycle_note`: official -> TecAlliance -> Spareto -> manual
- `replacement_code`: official -> TecAlliance -> Martex -> Spareto -> manual
- `hs_code`: official -> TecAlliance -> Spareto -> manual
- `origin`: official -> TecAlliance -> Spareto -> manual
- `weight_kg`: official -> TecAlliance -> Spareto -> manual
- `image_url`: official -> TecAlliance -> Martex -> Spareto -> manual
- `ean`: official -> TecAlliance -> Martex -> Spareto -> manual

Lifecycle and replacement data are treated as critical authority fields:

- `continued`
- `no longer available`
- `supersedes`
- `replacement`

These should not drift to weaker marketplace text when the official or TecAlliance source already defines them.

## Mandatory Official Fetch Contract

Every official or browser-assisted fetch must try to capture the same authoritative technical shape so later syncs stay deterministic.

Required capture order:

1. `product_code`
2. `brand`
3. `ean`
4. `description`
5. `image_url`
6. `oem_no`
7. `vehicle`
8. `vehicle_model`
9. `engine_code`
10. `market_segment`
11. `hs_code` / `tariff`
12. `origin`
13. `weight_kg`
14. `lifecycle_status`
15. `lifecycle_note`
16. `replacement_old_code`
17. `replacement_code`
18. `replacement_reason`
19. `source_url`

Canonical market segment values are now `pc`, `cv`, `lcv`, `motorcycle`, `engines`, `universal`, `marine`, `industrial`, and `agriculture`.

Rules:

- If the source exposes a field, it must be captured on fetch.
- If the source does not expose a field, preserve the existing database value on update instead of inventing a replacement.
- Never overwrite lifecycle or replacement data with a default value unless the source explicitly says so.
- Hella browser-assisted imports currently expose article number, EAN, description, and image. They must preserve existing lifecycle/replacement fields when re-imported.

TecAlliance-primary override:

- TecAlliance is the primary authority, not a secondary helper.
- Vehicle, model, engine code, tariff, and weight should remain technical-first even if marketplace completion exists.
- Any brand registered as `tecalliance_*` should inherit this profile automatically.

Hengst override:

- Official source is authoritative, but server-side automation is blocked.
- Use browser-assisted capture until access changes.
- Always use the visible title code like `E340H D247` as `product_code`, not the numeric item number.

Temporary marketplace-fallback brands:

- ATE
- Schaeffler family
- Knorr-Bremse
- HEPU
- Hella
- Nissens
- NRF
- Federal Mogul family

For these brands, the current executable path may still start from Spareto, but the target state remains official/TecAlliance-first. Hella's official shop is currently WAF/captcha-blocked for server-side automation, so bulk runtime stays on Spareto fallback until a stable official access route is available. Hella direct product pages that are available in a browser session are valid official evidence for browser-assisted import, including article number, EAN, description, and image. A sync is not considered fully healthy until key technical fields are rechecked against stronger authority sources.

## Confirmed Helper Findings

### Martex

Public endpoints are usable for helper enrichment, including:

- OE tables
- vehicle fitment
- vehicle model/type
- engine code
- EAN
- images

Martex is acceptable as a public technical helper. It is not the top authority over a brand's own official catalog.

### Wilmink

Wilmink exposes strong browser-side search and vehicle contracts, but direct raw API calls are protected. Use it only in browser-assisted analysis, not as a simple backend fetch target.

## Onboarding Rule For New Brands

Every new brand onboarding or re-sync must answer these questions before the brand is considered production-ready:

1. What is the official source URL?
2. Is the official stack TecAlliance-backed?
3. Which fields come cleanly from the official source today?
4. Which missing fields are allowed to fall back to Martex or Wilmink?
5. Which residual fields are allowed to use Spareto completion?
6. Which fields still require manual review?

If these answers are not known, the brand should stay in a temporary fallback state rather than silently becoming marketplace-led.

## Batch Execution Order

The batch rule is now:

1. Fetch brands that already exist in the system first.
2. Only after that pass completes, open missing but configured brands.
3. Fill those missing brands from their mapped official-first policy.
4. Keep lifecycle and replacement signals intact during both phases.
5. Use progressive repair batches for any brand with missing technical fields: `1 -> 50 -> 100 -> 500 -> 1000 -> 2000 -> 3000`.
6. After each pass, stop only when the current pass fully covers the available candidate set or when a smaller pass shows the remaining scope is already exhausted.
7. Do not leave partially known technical fields unresolved when a stronger source can fill them in the same run.
