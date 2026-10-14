-- Preparation only. Add the bounded multipart writer's MIME capability to the
-- existing private export bucket without changing access, size or global limits.
BEGIN;
DO $export_multipart_mime$
DECLARE bucket storage.buckets%rowtype;
BEGIN
  SELECT * INTO bucket FROM storage.buckets WHERE id='app-exports' FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'APP_EXPORT_BUCKET_BASELINE_REQUIRED'; END IF;
  IF bucket.public THEN RAISE EXCEPTION 'APP_EXPORT_BUCKET_PRIVATE_REQUIRED'; END IF;
  IF bucket.file_size_limit IS NOT NULL AND bucket.file_size_limit < 41943040 THEN
    RAISE EXCEPTION 'APP_EXPORT_BUCKET_BOUNDED_PART_CAPACITY_REQUIRED';
  END IF;
  -- NULL already permits all MIME types. Keep that configuration and avoid a
  -- write on exact replay when the existing restricted list already allows it.
  IF bucket.allowed_mime_types IS NOT NULL
     AND NOT bucket.allowed_mime_types @> ARRAY['application/octet-stream']::text[] THEN
    UPDATE storage.buckets
       SET allowed_mime_types=array_append(bucket.allowed_mime_types,'application/octet-stream'),
           updated_at=now()
     WHERE id='app-exports';
  END IF;
END $export_multipart_mime$;
COMMIT;
