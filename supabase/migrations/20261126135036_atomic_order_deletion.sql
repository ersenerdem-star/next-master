-- Preserve the existing guarded delete functions and their audit effects while
-- enforcing original editor versions and a single transaction for a batch.
create schema if not exists order_deletion_private;
revoke all on schema order_deletion_private from public,anon,authenticated,service_role;
alter function public.delete_sales_order_guarded(text) set schema order_deletion_private;
alter function public.delete_purchase_order_guarded(text) set schema order_deletion_private;
revoke all on function order_deletion_private.delete_sales_order_guarded(text) from public,anon,authenticated,service_role;
revoke all on function order_deletion_private.delete_purchase_order_guarded(text) from public,anon,authenticated,service_role;

create function order_deletion_private.delete_batch(items jsonb, purchase boolean) returns jsonb
language plpgsql security definer set search_path='' as $function$
declare org uuid:=public.current_profile_org_id(); role_name text:=public.current_profile_role();
 item jsonb; item_id text; expected timestamptz; actual timestamptz; result jsonb:='[]'::jsonb;
begin
 if auth.uid() is null or org is null or (coalesce(role_name,'') not in ('admin','sales') and not coalesce(public.is_superadmin(),false)) then
  raise exception 'ORDER_DELETE_STAFF_REQUIRED' using errcode='42501'; end if;
 if jsonb_typeof(items) is distinct from 'array' or jsonb_array_length(items) not between 1 and 1000 then raise exception 'ORDER_DELETE_INVALID'; end if;
 if exists(select 1 from jsonb_array_elements(items) e where length(coalesce(e->>'id','')) not between 1 and 180 or coalesce(e->>'expected_updated_at','')='')
  or (select count(distinct e->>'id') from jsonb_array_elements(items) e)<>jsonb_array_length(items) then raise exception 'ORDER_DELETE_INVALID'; end if;
 -- All locks in stable order; validate the whole selection before any delete.
 for item in select value from jsonb_array_elements(items) order by value->>'id' loop
  item_id:=item->>'id';
  begin expected:=(item->>'expected_updated_at')::timestamptz;
  exception when others then raise exception 'ORDER_DELETE_VERSION_REQUIRED'; end;
  if purchase then select p.updated_at into actual from public.purchase_orders p where p.organization_id=org and p.id=item_id for update;
  else select s.updated_at into actual from public.sales_orders s where s.organization_id=org and s.id=item_id for update; end if;
  if not found or actual is distinct from expected then raise exception 'ORDER_DELETE_STALE_VERSION'; end if;
 end loop;
 for item in select value from jsonb_array_elements(items) order by value->>'id' loop
  item_id:=item->>'id';
  if purchase then result:=result||jsonb_build_array(order_deletion_private.delete_purchase_order_guarded(item_id));
  else result:=result||jsonb_build_array(order_deletion_private.delete_sales_order_guarded(item_id)); end if;
 end loop;
 return result;
end;
$function$;
revoke all on function order_deletion_private.delete_batch(jsonb,boolean) from public,anon,authenticated,service_role;
create function public.delete_sales_orders_guarded_batch(items jsonb) returns jsonb language sql security definer set search_path='' as $$select order_deletion_private.delete_batch(items,false)$$;
create function public.delete_purchase_orders_guarded_batch(items jsonb) returns jsonb language sql security definer set search_path='' as $$select order_deletion_private.delete_batch(items,true)$$;
-- Old clients using the old single-delete RPC receive a version error instead
-- of deleting a newer document without an expected revision.
create function public.delete_sales_order_guarded(id text) returns jsonb language plpgsql security definer set search_path='' as $$begin raise exception 'ORDER_DELETE_VERSION_REQUIRED';end$$;
create function public.delete_purchase_order_guarded(id text) returns jsonb language plpgsql security definer set search_path='' as $$begin raise exception 'ORDER_DELETE_VERSION_REQUIRED';end$$;
revoke all on function public.delete_sales_orders_guarded_batch(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.delete_purchase_orders_guarded_batch(jsonb) from public,anon,authenticated,service_role;
revoke all on function public.delete_sales_order_guarded(text) from public,anon,authenticated,service_role;
revoke all on function public.delete_purchase_order_guarded(text) from public,anon,authenticated,service_role;
grant execute on function public.delete_sales_orders_guarded_batch(jsonb),public.delete_purchase_orders_guarded_batch(jsonb),public.delete_sales_order_guarded(text),public.delete_purchase_order_guarded(text) to authenticated,service_role;
notify pgrst, 'reload schema';
-- Browser staff use RPCs for commercial writes. Preserve only the narrow
-- portal-seen flag; portal mutations use service_role and guarded endpoints.
revoke insert,update,delete,truncate,trigger,references on public.sales_orders,public.purchase_orders from public,anon,authenticated;
do $permissions$
declare t text; c record;
begin
 for t in select unnest(array['sales_orders','purchase_orders']) loop
  for c in select column_name from information_schema.columns where table_schema='public' and table_name=t loop
   execute format('revoke insert (%I), update (%I), references (%I) on public.%I from public,anon,authenticated',c.column_name,c.column_name,c.column_name,t);
  end loop;
 end loop;
end;
$permissions$;
grant insert on public.sales_orders,public.purchase_orders to authenticated;
grant update (portal_seen_at) on public.sales_orders to authenticated;
