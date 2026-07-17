# NM-CATALOG-WP2-D Decision Engine Release Record

Status: RELEASE_RECORDED

Domain: API / Catalog

Phase: Evidence-Based Decision Intelligence

Work Package: NM-CATALOG-WP2-D

Feature Commit: ae05d5cba8e29ba4b32bd9291b682f1de762959f

Production Observation Run: 11581bfd-3a12-43d5-bb39-d6aa09e3bd96

Artifact Directory: /Users/ersen/Developer/NextMaster/artifacts/wp2d-decision-2026-07-17T22-45-00-056Z

## Purpose And Scope

This release records the deterministic recommendation engine that evaluates the six existing WP2-C review queue items.

The engine is advisory only.

It recommends.

It does not approve, reject, review, publish, apply, mutate, or persist Catalog truth.

## Runtime Call Chain

The production read-only validation path is:

1. CLI entrypoint: `scripts/catalog/run-catalog-observation-decision-engine.mjs`
2. bounded WP2-C review queue input
3. observation, evidence, source, trust-profile, and run-state reads
4. deterministic rule evaluation
5. score calculation
6. winning rule selection
7. human explanation synthesis
8. fingerprint generation
9. local artifact output

Only read-only GET/count calls are used.

No recommendation is written to the database.

## Input Dataset

Production validation used the existing WP2-C review queue derived from source run `11581bfd-3a12-43d5-bb39-d6aa09e3bd96`.

Validated queue size: 6

Validated source run state:

- total observations: 9
- `NO_CHANGE`: 3
- `ENRICHMENT_CANDIDATE`: 5
- `CONFLICT`: 1
- review queue items: 6
- review decisions: 0

## Rule Precedence

Winning rule precedence is fixed:

1. `INSUFFICIENT_EVIDENCE`
2. `LIKELY_REJECT`
3. `MANUAL_REQUIRED`
4. `LIKELY_ACCEPT`
5. `AUTO_SAFE`

The highest-priority matching rule wins.

The score never overrides precedence.

## Scoring Boundaries

The deterministic score uses bounded contributions and penalties for:

- source trust
- observation confidence
- evidence completeness
- successful run
- source consistency
- independent corroboration
- freshness
- conflict penalty
- ambiguity penalty
- missing optional evidence penalty

The score is explanation support only.

It does not independently upgrade or downgrade the winning rule.

## AUTO_SAFE Restrictions

`AUTO_SAFE` is allowed only when all of the following are proven:

- review item is an enrichment candidate
- Product target field is empty
- evidence is complete
- acquisition run succeeded
- source trust level is at least `T3`
- source trust score is at least `0.90`
- observation confidence is at least `0.90`
- at least two independent approved evidence records agree
- no contradictory approved observation exists
- observation is within freshness threshold

The single-source ZF pilot cannot become `AUTO_SAFE` merely because it is an official source.

If independent evidence cannot be proven, `AUTO_SAFE` count must be zero.

## Deterministic Fingerprint Contract

Every recommendation body is byte-stable for identical input.

The recommendation fingerprint is SHA-256 over the canonical recommendation body.

`generated_at` is excluded from the fingerprint.

The production validation proved that:

- deterministic repeatability is `true`
- fingerprint repeatability is `true`

## Production Recommendation Results

| Observation ID | Product ID | Comparison | Recommendation | Score | Winning Rule |
| --- | --- | --- | --- | --- | --- |
| `4a66cf02-f439-4863-adf7-2bb408feda27` | `3bc8720c-b9d7-41d9-8dfe-73d92bb197d9` | `CONFLICT` | `MANUAL_REQUIRED` | 62 | `manual_required` |
| `f67ce7e8-c2cd-4088-9361-2fbf18ee37ee` | `a73ba233-5162-48c7-a70b-a1ef2dae6b3e` | `ENRICHMENT_CANDIDATE` | `LIKELY_ACCEPT` | 80 | `likely_accept` |
| `bee420ae-64bf-4315-9ae4-84b1f28fdda3` | `db2abfcd-0113-42d2-afff-dd97269a896e` | `ENRICHMENT_CANDIDATE` | `LIKELY_ACCEPT` | 80 | `likely_accept` |
| `a96d3be5-7d33-4aff-930a-0a622322ef2e` | `5b67a391-61ae-43ec-8d76-5fa269cf739f` | `ENRICHMENT_CANDIDATE` | `LIKELY_ACCEPT` | 80 | `likely_accept` |
| `a95a32a4-dea0-431b-b148-6972c646b3f2` | `0c97dfd9-8f51-4add-920f-1899691d022d` | `ENRICHMENT_CANDIDATE` | `LIKELY_ACCEPT` | 80 | `likely_accept` |
| `088adb16-671d-4034-8c68-0e6bd99415b8` | `0c97dfd9-8f51-4add-920f-1899691d022d` | `ENRICHMENT_CANDIDATE` | `LIKELY_ACCEPT` | 80 | `likely_accept` |

Recommendation totals:

- `AUTO_SAFE`: 0
- `LIKELY_ACCEPT`: 5
- `MANUAL_REQUIRED`: 1
- `LIKELY_REJECT`: 0
- `INSUFFICIENT_EVIDENCE`: 0

## Deterministic Repeatability Proof

Production validation proved:

- identical input produced identical recommendation body
- identical input produced identical score
- identical input produced identical fingerprint
- generated_at did not affect the fingerprint
- rule precedence remained stable

## Immutability Proof

Production safety evidence:

- Product count before: 391582
- Product count after: 391582
- observations before: 9
- observations after: 9
- review decision count before: 0
- review decision count after: 0

Selected Product snapshots were re-read and remained unchanged.

## Validation

Validation commands:

- `node --test scripts/tests/*.test.mjs`: passed, 47 tests
- `node --check scripts/catalog/lib/catalog-observation-decision-core.mjs`: passed
- `node --check scripts/catalog/run-catalog-observation-decision-engine.mjs`: passed
- `node --check scripts/tests/catalog-observation-decision-engine.test.mjs`: passed
- `git diff --check`: passed
- `git diff --cached --check`: passed

App build was not required because the release changed only scripts, tests, and docs, not deployable shared app or Netlify source.

## Explicit Non-Persistence

This release did not:

- persist recommendations
- create review decisions
- mutate Product
- mutate observations
- apply canonical values
- rerun acquisition
- publish anything
- run backfill
- run a Supabase migration
- deploy Netlify
