# Admin Module

Internal control-plane features only.


`workspaceNavigation.ts` resolves existing authorized page/tab destinations for
both the shell and dashboard. Supplier release review and row issues belong to
Purchasing / Supplier Prices. Reports / Status Center owns operation health and
links to that workspace instead of duplicating publication controls.

Commercial schema differences and release gates are recorded in
`docs/runtime/platform/OPERATIONS_ENGINE_ASSESSMENT.md` and
`scripts/ops/legacy-ui-integration/manifest.json`.
