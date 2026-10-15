-- The replacement publication pipeline bypasses legacy import-run triggers.
-- Reuse the existing portal notification feed only after a published release
-- owns the current supplier/brand pointer. This sends no email or chat message.
create unique index portal_price_publication_notice_unique on public.portal_audit_logs
 (invite_id,(details->>'publication_id'))
 where event_type='portal_price_list_updated' and details->>'publication_id' is not null;

create function public.emit_portal_published_price_notice(input_publication_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare inserted_count integer;
begin
 insert into public.portal_audit_logs(organization_id,invite_id,party_type,email,event_type,status,details)
 select p.organization_id,i.id,i.party_type,i.email,'portal_price_list_updated','ok',
   jsonb_build_object('publication_id',p.id,'release_id',p.release_id,'brand_id',p.brand_id,
     'brand_name',b.name,'publication_version',p.publication_version,'published_at',p.published_at,
     'message',format('The new %s price list is now available in your customer portal.',b.name))
 from public.supplier_price_publications p
 join public.supplier_current_price_pointers cp on cp.publication_id=p.id and cp.release_id=p.release_id
   and cp.organization_id=p.organization_id and cp.supplier_id=p.supplier_id and cp.brand_id=p.brand_id
 join public.brands b on b.id=p.brand_id and b.organization_id=p.organization_id
 join public.portal_invites i on i.organization_id=p.organization_id
 where p.id=input_publication_id and p.status='published' and p.published_at is not null
   and i.status='active' and i.party_type='customer' and i.customer_id is not null
   and not(coalesce(i.excluded_brand_ids,'[]'::jsonb) @> jsonb_build_array(p.brand_id::text))
   and (coalesce(i.allowed_brand_ids,'[]'::jsonb)='[]'::jsonb
        or i.allowed_brand_ids @> jsonb_build_array(p.brand_id::text))
 on conflict do nothing;
 get diagnostics inserted_count=row_count;
 return inserted_count;
end $$;
revoke all on function public.emit_portal_published_price_notice(uuid) from public,anon,authenticated,service_role;

create function public.notify_portal_current_price_publication() returns trigger
language plpgsql security definer set search_path='' as $$
begin
 if tg_table_name='supplier_price_publications' then
   if new.status='published' then perform public.emit_portal_published_price_notice(new.id);end if;
 else
   if tg_op='UPDATE' and new.publication_id is not distinct from old.publication_id
     and new.release_id is not distinct from old.release_id then return null;end if;
   perform public.emit_portal_published_price_notice(new.publication_id);
 end if;
 return null;
end $$;
revoke all on function public.notify_portal_current_price_publication() from public,anon,authenticated,service_role;
create trigger portal_current_price_publication_notice
 after insert or update of publication_id,release_id on public.supplier_current_price_pointers
 for each row execute function public.notify_portal_current_price_publication();
-- Also handles a publication being finalized after its pointer was written.
create trigger portal_published_price_status_notice
 after insert or update of status on public.supplier_price_publications
 for each row execute function public.notify_portal_current_price_publication();

-- Repair only missing notices for recent CURRENT releases. Historical and
-- superseded imports (including September's legacy upload) remain untouched.
select public.emit_portal_published_price_notice(p.id)
 from public.supplier_price_publications p
 join public.supplier_current_price_pointers cp on cp.publication_id=p.id
   and cp.release_id=p.release_id and cp.organization_id=p.organization_id
   and cp.supplier_id=p.supplier_id and cp.brand_id=p.brand_id
 where p.status='published' and p.published_at>=now()-interval '7 days';
