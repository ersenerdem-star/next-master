-- Allow MIRA to stage Corteco image observations under the existing
-- observation-only TecAlliance scope. This does not grant catalog writes or
-- publication authority.

update public.catalog_external_source_trust_profiles t
set allowed_field_families = array[
  'image_reference',
  'ean_reference',
  'supplemental_description',
  'oem_reference',
  'technical_specification'
]::text[],
    updated_at = now()
from public.catalog_external_sources s
where t.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
  and t.source_id = s.id
  and s.organization_id = t.organization_id
  and s.source_key = 'tecalliance_corteco';

update public.catalog_observation_jobs j
set allowed_field_families = array[
  'image_reference',
  'ean_reference',
  'supplemental_description',
  'oem_reference',
  'technical_specification'
]::text[],
    updated_at = now()
from public.catalog_external_sources s
where j.organization_id = '1e4c5e99-e387-41aa-a6d3-cbe74558f766'::uuid
  and j.source_id = s.id
  and s.organization_id = j.organization_id
  and s.source_key = 'tecalliance_corteco'
  and j.job_key = 'mira_corteco_tecalliance';
