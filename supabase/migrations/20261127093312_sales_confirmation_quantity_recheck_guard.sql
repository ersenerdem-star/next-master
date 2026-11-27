-- Existing orders and prices are not modified. A quantity-sensitive supplier
-- offer must be rechecked before a draft becomes a confirmed order.
create function sales_confirmation_private.require_quantity_price_recheck()
returns trigger language plpgsql security definer set search_path='' as $function$
declare
 previous_status text;
 previous_lines jsonb;
 item jsonb;
begin
 if lower(coalesce(new.status,'draft')) <> 'confirmed' then return new; end if;
 if tg_op = 'UPDATE' then
  previous_status := lower(coalesce(old.status,'draft'));
  previous_lines := old.lines;
 else
  -- INSERT ... ON CONFLICT also runs BEFORE INSERT for an existing row.
  select lower(coalesce(so.status,'draft')), so.lines into previous_status,previous_lines
  from public.sales_orders so where so.organization_id=new.organization_id and so.id=new.id;
 end if;
 -- Historical confirmed documents and idempotent retry do not undergo a new
 -- confirmation. They must remain readable/editable under existing rules.
 if previous_status='confirmed' then return new; end if;
 if jsonb_typeof(new.lines) is distinct from 'array' then return new; end if;
 if exists(select 1 from jsonb_array_elements(new.lines) l(value)
  where l.value->'purchase_qty_recheck_required' is not null
   and l.value->'purchase_qty_recheck_required' not in ('false'::jsonb,'null'::jsonb)) then
  raise exception 'SALES_CONFIRMATION_QUANTITY_RECHECK_REQUIRED' using errcode='P0001';
 end if;
 -- An older editor might omit this recently introduced flag on a saved draft.
 -- Refuse confirmation when the same unresolved line survives without an
 -- explicit false; removing an entire line does not block confirmation.
 if jsonb_typeof(previous_lines)='array' then
  for item in select value from jsonb_array_elements(previous_lines)
   where value->'purchase_qty_recheck_required'='true'::jsonb loop
   if exists (select 1 from jsonb_array_elements(new.lines) l(value)
    where (nullif(item->>'lineId','') is not null and l.value->>'lineId'=item->>'lineId'
      or (nullif(item->>'lineId','') is null or nullif(l.value->>'lineId','') is null)
         and l.value->>'brand' is not distinct from item->>'brand'
         and l.value->>'resolvedCode' is not distinct from item->>'resolvedCode'
         and l.value->>'requestedCode' is not distinct from item->>'requestedCode')
      and l.value->'purchase_qty_recheck_required' is distinct from 'false'::jsonb) then
    raise exception 'SALES_CONFIRMATION_QUANTITY_RECHECK_REQUIRED' using errcode='P0001';
   end if;
  end loop;
 end if;
 return new;
end;
$function$;
revoke all on function sales_confirmation_private.require_quantity_price_recheck() from public,anon,authenticated,service_role;
create trigger sales_confirmation_quantity_price_recheck
 before insert or update of status,lines on public.sales_orders
 for each row execute function sales_confirmation_private.require_quantity_price_recheck();
