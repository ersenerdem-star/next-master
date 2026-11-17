import type {Config} from '@netlify/functions';
import worker from './catalog-brand-worker-background.mts';

// A distinct endpoint keeps a preview invocation tied to its own worker and
// allows already-running calls to the previous endpoint to finish unchanged.
export default worker;
export const config:Config={path:'/api/catalog-brand-worker-v2-background',method:'POST',background:true};
