export type CatalogProductSourceRecord = {
  id: string;
  source_key: string;
  source_url: string;
  source_product_id: string | null;
  source_version: string | null;
  source_product_type: string | null;
  source_as_of: string | null;
  retrieved_at: string | null;
  payload_fingerprint: string;
};

export type CatalogProductIdentifier = {
  id: string;
  identifier_type: string;
  authority: string | null;
  value: string;
  source_record_id: string | null;
  created_at: string | null;
};

export type CatalogProductAttribute = {
  id: string;
  attribute_key: string;
  label: string;
  value_text: string | null;
  value_numeric: number | null;
  unit: string | null;
  ordinal: number;
  source_record_id: string | null;
};

export type CatalogProductRelationType =
  | "replacement"
  | "replaced_by"
  | "alternative"
  | "kit_component"
  | "recommended_tool"
  | "related";

export type CatalogProductRelation = {
  id: string;
  relation_type: CatalogProductRelationType;
  related_brand: string | null;
  related_product_code: string | null;
  related_oem_no: string | null;
  related_description: string | null;
  source_record_id: string | null;
  relation_fingerprint: string;
  created_at: string | null;
};

export type CatalogProductFitment = {
  id: string;
  fitment_type: "vehicle" | "engine";
  manufacturer: string | null;
  model_series: string | null;
  vehicle: string | null;
  model_year_from: string | null;
  model_year_to: string | null;
  engine_code: string | null;
  fuel_type: string | null;
  power_kw_min: number | null;
  power_kw_max: number | null;
  power_ps_min: number | null;
  power_ps_max: number | null;
  charging_type: string | null;
  cylinder_count: number | null;
  valve_count: number | null;
  bore_mm: number | null;
  stroke_mm: number | null;
  displacement_cc: number | null;
  compression_ratio: number | null;
  source_record_id: string | null;
  fitment_fingerprint: string;
};

export type CatalogProductDetails = {
  product_id: string;
  product_code: string | null;
  source_records: CatalogProductSourceRecord[];
  identifiers: CatalogProductIdentifier[];
  attributes: CatalogProductAttribute[];
  relations: CatalogProductRelation[];
  fitments: CatalogProductFitment[];
  counts: {
    source_records: number;
    identifiers: number;
    attributes: number;
    relations: number;
    vehicle_fitments: number;
    engine_fitments: number;
  };
};
