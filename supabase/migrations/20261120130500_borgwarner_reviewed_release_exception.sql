-- Owner-approved exceptions for these three exact, verified GroupAuto files.
-- Other releases retain the existing cross-brand review rule unchanged.
do $migration$
declare
  definition text := pg_get_functiondef('supplier_price_validation_internal.cross_brand_audit(uuid)'::regprocedure);
  insertion text := $insert$
  if v_result->>'checked' = 'true' and v_result->>'review_required' = 'true'
     and v_release.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
     and v_release.supplier_id = 'bb8aa954-5c9c-4edb-8c25-37e170253a1b'::uuid
     and v_release.status in ('validated','review_required')
     and v_release.source_verification_required is true
     and v_release.accepted_rows = v_release.total_rows
     and v_release.rejected_rows = 0 and v_release.conflict_rows = 0
     and exists (
       select 1 from (values
         ('f4ab679d-fbd7-4b05-8483-23362727f3c6'::uuid,'6a667fc1-3785-4f02-88fd-031b02cc9d50'::uuid,'28404f30319ef59d83bea72f9e7a9c5b60f2c5988a866d5e1640046369d7b02d',492::bigint,'e7d121f2b5b2dd2b460ad1f894c6bf66'),
         ('3242b9b7-d4d4-461e-a152-fd446851b571'::uuid,'de39a284-7a8b-4c55-a58c-84b390ae19fc'::uuid,'b887af330dfc5383220046285918a6f8e2ce33f194e45df05e34cb50ac189832',1916::bigint,'7d153519ea914710fa4e9a33734f89ac'),
         ('8bcc1c47-eac9-488e-92cc-1d9175523d9a'::uuid,'bc9c1aaf-8a74-4add-890d-624580da5df0'::uuid,'0c9c039fb63bbfd93902606a6ee42b72d6825f414254295ea76fdbe3a64a7654',78::bigint,'559efd6adc8dad8c17d051d3bf0d88ca')
       ) approved(release_id,brand_id,sha256,row_count,row_digest)
       where approved.release_id=v_release.id and approved.brand_id=v_release.brand_id
         and approved.sha256=v_release.source_file_sha256 and approved.row_count=v_release.total_rows
         and (select count(*) from public.supplier_price_release_rows rr where rr.release_id=v_release.id and rr.row_status='accepted')=approved.row_count
         and (select md5(string_agg(rr.source_row_number::text||'|'||rr.product_code||'|'||to_char(rr.buy_price,'FM999999999999990.00'), E'\n' order by rr.source_row_number))
              from public.supplier_price_release_rows rr where rr.release_id=v_release.id)=approved.row_digest
     ) then
    v_result := v_result || jsonb_build_object('review_required',false,
      'original_review_required',true,'owner_approved_exception','groupauto-borgwarner-20261120',
      'exception_scope','exact_release_and_file_and_rows');
  end if;
  return v_result;
$insert$;
begin
  if md5(definition) <> '92a5198c6c9571324f877a6fa092895e'
     or position('  return v_result;' in definition)=0 then
    raise exception 'BOR WARNER AUDIT DEFINITION CHANGED';
  end if;
  execute replace(definition, '  return v_result;', insertion);
end
$migration$;
