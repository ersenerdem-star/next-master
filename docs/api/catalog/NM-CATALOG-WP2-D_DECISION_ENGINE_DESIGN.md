# NM-CATALOG-WP2-D Decision Recommendation Engine Design

Status: Draft v1

Domain: API / Catalog

Phase: Evidence-Based Decision Intelligence

Work Package: NM-CATALOG-WP2-D - Deterministic Decision Recommendation Engine

## Advisory-Only Boundary

The decision engine is a deterministic recommendation runtime.

It recommends only.

It does not:

- approve observations;
- reject observations;
- assign reviewers;
- create review decisions;
- publish evidence;
- apply canonical Catalog values;
- mutate Catalog Products;
- mutate observations;
- run acquisition;
- run backfill;
- run migrations;
- expose Netlify functions;
- create UI behavior.

`AUTO_SAFE` is still advisory. It does not mean auto-apply.

## Inputs

The engine consumes only already-existing WP2-C review queue context:

- review queue items produced by the comparison engine;
- `catalog_external_observations`;
- referenced `catalog_products`;
- `catalog_external_sources`;
- `catalog_external_source_trust_profiles`;
- `catalog_observation_runs`;
- existing review decision count for safety proof.

The runtime rejects unbounded input. A single run may process at most 25 review items.

The current production validation dataset is bounded to source run:

`11581bfd-3a12-43d5-bb39-d6aa09e3bd96`

## Outputs

For every review queue item, the engine emits one local recommendation artifact:

- `organization_id`
- `product_id`
- `observation_id`
- `review_queue_key`
- `field_family`
- `comparison_result`
- `recommendation`
- `score`
- `positive_factors`
- `negative_factors`
- `rules_evaluated`
- `winning_rule`
- `human_explanation`
- `source_key`
- `source_trust_level`
- `source_trust_score`
- `observation_confidence`
- `evidence_complete`
- `run_status`
- `generated_at`
- `recommendation_fingerprint`

No recommendation is persisted to the database in this work package.

## Rule Precedence

The rule precedence is explicit:

1. `INSUFFICIENT_EVIDENCE`
2. `LIKELY_REJECT`
3. `MANUAL_REQUIRED`
4. `LIKELY_ACCEPT`
5. `AUTO_SAFE`

The first applicable blocking/safety rule wins. `LIKELY_ACCEPT` is only eligible when `AUTO_SAFE` requirements are not fully met, so independently corroborated high-confidence enrichment can still reach `AUTO_SAFE`.

Every evaluated rule is retained in the recommendation explanation.

## Recommendation Rules

`INSUFFICIENT_EVIDENCE` is returned when mandatory safety evidence is missing, including unsupported field family, missing observation value, missing evidence hash, missing evidence reference, missing trust profile, non-succeeded run status, invalid confidence, or missing Product/observation linkage.

`LIKELY_REJECT` is returned when evidence exists but is materially unsafe, including trust score below 0.50, confidence below 0.50, trust level below the accepted observation tier, stale evidence, or deterministic contradiction outside a normal comparison conflict.

`MANUAL_REQUIRED` is returned for valid conflicts, ambiguous evidence, duplicated evidence, middle-band trust, or middle-band confidence.

`LIKELY_ACCEPT` is returned for valid enrichment candidates with complete evidence, succeeded run, supported field family, no contradiction, trust score at least 0.75, and confidence at least 0.75, when `AUTO_SAFE` is not fully proven.

`AUTO_SAFE` is returned only for enrichment candidates where Product target field is empty, evidence is complete, run succeeded, source trust level is at least `T3`, trust score is at least 0.90, confidence is at least 0.90, at least two independent evidence records agree, no contradiction exists, and evidence is fresh.

The current single-source ZF/SACHS pilot cannot become `AUTO_SAFE` merely because it is an official source.

## Scoring Model

The score is a deterministic integer from 0 to 100.

The score uses named contributions and penalties:

- source trust;
- observation confidence;
- evidence completeness;
- successful run;
- source consistency;
- independent corroboration;
- freshness;
- conflict penalty;
- ambiguity penalty;
- missing optional evidence penalty.

The score supports explanation only.

The score never overrides rule precedence.

## Deterministic Fingerprint Contract

The recommendation fingerprint is SHA-256 over the canonical recommendation body.

`generated_at` is excluded from the fingerprint.

For identical input, the recommendation body excluding `generated_at` and the fingerprint must remain byte-stable.

## Safety Boundaries

The production validation runner captures before and after snapshots for:

- selected Product rows;
- selected observation rows;
- review decision count;
- trusted Product count from the WP2-C production safety artifact.

The runner writes only local files to the external artifact directory.

It does not execute SQL, migrations, RPC mutations, source acquisition, apply, publication, or background work.

## Production Validation Dataset

Expected WP2-C source state:

- total observations: 9
- `NO_CHANGE`: 3
- `ENRICHMENT_CANDIDATE`: 5
- `CONFLICT`: 1
- review queue items: 6
- review decisions: 0

Semantic constraints:

- the `CONFLICT` item must not be `AUTO_SAFE` or `LIKELY_ACCEPT`;
- single-source evidence must not become `AUTO_SAFE`;
- every recommendation must include deterministic rules, score, factors, explanation, and fingerprint.

## Non-Persistence Statement

This work package creates local recommendation artifacts only.

Recommendations are not Catalog truth.

Recommendations are not review decisions.

Recommendations are not commands.

Humans and later Catalog-owned apply boundaries remain responsible for review and canonical mutation.
