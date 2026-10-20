-- Image changes do not affect search terms. Preserve the existing derived text
-- when every search input is unchanged, including previously unbackfilled rows.
set lock_timeout='500ms';
set statement_timeout='5s';
create or replace function public.set_catalog_product_search_text()
returns trigger language plpgsql set search_path=public as $$
declare brand_name text:='';
begin
 if current_setting('next_master.catalog_bulk_load',true)='provider_stage_publication' then return new; end if;
 if tg_op='UPDATE' and row(new.product_code,new.normalized_code,new.ean,new.normalized_ean,new.brand_id,
  new.description,new.oem_no,new.normalized_oem,new.vehicle,new.vehicle_model,new.hs_code,new.origin,
  new.market_segment,new.lifecycle_status,new.lifecycle_note,new.search_text)
  is not distinct from row(old.product_code,old.normalized_code,old.ean,old.normalized_ean,old.brand_id,
  old.description,old.oem_no,old.normalized_oem,old.vehicle,old.vehicle_model,old.hs_code,old.origin,
  old.market_segment,old.lifecycle_status,old.lifecycle_note,old.search_text) then return new; end if;
 select coalesce(b.name,'') into brand_name from public.brands b where b.id=new.brand_id;
 new.search_text:=public.catalog_product_search_text(new.product_code,new.normalized_code,new.ean,new.normalized_ean,
  brand_name,new.description,new.oem_no,new.normalized_oem,new.vehicle,new.vehicle_model,new.hs_code,new.origin,
  new.market_segment,new.lifecycle_status,new.lifecycle_note);
 return new;
end;
$$;
