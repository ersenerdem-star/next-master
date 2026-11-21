export type AdminPriceListType = 'A' | 'B' | 'Manual';
export function parseManualMarginPercent(input: string): number | null;
export function isManualMargin(value: unknown): value is number;
export function adminPriceListFileLabel(priceListType: string, margin: number): string;
