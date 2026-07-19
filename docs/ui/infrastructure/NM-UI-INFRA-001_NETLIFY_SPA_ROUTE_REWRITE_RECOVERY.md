# NM-UI-INFRA-001 Netlify SPA Route Rewrite Recovery

## Summary
Production deep links under the app shell were returning Netlify 404 responses even though the UI bundle already contained the `CatalogObservationReviewPage` route and the API endpoint existed.

## Root Cause
`netlify.toml` only provided SPA fallback coverage for:
- `/portal`
- `/portal/*`

There was no general app-shell fallback for routes such as:
- `/catalog/observation-review`
- `/catalog`
- `/dashboard`

As a result, Netlify served its own 404 page for direct navigation and refresh on those app routes.

## Implemented Rule Order
1. `/api/*` → `/.netlify/functions/:splat`
2. `/portal` → `/index.html`
3. `/portal/*` → `/index.html`
4. `/*` → `/index.html`

The general SPA fallback is last so API and direct static content remain unaffected.

## Exclusions Preserved
- `/api/*`
- `/.netlify/functions/*`
- `/version.json`
- `/assets/*`
- `/portal/*`
- existing static files

## Validation
- `node --test scripts/tests/*.test.mjs` passed
- `npm --workspace apps/web run build` passed
- `git diff --check` passed
- `npx netlify build --dry` passed
- Production `/version.json` matched the merged commit before the docs closeout step
- Production route `/catalog/observation-review` returned the app shell instead of Netlify 404
- Production `/api/catalog/observation-review` still returned auth-protected API behavior

## Production Proof
- Production commit: `429f513cad10a4daaa0c34b15a54f5f1cb9435f8`
- Deploy id: `6a5cb7d3c825b10008703c94`

## Evidence Paths
- `/Users/ersen/Developer/NextMaster/artifacts/wp2e2-routing-recovery-2026-07-19-1142/production-observation-review-loaded.png`
- `/Users/ersen/Developer/NextMaster/artifacts/wp2e2-routing-recovery-2026-07-19-1142/production-observation-review-detail.png`

## Rollback
If needed, remove the trailing `/* -> /index.html` fallback and redeploy the previous safe main commit.
