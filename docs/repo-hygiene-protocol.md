# Repo Hygiene Protocol

This protocol exists to prevent local/generated work from silently replacing or hiding product source.

## Product Source Of Truth

- `apps/web/src`: React application source.
- `netlify/functions`: public/server API source.
- `supabase/migrations`: database source.
- `scripts`: repeatable operational scripts only.
- `docs`: architecture, policy, and handoff notes only.

Generated CSV, JSON, capture folders, review bundles, platform experiments, and stress-test reports are local artefacts. They must not be treated as product source unless they are deliberately promoted and committed.

## Clean Worktree Rule

Before any production deploy:

```bash
npm run predeploy:verify
git status --short
```

The deploy is blocked when:

- `apps/web/src`, `netlify/functions`, `supabase/migrations`, or `scripts` contains untracked source.
- A generated artefact is visible to git instead of ignored.
- Secret-surface scan finds a credential-like value.
- The frontend build fails.

## Generated Artefact Rule

Timestamped outputs belong to ignored local paths:

- `docs/security/*.json`
- `docs/performance/*.json`
- `docs/**/*-summary-*.json`
- `docs/**/*-errors-*.csv`
- `docs/**/*-changes-*.csv`
- `docs/**/*-catalog-20*.csv`
- `docs/**/captures/`
- `review-package/`

If a generated result matters long term, summarize it in a tracked Markdown doc instead of committing the raw batch output.

## Workbench Boundary Rule

Admin, portal, and warehouse must not share page state or layout hacks.

- Admin owns internal operations, catalog, pricing, sales, purchase, settings, and diagnostics.
- Portal owns external customer/vendor self-service and must stay scoped to invite/session.
- Warehouse owns scan, movement, packing, and stock execution.
- Shared UI belongs in reusable components, not copied page CSS.

## Frontend Redesign Rule

All workbench redesign work must use one shell system:

- One responsive shell.
- One navigation contract.
- One table/card density system.
- One i18n provider.
- One RTL stylesheet layer.

Page-specific fixes are allowed only when they do not break the shell contract.

## RTL Rule

Arabic and Persian are first-class layouts, not post-fix translations.

- Use logical CSS properties: `padding-inline`, `margin-inline`, `inset-inline`.
- Use `text-align: start/end`, not hard-coded left/right.
- Use Arabic-capable fonts for `html[lang="ar"]` and `html[lang="fa"]`.
- Disable letter-spacing and uppercase transforms for Arabic/Persian UI labels.
- Wrap product codes, invoice numbers, OEM numbers, EAN, and prices with LTR isolation when shown inside RTL text.

## Mobile/Platform Rule

Root-level `android/`, `ios/`, and `capacitor.config.ts` are local platform experiments until promoted. If mobile becomes product source, it must move under an explicit owned app folder such as `apps/mobile` and be committed intentionally.
