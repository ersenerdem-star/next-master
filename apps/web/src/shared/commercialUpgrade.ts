// Deployment capability, not actor authorization. Default closed because the
// legacy commercial contract is present on staging but absent on production.
// Enable only after target schema fingerprints and business acceptance pass.
export function commercialUpgradeEnabled() {
  return import.meta.env?.VITE_COMMERCIAL_DOCUMENT_UPGRADE_ENABLED === "true";
}
