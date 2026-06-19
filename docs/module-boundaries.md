# Admin, Portal, Warehouse Module Boundaries

This project has three runtime surfaces that must stay isolated.

## Admin

Admin is the internal control plane.

Allowed:
- Internal catalog search/import/export and brand sync controls.
- Sales, purchase, invoice, price-list, user, portal settings, and diagnostics.
- Warehouse API client administration.

Required:
- Supabase user token verification.
- Role check before service-role use.
- Sanitized error messages.

Forbidden:
- Returning portal data without portal/customer/vendor scope.
- Running long sync work automatically during ordinary admin page load.

## Portal

Portal is the customer/vendor self-service plane.

Allowed:
- Portal login/session, scoped catalog search, scoped price download, basket/order submit, order history.

Required:
- Invite/session verification.
- Rate limit.
- Organization and party isolation.
- Customer/vendor price-list rule enforcement.
- Soft fallback for optional expensive enrichment.

Forbidden:
- Admin role/session dependence.
- Unscoped catalog or supplier-price data.
- Blocking portal UX on full-brand sync or unrelated warehouse tasks.

## Warehouse

Warehouse is the stock execution and partner API plane.

Allowed:
- Scan center, stock movements, receiving, transfers, packing/loading, EAN/barcode aliases.
- Partner stock feed and order submit endpoints.

Required:
- Internal role scoping for UI/API calls.
- Partner API key, optional HMAC, IP allowlist, and warehouse assignment checks for external endpoints.
- No dependency on portal pricing for warehouse execution.

Forbidden:
- Customer portal session access.
- Admin-only user management except through admin configuration endpoints.

## Release Rule

Do not deploy broad admin, portal, and warehouse changes together unless:
- `npm run build` passes.
- `npm run audit:modules` reports no critical findings.
- `npm run stress:admin`, `npm run stress:portal`, and `npm run stress:warehouse` each complete without route failures for the touched surface.
- `npm run stress:admin-portal-warehouse -- --base-url=<target>` completes without route failures.
- The deploy note lists exactly which module changed.

## Frontend Ownership Rule

`apps/web/src/presentation/pages` is compatibility-only.

Allowed:
- Single-line re-export wrappers that point to module-owned pages.

Forbidden:
- Business logic, API calls, state management, or UI composition in presentation pages.
- New feature pages added directly under presentation.

## Workbench UI Rule

Admin, portal, and warehouse may share the same design system, but they must not share accidental page-level layout fixes.

Required:
- One shell/navigation contract for admin and warehouse workbench screens.
- Portal shell isolated from admin state and admin-only modules.
- Shared responsive primitives for cards, forms, grids, tables, and action bars.
- No table/list component may depend on a fixed viewport width.
- No page may solve layout by adding horizontal overflow to the whole app shell.

Responsive breakpoints:
- `>=1440`: full desktop workbench.
- `1280-1439`: compact desktop with same information hierarchy.
- `768-1279`: tablet shell; sidebar may collapse but state must stay mounted.
- `<768`: mobile shell with bottom nav/subnav and single-column panels.

## Language And RTL Rule

The i18n layer is a shared product module. Page-local translation maps are forbidden.

Required:
- `en`, `tr`, `de`, `fa`, and `ar` are supported from one dictionary/provider.
- `ar` and `fa` set `dir="rtl"` and use Arabic-capable fonts.
- Product codes, OEM numbers, EAN values, prices, and document numbers stay visually LTR inside RTL screens.
- CSS must use logical properties and `text-align: start/end`.
