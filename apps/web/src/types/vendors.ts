export type VendorKind = "Business" | "Individual";

export type LocalVendor = {
  id: string;
  vendor_type: VendorKind;
  salutation: string;
  first_name: string;
  last_name: string;
  company_name: string;
  display_name: string;
  email: string;
  vendor_number: string;
  work_phone: string;
  mobile_phone: string;
  language: string;
  tax_rate: string;
  company_id: string;
  currency: string;
  payment_terms: string;
  billing_address: string;
  shipping_address: string;
  contact_persons: string;
  custom_fields: string;
  reporting_tags: string;
  remarks: string;
  created_at: string;
  updated_at: string;
};
