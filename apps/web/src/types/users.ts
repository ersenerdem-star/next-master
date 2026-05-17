export type OrgUser = {
  user_id: string;
  email: string;
  full_name: string | null;
  role: string;
  is_active: boolean;
  created_at: string | null;
  last_login_at: string | null;
  last_seen_at: string | null;
  quote_count: number | null;
  last_quote_at: string | null;
};
