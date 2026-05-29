create schema if not exists private;

revoke all on schema private from public;
revoke all on schema private from anon;
revoke all on schema private from authenticated;

create table if not exists private.portal_request_rate_limits (
  route text not null,
  subject text not null,
  window_started_at timestamptz not null,
  attempt_count integer not null default 0,
  blocked_until timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (route, subject, window_started_at)
);

create index if not exists portal_request_rate_limits_lookup_idx
  on private.portal_request_rate_limits (route, subject, window_started_at desc);

create index if not exists portal_request_rate_limits_blocked_idx
  on private.portal_request_rate_limits (route, subject, blocked_until desc);

grant select, insert, update, delete
on private.portal_request_rate_limits
to service_role;

create or replace function public.check_portal_rate_limit(
  p_route text,
  p_subject text,
  p_limit integer,
  p_window_seconds integer,
  p_block_seconds integer default 900
)
returns table (
  allowed boolean,
  retry_after_seconds integer,
  remaining integer,
  blocked_until timestamptz
)
language plpgsql
security definer
set search_path = public, private, pg_temp
as $$
declare
  v_now timestamptz := now();
  v_window integer := greatest(coalesce(p_window_seconds, 0), 1);
  v_limit integer := greatest(coalesce(p_limit, 0), 1);
  v_block integer := greatest(coalesce(p_block_seconds, 0), 60);
  v_subject text := lower(trim(coalesce(p_subject, '')));
  v_route text := lower(trim(coalesce(p_route, '')));
  v_window_start timestamptz;
  v_count integer := 0;
  v_blocked_until timestamptz;
begin
  if v_route = '' or v_subject = '' then
    raise exception 'Route and subject are required for portal rate limiting';
  end if;

  v_window_start :=
    to_timestamp(floor(extract(epoch from v_now) / v_window) * v_window);

  delete from private.portal_request_rate_limits
  where updated_at < v_now - interval '2 days';

  select max(limits.blocked_until)
  into v_blocked_until
  from private.portal_request_rate_limits as limits
  where limits.route = v_route
    and limits.subject = v_subject
    and limits.blocked_until is not null
    and limits.blocked_until > v_now;

  if v_blocked_until is not null then
    return query
    select false,
           greatest(1, ceil(extract(epoch from v_blocked_until - v_now))::integer),
           0,
           v_blocked_until;
    return;
  end if;

  insert into private.portal_request_rate_limits (
    route,
    subject,
    window_started_at,
    attempt_count,
    blocked_until,
    created_at,
    updated_at
  )
  values (
    v_route,
    v_subject,
    v_window_start,
    1,
    null,
    v_now,
    v_now
  )
  on conflict (route, subject, window_started_at)
  do update
    set attempt_count = private.portal_request_rate_limits.attempt_count + 1,
        updated_at = excluded.updated_at;

  select coalesce(sum(limits.attempt_count), 0)
  into v_count
  from private.portal_request_rate_limits as limits
  where limits.route = v_route
    and limits.subject = v_subject
    and limits.window_started_at >= v_now - make_interval(secs => v_window);

  if v_count > v_limit then
    v_blocked_until := v_now + make_interval(secs => v_block);

    update private.portal_request_rate_limits
    set blocked_until = v_blocked_until,
        updated_at = v_now
    where route = v_route
      and subject = v_subject
      and window_started_at = v_window_start;

    return query
    select false,
           greatest(1, ceil(extract(epoch from v_blocked_until - v_now))::integer),
           0,
           v_blocked_until;
    return;
  end if;

  return query
  select true,
         0,
         greatest(v_limit - v_count, 0),
         null::timestamptz;
end;
$$;

revoke all
on function public.check_portal_rate_limit(text, text, integer, integer, integer)
from public;

revoke all
on function public.check_portal_rate_limit(text, text, integer, integer, integer)
from anon;

revoke all
on function public.check_portal_rate_limit(text, text, integer, integer, integer)
from authenticated;

grant execute
on function public.check_portal_rate_limit(text, text, integer, integer, integer)
to service_role;
