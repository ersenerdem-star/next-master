-- Draft procurement sourcing is independent of the accepted customer sale.
-- One transaction moves selected line snapshots, reprices from the current
-- supplier reader, and records an immutable, replay-safe decision receipt.
create table public.purchase_order_supplier_changes (
  organization_id uuid not null references public.organizations(id),
  decision_id uuid not null,
  actor_id uuid not null,
  source_order_id text not null,
  target_order_id text not null,
  reason text not null,
  request jsonb not null,
  before_snapshot jsonb not null,
  result jsonb not null,
  created_at timestamptz not null default now(),
  primary key (organization_id, decision_id)
);
alter table public.purchase_order_supplier_changes enable row level security;
revoke all on public.purchase_order_supplier_changes from public, anon, authenticated, service_role;
grant select on public.purchase_order_supplier_changes to authenticated, service_role;
create policy purchase_supplier_change_read on public.purchase_order_supplier_changes
  for select to authenticated using (
    organization_id = public.current_profile_org_id()
    and (public.current_profile_role() in ('admin','sales') or public.is_superadmin())
  );

create function public.reassign_purchase_order_supplier_atomic(payload jsonb)
returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := public.current_profile_org_id();
  v_actor uuid := auth.uid();
  v_decision uuid := (payload->>'decision_id')::uuid;
  v_source_id text := payload->>'source_order_id';
  v_target_id text := nullif(payload->>'target_order_id','');
  v_supplier_id uuid := (payload->>'supplier_id')::uuid;
  v_reason text := btrim(coalesce(payload->>'reason',''));
  v_source public.purchase_orders%rowtype;
  v_target public.purchase_orders%rowtype;
  v_supplier public.suppliers%rowtype;
  v_vendor public.vendors%rowtype;
  v_receipt public.purchase_order_supplier_changes%rowtype;
  v_before jsonb;
  v_selected jsonb := payload->'line_indices';
  v_indices integer[];
  v_line jsonb;
  v_moved jsonb := '[]';
  v_remaining jsonb := '[]';
  v_offer record;
  v_options jsonb;
  v_qty numeric;
  v_combined_qty numeric;
  v_expected numeric;
  v_count integer;
  v_index integer;
  v_result jsonb;
begin
  if v_actor is null or v_org is null
    or (coalesce(public.current_profile_role(),'') not in ('admin','sales') and not coalesce(public.is_superadmin(),false)) then
    raise exception 'PURCHASE_SUPPLIER_ACCESS_DENIED';
  end if;
  if v_decision is null or v_supplier_id is null or v_source_id is null
    or length(v_reason) not between 3 and 1000 then
    raise exception 'PURCHASE_SUPPLIER_REQUEST_INVALID';
  end if;
  perform pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(v_org::text || v_decision::text,0));
  select * into v_receipt from public.purchase_order_supplier_changes
    where organization_id=v_org and decision_id=v_decision;
  if found then
    if v_receipt.actor_id<>v_actor or v_receipt.request<>payload then
      raise exception 'PURCHASE_SUPPLIER_REPLAY_CONFLICT';
    end if;
    return v_receipt.result || jsonb_build_object('replayed',true);
  end if;
  select * into v_source from public.purchase_orders where organization_id=v_org and id=v_source_id;
  if not found then raise exception 'PURCHASE_SUPPLIER_ORDER_NOT_FOUND'; end if;
  -- Same lock order as order confirmation/save: Sales first, then its POs.
  perform 1 from public.sales_orders where organization_id=v_org and id=v_source.sales_order_id and status='confirmed' for update;
  if not found then raise exception 'PURCHASE_SUPPLIER_CONFIRMED_SALE_REQUIRED'; end if;
  perform 1 from public.purchase_orders where organization_id=v_org
    and id in (v_source_id,v_target_id) order by id for update;
  select * into v_source from public.purchase_orders where organization_id=v_org and id=v_source_id;
  if v_source.updated_at is distinct from (payload->>'expected_source_updated_at')::timestamptz then
    raise exception 'PURCHASE_SUPPLIER_ORDER_CHANGED';
  end if;
  if v_source.status<>'draft' or upper(v_source.currency)<>'EUR' then
    raise exception 'PURCHASE_SUPPLIER_EUR_DRAFT_REQUIRED';
  end if;
  if v_target_id=v_source_id then raise exception 'PURCHASE_SUPPLIER_TARGET_INVALID'; end if;
  select * into v_supplier from public.suppliers where organization_id=v_org and id=v_supplier_id;
  if not found or lower(btrim(v_source.supplier_name))=lower(btrim(v_supplier.name)) then
    raise exception 'PURCHASE_SUPPLIER_TARGET_INVALID';
  end if;
  select count(*) into v_count from public.vendors where organization_id=v_org
    and (lower(btrim(display_name))=lower(btrim(v_supplier.name)) or lower(btrim(company_name))=lower(btrim(v_supplier.name)));
  if v_count<>1 then raise exception 'PURCHASE_SUPPLIER_VENDOR_MAPPING_REQUIRED'; end if;
  select * into v_vendor from public.vendors where organization_id=v_org
    and (lower(btrim(display_name))=lower(btrim(v_supplier.name)) or lower(btrim(company_name))=lower(btrim(v_supplier.name)));
  if v_target_id is not null then
    select * into v_target from public.purchase_orders where organization_id=v_org and id=v_target_id;
    if not found or v_target.status<>'draft' or v_target.sales_order_id<>v_source.sales_order_id
      or (v_target.vendor_id is not null and v_target.vendor_id<>v_vendor.id)
      or v_target.purchase_company<>v_source.purchase_company or v_target.currency<>v_source.currency
      or lower(btrim(v_target.supplier_name))<>lower(btrim(v_supplier.name))
      or v_target.updated_at is distinct from (payload->>'expected_target_updated_at')::timestamptz then
      raise exception 'PURCHASE_SUPPLIER_TARGET_CHANGED';
    end if;
  end if;
  if exists(select 1 from public.bills b where b.organization_id=v_org and (
      b.purchase_order_id in (v_source_id,v_target_id)
      or exists(select 1 from jsonb_array_elements(b.lines) l where l->>'purchase_order_id' in (v_source_id,v_target_id))))
    or exists(select 1 from public.purchase_receives where organization_id=v_org and purchase_order_id in (v_source_id,v_target_id))
    or exists(select 1 from public.inventory_movements where organization_id=v_org
      and (document_id in (v_source_id,v_target_id) or document_no in (v_source_id,v_target_id)))
    or exists(select 1 from public.outbound_emails where organization_id=v_org and related_type='purchase_order'
      and related_id in (v_source_id,v_target_id) and status not in ('failed','cancelled')) then
    raise exception 'PURCHASE_SUPPLIER_ORDER_ALREADY_ISSUED';
  end if;
  if jsonb_typeof(v_selected) is distinct from 'array' or jsonb_array_length(v_selected)=0
    or exists(select 1 from jsonb_array_elements(v_selected) i where jsonb_typeof(i)<>'number' or i::text !~ '^(0|[1-9][0-9]*)$') then
    raise exception 'PURCHASE_SUPPLIER_LINES_INVALID';
  end if;
  select array_agg(i::text::integer order by i::text::integer) into v_indices from jsonb_array_elements(v_selected) i;
  if cardinality(v_indices)<>(select count(distinct i) from unnest(v_indices) i)
    or v_indices[1]<0 or v_indices[cardinality(v_indices)]>=jsonb_array_length(v_source.lines)
    or jsonb_typeof(payload->'expected_prices') is distinct from 'array'
    or jsonb_array_length(payload->'expected_prices')<>cardinality(v_indices) then
    raise exception 'PURCHASE_SUPPLIER_LINES_INVALID';
  end if;
  v_before := jsonb_build_object('source',to_jsonb(v_source),'target',case when v_target.id is null then null else to_jsonb(v_target) end);
  for v_line,v_index in select value,(ordinality-1)::integer from jsonb_array_elements(v_source.lines) with ordinality loop
    if not (v_index=any(v_indices)) then v_remaining:=v_remaining||jsonb_build_array(v_line); continue; end if;
    select coalesce(jsonb_agg(to_jsonb(o)),'[]') into v_options
      from public.cloud_current_supplier_commercial_options_core(v_org,v_line->>'product_code',v_line->>'brand') o
      where o.supplier_id=v_supplier_id and upper(regexp_replace(btrim(o.product_code),'[[:space:]]+','','g'))
        =upper(regexp_replace(btrim(v_line->>'product_code'),'[[:space:]]+','','g'));
    if jsonb_array_length(v_options)<>1 then raise exception 'PURCHASE_SUPPLIER_PRICE_UNAVAILABLE'; end if;
    select * into v_offer from jsonb_to_record(v_options->0) as o(buy_price numeric,price_date date,moq integer,order_multiple integer,stock_qty integer,valid_to date);
    select count(*),min((e->>'buy_price')::numeric) into v_count,v_expected
      from jsonb_array_elements(payload->'expected_prices') e
      where e->>'line_index'=v_index::text and jsonb_typeof(e->'buy_price')='number';
    if v_count<>1 or v_expected is distinct from v_offer.buy_price or v_offer.buy_price<=0
      or v_offer.buy_price::text in ('NaN','Infinity','-Infinity') then raise exception 'PURCHASE_SUPPLIER_PRICE_CHANGED'; end if;
    v_qty := (v_line->>'qty')::numeric;
    -- Stock covers all demand in the destination, including existing and duplicate lines.
    select coalesce(sum((l.value->>'qty')::numeric),0) into v_combined_qty
    from jsonb_array_elements(v_source.lines) with ordinality l(value,n)
    where (l.n-1)::integer=any(v_indices)
      and upper(regexp_replace(l.value->>'product_code','[[:space:]]+','','g'))=upper(regexp_replace(v_line->>'product_code','[[:space:]]+','','g'))
      and public.normalize_part_code(l.value->>'brand')=public.normalize_part_code(v_line->>'brand');
    if v_target.id is not null then
      select v_combined_qty+coalesce(sum((l->>'qty')::numeric),0) into v_combined_qty
      from jsonb_array_elements(v_target.lines) l
      where upper(regexp_replace(l->>'product_code','[[:space:]]+','','g'))=upper(regexp_replace(v_line->>'product_code','[[:space:]]+','','g'))
        and public.normalize_part_code(l->>'brand')=public.normalize_part_code(v_line->>'brand');
    end if;
    if v_qty is null or v_qty::text in ('NaN','Infinity','-Infinity') or v_qty<=0 or v_qty<>trunc(v_qty)
      or (v_offer.moq is not null and v_qty<v_offer.moq)
      or (coalesce(v_offer.order_multiple,1)>1 and mod(v_qty,v_offer.order_multiple)<>0)
      or (v_offer.stock_qty is not null and v_combined_qty>v_offer.stock_qty)
      or (v_offer.valid_to is not null and v_offer.valid_to<current_date) then
      raise exception 'PURCHASE_SUPPLIER_QUANTITY_UNAVAILABLE';
    end if;
    v_moved:=v_moved||jsonb_build_array(v_line||jsonb_build_object(
      'supplier_id',v_supplier_id,'supplier_name',v_supplier.name,'buy_price',v_offer.buy_price,
      'line_total',round(v_offer.buy_price*v_qty,2),'supplier_price_date',v_offer.price_date,
      'sourcing_reason',v_reason,'source_purchase_order_id',v_source_id));
  end loop;
  if v_target.id is null and jsonb_array_length(v_remaining)=0 then
    -- Whole draft retarget: preserve the original document ID.
    update public.purchase_orders set supplier_name=v_supplier.name,
      supplier_key=regexp_replace(lower(v_supplier.name),'[^a-z0-9]+','-','g'),vendor_id=v_vendor.id,
      lines=v_moved,line_count=jsonb_array_length(v_moved),
      total_amount=(select coalesce(sum((l->>'line_total')::numeric),0) from jsonb_array_elements(v_moved) l),
      updated_at=clock_timestamp() where organization_id=v_org and id=v_source_id returning * into v_target;
    v_source:=v_target;
  else
    if v_target.id is null then
      v_target_id:='PO-'||v_decision::text;
      insert into public.purchase_orders(id,organization_id,vendor_id,supplier_name,supplier_key,purchase_company,
        sales_order_id,sales_order_no,customer_name,status,currency,total_amount,line_count,lines)
      values(v_target_id,v_org,v_vendor.id,v_supplier.name,regexp_replace(lower(v_supplier.name),'[^a-z0-9]+','-','g'),
        v_source.purchase_company,v_source.sales_order_id,v_source.sales_order_no,v_source.customer_name,'draft',v_source.currency,0,0,'[]') returning * into v_target;
    end if;
    -- Keep separate demand lines rather than merging quantities or rewriting sales snapshots.
    v_moved:=v_target.lines||v_moved;
    update public.purchase_orders set vendor_id=v_vendor.id,lines=v_moved,line_count=jsonb_array_length(v_moved),
      total_amount=(select coalesce(sum(round((l->>'buy_price')::numeric*(l->>'qty')::numeric,2)),0) from jsonb_array_elements(v_moved) l),
      updated_at=clock_timestamp() where organization_id=v_org and id=v_target.id returning * into v_target;
    update public.purchase_orders set lines=v_remaining,line_count=jsonb_array_length(v_remaining),
      status=case when jsonb_array_length(v_remaining)=0 then 'closed' else status end,
      total_amount=(select coalesce(sum(round((l->>'buy_price')::numeric*(l->>'qty')::numeric,2)),0) from jsonb_array_elements(v_remaining) l),
      updated_at=clock_timestamp() where organization_id=v_org and id=v_source_id returning * into v_source;
  end if;
  v_result:=jsonb_build_object('source_order',to_jsonb(v_source),'target_order',to_jsonb(v_target),'replayed',false);
  insert into public.purchase_order_supplier_changes(organization_id,decision_id,actor_id,source_order_id,target_order_id,reason,request,before_snapshot,result)
    values(v_org,v_decision,v_actor,v_source_id,v_target.id,v_reason,payload,v_before,v_result);
  return v_result;
end;
$$;
revoke all on function public.reassign_purchase_order_supplier_atomic(jsonb) from public,anon;
grant execute on function public.reassign_purchase_order_supplier_atomic(jsonb) to authenticated;
