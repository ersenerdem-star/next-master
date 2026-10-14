-- Prepared data operation only. The migration manifest does not auto-run it.
-- Exact customer mapping approved by the user: Ersen, retired C -> A.
-- Run only through a connection preflighted as zjgueqijumzlfioihnkt.
-- Other accounts and their embedded/custom margins are preserved.
do $alignment$
declare
  v_customer public.customers%rowtype;
  v_parts text[];
  v_meta jsonb;
  v_custom_fields text;
begin
  select * into v_customer from public.customers
    where id='fd9f8834-7935-4050-8895-fde8a2eb4914'::uuid
      and organization_id='1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
    for update;
  if not found then raise exception 'PRICE_PROFILE_APPROVED_CUSTOMER_NOT_FOUND'; end if;
  if coalesce(v_customer.price_list_type,'') not in ('C','A') or v_customer.price_list_margin_percent is not null then
    raise exception 'PRICE_PROFILE_APPROVED_CUSTOMER_CHANGED';
  end if;
  v_custom_fields := v_customer.custom_fields;
  v_parts := regexp_match(coalesce(v_custom_fields,''), '(?s)^(.*)\[\[NEXT_MASTER_META\]\](.*)$');
  if v_parts is not null then
    begin v_meta := btrim(v_parts[2])::jsonb;
    exception when others then raise exception 'PRICE_PROFILE_METADATA_INVALID'; end;
    if jsonb_typeof(v_meta) <> 'object'
      or (v_meta->>'price_list_type' is not null and v_meta->>'price_list_type' not in ('C','A'))
      or nullif(v_meta->>'price_list_margin_percent','') is not null then
      raise exception 'PRICE_PROFILE_APPROVED_CUSTOMER_CHANGED';
    end if;
    v_custom_fields := v_parts[1] || '[[NEXT_MASTER_META]]' || jsonb_set(v_meta,'{price_list_type}','"A"'::jsonb,true)::text;
  end if;
  if v_customer.price_list_type is distinct from 'A' or v_customer.custom_fields is distinct from v_custom_fields then
    update public.customers set price_list_type='A',custom_fields=v_custom_fields,updated_at=now()
      where id=v_customer.id and organization_id=v_customer.organization_id;
  end if;
end;
$alignment$;
