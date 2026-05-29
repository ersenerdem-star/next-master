export type Warehouse = {
  id: string;
  warehouse_code: string;
  warehouse_name: string;
  region: string;
  address: string;
  warehouse_kind: "internal" | "outsourced";
  fulfillment_model: "stocked" | "dropship";
  outsource_partner_name: string;
  external_sync_enabled: boolean;
  external_api_provider: string;
  external_api_url: string;
  external_location_code: string;
  external_auth_type: "none" | "bearer_env";
  external_api_token_env: string;
  external_last_sync_at: string;
  external_last_sync_status: string;
  external_last_sync_message: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type WarehouseApiClient = {
  id: string;
  client_name: string;
  partner_name: string;
  status: "active" | "disabled";
  allowed_ip_list: string;
  require_hmac: boolean;
  allow_order_submit: boolean;
  include_zero_stock: boolean;
  expose_unit_cost: boolean;
  notes: string;
  expires_at: string;
  api_key_prefix: string;
  last_used_at: string;
  last_used_ip: string;
  warehouse_ids: string[];
  warehouse_labels: string[];
  created_at: string;
  updated_at: string;
};

export type WarehouseApiClientSecret = {
  api_key: string;
  api_base_url: string;
  header_name: string;
  sample_url: string;
};
