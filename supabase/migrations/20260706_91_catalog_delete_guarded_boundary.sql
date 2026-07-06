-- Guard catalog hard-delete behind a runtime reference check.
-- Referenced commercial identity must be deactivated or corrected explicitly,
-- not silently deleted from downstream snapshots and ledgers.

create or replace function public.delete_catalog_product_guarded(product_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_org_id uuid;
  v_product public.catalog_products%rowtype;
  v_brand_name text := '';
  v_references jsonb := '[]'::jsonb;
  v_count integer := 0;
begin
  v_org_id := public.current_profile_org_id();

  if v_org_id is null or not public.is_superadmin() then
    raise exception 'Only active superadmin users can delete catalog products';
  end if;

  if product_id is null then
    raise exception 'Catalog product id is required';
  end if;

  select *
  into v_product
  from public.catalog_products cp
  where cp.id = product_id
    and cp.organization_id = v_org_id
  for update;

  if not found then
    raise exception 'Catalog product was not found';
  end if;

  select coalesce(b.name, '')
  into v_brand_name
  from public.brands b
  where b.id = v_product.brand_id
    and b.organization_id = v_org_id
  limit 1;

  select count(*)::integer
  into v_count
  from public.sales_orders so
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(coalesce(so.lines, '[]'::jsonb)) = 'array' then coalesce(so.lines, '[]'::jsonb) else '[]'::jsonb end
  ) line
  where so.organization_id = v_org_id
    and (
      (
        nullif(line->>'product_id', '') is not null
        and nullif(line->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and nullif(line->>'product_id', '')::uuid = v_product.id
      )
      or (
        lower(trim(coalesce(line->>'brand', ''))) = lower(trim(v_brand_name))
        and public.normalize_part_code(coalesce(line->>'product_code', line->>'resolvedCode', line->>'requestedCode', '')) = v_product.normalized_code
      )
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'sales_order_lines', 'label', 'Sales order lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.purchase_orders po
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(coalesce(po.lines, '[]'::jsonb)) = 'array' then coalesce(po.lines, '[]'::jsonb) else '[]'::jsonb end
  ) line
  where po.organization_id = v_org_id
    and (
      (
        nullif(line->>'product_id', '') is not null
        and nullif(line->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and nullif(line->>'product_id', '')::uuid = v_product.id
      )
      or (
        lower(trim(coalesce(line->>'brand', ''))) = lower(trim(v_brand_name))
        and public.normalize_part_code(coalesce(line->>'product_code', line->>'resolvedCode', line->>'requestedCode', '')) = v_product.normalized_code
      )
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'purchase_order_lines', 'label', 'Purchase order lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.invoices i
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(coalesce(i.lines, '[]'::jsonb)) = 'array' then coalesce(i.lines, '[]'::jsonb) else '[]'::jsonb end
  ) line
  where i.organization_id = v_org_id
    and (
      (
        nullif(line->>'product_id', '') is not null
        and nullif(line->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and nullif(line->>'product_id', '')::uuid = v_product.id
      )
      or (
        lower(trim(coalesce(line->>'brand', ''))) = lower(trim(v_brand_name))
        and public.normalize_part_code(coalesce(line->>'product_code', line->>'resolvedCode', line->>'requestedCode', '')) = v_product.normalized_code
      )
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'invoice_lines', 'label', 'Invoice lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.bills b
  cross join lateral jsonb_array_elements(
    case when jsonb_typeof(coalesce(b.lines, '[]'::jsonb)) = 'array' then coalesce(b.lines, '[]'::jsonb) else '[]'::jsonb end
  ) line
  where b.organization_id = v_org_id
    and (
      (
        nullif(line->>'product_id', '') is not null
        and nullif(line->>'product_id', '') ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
        and nullif(line->>'product_id', '')::uuid = v_product.id
      )
      or (
        lower(trim(coalesce(line->>'brand', ''))) = lower(trim(v_brand_name))
        and public.normalize_part_code(coalesce(line->>'product_code', line->>'resolvedCode', line->>'requestedCode', '')) = v_product.normalized_code
      )
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'bill_lines', 'label', 'Bill lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.inventory_movements im
  where im.organization_id = v_org_id
    and (
      im.product_id = v_product.id
      or (
        lower(trim(coalesce(im.brand, ''))) = lower(trim(v_brand_name))
        and public.normalize_part_code(coalesce(nullif(im.product_code, ''), im.old_code, '')) = v_product.normalized_code
      )
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'inventory_movements', 'label', 'Inventory movements', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.supplier_prices sp
  where sp.organization_id = v_org_id
    and sp.brand_id = v_product.brand_id
    and sp.normalized_code = v_product.normalized_code;
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'supplier_prices', 'label', 'Supplier prices', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.customer_price_list_items cpi
  where cpi.organization_id = v_org_id
    and cpi.brand_id = v_product.brand_id
    and cpi.normalized_code = v_product.normalized_code;
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'customer_price_list_items', 'label', 'Customer price list items', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.item_code_references icr
  where icr.organization_id = v_org_id
    and icr.brand_id = v_product.brand_id
    and (
      icr.normalized_old_code = v_product.normalized_code
      or icr.normalized_new_code = v_product.normalized_code
      or icr.normalized_original_number = v_product.normalized_oem
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'item_code_references', 'label', 'Item code references', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.bill_lines bl
  where bl.organization_id = v_org_id
    and (
      bl.product_id = v_product.id
      or (bl.brand_id = v_product.brand_id and bl.normalized_code = v_product.normalized_code)
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'reporting_bill_lines', 'label', 'Reporting bill lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.invoice_lines il
  where il.organization_id = v_org_id
    and (
      il.product_id = v_product.id
      or (il.brand_id = v_product.brand_id and il.normalized_code = v_product.normalized_code)
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'reporting_invoice_lines', 'label', 'Reporting invoice lines', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.commercial_line_facts clf
  where clf.organization_id = v_org_id
    and (
      clf.product_id = v_product.id
      or (clf.brand_id = v_product.brand_id and clf.normalized_code = v_product.normalized_code)
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'commercial_line_facts', 'label', 'Commercial line facts', 'count', v_count));
  end if;

  select count(*)::integer
  into v_count
  from public.price_variance_checks pvc
  where pvc.organization_id = v_org_id
    and (
      pvc.product_id = v_product.id
      or (pvc.brand_id = v_product.brand_id and pvc.normalized_code = v_product.normalized_code)
    );
  if v_count > 0 then
    v_references := v_references || jsonb_build_array(jsonb_build_object('key', 'price_variance_checks', 'label', 'Price variance checks', 'count', v_count));
  end if;

  if jsonb_array_length(v_references) > 0 then
    return jsonb_build_object(
      'deleted', false,
      'reason', 'referenced',
      'product_id', v_product.id,
      'product_code', v_product.product_code,
      'brand', v_brand_name,
      'reference_summary', v_references
    );
  end if;

  delete from public.catalog_products cp
  where cp.id = v_product.id
    and cp.organization_id = v_org_id;

  return jsonb_build_object(
    'deleted', true,
    'product_id', v_product.id,
    'product_code', v_product.product_code,
    'brand', v_brand_name,
    'reference_summary', '[]'::jsonb
  );
end;
$$;

grant execute on function public.delete_catalog_product_guarded(uuid) to authenticated;
grant execute on function public.delete_catalog_product_guarded(uuid) to service_role;
