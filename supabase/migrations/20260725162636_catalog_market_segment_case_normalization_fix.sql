create or replace function public.normalize_catalog_market_segment(input_value text)
returns text
language sql
immutable
set search_path = public
as $$
  with normalized as (
    select regexp_replace(lower(trim(coalesce(input_value, ''))), '[^a-z0-9]+', '_', 'g') as value
  )
  select case
    when input_value is null then null
    when value in ('pc', 'pkw', 'passengercar', 'passenger_car', 'passenger_cars', 'passenger_vehicle', 'passengervehicle', 'passenger_vehicles', 'car') then 'pc'
    when value in ('cv', 'truck', 'truckbus', 'truck_bus', 'truck_bus_commercial', 'truck_bus_light_commercial', 'commercial', 'commercial_vehicle', 'commercialvehicle', 'commercial_vehicles', 'lkw') then 'cv'
    when value in ('lcv', 'light_commercial', 'lightcommercial', 'light_commercial_vehicle', 'lightcommercialvehicle', 'light_commercial_vehicles', 'van') then 'lcv'
    when value in ('motorcycle', 'motorbike', 'motorcycles', 'motorbikes', 'bike') then 'motorcycle'
    when value in ('engine', 'engines', 'powertrain') then 'engines'
    when value = 'universal' then 'universal'
    when value = 'marine' then 'marine'
    when value = 'industrial' then 'industrial'
    when value in ('agriculture', 'agricultural', 'agri') then 'agriculture'
    else null
  end
  from normalized;
$$;
