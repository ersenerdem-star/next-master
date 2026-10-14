const STAGING_REF = 'kaxsqafdevabkxofwdod';
const PRODUCTION_REF = 'zjgueqijumzlfioihnkt';
const STAGING_PORTAL = 'https://next-master-v3-staging-20261006.netlify.app';
const PRODUCTION_PORTAL = 'https://portal.next-master.com';

export function supplierVerifiedUploadTargetEnabled(
  requestUrl: string,
  read: (name: string) => string | undefined = name => Netlify.env.get(name),
): boolean {
  if (read('SUPPLIER_PRICE_UPLOAD_VERIFIED_ADMISSION_ENABLED') !== 'true') return false;
  const url = read('SUPABASE_URL');
  let origin: string;
  try { origin = new URL(requestUrl).origin; } catch { return false; }
  if (url === `https://${STAGING_REF}.supabase.co`) {
    return origin === STAGING_PORTAL && !read('NM_PRODUCTION_TARGET')
      && read('SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED') !== '1';
  }
  return url === `https://${PRODUCTION_REF}.supabase.co`
    && read('NM_PRODUCTION_TARGET') === PRODUCTION_REF
    && !read('NM_FULL_STAGING_TARGET')
    && read('SUPPLIER_PRICE_UPLOAD_PRODUCTION_ENABLED') === '1'
    && origin === PRODUCTION_PORTAL;
}

export const supplierUploadTargetPauseMessage = 'Verified supplier upload is not enabled for this environment.';
