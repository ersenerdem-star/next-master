# NM-CATALOG-WP2-A DB Design: Single-Source Single-Brand Observation Pilot

Status: Draft v1
Runtime Repository: `/Users/ersen/Documents/Codex/next-master-ui-consolidation`
Domain: DB / Catalog
Phase: Phase 1 - Operational Foundation Hardening
Work Package: NM-CATALOG-WP2-A

## Workspace Decision

The architecture source repository is `/Users/ersen/Documents/Next-Master` at commit `ef2af9007975fda868fbe9bfe4759f625903d53c`.

The runtime implementation target is `/Users/ersen/Documents/Codex/next-master-ui-consolidation` because it:

- uses runtime remote `git@github.com:ersenerdem-star/next-master.git`
- contains `supabase/migrations`, `apps/web`, and `package.json`
- is clean before this work package
- contains Catalog Integrity Sync commit `0c0dcdfa`
- includes later runtime UI lineage

The architecture repository is not modified by this work package.

## Slice Objective

Create the DB foundation for one bounded external Catalog observation pilot:

- one source
- one brand
- bounded field families
- append-only evidence capture
- run and checkpoint state
- candidate comparison state
- human-review state
- apply-event audit records

This slice does not implement external fetchers, API routes, UI screens, background workers, full backfill, or canonical Catalog mutation.

## Data Classification

| Object | Role | Classification |
|---|---|---|
| `catalog_external_sources` | Source identity and source governance metadata | Catalog configuration truth |
| `catalog_external_source_trust_profiles` | Trust, license, field, and review posture | Catalog configuration truth |
| `catalog_observation_jobs` | Approved scoped observation intent | Operational working data |
| `catalog_observation_runs` | Concrete execution attempt | Operational working data |
| `catalog_observation_checkpoints` | Safe cursor/progress state | Operational working data |
| `catalog_external_observations` | Append-only raw and normalized external evidence | Evidence / operational working data |
| `catalog_observation_candidates` | Compare outcome for an observation | Operational working data |
| `catalog_observation_review_decisions` | Human decision records | Operational working data / audit input |
| `catalog_apply_events` | Approved apply intent/provenance ledger | Catalog provenance, not direct truth mutation |
| `catalog_observation_audit_ledger` | Lifecycle audit trail | Audit evidence |

`catalog_products` remains the canonical Catalog Product truth table.
External observations do not update `catalog_products` in this slice.

## Runtime Boundary

The intended future runtime path is:

Source registry -> observation job -> observation run -> append observation -> candidate compare -> review decision -> apply event -> future Catalog-owned apply boundary.

This migration creates only the persistence and DB contracts needed to make that path observable, resumable, idempotent, and reviewable.

## Security Model

- Tables are RLS-enabled.
- Authenticated users may select organization-scoped rows where appropriate.
- Mutation RPCs require `auth.role() = 'service_role'`.
- `PUBLIC` execution is revoked from all functions.
- No customer or portal role can read raw observation evidence unless a later portal-safe projection is explicitly designed.

## Organization and Scope Consistency

The DB boundary rejects cross-scope relationships before they can become operational evidence.

Consistency triggers validate that:

- source trust profiles belong to the same organization as their source
- jobs bind a source, trust profile, and brand from the same organization
- runs, checkpoints, observations, candidates, reviews, apply events, audit rows, and health rows remain inside the same organization/job/source/brand chain
- linked `catalog_products` rows, when present, belong to the observation organization and brand

This keeps the service-role runtime powerful enough to process observations while preventing accidental cross-organization evidence linkage.

## Append-Only Guard

`catalog_external_observations` is evidence. The immutable evidence fields cannot be changed after insert. Mutable workflow state is restricted to compare/review/apply status, lock, retry, error, and timestamp fields.

Deletion is blocked at DB level. Test fixtures are expected to run inside rollback transactions.

## Idempotency

Observation deduplication uses an organization-scoped `deduplication_key`.
The append function computes a stable key from source/job/brand/product/field/value/evidence identity and returns the existing observation when the same evidence is submitted again.

## Non-Goals

This work package does not:

- insert a real source
- create a real job
- run a backfill
- create a worker
- change `catalog_products`
- change Product overwrite guards
- alter Catalog Integrity Sync
- update API/UI/Netlify functions
- expose portal-facing data
- apply external observations to canonical truth

## Validation Standard

Manual Supabase validation must prove:

- physical DB objects exist
- RLS is enabled
- PUBLIC execution is absent
- service-role contracts exist
- controlled observation fixtures can be inserted and deduplicated inside a rollback transaction
- immutable evidence fields cannot be changed
- candidate, review, apply-event, audit, run, and checkpoint contracts function
- no fixture persists after rollback

## Current Decision

Proceed with additive DB foundation only.
