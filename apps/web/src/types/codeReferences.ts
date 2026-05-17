export type CodeReferenceRow = {
  id: string;
  brand_id: string;
  brand: string;
  old_code: string;
  new_code: string;
  original_number: string | null;
  reason: string | null;
  is_active: boolean;
  created_at?: string | null;
  updated_at?: string | null;
};

export type CodeReferenceMatch = {
  id: string;
  brand_id: string;
  brand: string;
  old_code: string;
  new_code: string;
  original_number: string | null;
  reason: string | null;
};

export type CodeReferenceUsage = {
  code: string;
  matchesOldCode: Array<{
    id: string;
    old_code: string;
    new_code: string;
  }>;
  matchesNewCode: Array<{
    id: string;
    old_code: string;
    new_code: string;
  }>;
};
