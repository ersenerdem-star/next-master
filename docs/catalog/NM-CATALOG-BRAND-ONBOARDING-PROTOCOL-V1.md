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

## All-brand engine rollout — 2026-10-20

The Product Decision Owner requested completion of existing upload/enrichment
jobs followed by an official-source engine for every uncovered brand. Reuse
shared family connectors with a separate exact brand identity; do not make a
legacy source URL or marketplace fallback look production-ready. Track source,
exact reader, durable execution, field coverage, source holds, and live evidence
separately for each brand. Ask the owner for the official catalogue URL when
unconfigured; Denso's supplied URL is https://www.denso-am.eu/catalog/pv.

The all-brand entry point is `/api/catalog-brand` with the existing brand selector
and **Brand Engines** overview. Existing ZF and Elring engines retain their own
review contracts. Other configured exact readers use `catalog_brand_jobs`,
immutable job items and application receipts. Admission is tenant-superadmin
only; execution is service-only, bound to the registered source and exact
existing product. Sources require explicit `brand_engine_read_allowed` and
`brand_engine_enrichment_allowed` metadata in addition to their existing policy.
The new scope must not alter older source collection or automatic-apply grants.

A signed one-minute dispatcher runs bounded jobs without a browser session.
Leases fence concurrent or expired workers. Each official row is saved before
continuing, and reviewed publication reuses the sealed observation. Temporary
network failures have persisted bounded backoff; identity, authorization and
source-policy errors stop for review. Unknown sources never fall through to a
marketplace. Scalar completion preserves populated values and concurrent edits;
EAN conflicts hold all metadata for that product. Identifier additions are
computed against the reviewed snapshot. One short transaction updates a product
once and records before/changes/outcomes; prices, lifecycle and operational
replacement mappings stay outside this generic completion boundary.

Denso uses the public parts endpoint serving the owner-supplied catalogue.
Require one returned exact article, preserve punctuation and distinguish gross
from net weights. The observed DCRI100360 response has EAN 8717613058732,
net 720 g and gross 920 g; only gross 0.92 kg is eligible. Missing origin/tariff
stays missing. TecAlliance completion likewise requires explicit gross units;
MANN completion excludes an unlabelled logistics weight and uses product-bound
OEM references. Legacy collection paths are not promoted to verified readers.

The overview separates registered readers, missing source registrations,
unimplemented adapters, required official links, authorized-access needs and
operational holds. PartsFinder for Febi/Swag/Blue Print returned HTTP 401 in the
current exact-detail probe; do not copy browser tokens or bypass that boundary.
Unbranded products remain file/manual managed. An engine being connected is
not proof that all brand products have been enriched.

The first production Denso review and publication completed through the signed
scheduled worker for DCRI100360, DCRI100510 and DCRI100570. Canonical reread
confirmed the official descriptions, EANs and gross weights (0.92, 0.84 and
0.84 kg). Origin and tariff remained absent. Both current supplier publication
pointers remained unchanged. The two current supplier enrichment jobs (7,349
and 9,469 source rows, different suppliers) were requeued at their preserved
official cursors; this is not proof of whole-list enrichment completion.

On 2026-10-21 both Denso supplier jobs were found stopped at DSN2112
(source rows 4,854 and 4,602). Its official fitment `items` has sparse numeric
JSON object keys rather than an array. Preserve every model by accepting both
numeric list representations, reject unrelated object shapes, and cover the
same product response in regression validation before resuming those cursors.
Do not reset successful prefixes or alter either supplier price publication.

On 2026-10-21 production database statement statistics measured approximately
24.5 ms per enrichment batch read and 36.0 ms per apply. Do not replace exact
product-code normalization with the compact generated column to optimize this
path: punctuation is part of identity and the exact expression already has an
index. The principal remaining work is the serialized official-source lookup.

Supplier publication enrichment may use two official consumers globally: one
Denso job and one conservative shared lane for all other official sources,
including every ZF brand. Two suppliers' Denso lists remain serialized with
each other. Claim admission keeps its transaction advisory lock and atomic
lease fencing. File projection drains official consumers and runs exclusively;
eligible new files retain priority. Source pacing and bounded worker windows
remain unchanged. This separation does not relax generic manual review jobs'
source, identity or publication approval contracts.

The SKF shared engine uses `skf_official_product_v1`, restricted to the current
official SKF Automotive product pages and exact SKU/name, SKF brand and canonical
article URL in Product JSON-LD. This is an automotive source, not the industrial
bearing catalogue. The production catalogue's VKBA906 was matched against the
official VKBA906 page. Its product-bound breadcrumb identifies Wheel Bearing
Kit, with width 37 mm, inner diameter 35 mm and outer diameter 66 mm. Missing
EAN, origin, tariff and explicit gross weight remain missing; an unqualified
Weight property must never become gross kg. Existing populated values remain
protected by the generic reviewed-completion contract. Unsupported product
domains produce per-row review evidence and allow subsequent rows to continue.

Connector review on 2026-10-21 found Hengst's official homepage returning a
Cloudflare 403; do not bypass it or activate the old stub. The Donaldson
A161500 URL returned an unverified generic regional page, not an exact article.
A 200 homepage or a source URL does not establish a working product reader.

The supplier-enrichment worker must checkpoint every completed official row
before the next request, use bounded source pacing, and preserve file progress.
A source failure on row N must not replay successful earlier observations in
the same batch. Resume retains the same job/release/cursor. Do not clear old
review-required or failed states merely to display green: missing source fields
and source access failures remain explicit outcomes. The Elring publication
hold below remains in force until its cause is repaired and validated.

## All-brand official-first completion decision — 2026-10-21

### Schaeffler shared family — 2026-10-21

The owner supplied https://vehiclelifetimesolutions.schaeffler.com/en/catalog
as the common official catalogue for **FAG, INA, LuK and Vitesco**, and named
the engine **Schaeffler**. Use one `schaeffler_aftermarket` source/family,
preserving the existing separate brand IDs and exact brand/article identity.
The overview and selected-brand engine show this shared name. No Schaeffler
product brand or merged catalogue identities are created.

Normal public browser navigation confirmed all four product-brand links and
Vitesco article `571 0122 10`, official product `p-TA-4319-5710122100`, EAN
`4014870798192`, with article status `Normal`. This bounded browser observation
is not a server-reader proof, a canonical write or whole-brand completion.
The supplied catalogue and robots URL returned HTTP 403 to the server client.
Keep the shared source registered but inactive, its reader/publication grants
off, and report `server_access_required`. Do not copy browser credentials,
bypass access controls or run a marketplace-first legacy sync. The verified
official receipt remains mandatory before any Spareto supplemental completion.
Replacement/discontinued checks remain required; an unavailable source records
blocked/unsupported coverage rather than a fabricated production state.

Reader follow-up: the owner has only the public web catalogue. Normal signed-out
browser navigation exposed the official `/api/AAM-COM/products/search`,
`products/{internal-code}` and `products/{internal-code}/oenumbers` routes.
The shared exact reader is implemented against those response contracts, with
20-result complete-search limits, separate brand/article/internal-ID checks,
fixed-origin JSON requests, response caps, request fingerprints and at least
1100 ms pacing. Product names, EAN and scoped OE numbers are supported. Explicit
ISO origin, tariff, gross weight and mm-labelled criteria may complete fields;
net/unqualified weights, unitless dimensions and trade numbers never do.
Vehicle/model data is not inferred from OE manufacturers. A replacement
reference contract has not been verified, so that mandatory check remains
`unsupported`; product availability cannot assert discontinued production.
OE references marked as component-only or with unknown exchangeability never
become complete-product OEM interchange numbers; only explicit
`Interchangeable` references are admitted.

The actual Vitesco `571 0122 10` response has net weight `0.273` without a unit,
unitless packaging dimensions and EAN `4014870798192`. Only the qualified
metadata enters the bounded test fixture. This is browser-derived contract
validation, not a server-worker or canonical publication result. Generic brand
jobs now have the reader but require `server_access_verified` plus the existing
read/publication approvals. Supplier upload execution remains unchanged while
access is blocked. Schaeffler's Akamai response explicitly reports a security
block and directs mistaken blocks to `vehiclelifetimesolutions@schaeffler.com`.
No cookies, credentials, user-agent impersonation or network rerouting is used.
Keep the source inactive and jobs unstarted until permitted automated access
has been supplied and verified. The reader being implemented is separate from
source activation and all-brand enrichment completion.

Owner instruction `user-official-first-spareto-lifecycle-2026-10-21` applies to
all brands. First match the exact official brand and product; then use
`https://spareto.com` for remaining missing attributes. Preserve populated
official, supplier-file and manual values. Record a separate secondary receipt
with the exact product URL, retrieval time, fingerprint, field values and
conflicts; never label marketplace values as official. A conflicting EAN holds
the secondary candidate. Preserve punctuation in product identity and the
separate TRW Engine Components domain. Do not infer an individual VAG marque
from a number prefix or treat the aggregate VAG price-list brand as an exact
Spareto manufacturer identity.

This replaces the former blanket ZF marketplace-completion exclusion only for
the reviewed, missing-only secondary phase. Retired fuzzy/direct-write scripts
remain retired. Missing official source access is a deferred source review,
not a successful official match or permission to bypass the official step.
Spareto requests use exact product pages, bounded requests and at least 1100 ms
spacing; robots-disallowed brand/per_page listing routes are excluded. Missing
secondary coverage remains visible. Public access does not itself establish
redistribution rights or override each registered source's execution grants.

Every brand package must record **replacement** and **discontinued** checks,
including when the reader does not supply them. Distinguish found,
no_explicit_signal, unsupported, blocked and review_required. A source 404,
stock shortage, `No longer available`, or `No longer deliverable by the
manufacturer` does not establish production discontinuation. A replacement
also does not imply discontinuation. Keep source wording and directional
old → successor evidence. Same-brand exact target verification and cycle,
ambiguity, manual-reference and source-conflict checks precede operational
replacement changes. Secondary lifecycle signals remain separately attributed
review candidates; do not silently overwrite official lifecycle evidence.
The generic scalar completion RPC continues to exclude lifecycle writes.

VAG means Volkswagen, Audi, Skoda, SEAT and Porsche. ETKA's official page
(`https://www.etka.com/etkaportal/en/about-etka/what-is-etka.html`) directs
independent operators to partslink24. Its official brand list includes these
five marques (`https://www.partslink24.com/partlink24mobile/index.html`), with
market-specific availability. The July 2026 terms, section 6
(`https://legal.lexcom.de/legaldocs/partslink24-tos/-/10/en/partslink24-tos.html`),
restrict automated extraction and integration. Record VAG as
`authorized_access_required`, with **no working reader or new subscription**.
Licensed data-file/API availability remains unverified. Porsche Classic's
public model PDFs cover a limited historical subset, not the whole VAG scope.

Deferred final review includes VAG, Febi/Swag/Blue Print authorization,
Hengst's blocked official source, Donaldson's unverified product detail,
Elring's operational hold, and all inventory entries without an implemented
official adapter or verified official source. Continue the already admitted
Denso and ZF jobs at their existing checkpoints; never restart them merely
because this policy changed. Existing receipts are not retroactive evidence
of the new mandatory checks. Runtime rollout and live proof must be reported
separately from this owner decision.

The first implementation records lifecycle coverage in new generic brand job
observations and supplier official evidence. TecAlliance/ZF preserve their
existing parsed lifecycle evidence; MANN/Denso keep unverified successor
candidates as review-only. Older completed items are not rewritten.
`spareto-secondary-provider.mjs` reads a supplied exact product URL and
`planSparetoMissingCompletion` prepares separate missing-only review candidates.
This reader/planner does not discover an entire brand, run automatically after
every official job, or apply secondary candidates to canonical data. Durable
secondary dispatch, reviewed publication and UI coverage remain rollout work.
Read-only production checks matched Sachs 280960 and SKF VKBA906 against both
official and Spareto pages, with canonical rereads unchanged. VKBA906 already
has origin SE while Spareto reports IT: preserve SE and record both values as
a secondary-source conflict, rather than treating exact SKU/EAN as proof that
every origin batch is the same. No secondary candidate was applied in these
checks.

## Supplier upload safety correction — 2026-10-21

Owner approval authorizes correcting the four reviewed gaps in sequence, while
preserving the existing publication/price/order boundaries and active jobs.
Official EAN conflicts hold **all** metadata at both planner and locked database
application boundaries; source EAN and the conflict remain in the receipt.
An older worker lacking source EAN evidence cannot apply an official patch to
an existing EAN-bearing product. Missing source EAN is recorded explicitly as
null by the new reader, not guessed to match an existing barcode.

The v2 upload worker requests exact official evidence for every accepted row,
including metadata-complete products. Every successful or not-found/domain
outcome records replacement/discontinued coverage; source outages retain the
same unadvanced checkpoint and actionable error. Lifecycle results remain
review evidence and do not directly change operational replacements or status.
The historical `official_checked` is **scanned row progress**, not proof of
actual requests. New `official_requested` / `lifecycle_recorded` counters begin
at an explicit `coverage_start_row`. Do not manufacture historical coverage or
restart already processed rows. Transport signing stays on its existing v1
protocol so deployment does not invalidate an in-flight invocation.

File projection remains globally exclusive. Under file pressure, completed
four-minute file turns alternate with one-minute official turns, without
starting concurrent file/official writers. Existing source lanes still allow
at most two official consumers when no file waits. Every job keeps its cursor,
publication and lease fencing; the next turn is a scheduler decision only.
The currently running file invocation drains normally before the first source
turn. A source request may complete after the one-minute budget; its row is
committed before yielding. No official source pacing is relaxed.

## Spareto supplemental completion queue — 2026-10-21

### Owner-reviewed Schaeffler corrections — 2026-10-21

The owner's explicit follow-up authorizes Spareto correction of **description,
OEM references, market segment and product image for INA, FAG and LUK**, including
populated descriptions. This is a scoped exception to missing-only completion,
not an activation of Schaeffler's blocked official web reader. The supplied
GroupAuto/Schaeffler file remains a separate, price-free source receipt. Vitesco
and every other brand retain their existing policies.

Use the existing durable brand jobs/items/checkpoints with the separate
`spareto-reviewed-correction.v1` adapter and a time-limited
`spareto_schaeffler_correction_v1` source approval. Seal exact product evidence
before application. Current EAN must occur in the primary product GTIN list;
unknown, ambiguous and conflicting identity is held individually. Source failures
and unsupported fields remain visible and never stop later eligible products.
OEM completion is additive. A segment requires an explicit labelled vehicle
class; `commercial-groups`, product titles and manufacturer names cannot supply
it. Preserve the supplier-file segment when Spareto has no such field.

The owner approval includes the exact primary-product Spareto image candidate,
including correction of a populated image. Only non-placeholder HTTPS raster
assets under `cdn.spareto.com/variants/images/` present in the primary product's
image metadata are admitted. This dedicated four-field correction RPC does not
relax any other image-review route. Preserve EAN, origin, tariff, weight, vehicle,
dimensions, lifecycle, replacements, prices and orders. Concurrent edits after
the sealed snapshot are preserved field by field, with a durable before/after
application and source receipt. Same-brand primary writers defer corrections;
unrelated supplier-file brands retain their own cursors and leases.

Correction and existing supplemental readers share the existing global Spareto
transport gate and 1100 ms request spacing.
The correction retains its fenced job lease for at most 125 seconds while an
already-running supplemental row drains, so the old reader cannot immediately
reclaim the gate and starve correction work. No source work is canceled.
Jobs run through the existing signed scheduled dispatcher, without a browser,
new service or new paid subscription.
The brand engine displays the correction's processed/updated/held counts
separately from the inactive official-reader status. Search cards explicitly
marked as alternatives are excluded before the 200-primary-card search bound.

The existing upload worker's exact matched official receipts feed a separate
secondary queue. Only a registered `spareto_secondary_exact_v1` source with
explicit brand, read, application and field approval can run. Source admission
does not enable old marketplace writers or change their grants. EAN-conflicting
primary receipts never enqueue. One globally fenced secondary reader searches
with the product keyword only, verifies both card brand/code and exact detail
brand/MPN, spaces every request by at least 1100 ms, caps response size, refuses
redirects, and records fingerprints. Brand/per_page listing routes are unused.

Secondary completion follows the owner's preapproved missing-only field rule.
It seals the source observation and candidate before a separately guarded
application transaction. Only explicitly approved metadata fields may auto-fill;
existing or concurrently edited values are preserved. Source-policy revocation,
EAN conflicts and ambiguous identity prevent application. Lifecycle candidates
and image references do not enter canonical lifecycle/replacement/image fields.
The manual page action is available for deliberate administrator review, not a
new approval requirement for every ordinary missing-field completion.

The secondary application uses the primary scheduler's transaction advisory
lock and defers while a primary catalog lease is active. Read-only source work
can continue independently, but canonical writers do not overlap an active
primary turn. A deferred application remains durable for a later dispatcher.
It cannot change a primary cursor, publication pointer, supplier price or order.
Short application receipts survive queue/parent-job cleanup independently.
Applied fields also update the existing enrichment-field ledger with the actual
normalized value, parent job and source date, so a later authoritative supplier
file can refresh them without treating the supplemental fill as a manual edit.
An item whose product identity changed is held individually; it cannot block
subsequent automatic applications.

Both transport and job leases are scope-bound. Failed attempts retain their
request identity/error and bounded retry schedule. Source not-found, schema,
authorization or ambiguous matches stay explicit per product; a source failure
does not stop the primary upload. Queue-enqueue failures have a separate counter.
New official receipts feed this queue automatically after source activation;
older prefixes are not silently replayed or declared covered.

Product facts are scoped before reviews/related products. Some primary products
explicitly list more than one GTIN: use a known official/current EAN only when
it appears in that exact product's GTIN set. Without a known match, do not pick
an arbitrary barcode; retain the candidate set. A known EAN absent from the set
holds the product. Source-provided origin/tariff remain secondary evidence;
shipping or volumetric weight is never guessed to be gross kg. OEM references
are limited to the OE section, and vehicle/model information is explicitly a
page-level model summary, not complete variant/VIN fitment.

## ZF Group exact identity and correction — 2026-10-20

The Product Decision Owner requested repair of order `FU26-R42026` and the
Sachs/Boge/TRW/Lemforder/Wabco catalog engine, including official replacement
and discontinued evidence. The existing ZF brand remains in the same connector;
TRW Engine Components remains a distinct Motorservice domain. This instruction
authorizes bounded internal official-source observations and reviewed corrections
for these six existing brands, not unrestricted catalog collection or public
republication. The source approval reference is
`user-zf-group-catalog-order-repair-2026-10-20`.

Every lookup verifies the requested brand and exact article number in the
authoritative detail response; search cards must match too when search is used.
A six-digit Sachs article may use its known 3+3 official spelling directly,
with the same exact returned-brand/article check and exact-search fallback.
Whitespace is presentation; punctuation remains
identity. No reader may substitute the first fuzzy search result. Use the source
article spelling in the detail URL. All legacy ZF reads share this reader. Legacy CLI --apply/--import writers
are retired and refuse execution before credentials or network access; reviewed
publication must use the durable engine.
Weight is the explicitly labelled gross shipping weight in kg; convert grams
only with an explicit unit and report conflicting product-type weights as
unavailable. Never substitute a kit component, a net value or an unknown unit.
The user-corrected Sachs `350038` has a valid 4.33 kg gross weight and matching
EAN; it is not evidence that every existing Sachs attribute is wrong.

The durable engine collects an immutable exact-code manifest of at most 100
products, then shows source/current field differences before application.
Requests are bounded and source snapshots, identities, errors and checkpoints
are retained. Applying reviewed description/weight corrections requires the
same field values seen during review; a subsequent manual edit is preserved.
Existing EAN, menşe/tariff and identifiers are preserved or conflict-reported;
blank source values never erase canonical values. A source weight below half or
above twice an existing positive weight is held for individual product review;
exact official identity is not proof that every official attribute is correct.
A confirmed foreign SKU-prefixed title makes its old weight an untrusted
baseline: exact official brand/article evidence and a usable non-conflicting
official EAN can correct it. Numeric technical descriptions without a SKU-title
separator are not contamination (for example Wabco 4/3 valves). ZF Group
marketplace completion is disabled, including legacy marketplace entrypoints.
Raw source payloads remain in receipts; portal projections omit raw bodies, and
collected receipts are capped at 5 MiB. Each mutation records its
source and before/after values in a small transaction with a short lock timeout.
No source policy is inferred from successful HTTP access.

An explicit operator review may quarantine confirmed foreign SKU-title metadata
on a completed Sachs manifest when the exact official article is unavailable.
A source 404 alone never authorizes this action. The service-only operation
checks tenant/admin, exact product, immutable before-values and title shape;
concurrent edits are preserved. Original full records remain in an RLS-protected
ledger before description/weight become unknown. EAN, code, origin, tariff,
prices and lifecycle remain unchanged; missing source never means discontinued.

Replacement signals are directional: `replacedBy` means old → successor;
`replaces` means predecessor → current. Parse the official nested `values`
structure. Verify every target against the same brand and exact identity before
recording evidence. Only a unique, non-cyclic, non-conflicting successor can enter
operational Code References; existing manual mappings remain authoritative.
Multiple/unverified successors require review. Availability, a numeric status,
or a replacement alone is not proof that production ended. Only explicit
production-stop wording changes canonical discontinued status; normal or missing
status never reactivates a discontinued item automatically.

Order resync is a separate pricing operation. It keeps valid saved prices for
unchanged SKUs, fills unpriced lines from current supplier options, and clears
old SKU attributes/prices before resolving a newly approved replacement. The
original requested code is retained. Missing prices and lookup failures remain
visible per row; a missing supplier cannot force use of a stale supplier price.
Full explicit repricing retains its exact-SKU, saved-supplier and EUR guards.

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
