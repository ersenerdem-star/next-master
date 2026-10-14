export type SupplierUploadTargetConfig = {
  enabled?: string;
  productionEnabled?: string;
  productionTarget?: string;
  supabaseUrl?: string;
  portalOrigin?: string;
};

export function supplierVerifiedUploadTargetEnabled(config: SupplierUploadTargetConfig): boolean {
  if (config.enabled !== 'true') return false;
  if (config.supabaseUrl === 'https://kaxsqafdevabkxofwdod.supabase.co') {
    return config.portalOrigin === 'https://next-master-v3-staging-20261006.netlify.app'
      && !config.productionTarget && config.productionEnabled !== '1';
  }
  return config.supabaseUrl === 'https://zjgueqijumzlfioihnkt.supabase.co'
    && config.productionTarget === 'zjgueqijumzlfioihnkt'
    && config.productionEnabled === '1'
    && config.portalOrigin === 'https://portal.next-master.com';
}
