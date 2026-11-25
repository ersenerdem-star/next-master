import type { PortalPreparedLine } from '../../infrastructure/api/portalOrderApi';

function identity(line: PortalPreparedLine) {
  return JSON.stringify([
    // Compact search keys are not proof that punctuation identifies the same
    // product. Match the backend's conservative exact SKU rule for all brands.
    String(line.requestedCode || line.resolvedCode || '').trim().toUpperCase().replace(/\s+/g,''),
    String(line.brand || '').toLowerCase(),
    String(line.market_segment || '').toLowerCase(),
  ]);
}

export function mergePortalPreparedLines(current: PortalPreparedLine[], next: PortalPreparedLine[]) {
  const merged = current.map(line => ({...line}));
  const firstByKey = new Map<string, number>();
  merged.forEach((line, index) => { const key=identity(line); if (!firstByKey.has(key)) firstByKey.set(key,index); });
  for (const line of next) {
    const key=identity(line), index=firstByKey.get(key);
    if (index !== undefined) merged[index] = {...merged[index], qty: merged[index].qty + line.qty, quantity_suggestion: undefined};
    else { firstByKey.set(key,merged.length); merged.push({...line}); }
  }
  return merged;
}
