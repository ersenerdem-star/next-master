create table if not exists email_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  template_key text not null,
  template_name text not null,
  subject text not null default '',
  body text not null default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, template_key)
);

create index if not exists idx_email_templates_org_key on email_templates (organization_id, template_key);

alter table email_templates enable row level security;

drop policy if exists email_templates_select_org on email_templates;
create policy email_templates_select_org on email_templates
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists email_templates_write_admin on email_templates;
create policy email_templates_write_admin on email_templates
for all
using (
  is_admin()
  and organization_id = current_profile_org_id()
)
with check (
  is_admin()
  and organization_id = current_profile_org_id()
);

create table if not exists outbound_emails (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  template_key text not null,
  recipient_type text not null check (recipient_type in ('customer', 'vendor', 'internal')),
  recipient_name text not null default '',
  recipient_email text not null default '',
  subject text not null default '',
  body text not null default '',
  related_type text not null default '',
  related_id text not null default '',
  status text not null default 'queued' check (status in ('draft', 'queued', 'sent', 'failed')),
  sent_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, template_key, related_type, related_id, recipient_email)
);

create index if not exists idx_outbound_emails_org_updated on outbound_emails (organization_id, updated_at desc);
create index if not exists idx_outbound_emails_org_status on outbound_emails (organization_id, status);

alter table outbound_emails enable row level security;

drop policy if exists outbound_emails_select_org on outbound_emails;
create policy outbound_emails_select_org on outbound_emails
for select
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);

drop policy if exists outbound_emails_write_org on outbound_emails;
create policy outbound_emails_write_org on outbound_emails
for all
using (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
)
with check (
  current_profile_role() in ('admin', 'sales')
  and organization_id = current_profile_org_id()
);
