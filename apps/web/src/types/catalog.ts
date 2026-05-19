import type { CatalogLifecycleStatus } from "../domain/shared/lifecycle";

export type CatalogRow = {
  total_count: number;
  product_id: string;
  product_code: string;
  brand: string;
  description: string;
  oem_no: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status: CatalogLifecycleStatus | null;
  lifecycle_note: string;
};
