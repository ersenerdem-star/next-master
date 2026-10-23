-- Session refreshes/default-card upserts often SET the same values. They are
-- not price changes. Do not keep all profiles at the front of the queue.
create or replace function public.queue_prepared_price_profiles()
returns trigger language plpgsql security definer set search_path='' as $fn$
declare org uuid; brand uuid; keys text[]; before_values jsonb; after_values jsonb;
begin
  if tg_op='UPDATE' then
    keys:=case tg_table_name
      when 'customers' then array['organization_id','price_list_type','price_list_margin_percent','currency','custom_fields']
      when 'customer_price_lists' then array['organization_id','list_type','margin_percent','is_active']
      when 'portal_invites' then array['organization_id','status','customer_id','access_can_view_orders','allowed_brand_ids','excluded_brand_ids','expires_at','seller_company_profile_id']
      when 'supplier_current_price_pointers' then array['organization_id','brand_id','supplier_id','publication_id','release_id']
      when 'supplier_price_source_versions' then array['organization_id','brand_id','source_revision']
      when 'prepared_price_catalog_versions' then array['organization_id','brand_id','revision']
      when 'item_code_references' then array['organization_id','brand_id','old_code','new_code','is_active','reason']
      when 'supplier_price_publications' then array['organization_id','brand_id','status','published_at','created_at']
    end;
    if keys is not null then
      select pg_catalog.jsonb_object_agg(k,pg_catalog.to_jsonb(old)->k),
        pg_catalog.jsonb_object_agg(k,pg_catalog.to_jsonb(new)->k)
      into before_values,after_values from pg_catalog.unnest(keys) k;
      if before_values is not distinct from after_values then return null; end if;
    end if;
  end if;
  if tg_op='DELETE' then org:=old.organization_id; else org:=new.organization_id; end if;
  if tg_table_name in('supplier_current_price_pointers','supplier_price_source_versions',
    'prepared_price_catalog_versions','item_code_references','supplier_price_publications') then
    if tg_op='DELETE' then brand:=old.brand_id; else brand:=new.brand_id; end if;
  end if;
  update public.prepared_price_export_profiles set next_check_at='epoch',revision=revision+1
  where organization_id=org and (brand is null or brand_id=brand);
  return null;
end;
$fn$;
revoke all on function public.queue_prepared_price_profiles() from public,anon,authenticated,service_role;

-- Fairness also holds when real events arrive continuously for many profiles.
-- Preserve the global preparation lease and one active cold-job guard.
create or replace function public.claim_prepared_price_profile()
returns setof public.prepared_price_export_profiles language plpgsql security definer set search_path='' as $fn$
declare p public.prepared_price_export_profiles%rowtype;
begin
  if not pg_catalog.pg_try_advisory_xact_lock(pg_catalog.hashtextextended('prepared-price-prewarm',0)) then return; end if;
  if exists(select 1 from public.prepared_price_export_profiles where lease_expires_at>pg_catalog.clock_timestamp()) then return; end if;
  if exists(select 1 from public.app_export_jobs where export_type in('admin_price_list','portal_price_list')
    and status in('queued','running') and expires_at>pg_catalog.clock_timestamp()) then return; end if;
  select * into p from public.prepared_price_export_profiles
  where next_check_at<=pg_catalog.clock_timestamp()
    and (lease_expires_at is null or lease_expires_at<=pg_catalog.clock_timestamp())
  order by next_check_at,last_checked_at nulls first,id for update skip locked limit 1;
  if not found then return; end if;
  update public.prepared_price_export_profiles set lease_token=gen_random_uuid(),lease_expires_at=pg_catalog.clock_timestamp()+interval '5 minutes'
  where id=p.id returning * into p;
  return next p;
end;
$fn$;
revoke all on function public.claim_prepared_price_profile() from public,anon,authenticated;
grant execute on function public.claim_prepared_price_profile() to service_role;
