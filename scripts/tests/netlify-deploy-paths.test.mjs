import {test} from 'node:test';import assert from 'node:assert/strict';
import {absoluteNetlifyDeployPaths} from '../ops/netlify-deploy-paths.mjs';
test('explicit production artifact paths remain rooted in the caller repository across workspace-base changes',()=>{
 assert.deepEqual(absoluteNetlifyDeployPaths(['netlify','deploy','--prod','--dir','apps/web/dist','--functions','netlify/functions','--no-build'],'/repo'),['netlify','deploy','--prod','--dir','/repo/apps/web/dist','--functions','/repo/netlify/functions','--no-build']);
 assert.deepEqual(absoluteNetlifyDeployPaths(['netlify','deploy','--dir=/repo/dist','--functions=netlify/functions'],'/repo'),['netlify','deploy','--dir=/repo/dist','--functions=/repo/netlify/functions']);
 assert.deepEqual(absoluteNetlifyDeployPaths(['netlify','status'],'/repo'),['netlify','status']);
});
