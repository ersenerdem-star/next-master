# NM-CATALOG-WP2-A Production Apply Record

## Production result

- Production DB gate: `READY_FOR_CONTROLLED_DEPLOY`
- Production-proven commit: `40399201ee037bcf7fe4b844c35acf7e78420017`
- Validation SHA-256: `07d0f2003b6fafef22541457e7c79e325598d4bef7c908c0b371f6b9410dc7eb`

## Applied change

- Applied migration path: `supabase/migrations/20260715_001_catalog_external_observation_pilot_foundation.sql`
- Applied manually through the atomic SQL Editor gate
- No Supabase CLI migration-history table exists in this package

## Safety notes

- No `catalog_products` mutation
- No Catalog Integrity backfill
- No API change
- No UI change
- No Netlify change
- No automatic DB deployment path was proven in repository configuration

## Deployment workflow audit

Inspected:

- `package.json`
- `scripts/ship-staged-to-production.mjs`
- `scripts/ops/apply-staged-supabase-migrations.mjs`
- `netlify.toml`
- `docs/core-guardian.md`

Result:

- Staged Supabase migrations are only applied by the explicit ship script path
- Netlify build config contains frontend build only
- No CI workflow file in this repository was present to auto-run Supabase migration commands on merge
- No automatic `supabase db push`, `supabase migration up`, or `supabase migration repair` execution was proven for `main` merge

## Future requirement

Migration-history normalization must be handled as a separate controlled project-wide work package.
