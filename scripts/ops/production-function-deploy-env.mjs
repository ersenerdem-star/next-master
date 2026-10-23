export const PRODUCTION_SITE='08d7af8d-484c-4dba-a069-234e52dcfd6c';
export function isProductionFunctionDeploy(command){return command.includes('--prod')&&command[command.indexOf('--site')+1]===PRODUCTION_SITE;}
// CLI manual deploys can have deploy-preview metadata even when published.
// Pin only the non-secret production gates on that one production deploy;
// never expand their site-level scope to preview deployments.
export function productionFunctionDeployArguments(command,resolved){
 if(!isProductionFunctionDeploy(command))return [];
 if(resolved.SUPABASE_URL!=='https://zjgueqijumzlfioihnkt.supabase.co'||resolved.NM_PRODUCTION_TARGET!=='zjgueqijumzlfioihnkt'||resolved.NM_FULL_STAGING_TARGET)throw Error('PRODUCTION_FUNCTION_TARGET_MISMATCH');
 if(resolved.SUPPLIER_CATALOG_ENRICHMENT_ENABLED!=='1'||!resolved.SUPABASE_SERVICE_ROLE_KEY)throw Error('PRODUCTION_CATALOG_RUNTIME_DISABLED');
 if(command.some(v=>/^(NM_PRODUCTION_TARGET|SUPPLIER_CATALOG_ENRICHMENT_ENABLED)=/.test(v)))throw Error('PRODUCTION_FUNCTION_GATE_OVERRIDE_CONFLICT');
 return ['--env','NM_PRODUCTION_TARGET=zjgueqijumzlfioihnkt','--env','SUPPLIER_CATALOG_ENRICHMENT_ENABLED=1'];
}
