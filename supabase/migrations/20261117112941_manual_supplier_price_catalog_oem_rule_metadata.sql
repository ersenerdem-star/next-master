-- Persist the business rule on the existing writer without changing its body,
-- permissions, or runtime behavior. Unknown bodies or comments require review.
do $migration$
declare
  writer regprocedure := pg_catalog.to_regprocedure(
    'public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text)'
  );
  existing_comment text;
  rule_text constant text := 'SP-MANUAL-OEM-001: Across all brands and suppliers, manual supplier prices must accept complete OEM text copied from the catalog. An OEM value over 1000 characters is permitted only when it equals the catalog OEM (with surrounding catalog whitespace trimmed) for the same organization, brand, and exact normalized product code. Do not truncate or alter OEM content, punctuation, ordering, or zeros. Unmatched free-form OEM input remains limited to 1000 characters. Existing price, quantity, authorization, and tenant-scope validation remains unchanged.';
begin
  if writer is null then
    raise exception 'MANUAL_SUPPLIER_PRICE_RULE_WRITER_MISSING';
  end if;
  if pg_catalog.md5(pg_catalog.pg_get_functiondef(writer)) is distinct from '75699dd803dff297c2a4e2f21a28510c' then
    raise exception 'MANUAL_SUPPLIER_PRICE_RULE_WRITER_BASELINE_CHANGED';
  end if;
  existing_comment := pg_catalog.obj_description(writer,'pg_proc');
  if existing_comment is not null and existing_comment is distinct from rule_text then
    raise exception 'MANUAL_SUPPLIER_PRICE_RULE_COMMENT_CONFLICT';
  end if;
  execute pg_catalog.format(
    'comment on function public.save_manual_supplier_price(uuid,uuid,text,numeric,date,text,text,integer,integer,integer,text) is %L',
    rule_text
  );
end;
$migration$;
