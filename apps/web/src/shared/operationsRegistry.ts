/**
 * Canonical static registry for known Next-Master operations.
 * See docs/runtime/platform/OPERATIONS_REGISTRY_ASSESSMENT.md
 * and docs/runtime/platform/OPERATIONS_ENGINE_BLUEPRINT.md.
 */

export type OperationRegistryEntry = {
  operation_type: string;
  domain: string;
  display_key: string;
  description_key: string;
  supports_retry: boolean;
  supports_cancel: boolean;
  readiness_rule: "import" | "operations" | "reporting" | "pricing";
  owner: string;
};

export const OPERATIONS_REGISTRY = [
  {
    operation_type: "supplier_import",
    domain: "Supplier",
    display_key: "operations.supplierImport.display",
    description_key: "operations.supplierImport.description",
    supports_retry: true,
    supports_cancel: false,
    readiness_rule: "import",
    owner: "Supplier",
  },
  {
    operation_type: "supplier_catalog_sync",
    domain: "Supplier",
    display_key: "operations.supplierCatalogSync.display",
    description_key: "operations.supplierCatalogSync.description",
    supports_retry: true,
    supports_cancel: false,
    readiness_rule: "operations",
    owner: "Supplier",
  },
  {
    operation_type: "supplier_rollup_refresh",
    domain: "Reporting",
    display_key: "operations.supplierRollupRefresh.display",
    description_key: "operations.supplierRollupRefresh.description",
    supports_retry: true,
    supports_cancel: false,
    readiness_rule: "operations",
    owner: "Reporting",
  },
  {
    operation_type: "catalog_import",
    domain: "Catalog",
    display_key: "operations.catalogImport.display",
    description_key: "operations.catalogImport.description",
    supports_retry: true,
    supports_cancel: true,
    readiness_rule: "import",
    owner: "Catalog",
  },
  {
    operation_type: "reporting_refresh",
    domain: "Reporting",
    display_key: "operations.reportingRefresh.display",
    description_key: "operations.reportingRefresh.description",
    supports_retry: true,
    supports_cancel: false,
    readiness_rule: "reporting",
    owner: "Reporting",
  },
  {
    operation_type: "customer_price_replace",
    domain: "Pricing",
    display_key: "operations.customerPriceReplace.display",
    description_key: "operations.customerPriceReplace.description",
    supports_retry: true,
    supports_cancel: true,
    readiness_rule: "pricing",
    owner: "Pricing",
  },
] as const satisfies readonly OperationRegistryEntry[];

export function getOperationDefinition(operationType: string) {
  return OPERATIONS_REGISTRY.find((entry) => entry.operation_type === operationType) || null;
}

export function isRegisteredOperation(operationType: string) {
  return Boolean(getOperationDefinition(operationType));
}
