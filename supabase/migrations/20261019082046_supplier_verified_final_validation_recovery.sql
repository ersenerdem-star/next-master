-- Bounded worker-only final validation, including fully staged interrupted sources.
-- Source/row integrity, brand review, grants and explicit publication remain enforced.
-- Finish the verified import with the existing cross-brand policy automatically.
-- Retain source/row integrity, explicit publication and reviewed-release replay.
-- Serialize with review/publication using their existing organization identity lock.
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
set statement_timeout = '45s'
as $function$
declare
  v_release public.supplier_price_releases%rowtype;
  v_recovering boolean;
  v_organization_id uuid;
  v_audit jsonb;
  v_rows bigint;
  v_distinct_source_rows bigint;
  v_distinct_codes bigint;
  v_first_row bigint;
  v_last_row bigint;
  v_invalid_rows bigint;
  v_publishable boolean;
  v_error_code text;
  v_error_message text;
begin
  if coalesce(auth.role(), '') <> 'service_role' then
    raise exception 'DuckDB validation completion requires service role';
  end if;
  if input_release_id is null or input_total_rows is null or input_total_rows < 1
     or input_accepted_rows is distinct from input_total_rows
     or input_rejected_rows is distinct from 0
     or input_warning_rows is distinct from 0
     or input_conflict_rows is distinct from 0
     or input_missing_price_rows is distinct from 0
     or input_duplicate_rows is distinct from 0
     or input_currency_count is distinct from 1 then
    raise exception 'DuckDB validation summary is not publishable';
  end if;

  if current_setting('transaction_isolation') <> 'read committed' then
    raise exception 'SUPPLIER_VALIDATION_REQUIRES_READ_COMMITTED';
  end if;
  select r.organization_id into v_organization_id
    from public.supplier_price_releases r where r.id = input_release_id;
  if not found then raise exception 'Supplier release not found'; end if;
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended('supplier-price-identity:' || v_organization_id::text, 0));

  select r.* into v_release
    from public.supplier_price_releases r
   where r.id = input_release_id
   for update;
  if not found then raise exception 'Supplier release not found'; end if;
  if v_release.organization_id is distinct from v_organization_id then
    raise exception 'BRAND_IDENTITY_SCOPE_INVALID';
  end if;
  v_recovering := v_release.status = 'failed'
    and v_release.error_code = 'SUPPLIER_PROCESSING_INTERRUPTED'
    and v_release.validated_at is null and v_release.published_at is null;
  if (v_release.status not in ('staged', 'validated') and not coalesce(v_recovering,false))
     or v_release.source_verification_required is not true then
    raise exception 'Release is not ready for verified validation completion';
  end if;
  if v_release.total_rows is distinct from input_total_rows
     or v_release.current_cursor is distinct from input_total_rows
     or v_release.processed_rows is distinct from input_total_rows then
    raise exception 'Staged release cursor coverage is incomplete';
  end if;

  -- Recovery still runs every persisted-row and brand-identity check below.
  if v_recovering then
    if v_release.uploaded_at is null
      or not exists(select 1 from supplier_price_ingestion_internal.handoffs h
        where h.release_id=v_release.id and h.organization_id=v_release.organization_id
          and h.source_sha256=v_release.source_file_sha256
          and h.source_path=v_release.source_file_path and h.total_rows=v_release.total_rows)
      or exists(select 1 from public.supplier_price_release_batches b
        where b.release_id=v_release.id and b.status<>'completed')
      or (select coalesce(sum(b.row_count),0) from public.supplier_price_release_batches b
        where b.release_id=v_release.id and b.status='completed')<>input_total_rows then
      raise exception 'INTERRUPTED_VALIDATION_RECOVERY_UNCONFIRMED';
    end if;
  end if;

  -- Punctuation is significant in supplier SKUs: 61/1 and 611 remain
  -- distinct. Reject only duplicate identities under the staging contract.
  select count(*), count(distinct r.source_row_number),
         count(distinct r.normalized_code collate "C"),
         min(r.source_row_number), max(r.source_row_number),
         count(*) filter (where r.row_status is distinct from 'accepted'
           or r.product_code is null
           or r.normalized_code is null
           or r.normalized_code is distinct from upper(regexp_replace(r.product_code,'[[:space:]]+','','g'))
           or r.normalized_code !~ '[A-Z0-9]'
           or r.buy_price is null or r.buy_price <= 0
           or r.currency is distinct from 'EUR'
           or r.valid_from is null)
    into v_rows, v_distinct_source_rows, v_distinct_codes,
         v_first_row, v_last_row, v_invalid_rows
    from public.supplier_price_release_rows r
   where r.release_id = input_release_id;
  if v_rows <> input_total_rows or v_distinct_source_rows <> input_total_rows
     or v_distinct_codes <> input_total_rows
     or v_first_row <> 1 or v_last_row <> input_total_rows
     or v_invalid_rows <> 0 then
    raise exception 'STAGED_RELEASE_ROW_INTEGRITY_FAILED';
  end if;

  -- Only the initial staged -> validated transition computes and records an
  -- automatic audit. A workflow retry cannot overwrite an administrator's review.
  v_audit := v_release.brand_identity_audit;
  v_error_code := v_release.error_code;
  v_error_message := v_release.error_message;
  if v_release.status = 'staged' or v_recovering then
    begin
      v_audit := supplier_price_validation_internal.cross_brand_audit(input_release_id);
    exception when undefined_table or undefined_column or insufficient_privilege then
      v_audit := jsonb_build_object('policy','cross-brand-v1','checked',false,
        'review_required',true,'reason','BRAND_IDENTITY_COMPARISON_UNAVAILABLE');
    end;
    v_error_code := null;
    v_error_message := null;
    if not coalesce((v_audit->>'checked')::boolean, false) then
      v_error_code := 'BRAND_IDENTITY_COMPARISON_UNAVAILABLE';
      v_error_message := 'File validated; brand comparison is unavailable. Complete checks before publication.';
    elsif coalesce((v_audit->>'review_required')::boolean, true) then
      v_error_code := case when coalesce((v_audit->>'distinct_incoming_codes')::bigint,0)=0
        then 'BRAND_IDENTITY_EMPTY_CODES' else 'CROSS_BRAND_BULK_OVERLAP' end;
      v_error_message := 'File validated; brand identity needs review before publication.';
    end if;
    update public.supplier_price_releases r
       set status = 'validated', validated_at = now(), updated_at = now(),
           accepted_rows = input_total_rows, rejected_rows = 0,
           warning_rows = 0, conflict_rows = 0,
           worker_version = 'duckdb-validation-v3',
           brand_identity_audit = v_audit,
           error_code = v_error_code, error_message = v_error_message
     where r.id = input_release_id;
    insert into public.supplier_price_release_events
      (release_id,event_type,stage,status,cursor,processed_rows,total_rows,
       worker_version,error_code,error_message)
      values (input_release_id,'release_validated','validation',
        case when v_error_code is null then 'completed' else 'review' end,
        input_total_rows,input_total_rows,input_total_rows,
        'duckdb-validation-v3',v_error_code,v_error_message);
  end if;

  v_publishable := v_error_code is null
    and coalesce((v_audit->>'checked')::boolean, false)
    and not coalesce((v_audit->>'review_required')::boolean, true);

  return query select 'validated'::text,input_release_id,'validated'::text,
    v_release.total_rows,input_total_rows::bigint,0::bigint,0::bigint,0::bigint,
    0,0,1,v_publishable,
    coalesce(v_error_message,'File, staged rows and brand identity validated; publication is a separate decision.')::text;
end;
$function$;

revoke all on function public.complete_supplier_price_release_duckdb_validation(
  uuid,integer,integer,integer,integer,integer,integer,integer,integer)
  from public,anon,authenticated;
grant execute on function public.complete_supplier_price_release_duckdb_validation(
  uuid,integer,integer,integer,integer,integer,integer,integer,integer)
  to service_role;

NOTIFY pgrst, 'reload schema';
