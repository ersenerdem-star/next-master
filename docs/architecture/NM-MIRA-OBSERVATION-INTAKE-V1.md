# NM-MIRA-OBSERVATION-INTAKE v1

Status: implementation boundary (observation-only; no Apply authority)

This package is the server-side handoff for a MIRA mission that returns typed
catalog evidence. MIRA may discover and report candidates, but it does not
write canonical Product values. The intake validates the tenant, source,
trust profile, job, brand, product identity, evidence, and policy again on the
server, then appends only to the existing Catalog observation pipeline.

## Data flow

```text
MIRA mission result
  -> trusted Next-Master server boundary
  -> validateMiraObservationBatch()
  -> ingest_mira_catalog_observation_batch RPC (service role only)
  -> begin_catalog_observation_run
  -> append_catalog_external_observation (one candidate at a time)
  -> finish_catalog_observation_run
  -> Observation Review / Debrief
```

The migration does not insert, update, delete, or finalize rows in
`catalog_products`. `ean_reference` is an observation field family; it is not
an EAN Product-column mutation. Review and a separately governed Apply package
remain required before canonical enrichment.

## Server integration hook

Use `/netlify/functions/_shared/catalog/mira-observation-intake.mjs` from a
trusted server handler after the mission worker has produced its typed result.
The handler must resolve `source`, `trustProfile`, `job`, `brand`, and the
organization-scoped `products` itself. Do not accept those records or a
service-role key from a browser. Then call:

```js
const result = await createMiraObservationIntakeClient({
  supabaseUrl: process.env.SUPABASE_URL,
  serviceRoleKey: process.env.SUPABASE_SERVICE_ROLE_KEY,
}).ingest({
  organization_id,
  source_id,
  trust_profile_id,
  job_id,
  brand_id,
  idempotency_key: mission.id,
  request_fingerprint: mission.payloadFingerprint,
  observations: mission.candidates,
}, { source, trustProfile, job, brand, products });
```

The handler should persist the returned run id and response in the MIRA
mission debrief. A failed or blocked response is a reasoned handoff; it is not
permission to retry with a different source or to write Products directly.

## Policy gate

Automatic observation is accepted only when the source is active and has:

- `license_posture = allowed`;
- `robots_posture = allowed` or `not_applicable`;
- `rate_limit_posture = bounded`, `restricted`, or `not_applicable`;
- `credential_boundary` empty/`none`;
- metadata flags `automated_read_only_approved = true` and
  `internal_observation_allowed = true`.

The trust profile and job must be active, tenant-scoped, and explicitly allow
the candidate field family. The product identity must already exist in the
same organization and brand. Evidence URLs must be HTTPS; evidence payloads
reject credential-shaped keys and are bounded in size.

## Idempotency and bounds

The database intake uses `(organization_id, idempotency_key)` as its replay
key and stores the request fingerprint. Replaying the same fingerprint returns
the stored response; reusing the key with a different fingerprint is blocked.
Each request contains 1-100 observations. Values and evidence references are
bounded, and duplicate observations are handled by the existing observation
deduplication key.

## Migration / verification

Migration:

`supabase/migrations/20260812225153_mira_ean_observation_field_family.sql`

It adds the service-role-only intake table and RPC, extends the append RPC with
`ean_reference`, pins every security-definer search path to `public`, and
revokes default function/table access. Apply it only through the normal staged
Supabase migration process, then verify the function grants and that a test
response reports `catalog_products_written = 0` and `apply_performed = false`.
