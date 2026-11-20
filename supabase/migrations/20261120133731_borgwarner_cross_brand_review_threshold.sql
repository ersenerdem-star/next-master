-- BorgWarner article numbers can overlap with unrelated manufacturers, and
-- some aliases share product families. Keep majority-overlap review, while
-- preserving the existing five-percent rule for every other brand.
do $migration$
declare
  definition text := pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure);
  threshold text := $expr$(case when upper(btrim(v_selected_brand_name)) in ('BORGWARNER','BORGWARNER (BERU)','BORGWARNER (KKK)','BORGWARNER (SCHWITZER)') then 50 else 5 end)$expr$;
  threshold_marker text := $marker$'ratio_threshold_percent',5,'ratio_comparison'$marker$;
  decision_marker text := $marker$matching_codes::numeric*100 > (select n from counts)*5$marker$;
begin
  if md5(definition) <> 'eb1f623c4c23994bcbd364c25e1cf7a3'
     or position(threshold_marker in definition)=0
     or position(decision_marker in definition)=0 then
    raise exception 'BORGWARNER_AUDIT_DEFINITION_CHANGED';
  end if;
  definition := replace(definition,threshold_marker,'''ratio_threshold_percent'','||threshold||',''ratio_comparison''');
  definition := replace(definition,decision_marker,'matching_codes::numeric*100 > (select n from counts)*'||threshold);
  execute definition;
end
$migration$;
