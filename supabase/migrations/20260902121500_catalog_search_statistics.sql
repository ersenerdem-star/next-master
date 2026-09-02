-- Improve planner estimates for skewed trigram catalog searches.
alter table if exists public.catalog_products
  alter column search_text set statistics 1000;
