export type QuantityCurveRow = {code:string;minimum_quantity:number;unit_buy_price:number|string};
export function isWahlerBrand(brand:unknown): boolean;
export function quantityTierLabels(rows:QuantityCurveRow[], marginPercent?:number|null): Map<string,string>;
