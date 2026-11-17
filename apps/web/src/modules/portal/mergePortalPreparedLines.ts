import { normalizePartCode } from '../../domain/shared/normalize';
import type { PortalPreparedLine } from '../../infrastructure/api/portalOrderApi';

function identity(line: PortalPreparedLine) {
  return JSON.stringify([
    normalizePartCode(String(line.requestedCode || line.resolvedCode || '')),
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
    if (index !== undefined) merged[index] = {...merged[index], qty: merged[index].qty + line.qty};
    else { firstByKey.set(key,merged.length); merged.push({...line}); }
  }
  return merged;
}
