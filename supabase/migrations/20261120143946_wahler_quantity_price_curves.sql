-- Price the actual published thresholds using the same offer reader as orders.
-- The optional supplier restricts the result to an internal purchase list.
create function supplier_price_ingestion_internal.wahler_quantity_price_curves(
  input_organization_id uuid,input_brand_id uuid,input_codes text[],input_supplier_id uuid default null
) returns table(code text, minimum_quantity integer, unit_buy_price numeric)
language sql stable set search_path = '' as $$
  with thresholds as materialized (
    select distinct b.product_code, q.minimum_quantity
    from public.supplier_current_price_pointers p
    join public.brands br on br.id=p.brand_id and br.organization_id=p.organization_id
    join public.supplier_price_release_rows b on b.release_id=p.release_id and b.row_status='accepted'
    join supplier_price_ingestion_internal.quantity_tiers q on q.release_id=b.release_id and q.base_row_id=b.id
    where p.organization_id=input_organization_id and p.brand_id=input_brand_id
      and lower(btrim(br.name))='wahler' and b.product_code=any(input_codes)
      and (input_supplier_id is null or p.supplier_id=input_supplier_id)
  )
  select t.product_code,t.minimum_quantity,offer.buy_price
  from thresholds t
  cross join lateral (
    select o.buy_price,o.applied_min_quantity,o.moq,o.order_multiple,o.stock_qty
    from supplier_price_ingestion_internal.current_supplier_quantity_options(
      input_organization_id,t.product_code,'Wahler',t.minimum_quantity) o
    where o.brand_id=input_brand_id and o.product_code=t.product_code
      and (input_supplier_id is null or o.supplier_id=input_supplier_id)
    order by o.buy_price,o.price_date desc,o.supplier_id
    limit 1
  ) offer
  where offer.applied_min_quantity=t.minimum_quantity
    and t.minimum_quantity>=coalesce(offer.moq,1)
    and t.minimum_quantity % greatest(coalesce(offer.order_multiple,1),1)=0
    and (offer.stock_qty is null or t.minimum_quantity<=offer.stock_qty)
  order by t.product_code,t.minimum_quantity
$$;
revoke all on function supplier_price_ingestion_internal.wahler_quantity_price_curves(uuid,uuid,text[],uuid)
  from public,anon,authenticated,service_role;

create function public.cloud_wahler_quantity_price_curves(
  input_organization_id uuid,input_brand_id uuid,input_codes text[],input_supplier_id uuid default null
) returns table(code text, minimum_quantity integer, unit_buy_price numeric)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'QUANTITY_TIERS_SERVICE_REQUIRED';
  end if;
  if coalesce(cardinality(input_codes),0) not between 1 and 5000 then
    raise exception 'QUANTITY_TIERS_BATCH_SIZE_INVALID';
  end if;
  return query select * from supplier_price_ingestion_internal.wahler_quantity_price_curves(
    input_organization_id,input_brand_id,input_codes,input_supplier_id);
end
$$;
revoke all on function public.cloud_wahler_quantity_price_curves(uuid,uuid,text[],uuid)
  from public,anon,authenticated,service_role;
grant execute on function public.cloud_wahler_quantity_price_curves(uuid,uuid,text[],uuid) to service_role;
