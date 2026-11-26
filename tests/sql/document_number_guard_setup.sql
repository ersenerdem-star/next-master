create role anon nologin;
create role authenticated nologin;
create role service_role nologin;
create table public.sales_orders (id text primary key, organization_id uuid not null, sales_order_no text not null, status text not null default 'draft', notes text not null default '');
create table public.invoices (id text primary key, organization_id uuid not null, status text not null default 'draft', notes text not null default '');
create function public.current_profile_org_id() returns uuid language sql stable as $$ select current_setting('test.org', true)::uuid $$;
create function public.current_profile_role() returns text language sql stable as $$ select current_setting('test.role', true) $$;
create function public.is_superadmin() returns boolean language sql stable as $$ select false $$;
-- Mimic the existing public RPC's insert-on-conflict behavior for the guard.
create function public.save_invoice_atomic(payload jsonb, previous_id text default null)
returns jsonb language plpgsql security definer set search_path=public as $$
declare v_id text := trim(payload->>'id'); v_org uuid := public.current_profile_org_id(); v_row public.invoices%rowtype;
begin
 if previous_id is not null and previous_id <> v_id then delete from public.invoices where id=previous_id and organization_id=v_org; end if;
 insert into public.invoices(id,organization_id,status,notes) values(v_id,v_org,coalesce(payload->>'status','draft'),coalesce(payload->>'notes',''))
 on conflict(id) do update set status=excluded.status,notes=excluded.notes where public.invoices.organization_id=v_org returning * into v_row;
 return to_jsonb(v_row);
end;
$$;
insert into public.sales_orders(id,organization_id,sales_order_no,status) values
 ('old-a','00000000-0000-0000-0000-000000000001','SO-OLD','draft'),
 ('old-b','00000000-0000-0000-0000-000000000001',' so-old ','draft'),
 ('foreign','00000000-0000-0000-0000-000000000002','SO-OTHER','draft');
insert into public.invoices(id,organization_id,status) values
 ('INV-OLD','00000000-0000-0000-0000-000000000001','draft'),
 ('inv-old','00000000-0000-0000-0000-000000000001','draft'),
 ('FOREIGN-INV','00000000-0000-0000-0000-000000000002','draft');
