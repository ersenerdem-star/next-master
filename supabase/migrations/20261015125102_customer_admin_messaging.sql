-- Portal identities use signed invite cookies, not Supabase Auth JWTs.
-- Only the authenticated application gateways may access this store.
create table public.customer_messages (
  id uuid primary key,
  organization_id uuid not null,
  customer_id uuid not null references public.customers(id) on delete restrict,
  sender_kind text not null check (sender_kind in ('admin','customer')),
  sender_id uuid not null,
  sender_name text not null check (char_length(sender_name) between 1 and 180),
  body text not null check (char_length(btrim(body)) between 1 and 4000),
  created_at timestamptz not null default now(),
  read_at timestamptz
);
create index customer_messages_thread_idx on public.customer_messages(organization_id,customer_id,created_at desc,id desc);
create index customer_messages_unread_idx on public.customer_messages(organization_id,sender_kind,customer_id) where read_at is null;
create index customer_messages_rate_idx on public.customer_messages(sender_id,created_at desc);
alter table public.customer_messages enable row level security;
revoke all on public.customer_messages from public, anon, authenticated, service_role;
grant select, insert, update on public.customer_messages to service_role;

create function public.send_customer_message(p_organization_id uuid,p_customer_id uuid,p_id uuid,p_sender_kind text,p_sender_id uuid,p_sender_name text,p_body text)
returns public.customer_messages language plpgsql security invoker set search_path='' as $$
declare v public.customer_messages;
begin
  if p_sender_kind not in ('admin','customer') or p_sender_kind is null or p_sender_id is null
     or p_body is null or char_length(btrim(p_body)) not between 1 and 4000
     or p_sender_name is null or char_length(btrim(p_sender_name)) not between 1 and 180 then
    raise exception 'Invalid message' using errcode='22023';
  end if;
  if not exists(select 1 from public.customers c where c.id=p_customer_id and c.organization_id=p_organization_id) then
    raise exception 'Customer not available' using errcode='22023';
  end if;
  -- Serialize a sender's submissions so retries and rate accounting are atomic.
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(p_sender_id::text,391));
  select * into v from public.customer_messages where id=p_id;
  if not found then
    if (select count(*) from public.customer_messages where sender_id=p_sender_id and created_at>now()-interval '1 minute') >= 20 then
      raise exception 'Message rate limit reached' using errcode='P0001';
    end if;
    insert into public.customer_messages(id,organization_id,customer_id,sender_kind,sender_id,sender_name,body)
    values(p_id,p_organization_id,p_customer_id,p_sender_kind,p_sender_id,btrim(p_sender_name),btrim(p_body))
    on conflict(id) do nothing;
    select * into v from public.customer_messages where id=p_id;
  end if;
  if v.organization_id is distinct from p_organization_id or v.customer_id is distinct from p_customer_id
     or v.sender_id is distinct from p_sender_id or v.sender_kind is distinct from p_sender_kind or v.body is distinct from btrim(p_body) then
    raise exception 'Message reference conflict' using errcode='22023';
  end if;
  return v;
end $$;

create function public.customer_message_inbox(p_organization_id uuid)
returns table(customer_id uuid,customer_name text,last_message_at timestamptz,unread_count bigint)
language sql stable security invoker set search_path='' as $$
  select c.id,coalesce(nullif(c.display_name,''),nullif(c.company_name,''),'Customer'),max(m.created_at),
    count(*) filter(where m.sender_kind='customer' and m.read_at is null)
  from public.customer_messages m join public.customers c on c.id=m.customer_id and c.organization_id=m.organization_id
  where m.organization_id=p_organization_id
  group by c.id,c.display_name,c.company_name order by max(m.created_at) desc,c.id limit 100;
$$;
revoke all on function public.send_customer_message(uuid,uuid,uuid,text,uuid,text,text) from public,anon,authenticated;
revoke all on function public.customer_message_inbox(uuid) from public,anon,authenticated;
grant execute on function public.send_customer_message(uuid,uuid,uuid,text,uuid,text,text) to service_role;
grant execute on function public.customer_message_inbox(uuid) to service_role;
