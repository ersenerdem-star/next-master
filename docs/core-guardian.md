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
7. registry-backed TecAlliance brands must exist in `brands`; use `npm run guardian:brands -- --apply` to seed missing rows before sync.

## Enforcement

- `npm run audit:modules` checks module boundaries.
- `npm run audit:core` checks the guardian rules.
- `npm run guardian:brands` checks and optionally repairs missing registry-backed brand rows.
- `npm run predeploy:verify` must pass before production deploys.

If the guardian fails, the repo is not considered core-safe.
