-- DuckDB performs the bounded file-level validation before row staging.
-- This RPC records that receipt and advances the release to validated without
-- re-running the timeout-prone whole-table SQL validator.
create or replace function public.complete_supplier_price_release_duckdb_validation(
  input_release_id uuid,
  input_total_rows integer,
  input_accepted_rows integer,
  input_rejected_rows integer,
  input_warning_rows integer,
  input_conflict_rows integer,
  input_missing_price_rows integer,
  input_duplicate_rows integer,
  input_currency_count integer
)
returns table(
  status text,
  release_id uuid,
  release_status text,
  total_rows bigint,
  accepted_rows bigint,
  rejected_rows bigint,
  warning_rows bigint,
  conflict_rows bigint,
  missing_price_rows integer,
  duplicate_rows integer,
  currency_count integer,
  publishable boolean,
  message text
)
language plpgsql
security definer
set search_path to ''
as $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_publishable boolean;
  v_error_code text;
  v_error_message text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'DuckDB validation completion requires service role';
  end if;
  if input_release_id is null or input_total_rows is null or input_accepted_rows is null
     or input_rejected_rows is null or input_warning_rows is null or input_conflict_rows is null
     or input_missing_price_rows is null or input_duplicate_rows is null or input_currency_count is null
     or input_total_rows < 0 or input_accepted_rows < 0 or input_rejected_rows < 0
     or input_warning_rows < 0 or input_conflict_rows < 0 or input_missing_price_rows < 0
     or input_duplicate_rows < 0 or input_currency_count < 0 then
    raise exception 'Invalid DuckDB validation summary';
  end if;

  select r.* into v_release
    from public.supplier_price_releases r
    where r.id = input_release_id
    for update;
  if not found then raise exception 'Supplier release not found'; end if;
  if v_release.status not in ('staged', 'validated') then
    raise exception 'Release is not ready for DuckDB validation completion';
  end if;
  if input_total_rows::bigint <> v_release.total_rows then
    raise exception 'DuckDB total row count does not match release';
  end if;
  if input_accepted_rows::bigint + input_rejected_rows + input_warning_rows <> input_total_rows then
    raise exception 'DuckDB row counts do not cover the release';
  end if;
  if input_missing_price_rows > input_rejected_rows and input_missing_price_rows > 0 then
    raise exception 'Missing price rows exceed rejected rows';
  end if;
  if input_duplicate_rows <> input_conflict_rows then
    raise exception 'Duplicate and conflict counts must agree';
  end if;

  v_publishable := input_rejected_rows = 0
    and input_warning_rows = 0
    and input_conflict_rows = 0
    and input_missing_price_rows = 0
    and input_currency_count <= 1
    and v_release.brand_identity_audit is not null
    and coalesce((v_release.brand_identity_audit->>'checked')::boolean, false)
    and not coalesce((v_release.brand_identity_audit->>'review_required')::boolean, true);
  if not v_publishable then
    v_error_code := case
      when input_rejected_rows > 0 then 'VALIDATION_REJECTED_ROWS'
      when input_conflict_rows > 0 then 'VALIDATION_CONFLICTS'
      when input_missing_price_rows > 0 then 'VALIDATION_MISSING_PRICE'
      when input_currency_count > 1 then 'VALIDATION_MULTIPLE_CURRENCIES'
      when v_release.brand_identity_audit is null
        or not coalesce((v_release.brand_identity_audit->>'checked')::boolean, false)
        or coalesce((v_release.brand_identity_audit->>'review_required')::boolean, true)
        then 'BRAND_IDENTITY_COMPARISON_PENDING'
      else 'VALIDATION_REVIEW_REQUIRED'
    end;
    v_error_message := 'DuckDB file validation completed; publication gates remain pending.';
  end if;

  update public.supplier_price_releases as r
    set status = 'validated', validated_at = now(), updated_at = now(),
        accepted_rows = input_accepted_rows, rejected_rows = input_rejected_rows,
        warning_rows = input_warning_rows, conflict_rows = input_conflict_rows,
        processed_rows = greatest(r.processed_rows, input_total_rows),
        current_cursor = greatest(r.current_cursor, input_total_rows),
        worker_version = 'duckdb-validation-v1', error_code = v_error_code,
        error_message = v_error_message,
        brand_identity_audit = coalesce(r.brand_identity_audit,
          jsonb_build_object('policy','cross-brand-v1','checked',false,'review_required',true,
            'reason','DUCKDB_VALIDATION_BRAND_AUDIT_PENDING'))
    where r.id = input_release_id;

  insert into public.supplier_price_release_events
    (release_id, event_type, stage, status, cursor, processed_rows, total_rows, worker_version, error_code, error_message)
    values (input_release_id, 'release_validated', 'validation', 'completed', input_total_rows,
            input_total_rows, input_total_rows, 'duckdb-validation-v1', v_error_code, v_error_message);

  return query select 'validated'::text, input_release_id, 'validated'::text,
    v_release.total_rows, input_accepted_rows::bigint, input_rejected_rows::bigint,
    input_warning_rows::bigint, input_conflict_rows::bigint, input_missing_price_rows,
    input_duplicate_rows, input_currency_count, v_publishable,
    coalesce(v_error_message, 'DuckDB validation completed; release is ready for publication review.')::text;
end;
$function$;

revoke all on function public.complete_supplier_price_release_duckdb_validation(uuid, integer, integer, integer, integer, integer, integer, integer, integer) from public, anon, authenticated;
grant execute on function public.complete_supplier_price_release_duckdb_validation(uuid, integer, integer, integer, integer, integer, integer, integer, integer) to service_role;
