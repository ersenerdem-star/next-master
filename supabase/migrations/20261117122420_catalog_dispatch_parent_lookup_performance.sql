-- Preserve the deployed admission policies while making the parent lookup use
-- the existing UUID/organization index. Invalid/noncanonical IDs still match no parent.
do $$
declare def text; before_join text; after_join text; func_name text; child_alias text;
begin
 for func_name, child_alias in values ('admit_catalog_wilmink_application','j'),('admit_catalog_knorr_application','child') loop
  select pg_get_functiondef(p.oid) into strict def from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname=func_name and p.pronargs=0;
  before_join:='parent.id::text='||child_alias||'.manifest->>''discovery_job''';
  after_join:='parent.id = case when '||child_alias||'.manifest->>''discovery_job'' ~ ''^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'' then ('||child_alias||'.manifest->>''discovery_job'')::uuid else null end and '||before_join;
  if position(before_join in def)=0 then raise exception 'Catalog admission definition changed: %',func_name;end if;
  execute replace(def,before_join,after_join);
 end loop;
end$$;
