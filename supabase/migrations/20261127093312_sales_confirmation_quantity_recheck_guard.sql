-- Existing orders and prices are not modified. A quantity-sensitive supplier
-- offer must be rechecked before a draft becomes a confirmed order, and older
-- clients may not silently discard an unresolved recheck while saving a draft.
create function sales_confirmation_private.require_quantity_price_recheck()
returns trigger language plpgsql security definer set search_path='' as $function$
declare
 previous_status text;
 previous_lines jsonb;
 item jsonb;
 missing_by_id jsonb := '{}'::jsonb;
 missing_any_by_code jsonb := '{}'::jsonb;
 missing_idless_by_code jsonb := '{}'::jsonb;
 code_key text;
 line_id text;
begin
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
 if jsonb_typeof(new.lines) is distinct from 'array' then
  if previous_status='draft' and jsonb_typeof(previous_lines)='array'
     and exists(select 1 from jsonb_array_elements(previous_lines) p(value)
       where p.value->'purchase_qty_recheck_required'='true'::jsonb) then
   raise exception 'SALES_DRAFT_QUANTITY_RECHECK_REQUIRED: Siparişi yeniden açın; adet kademesi için tedarikçi seçeneklerini yenileyin. / Reopen the order and refresh the supplier quantity-tier options.' using errcode='P0001';
  end if;
  return new;
 end if;
 if lower(coalesce(new.status,'draft'))='confirmed' and exists(
  select 1 from jsonb_array_elements(new.lines) l(value)
  where l.value->'purchase_qty_recheck_required' is not null
   and l.value->'purchase_qty_recheck_required' not in ('false'::jsonb,'null'::jsonb)) then
  raise exception 'SALES_CONFIRMATION_QUANTITY_RECHECK_REQUIRED' using errcode='P0001';
 end if;
 -- Build lookup objects once instead of scanning the full incoming list for
 -- every unresolved old line. A removed line is fine; true and explicitly
 -- verified false both remain safe to save as a draft.
 if previous_status='draft' and jsonb_typeof(previous_lines)='array' and exists(
  select 1 from jsonb_array_elements(previous_lines) p(value)
   where p.value->'purchase_qty_recheck_required'='true'::jsonb) then
  select coalesce(jsonb_object_agg(n.line_id,true) filter (where n.line_id is not null),'{}'::jsonb),
   coalesce(jsonb_object_agg(n.code_key,true),'{}'::jsonb),
   coalesce(jsonb_object_agg(n.code_key,true) filter (where n.line_id is null),'{}'::jsonb)
   into missing_by_id,missing_any_by_code,missing_idless_by_code
  from (select nullif(l.value->>'lineId','') as line_id,
    jsonb_build_array(l.value->'brand',l.value->'resolvedCode',l.value->'requestedCode')::text as code_key
   from jsonb_array_elements(new.lines) l(value)
   where l.value->'purchase_qty_recheck_required' is null
      or l.value->'purchase_qty_recheck_required' not in ('true'::jsonb,'false'::jsonb)) n;
  for item in select value from jsonb_array_elements(previous_lines)
   where value->'purchase_qty_recheck_required'='true'::jsonb loop
   line_id:=nullif(item->>'lineId','');
   code_key:=jsonb_build_array(item->'brand',item->'resolvedCode',item->'requestedCode')::text;
   if (line_id is not null and (missing_by_id ? line_id or missing_idless_by_code ? code_key))
      or (line_id is null and missing_any_by_code ? code_key) then
    raise exception 'SALES_DRAFT_QUANTITY_RECHECK_REQUIRED: Siparişi yeniden açın; adet kademesi için tedarikçi seçeneklerini yenileyin. / Reopen the order and refresh the supplier quantity-tier options.' using errcode='P0001';
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
