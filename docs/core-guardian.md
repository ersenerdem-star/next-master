# Core Guardian

Core guardian, repo'nun merkez yapısını fail-closed korur.

## What It Protects

- `docs/core-architecture.md`
- `docs/module-boundaries.md`
- `docs/repo-hygiene-protocol.md`
- `docs/catalog-source-policy.md`
- `apps/web/src/modules/*`
- `netlify/functions/_shared/*`
- `scripts/*`

## Guardian Rules

1. Core surface files must stay inside their owned roots.
2. Presentation pages must remain compatibility wrappers only.
3. Catalog fetches must keep the mandatory technical shape.
4. Portal and warehouse helpers must remain scoped to their module trees.
5. Deploys are blocked if core docs or core directories are missing.
6. New catalog sources must preserve EAN, description, vehicle, vehicle model, lifecycle, and replacement metadata.
7. registry-backed TecAlliance brands must exist in `brands`; `npm run guardian:brands:apply`, `npm run predeploy:verify`, `npm run ship`, and the admin brand-list endpoint all seed missing rows automatically before users depend on them. Guardian reports must also surface brands that exist but still have zero `catalog_products` rows so empty brands stay visible in workflow checks.
8. Production shipping must treat local Netlify CLI link state as optional. `npm run ship` pushes `origin/main`, then runs `npm run deploy:status` logic through `scripts/ops/check-netlify-deploy-state.mjs`; if the local CLI is not linked, the workflow still classifies deployment as a Git-connected Netlify production deploy and checks the live site URL instead of surfacing a local setup blocker.
9. Staged Supabase migrations are part of the production ship command. If `supabase/migrations/*.sql` is staged, `npm run ship` runs `scripts/ops/apply-staged-supabase-migrations.mjs` before commit/push. If the live DB apply step fails or no DB connection value is available, shipping stops before frontend deployment.

## Enforcement

- `npm run audit:modules` checks module boundaries.
- `npm run audit:core` checks the guardian rules.
- `npm run guardian:brands` checks missing registry-backed brand rows.
- `npm run guardian:brands:apply` repairs missing registry-backed brand rows.
- `npm run predeploy:verify` must pass before production deploys.
- `npm run deploy:status` checks whether the latest pushed commit is visible on the Git-connected Netlify production site.
- `npm run db:migrate:staged` applies staged Supabase migration files to the live DB using `SUPABASE_DB_URL` or the configured Supabase project/password env values.

If the guardian fails, the repo is not considered core-safe.
