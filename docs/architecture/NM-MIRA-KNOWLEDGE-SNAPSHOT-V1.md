# MIRA Knowledge Snapshot v1

`GET /api/mira-missions?bridge=knowledge` exposes a bounded, tenant-scoped and
read-only operational snapshot to the authenticated Dimbax worker.

The snapshot contains only catalog completeness gaps, approved observation
channels, recent observation-run health, and queued/processing MIRA mission
metadata. It excludes customers, orders, supplier prices, credentials, and
canonical product payloads.

The route uses the existing MIRA HMAC bridge authentication and the configured
organization boundary. Database reads are performed server-side with the
service role and every query includes the configured organization filter. The
response is `private, no-store`.

Channel fields use intersection semantics: a field is advertised as runnable
only when both the observation job and its trust profile permit it. A channel
is admitted only when its source, policy metadata, trust profile, and job are
all active and explicitly allow bounded automated read-only observation.

This endpoint grants no Catalog write or Apply authority. Dimbax converts the
snapshot into `mira-knowledge-plan.v1`; collection results still return through
the governed evidence/intake path.
