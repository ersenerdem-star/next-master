import test from "node:test";
import assert from "node:assert/strict";
import { portalIdleForReload, portalMayAutoReload, runGuardedPortalReload } from "../../apps/web/src/app/portalAutoReload.ts";

const safe = { customer:true, online:true, restoring:false, home:true, selected:false, draftLines:0, draftId:"", cachedDraft:false, busy:false, feedback:false };

test("automatic refresh requires a safe empty customer home screen", () => {
  assert.equal(portalMayAutoReload(safe), true);
  for (const change of [{customer:false},{online:false},{restoring:true},{home:false},{selected:true},{draftLines:1},{draftId:"draft"},{cachedDraft:true},{busy:true},{feedback:true}]) {
    assert.equal(portalMayAutoReload({...safe,...change}), false, JSON.stringify(change));
  }
});

test("a newly started operation prevents a reload even during cache cleanup", async () => {
  let finish!: () => void, safeNow = true, reloaded = false;
  const pending = runGuardedPortalReload(() => new Promise<void>(resolve => { finish = resolve; }), () => safeNow, () => { reloaded = true; });
  safeNow = false; finish();
  assert.equal(await pending, false);
  assert.equal(reloaded, false);
  assert.equal(await runGuardedPortalReload(async () => {}, () => true, () => { reloaded = true; }), true);
  assert.equal(reloaded, true);
});

test("typing or recent interaction delays an automatic refresh", () => {
  assert.equal(portalIdleForReload(14_999,0,false), false);
  assert.equal(portalIdleForReload(15_000,0,true), false);
  assert.equal(portalIdleForReload(15_000,0,false), true);
  assert.equal(portalIdleForReload(16_000,10_000,false), false);
});
