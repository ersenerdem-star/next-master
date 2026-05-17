export type QuoteSupplierOption = {
  supplier_id?: string | null;
  supplier_name: string;
  buy_price: number | null;
  price_date: string | null;
  sell_price: number | null;
  notes: string | null;
};

export type QuoteResolveResult = {
  found: boolean;
  product_id?: string | null;
  product_code: string;
  brand: string | null;
  description: string | null;
  oem_no: string | null;
  hs_code: string | null;
  origin: string | null;
  weight_kg: number | null;
  supplier_id?: string | null;
  supplier_name: string | null;
  buy_price: number | null;
  price_date: string | null;
  sell_price: number | null;
  notes: string | null;
};

export type QuoteBuilderLine = {
  lineId: string;
  requestedCode: string;
  resolvedCode: string;
  brand: string;
  description: string;
  qty: number;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  supplier_name: string;
  buy_price: number | null;
  sell_price: number | null;
  c_sell_price: number | null;
  price_date: string;
  notes: string;
  found: boolean;
  codeChanged: boolean;
  codeChangeWarning: string;
  supplierOptions: QuoteSupplierOption[];
  selectedSupplierKey: string;
};
