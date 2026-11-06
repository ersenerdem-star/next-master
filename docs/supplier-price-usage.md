# Supplier price participation

Supplier management has a separate `price_usage_enabled` switch. Disabling it excludes both published and legacy commercial price sources before ranking, pagination, best/second price selection and current exports. Publication ownership stays intact, so disabled published sources cannot fall back to legacy prices.

The switch never changes source price rows, publications, sales orders, purchase orders, invoices or payments. Historical supplier-specific management exports stay available. The default management filter hides disabled suppliers; “Show disabled suppliers” restores them for inspection or reactivation.

The authenticated mutation RPC verifies active admin/superadmin access, organization, expected previous state and an audit reason. Its security definer privilege is intentional and is not granted to anonymous callers. The confirmation RPC is read-only, checks customer access, and compares financial line signatures to evidence captured when the supplier was disabled. It permits unchanged saved lines after notes-only edits, but blocks new orders, appended lines and commercial edits from reusing old disabled prices.

Audit and captured evidence tables live in an unexposed private schema. Application roles have no schema/table access and no direct execution on internal helpers. RLS with no policies is intentional on those private tables.

Changing participation takes the publication lock, captures old commercial lines, rebuilds only affected rollup keys and increments brand source revisions in one transaction. A bounded lateral price lookup plus hash/merge joins prevents supplier-first or ranked-CTE quadratic scans. Prepared current price exports are invalidated by the source revision. Rollback restores the whole switch if any step fails.

The initial GNK transition closed GNK-Diesel, GNK-Mechanik and GNK-Pump to current pricing while leaving GNK open. All 145 existing sales orders, 61 purchase orders and 44,164 old source price rows had identical fingerprints before and after the transition.

Tests: `supplier-price-usage-sql.test.mjs`, `supplier-price-usage-historical-confirmation.test.mjs`, `supplier-price-usage-confirmation-policy.test.mts`, `supplier-price-usage-direct-readers.test.mts`, `supplier-price-usage-endpoint.test.mts`.
