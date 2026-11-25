import type { PortalOrderInputRow } from '../../infrastructure/api/portalOrderApi';

// These aliases express names, not interchangeable products or price lists.
// Multiple actual brand records always require an explicit, per-row choice.
const aliases: Record<string, string[]> = {
  vdo: ['VDO', 'VDO/Continental'],
  mercedes: ['Mercedes', 'Mercedes-Benz'],
  knorr: ['Knorr', 'Knorr-Bremse'],
  reinz: ['Reinz', 'Victor Reinz'],
  'nüral': ['NÜRAL', 'Nural'],
  ks: ['KS', 'Kolbenschmidt'],
  beru: ['Beru', 'BorgWarner (BERU)'],
  kkk: ['KKK', 'BorgWarner (KKK)'],
  schwitzer: ['Schwitzer', 'BorgWarner (Schwitzer)'],
  continental: ['Continental', 'Continental CTAM', 'Continental Tires', 'Contitech', 'ContiTech Air Spring', 'VDO/Continental'],
  conti: ['Continental', 'Continental CTAM', 'Continental Tires', 'Contitech', 'ContiTech Air Spring', 'VDO/Continental'],
  trw: ['TRW', 'TRW Engine Components'],
  schaeffler: ['LUK', 'INA', 'FAG'],
};

const key = (value: string) => value.trim().toLocaleLowerCase('en-US');
const inherentlyAmbiguous = new Set(['beru', 'kkk', 'schwitzer', 'continental', 'conti', 'trw', 'schaeffler']);
export type BrandChoice = { index: number; code: string; entered: string; options: string[] };

export function planExcelBrandResolution(rows: PortalOrderInputRow[], permittedBrands: string[]) {
  const byName = new Map<string, string[]>();
  for (const brand of permittedBrands) {
    const name = brand.trim();
    if (!name) continue;
    const names = byName.get(key(name)) || [];
    names.push(name);
    byName.set(key(name), names);
  }
  const choices: BrandChoice[] = [];
  const resolved = rows.map((row, index) => {
    const entered = String(row.brand || '').trim();
    let options = [...new Set((aliases[key(entered)] || [entered]).flatMap((name) => byName.get(key(name)) || []))];
    const unknown = options.length === 0;
    if (unknown) options = [...new Set(permittedBrands.map((name) => name.trim()).filter(Boolean))];
    // Duplicate canonical names cannot safely identify a unique brand UUID.
    if (!unknown && options.some((name) => (byName.get(key(name)) || []).length > 1)) {
      throw new Error('Duplicate brand names require administrator review.');
    }
    if (!unknown && options.length === 1 && !inherentlyAmbiguous.has(key(entered))) return { ...row, brand: options[0], source_brand: entered, brand_choice_confirmed: false };
    choices.push({ index, code: row.code, entered, options });
    return { ...row, source_brand: entered, brand_choice_confirmed: false };
  });
  return { resolved, choices };
}

export function applyExcelBrandChoices(rows: PortalOrderInputRow[], issues: BrandChoice[], selected: Record<number, string>) {
  const result = rows.map((row) => ({ ...row }));
  for (const issue of issues) {
    const choice = selected[issue.index];
    if (!choice || !issue.options.includes(choice)) throw new Error('Choose a brand for every row.');
    result[issue.index] = { ...result[issue.index], brand: choice, brand_choice_confirmed: true };
  }
  return result;
}
