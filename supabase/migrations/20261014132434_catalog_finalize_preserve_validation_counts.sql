-- Validation owns insert_rows/update_rows/skip_rows. Publication owns the
-- corresponding *_count totals. Advance every bounded valid row, including
-- skips, so a trailing or entirely skipped batch can complete without writes.
-- This changes only the reviewed function; historical run rows stay intact.
do $migration$
declare
  v_function regprocedure := to_regprocedure('public.finalize_catalog_import_batch_pre_dimensions(uuid,integer)');
  v_definition text;
  v_start integer;
  v_end integer;
begin
  if v_function is null then
    raise exception 'CATALOG_FINALIZER_BASELINE_MISSING';
  end if;
  v_definition := pg_get_functiondef(v_function);
  if md5(v_definition) = '62438b8bbf47eeba619f9ec937ed64a2' then
    return;
  end if;
  if md5(v_definition) <> 'b6c02073f9dd230457e1901e3598c2c9' then
    raise exception 'CATALOG_FINALIZER_BASELINE_DRIFT';
  end if;

  -- An untouched timeout may restart actual progress, never its validation plan.
  v_definition := replace(v_definition,
    '        skipped_count = 0, insert_rows = 0, update_rows = 0, skip_rows = 0',
    '        skipped_count = 0');
  v_definition := replace(v_definition,
$old$      and s.proposed_action in ('insert', 'update')
      and s.row_index > v_cursor$old$,
$new$      and s.proposed_action in ('insert', 'update', 'skip')
      and s.row_index > v_cursor$new$);
  v_definition := replace(v_definition,
$old$    from batch_rows br
    on conflict$old$,
$new$    from batch_rows br
    where br.proposed_action in ('insert', 'update')
    on conflict$new$);

  -- Derive all actual batch counts from the same bounded materialized rows.
  -- Skipped rows advance the cursor but never enter the product upsert.
  v_start := strpos(v_definition, E'  select\n    (select count(*)::integer from batch_rows),');
  v_end := strpos(v_definition, '  select exists (');
  if v_start = 0 or v_end <= v_start then
    raise exception 'CATALOG_FINALIZER_BATCH_BLOCK_MISSING';
  end if;
  v_definition := substr(v_definition, 1, v_start - 1) ||
$new$  select
    (select count(*)::integer from batch_rows),
    coalesce((select count(*) filter (where was_inserted)::integer from upserted), 0),
    coalesce((select count(*) filter (where was_updated)::integer from upserted), 0),
    coalesce((select max(row_index)::integer from batch_rows), v_cursor),
    (select count(*)::integer from batch_rows where proposed_action = 'skip'),
    (select count(*)::integer from batch_rows
     where proposed_action in ('insert', 'update')
       and nullif(trim(coalesce(image_url, '')), '') is not null)
  into v_batch_count, v_inserted, v_updated, v_next_cursor, v_skipped, v_image_quarantined;

$new$ || substr(v_definition, v_end);
  v_definition := replace(v_definition,
$old$      insert_rows = coalesce(insert_rows, 0) + v_inserted,
      update_rows = coalesce(update_rows, 0) + v_updated,
      skip_rows = coalesce(skip_rows, 0) + v_skipped,
$old$, '');
  -- v_batch_count now includes skips; processed must count each row once.
  v_definition := replace(v_definition, 'v_batch_count + v_skipped', 'v_batch_count');
  if md5(v_definition) <> '62438b8bbf47eeba619f9ec937ed64a2' then
    raise exception 'CATALOG_FINALIZER_PATCH_MISMATCH';
  end if;
  execute v_definition;
end;
$migration$;
