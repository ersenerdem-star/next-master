-- A tier is attached to a verified base release, and follows its publication pointer.
create table supplier_price_ingestion_internal.quantity_tier_receipts (
  release_id uuid primary key references public.supplier_price_releases(id),
  original_sha256 text not null check (original_sha256 ~ '^[0-9a-f]{64}$'),
  tier_sha256 text not null,
  source_rows integer not null check (source_rows > 0),
  created_at timestamptz not null default now()
);

create table supplier_price_ingestion_internal.quantity_tiers (
  release_id uuid not null references supplier_price_ingestion_internal.quantity_tier_receipts(release_id),
  base_row_id bigint not null references public.supplier_price_release_rows(id),
  minimum_quantity integer not null check (minimum_quantity > 1),
  unit_price numeric not null check (unit_price > 0 and unit_price = round(unit_price,6) and unit_price < 1000000000000),
  source_row_number bigint not null check (source_row_number > 0),
  primary key (release_id, base_row_id, minimum_quantity),
  unique (release_id, source_row_number)
);

alter table supplier_price_ingestion_internal.quantity_tier_receipts enable row level security;
alter table supplier_price_ingestion_internal.quantity_tiers enable row level security;
revoke all on supplier_price_ingestion_internal.quantity_tier_receipts,
  supplier_price_ingestion_internal.quantity_tiers from public, anon, authenticated, service_role;

-- The trusted import worker supplies every original row, including the base
-- rows. Base rows must match the separately verified release exactly.
create function public.stage_verified_supplier_quantity_tiers(
  input_organization_id uuid, input_release_id uuid, input_base_sha256 text,
  input_original_sha256 text, input_rows jsonb
) returns integer
language plpgsql security definer set search_path = '' as $$
declare
  target public.supplier_price_releases%rowtype;
  receipt supplier_price_ingestion_internal.quantity_tier_receipts%rowtype;
  row_count integer;
  fingerprint text;
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'QUANTITY_TIERS_SERVICE_REQUIRED';
  end if;
  if input_original_sha256 is null or input_original_sha256 !~ '^[0-9a-f]{64}$'
     or jsonb_typeof(input_rows) is distinct from 'array' then
    raise exception 'QUANTITY_TIERS_INVALID_SOURCE';
  end if;
  row_count := jsonb_array_length(input_rows);
  if row_count < 2 then raise exception 'QUANTITY_TIERS_INVALID_SOURCE'; end if;
  select * into target from public.supplier_price_releases
    where id = input_release_id and organization_id = input_organization_id for update;
  if not found or input_base_sha256 is null
     or target.source_file_sha256 is distinct from input_base_sha256
     or not target.source_verification_required or target.mode <> 'replace' then
    raise exception 'QUANTITY_TIERS_RELEASE_MISMATCH';
  end if;
  fingerprint := encode(sha256(convert_to(input_rows::text, 'UTF8')), 'hex');
  select * into receipt from supplier_price_ingestion_internal.quantity_tier_receipts where release_id = target.id;
  if found then
    if receipt.original_sha256 = input_original_sha256 and receipt.tier_sha256 = fingerprint then
      return receipt.source_rows;
    end if;
    raise exception 'QUANTITY_TIERS_ALREADY_STAGED';
  end if;
  if target.status <> 'validated' or target.accepted_rows <> target.total_rows or target.total_rows < 1
     or target.rejected_rows <> 0 or target.conflict_rows <> 0 or target.warning_rows <> 0
     or target.error_code is not null or row_count <= target.accepted_rows then
    raise exception 'QUANTITY_TIERS_RELEASE_NOT_READY';
  end if;
  if exists (
    with incoming as materialized (
      select * from jsonb_to_recordset(input_rows)
      as entry(code text, quantity integer, price numeric, source_row bigint)
    ), matched as (
      select i.*, b.id as base_row, b.buy_price
      from incoming i left join public.supplier_price_release_rows b
        on b.release_id = target.id and b.product_code = i.code and b.row_status = 'accepted'
        and b.currency = 'EUR' and b.moq = 1 and coalesce(b.order_multiple,1) = 1
    )
    select 1 from matched where base_row is null or quantity is null or quantity <= 0
      or price is null or price <= 0 or price <> round(price,6) or price >= 1000000000000
      or source_row is null or source_row < 1 or source_row > row_count
      or (quantity = 1 and price is distinct from buy_price)
    union all select 1 from matched group by code, quantity having count(*) <> 1
    union all select 1 from incoming group by source_row having count(*) <> 1
    union all select 1 from matched having count(*) filter (where quantity = 1) <> target.total_rows
  ) then raise exception 'QUANTITY_TIERS_INVALID_ROWS'; end if;

  insert into supplier_price_ingestion_internal.quantity_tier_receipts
    (release_id, original_sha256, tier_sha256, source_rows)
    values (target.id, input_original_sha256, fingerprint, row_count);
  insert into supplier_price_ingestion_internal.quantity_tiers
    (release_id, base_row_id, minimum_quantity, unit_price, source_row_number)
  select target.id, b.id, i.quantity, i.price, i.source_row
  from jsonb_to_recordset(input_rows) as i(code text, quantity integer, price numeric, source_row bigint)
  join public.supplier_price_release_rows b
    on b.release_id = target.id and b.product_code = i.code and b.row_status = 'accepted'
  where i.quantity > 1;
  return row_count;
end;
$$;

revoke all on function public.stage_verified_supplier_quantity_tiers(uuid,uuid,text,text,jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.stage_verified_supplier_quantity_tiers(uuid,uuid,text,text,jsonb) to service_role;

-- Quantity-aware callers retain the existing purchase options, including
-- manual-price precedence. Only a current, exact published base can supply tiers.
create function public.cloud_current_supplier_quantity_options_service(
  input_organization_id uuid, input_code text, input_brand text, input_quantity integer
) returns table (
  supplier_id uuid, supplier_name text, brand_id uuid, brand text, product_code text,
  description text, buy_price numeric, price_date date, notes text, moq integer,
  order_multiple integer, stock_qty integer, valid_to date, applied_min_quantity integer
)
language plpgsql stable security definer set search_path = '' as $$
begin
  if (select auth.role()) is distinct from 'service_role' then
    raise exception 'QUANTITY_TIERS_SERVICE_REQUIRED';
  end if;
  if input_organization_id is null or input_quantity is null or input_quantity < 1
     or btrim(coalesce(input_code,'')) = '' or btrim(coalesce(input_brand,'')) = '' then
    raise exception 'QUANTITY_TIERS_SCOPE_REQUIRED';
  end if;

  return query
    select offer.supplier_id, offer.supplier_name, offer.brand_id, offer.brand, offer.product_code,
      offer.description, coalesce(tier.unit_price, offer.buy_price), offer.price_date, offer.notes,
      offer.moq, offer.order_multiple, offer.stock_qty, offer.valid_to, tier.minimum_quantity
    from public.cloud_current_supplier_commercial_options_core(input_organization_id,input_code,input_brand) offer
    left join lateral (
      select q.minimum_quantity, q.unit_price
      from public.supplier_current_price_pointers p
      join supplier_price_ingestion_internal.quantity_tier_receipts receipt on receipt.release_id = p.release_id
      join public.supplier_price_release_rows b on b.release_id = p.release_id
        and b.normalized_code = public.normalize_catalog_product_code(offer.product_code)
        and b.product_code = offer.product_code and b.row_status = 'accepted' and b.currency = 'EUR'
        and b.buy_price = offer.buy_price and b.valid_from = offer.price_date
      join supplier_price_ingestion_internal.quantity_tiers q
        on q.release_id = b.release_id and q.base_row_id = b.id
      where p.organization_id = input_organization_id and p.supplier_id = offer.supplier_id
        and p.brand_id = offer.brand_id and q.minimum_quantity <= input_quantity
        and (offer.stock_qty is null or input_quantity <= offer.stock_qty)
        and not exists (
          select 1 from supplier_manual_price_internal.entries m
          where m.organization_id = input_organization_id and m.supplier_id = offer.supplier_id
            and m.brand_id = offer.brand_id and m.active and m.valid_from <= current_date
            and m.exact_code = public.normalize_catalog_product_code(offer.product_code)
        )
      order by q.minimum_quantity desc
      limit 1
    ) tier on true
    order by coalesce(tier.unit_price, offer.buy_price), offer.price_date desc, offer.supplier_id;
end;
$$;

revoke all on function public.cloud_current_supplier_quantity_options_service(uuid,text,text,integer)
  from public, anon, authenticated, service_role;
grant execute on function public.cloud_current_supplier_quantity_options_service(uuid,text,text,integer) to service_role;
