export type CatalogZfStagingReviewJsonValue =
  | string
  | number
  | boolean
  | null
  | CatalogZfStagingReviewJsonValue[]
  | { [key: string]: CatalogZfStagingReviewJsonValue };

export type CatalogZfStagingReviewItem = {
  id: string;
  organization_id: string;
  brand_id: string;
  brand: string;
  proposed_display_code: string;
  normalized_code: string;
  official_source_display_code: string;
  official_comparison_key: string;
  description: string | null;
  ean: string | null;
  hs_code: string | null;
  origin: string | null;
  weight_kg: number | null;
  oem_references: string[];
  vehicle_applications: CatalogZfStagingReviewJsonValue[];
  fitment_facts: string[];
  engine_facts: string[];
  lifecycle_status: string;
  lifecycle_note: string | null;
  replacement_candidates: CatalogZfStagingReviewJsonValue[];
  supersession_candidates: CatalogZfStagingReviewJsonValue[];
  official_image_candidate_url: string | null;
  official_image_evidence_reference: string | null;
  official_source_url: string | null;
  observed_at: string | null;
  evidence_hash: string;
  payload_fingerprint: string;
  observation_fingerprint: string;
  candidate_version: number;
  supersedes_candidate_id: string | null;
  quarantine_class: string | null;
  limitation_flags: string[];
  source_schema_version: string;
  runtime_commit: string | null;
  deploy_id: string | null;
  created_at: string;
  latest_event_type: string | null;
  latest_event_version: number | null;
  latest_event_reason_code: string | null;
  latest_event_at: string | null;
  run_id: string;
  job_id: string;
  source_id: string;
  contract_version: string;
};

export type CatalogZfStagingReviewPage = {
  limit: number;
  cursor: string | null;
  next_cursor: string | null;
  has_more: boolean;
  returned_count: number;
};

export type CatalogZfStagingReviewResponse = {
  schema_version: string;
  organization_id: string;
  items: CatalogZfStagingReviewItem[];
  page: CatalogZfStagingReviewPage;
};

export type CatalogZfStagingReviewFilters = {
  candidateId?: string;
  runId?: string;
  brand?: string;
  latestEventType?: string;
  quarantine?: "all" | "eligible" | "quarantined";
  cursor?: string;
  limit?: number;
  signal?: AbortSignal;
};
