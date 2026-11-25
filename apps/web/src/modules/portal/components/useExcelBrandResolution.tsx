import { useEffect, useRef, useState } from 'react';
import { fetchPortalSnapshot } from '../../../infrastructure/api/portalAccessApi';
import type { PortalOrderInputRow } from '../../../infrastructure/api/portalOrderApi';
import type { PortalCredentials } from '../../../types/portalSession';
import { applyExcelBrandChoices, planExcelBrandResolution, type BrandChoice } from '../excelBrandResolution';

type Pending = { rows: PortalOrderInputRow[]; choices: BrandChoice[]; finish: (value: PortalOrderInputRow[] | null) => void };

export function useExcelBrandResolution(credentials: PortalCredentials, inviteId: string, customerId: string, language: string) {
  const [pending, setPending] = useState<Pending | null>(null);
  const [selected, setSelected] = useState<Record<number, string>>({});
  const pendingRef = useRef<Pending | null>(null);
  const dialogRef = useRef<HTMLElement | null>(null);
  const scope = `${inviteId}:${customerId}`;
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const tr = language === 'tr';
  function close(value: PortalOrderInputRow[] | null) {
    const current = pendingRef.current;
    pendingRef.current = null;
    setPending(null);
    setSelected({});
    current?.finish(value);
  }
  useEffect(() => () => { pendingRef.current?.finish(null); pendingRef.current = null; setPending(null); }, [scope]);
  useEffect(() => { if (pending) dialogRef.current?.focus(); }, [pending]);

  async function resolve(rows: PortalOrderInputRow[]): Promise<PortalOrderInputRow[] | null> {
    if (!inviteId || !customerId) throw new Error('Portal session is unavailable.');
    const { snapshot } = await fetchPortalSnapshot(credentials);
    if (snapshot.invite.id !== inviteId || snapshot.customer?.id !== customerId || scopeRef.current !== scope) throw new Error('Your portal account changed. Reload the page and try again.');
    const initialBrands = [...snapshot.availableBrands].sort();
    const plan = planExcelBrandResolution(rows, initialBrands);
    if (!plan.choices.length) return plan.resolved;
    if (pendingRef.current) throw new Error('A brand selection is already open.');
    const result = await new Promise<PortalOrderInputRow[] | null>((finish) => {
      const next = { rows: plan.resolved, choices: plan.choices, finish };
      pendingRef.current = next;
      setSelected({});
      setPending(next);
    });
    if (!result) return null;
    // Do not use choices from an expired session or changed brand scope.
    const { snapshot: latest } = await fetchPortalSnapshot(credentials);
    if (latest.invite.id !== inviteId || latest.customer?.id !== customerId || scopeRef.current !== scope || JSON.stringify([...latest.availableBrands].sort()) !== JSON.stringify(initialBrands)) {
      throw new Error('Your portal account or available brands changed. Re-upload the file.');
    }
    return result;
  }

  const groups = pending ? [...pending.choices.reduce((map, issue) => {
    const groupKey = JSON.stringify([issue.entered.trim().toLowerCase(), issue.options]);
    const items = map.get(groupKey) || [];
    items.push(issue);
    map.set(groupKey, items);
    return map;
  }, new Map<string, BrandChoice[]>()).values()].filter((items) => items.length > 1 && items[0].options.length) : [];
  const dialog = pending ? <div className="portal-brand-choice-backdrop" role="presentation">
    <section ref={dialogRef} tabIndex={-1} onKeyDown={(event) => { if (event.key === 'Escape') close(null); }} className="portal-brand-choice" role="dialog" aria-modal="true" aria-labelledby="portal-brand-choice-title">
      <h2 id="portal-brand-choice-title">{tr ? 'Markayı seçin' : 'Choose a brand'}</h2>
      <p>{tr ? 'Dosyanızdaki aşağıdaki satırlarda marka net değil. Her parça için doğru markayı seçin; fiyatlar seçiminizden sonra sorgulanır.' : 'Choose the correct brand for each row before prices are checked.'}</p>
      {groups.map((items, groupIndex) => <label key={groupIndex} className="portal-brand-choice__bulk">
        <span>{items[0].entered || '—'} · {items.length} {tr ? 'satıra aynı seçimi uygula' : 'rows: apply one choice'}</span>
        <select aria-label={`${items[0].entered || '—'} ${tr ? 'toplu marka seçimi' : 'bulk brand choice'}`} defaultValue="" onChange={(event) => {
          const value = event.target.value;
          if (value) setSelected((previous) => ({ ...previous, ...Object.fromEntries(items.map((item) => [item.index, value])) }));
          event.target.value = '';
        }}><option value="">{tr ? 'Marka seçin' : 'Choose brand'}</option>{items[0].options.map((option) => <option value={option} key={option}>{option}</option>)}</select>
      </label>)}
      <div className="portal-brand-choice__rows">{pending.choices.map((item) => <label key={item.index}>
        <span><strong>{item.code}</strong> · {tr ? 'Dosyadaki marka' : 'Brand in file'}: {item.entered || '—'}</span>
        {item.options.length ? <select aria-label={`${item.code} ${tr ? 'marka seçimi' : 'brand selection'}`} value={selected[item.index] || ''} onChange={(event) => setSelected((previous) => ({ ...previous, [item.index]: event.target.value }))}>
          <option value="">{tr ? 'Marka seçin' : 'Choose brand'}</option>
          {item.options.map((option) => <option value={option} key={option}>{option}</option>)}
        </select> : <span role="alert">{tr ? 'Bu marka bulunamadı veya hesabınızın yetkisi yok. Dosyadaki markayı kontrol edin.' : 'Brand unavailable or not permitted. Check the file.'}</span>}
      </label>)}</div>
      <div className="portal-brand-choice__actions"><button type="button" onClick={() => close(null)}>{tr ? 'İptal' : 'Cancel'}</button><button type="button" disabled={pending.choices.some((item) => !selected[item.index])} onClick={() => close(applyExcelBrandChoices(pending.rows, pending.choices, selected))}>{tr ? 'Seçimleri uygula' : 'Apply choices'}</button></div>
    </section>
  </div> : null;
  return { resolve, dialog };
}
