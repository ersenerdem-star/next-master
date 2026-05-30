import type { CatalogLifecycleStatus } from "../domain/shared/lifecycle";

export type CatalogRow = {
  total_count: number;
  product_id: string;
  product_code: string;
  brand: string;
  image_url?: string;
  description: string;
  oem_no: string;
  vehicle: string;
  hs_code: string;
  origin: string;
  weight_kg: number | null;
  lifecycle_status: CatalogLifecycleStatus | null;
  lifecycle_note: string;
  replacement_old_code?: string | null;
  replacement_code?: string | null;
  replacement_reason?: string | null;
  replacement_warning?: string | null;
};
