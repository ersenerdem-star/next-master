export type QuantityPriceTier = {
  minQuantity:number; unitPrice:number; orderMultiple?:number; availableQuantity?:number|null;
  validFrom?:string|null; validTo?:string|null;
};
export type QuantityQuote = QuantityPriceTier & {quantity:number;total:number};
export function resolveQuantityPrice(tiers:QuantityPriceTier[],requestedQuantity:number,options?:{date?:string}): {
  current:QuantityQuote|null; suggestion:(QuantityQuote & {extraUnits:number;savings:number})|null;
};
