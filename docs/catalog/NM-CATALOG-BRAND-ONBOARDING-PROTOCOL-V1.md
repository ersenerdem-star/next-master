# Next-Master Brand Onboarding Protocol v1

Status: Active operating protocol
Scope: every new catalog brand and every provider/CSV continuation package

## Goal

Every brand enters through the same observable, resumable flow. A package is
not considered complete merely because rows were downloaded or identities were
created. The system must show what was observed, what was accepted, which
fields were written, which fields were unavailable at the source, and whether
the canonical reread passed.

## Required sequence

1. **Register**: brand, logo, market segment policy, source key, source URL,
   authorization/licensing posture and rate limit are recorded before the
   provider starts.
2. **Discover**: fetch only bounded, read-only source pages. Record request
   URL, retrieval time, payload fingerprint and page/package position.
3. **Identify**: accept a row only when brand and product code match the
   requested brand. Never infer identity from a loose search result.
4. **Stage**: write immutable observations first. A review-only stage never
   mutates `catalog_products`.
5. **Enrich**: use the guarded provider enrichment protocol. Empty canonical
   fields may be filled; existing values and conflicts are preserved and
   reported. No provider package writes price, replacement, lifecycle or image
   URL directly to canonical catalog truth.
6. **Finalize**: publish in bounded batches with a checkpoint after every
   package. Re-read the canonical rows and persist counts for description,
   Turkish description, EAN, OEM, vehicle, vehicle model, dimensions, weight,
   HS code, origin, market segment and image.
7. **Report gaps**: a missing source field is a recorded `missing` outcome,
   not a zero, empty success, or guessed value. The package remains visible
   until its review, publication, enrichment and reread states are explicit.

## Elring official provider

Operational entry point: `npm run catalog:elring -- --help`. This uses the
existing provider-stage RPCs and the guarded enrichment protocol, with source
key `tecalliance_elring`, provider `2122`, supplier `10`. It never invokes the
legacy direct-write TecAlliance sync or marketplace completion. In Catalog,
selecting Elring replaces the old resync action with **Elring Catalog Engine**.
The legacy admin sync API rejects Elring with a pointer to the governed engine.

The exact-product input is a manifest (`--codes 115.100` or
`--codes-file <JSON array of strings>`). Select one
stable `--output` report per manifest; it contains immutable source snapshots,
request fingerprints, field presence, package receipts and resume checkpoints.
Packages contain at most 25 products. The runner stops on the first failed
package. Source calls are serial, at least 1100ms apart, with a 15s timeout and
a 2MiB response limit. A single operator must own an output report at a time.

Full-brand entry point: `node --import tsx
scripts/catalog/collect-elring-official-catalog.mjs --confirm-production --publish`.
**Operational hold (2026-10-19):** the Elring source is inactive following a
portal/database outage during publication. Do not reactivate or resume this
run until the publication/integrity summary contention and portal health
limits are repaired and validated. Collection evidence is complete for
21,543 identities; publication stopped at 17,250 processed identities and
12,642 inserts. Database restart restored SQL, Auth and authenticated portal
data access. Caller timeout did not establish server-side cancellation; the
publication statement timed out later inside product-code normalization.
The user's 2026-10-19 instruction to collect from the official Elring link
extends the registered scope to bounded manufacturer collection. This path
requires `brand_collection_allowed=true` as well as the existing publication
approval. It uses article-number search type **0**, supplier **10**, prefix
partitions and 250-row pages; type 10 also matches comparable/OEM numbers and
cannot establish disjoint manufacturer coverage. Caps are 30,000 products,
500 requests, 8 MiB per response and at least 1,100 ms between requests.
Each request, raw response and fingerprint is saved before continuing. The
unique normalized identities must equal the unfiltered manufacturer's total,
and an end-of-collection total check must agree before any stage or publication.
Changing counts, truncated windows, duplicate identities and wrong brands stop
the run. Resume uses the same output directory and immutable page evidence.

Full-brand collection publishes the **base attributes** profile through the
existing strict stage, publication, guarded enrichment and lifecycle RPCs.
It admits missing optional attributes: missing market segment stays null;
it never assigns all Elring parts to PC or infers compatibility from OEM makes.
Vehicle/model fitment is explicitly `pending` in the observation and run scope,
and image candidates remain `review_required`. This state is reported as
`base_attributes_published_verified`, never as complete vehicle enrichment.
The exact-product full-fitment publication gate described below is unchanged.
Both paths preserve existing canonical values and keep prices excluded.

Modes are `probe` (source evidence only), `stage` (durable review staging), and
`publish` (sealed publication, guarded enrichment and canonical reread).
`stage` and `publish` require `--confirm-production`; publication also requires
`--approved-by` and `--approval-reference` matching the existing source
metadata, plus `internal_catalog_persistence_allowed=true`. The runner never
grants itself these permissions or changes source policy. Database migration
`20261019184009_catalog_elring_guarded_enrichment.sql` installs the scoped,
service-role-only enrichment RPC. It requires a completed publication with
matching source and approval references and locks each affected product.

Field mapping preserves `product_code`, description, EAN, original OEM codes,
weight in kg, raw-digit tariff as `hs_code`, explicit origin, HTTPS image
evidence, vehicle manufacturer, model series, market segment and dimensions
as structured JSON with millimetre units. Other criteria, material, technical
notes and lifecycle signals remain in the raw observation. English requests
do not manufacture a Turkish description. Unknown units and absent values
are `missing`; an operator may supply a reviewed `--default-market-segment`
when the exact product response has no segment. No default segment is guessed.

Fitment follows the official web client's manufacturer → article-link pairs →
linked-vehicle details requests, with 25 pairs per detail request. The default
budget is 128 requests per product (`--fitment-max-requests`, maximum 1000).
Exhausted budgets preserve partial evidence and block canonical publication;
use a new report with a higher budget to collect a complete snapshot. The
source's OEM manufacturer list never substitutes for actual fitment. Models
retain manufacturer context. Multiple fitment segments never silently become
a single inferred market segment.

Publication fills only empty canonical attributes and records OEM, vehicle
and segment conflicts while preserving existing values. Images remain review
evidence for `apply_catalog_observation_review_image`; this adapter does not
automatically create an image-review decision or write canonical image URLs.
An explicit Product Decision Owner instruction on 2026-10-20 authorizes a
separate internal image-only source-fill job for the sealed Elring manifest.
`fill_approved_elring_images` requires a time-limited approval row matching the
organization, source, brand, run and manifest. It admits only official
TecAlliance asset URLs present in the exact Elring/supplier-10 article evidence,
fills empty image URLs on existing products, preserves populated images and
records a durable per-row audit. It does not insert products, change lifecycle
or prices, resume base publication, or reactivate the paused source. The source
must remain inactive during this recovery job; general review policy is intact.
The operator runner uses at most 25 rows per transaction, a 3-second database
timeout, a 250ms lock timeout, no automatic retries, and auth/data health checks
every five batches. A response over two seconds stops further publication.
An image-only update now preserves derived search text when all search inputs
are unchanged; edits to search inputs and inserts still rebuild search text.
For recovery runs, use explicit small cohorts: `--batch=10 --max-batches=50`
(500 staged rows), reducing to five rows per transaction when latency rises.
Between cohorts, inspect/maintain the six existing catalog trigram indexes.
Run `gin_clean_pending_list` separately from Product writes, with a 250ms lock
budget and a bounded maintenance timeout (up to 45 seconds), monitoring live
data access and cancelling the specifically tagged maintenance backend if its
health check exceeds two seconds. Never increase the image-write timeout to
accommodate index cleanup. Renew an expired image approval only after a new
operator instruction; preserve the existing job cursor and audit records.
The report shows image candidates separately from canonical image coverage.
Prices are excluded. Lifecycle and directional relations use the separate
Elring lifecycle step described below. `reread_verified`
means accepted identities were reread and each source/canonical field outcome
was recorded; individual missing/conflicting fields and pending images remain
explicit and do not imply complete brand coverage.

### Elring lifecycle and directional replacement

The `elring-official.v2` manifest explicitly requests `includeReplacesArticles`
and `includeReplacedByArticles`. It reuses `tecLifecycle` from the established
`mira-lifecycle.v1` evidence contract. Same-brand targets must carry a matching
manufacturer name or manufacturer ID; self-links, unidentified manufacturers
and unrelated alternative/OEM numbers are excluded. Opposing directions and
excessive relation counts fail the package.

`replacesArticles` records current product → old code as relation type
`replacement`. `replacedByArticles` records current product → successor as
`replaced_by`. The report also preserves explicit old → new edges. A missing
or empty response is an explicit unsupported/no-signal outcome, not a guessed
replacement. Multiple successors remain multiple relations.

Migration `20261019184623_catalog_elring_lifecycle_relations.sql` installs the
service-role-only lifecycle RPC. After scalar enrichment,
`apply_elring_provider_lifecycle_batch` revalidates
the source approval, tenant/brand, completed publication and raw article
identity. It creates source records and invokes the existing idempotent
`record_catalog_product_relation` evidence boundary. It does not create
operational `item_code_references`, redirect orders or replace product codes.

Only the existing contract's explicit production-stop labels may move an
active/empty lifecycle status to `discontinued`. The original label and raw
snapshot remain evidence; existing lifecycle notes are preserved. Numeric
status IDs, stock, availability and the existence of a successor never imply
discontinued. Normal or missing status never automatically reactivates a
discontinued product. Other existing lifecycle states are preserved and
conflict-reported. This dedicated step is separate from scalar enrichment,
which continues to exclude lifecycle writes.

The runner checkpoints this step and rereads canonical lifecycle fields plus
source-bound relation rows before marking the package `reread_verified`.
Old v1 reports must use a new output path, so an old snapshot that did not
request replacements cannot be silently reused as v2 evidence. Stage-only
mode never applies lifecycle changes or creates canonical relation records.

### Catalog screen and durable jobs

`/api/catalog-elring` is restricted to active tenant superadmins. Start creates
an idempotent exact-product manifest (1–100 codes plus an explicitly selected
segment) in `catalog_elring_jobs` and `catalog_elring_job_items`. Source-read
policy is checked before admission. This does not expand the registered
exact-identity source scope into an unbounded brand crawl.

The authenticated Netlify background worker processes one product per durable
package. Claims are serialized per tenant/source; expiring worker leases and
token-checked checkpoints fence stale invocations. Each source request and
Catalog RPC renews/checks the lease. Observations and package checkpoints are
persisted before moving to the next product. Closing the screen does not erase
progress. Time-window exhaustion pauses the job for explicit resume; source
failures preserve the current checkpoint. The worker does not depend on MIRA.

Collection ends at `reviewed`, with no canonical publication. A separate
**Publish reviewed package** action is available only when existing source
publication approval is registered. It reuses stored observations and sealed
runs, then applies guarded enrichment and the lifecycle step, and rereads the
canonical rows and source-bound relations. The screen shows reviewed versus
published states, source field coverage, missing fields and lifecycle signals.
Job APIs never return worker lease tokens or service credentials. New tables
have RLS and tenant-superadmin read policies; all mutation RPCs are service-only.

## CSV contract

The generated catalog template is the canonical import contract. Required
identity columns are `Product_Code` and `Brand`; `Market_Segment` is required
per row unless a single default is selected in the import dialog.

Optional columns are:

- `EAN`
- `Product_Name`, `Product_Name_TR`
- `OEM_No`
- `Vehicle`, `Vehicle_Model`
- `HS_Code`, `Origin`, `Weight_kg`
- `Dimensions_JSON` (valid JSON object or array, for example
  `{"length_mm":80,"width_mm":80,"height_mm":90}`)
- `Product_Type`, `Image_URL`
- `Lifecycle_Status`, `Lifecycle_Note`
- `Source_URL`, `Source_As_Of`, `Source_Retrieved_At`, `Source_Fingerprint`

The importer rejects malformed `Dimensions_JSON` instead of silently dropping
it. During staging and finalization, dimensions are typed as JSONB and copied
only into an empty canonical dimensions field. Re-uploading the same OEM or
other populated value is idempotent and does not overwrite canonical data.

## Package state gate

Each package must have these states in order: `reviewed` → `published` →
`enriched` → `reread_verified`. A failed state includes the exact source or
database reason and a resumable checkpoint. A process may continue to the
next package only after the previous package has a durable checkpoint; it may
not hide a failed package behind a success total.

## Operational invariant

The worker may continue in the background, but the UI and report must always
show the current package, last completed package, next checkpoint and field
coverage. No brand onboarding is complete while any package is still only
`reviewed` or `identity_only`.
