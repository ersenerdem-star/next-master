export type PortalReloadState = {
  customer: boolean; online: boolean; restoring: boolean; home: boolean; selected: boolean;
  draftLines: number; draftId: string; cachedDraft: boolean; busy: boolean; feedback: boolean;
};

export function portalMayAutoReload(state: PortalReloadState) {
  return state.customer && state.online && !state.restoring && state.home && !state.selected
    && state.draftLines === 0 && !state.draftId && !state.cachedDraft && !state.busy && !state.feedback;
}

export function portalIdleForReload(now: number, lastInteraction: number, editableFocused: boolean) {
  return !editableFocused && now - lastInteraction >= 15_000;
}

export async function runGuardedPortalReload(clearCaches: () => Promise<void>, stillSafe: () => boolean, reload: () => void) {
  await clearCaches();
  if (!stillSafe()) return false;
  reload();
  return true;
}
