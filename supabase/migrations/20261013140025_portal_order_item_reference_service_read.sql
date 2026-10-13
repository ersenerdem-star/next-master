-- Portal order preparation resolves old/new codes through item_code_references.
-- The Netlify function uses the service role and must be able to read this
-- tenant-scoped table; RLS remains enabled for client roles.
grant select on public.item_code_references to service_role;
