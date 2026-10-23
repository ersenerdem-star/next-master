# Import/export optimization results — 23 October 2026

This implements the first measured changes from [the performance review](IMPORT_EXPORT_PERFORMANCE_REVIEW_20261023.md). Work was performed in `/Users/ersen/.codex/worktrees/supplier-catalog-enrichment/next-master`, branch `codex/denso-catalog-resume`; the original dirty checkout was preserved. This is a configuration and measurement change, with unchanged pricing/publication rules and durable workflow semantics.

## Upload: compare first, then activate

The existing staging Render worker was aligned with production's local-stream reader and commercial-field/v7 workflow. Each candidate used the same 50,003-row, 3,849,283-byte CSV, SHA-256 `a024b77c1e8214b7800ea4c28cfe289556ee4d1f038c2ce5995435f1eba71d5f`. Three dedicated staging suppliers isolated the unpublished releases. Admission, private Storage, real Auth verification intent, the Render verifier, DBOS 5.2.11 and the actual Supabase batch RPCs ran; the direct runner was not substituted for the worker.

| Batch | Completed batches | Verified handoff to validation | Admission to validation | Retries |
| --- | ---: | ---: | ---: | ---: |
| 250 | 201 | 185.193 s | 195.261 s | 0 |
| 500 | 101 | 66.765 s | 78.507 s | 0 |
| 1,000 | 51 | 39.090 s | 53.248 s | 0 |

All three runs persisted exactly 50,003 distinct source rows, zero erroneous rows, and the same ordered row-hash digest `a399ecb5b3de10c411a16427903fd692`. Full-row checks covered code, price, origin, tariff, market segment, stock, order multiple and both validity dates. Each release remained unpublished. The largest serialized 1,000-row staging request was 633,154 bytes; it remained bounded rather than moving the complete file into a request or DBOS checkpoint.

These are individual observed runs, not a capacity SLA or cross-workload p95. The final 22 seconds of the intermediate 500-row run overlapped the beginning of an export test. The decisive 250-versus-1,000 ingestion runs were isolated from exports. Network/cache variation also prevents assigning the complete measured speed ratio to batch size alone.

Local acceptance included 70 existing source/workflow/service checks, a deterministic fixture/production-refusal test, and real DBOS v5/v7 crash/restart tests on PostgreSQL 17. The crash window was after the stage commit and before its durable checkpoint: recovery inserted the 1,000 business rows once, retained lease identity, and kept row payloads out of DBOS history. Existing history drain and unauthorized/changed replay guards passed.

Production was checked for unfinished releases and verification requests immediately before deployment; both counts were zero. Only `SUPPLIER_PRICE_SHADOW_BATCH_SIZE` changed from 250 to 1,000. The worker kept source commit `8f3fe51cd765e39c04868953c03ab762e31c0e61`, one execution, local stream and its existing history database. Render deployment `dep-dbdo07cs728c73ckakl0` reported application `0.11.0-measurement-diagnostics`, `batchSize:1000`, `executionLimit:1` at 15:41:54 UTC.

Operational detail: Save only followed by Restart service did not apply newly saved environment values in the staging check. A deployment of the same explicit commit did. Always verify the started worker's setting; an Environment page or Blueprint is insufficient evidence.

### Full-scale staging validation

A separate unpublished release `7224443d-dafa-4e1c-81ec-8dbfa9fea7a4`, session `eaa2298e-d029-4492-aec8-05f390d1ab1e`, uses the original 999,997-row Clevite acceptance source. Source bytes 48,752,699; SHA-256 `f63f5e17d84ebff66f2c0d1465e5684e8c4bce7e4694379c1f304d0ac33b440d`; source date 2026-10-14. The original object was copied to the newly admitted private staging path, leaving the original publication intact. This measures source verification/preparation and the real ingestion worker; it does not measure browser hashing or TUS transfer speed. The release validated at 16:05:40.535 UTC: 999,997 distinct accepted source rows, covering row numbers 1–999,997; 1,000 completed batches of at most 1,000 rows, zero retries, warnings, conflicts or rejections, no publication. Admission to validation took 12m35.544s; verified source to validation took 12m02.993s. The proposed ten-minute target was not met; a 50,003-row run must not be extrapolated as proof of million-row throughput.

## Export: isolate region from memory and pricing

`portal-export-worker-background` serves both admin and customer price lists. Only this function moved from the site's US default to `dub` (Ireland), near the existing EU-West database. Source configuration and `netlify.toml` agree. Other functions retained their site region. No memory, vCPU, plan, concurrency or timeout setting was raised. This uses Netlify's documented per-function region option: https://docs.netlify.com/build/functions/configuration/#in-code .

The bridge now emits bounded stage timing records for authorized snapshot, DuckDB materialization, partitions, XLSX assembly and artifact commit, including process CPU/RSS samples and available platform allocation metadata. Logs omit row payloads, prices, scope, credentials and exception text; a telemetry failure cannot change the fenced business result. Process RSS is a sample, not a per-stage peak. Historical CLI log retrieval did not yet return the new invocation's individual messages, so successful job timestamps and deployed region metadata are the current comparison evidence; do not present an unreturned allocation as measured.

| Same staging export | US `cmh` | Ireland `dub` |
| --- | --- | --- |
| Deployment | `6adb7c16ab46910fdc07bb06` | `6adb7e89b9720f1288d9e9a7` |
| Job | `528dc88c-6869-4793-bf6c-9a82ad495ffe` | `0296d1da-7e9e-420c-82be-a348b7f8dec9` |
| Rows | 999,997 | 999,997 |
| Creation to ready | 483.324 s (8m03s) | 264.113 s (4m24s) |
| Bytes | 25,377,743 | 25,377,743 |
| Source version | `31178214afb2c340fc6b54fa530cad18` | Same |
| Workbook SHA-256 | `349758a99358c96c231ffa9b7e869eefefad0d25d8e40cb3d135ad58065abbc5` | Same |

The region test changed no SQL, pricing, workbook writer or resource allocation. The baseline job was returned from cache in 4.729 seconds with the same job ID. Only this newly created test job's expiry was temporarily shortened to admit a cold comparison; its original expiry was restored. Neither artifact nor snapshot was deleted. These are individual measurements; the first run's initial overlap with the end of the 500-row ingestion test and ordinary cache variation remain comparison limits.

An opt-in full-file local test also generated and read back 1,048,577 synthetic rows through the actual DuckDB/partition/XLSX path. It verified every code, description, numeric price, date and lifecycle, including late commas/quotes/newlines. Sheet row counts were 1,048,576 and 3, including headers. That local result is not hosted throughput proof.

## Production release and authenticated file proof

Netlify production deployment `6adb80b678a1e8b3ade4df05` has production context, source `ec0a8e3136cd8468c3e02c9d06804caceb5464a1`, all four existing client features enabled, site default `iad`, and only the price-list worker overridden to `dub`. The production build helper and Linux DuckDB bundle verifier were used. Production-only catalog gates were preserved.

The existing authenticated Chrome admin started a cold VAG export, job `ca820bdc-16f3-4626-8356-62477b0921fe`: 1,615,023 rows, 40,511,355 bytes, created 15:46:24.390 UTC, finalized 15:53:26.960 UTC (422.570 seconds / 7m03s). Its file was transferred through the application, saved through the native picker to the selected QA folder, and fully read back. Sheet counts including headers were 1,048,576 and 566,449; the previously problematic `FOLIA3,5` SKU was preserved. File SHA-256 `1cacdf77b16170a0a61f6dddb46519563d53420ae46f952fcf12c5be3579fb30` equals the earlier valid VAG customer artifact. The older 53-minute incident/recovery duration remains an incident, not a comparable clean baseline.

While the admin job ran, the existing authenticated Ersen customer session requested Bosch. The valid cached artifact was reused, saved through the application's native location picker, and fully read back: 46,773 rows, 1,289,517 bytes, five approved customer columns, SHA-256 `f45b103ffbba7d165ebe453fd435d2b2a5b4ff1ea520ae7649e4feaf1db9c8f3`. This exercises two user flows concurrently, not two simultaneous cold million-row generation jobs.

The production publication-pointer digest before/after deployment and exports was `73dc1c9f2a9d787ecff9a1170a0be7fe`. No price list was published, old release reset, DBOS history cleared, or customer price setting saved by this work. Catalog job completions continued after the deploy; this is continuity evidence, not a claim that the whole catalog is complete.

## Evidence and remaining measurement boundary

- Runtime receipts, exact verification SQL, deployment/build/test logs and actual saved QA files: `artifacts/batch-optimization-20261023/`.
- Reproducible bounded upload admission: `apps/engine/supplier-price-shadow/src/staging-batch-benchmark.mjs`; its production target is explicitly refused.
- Full Excel limit test: `RUN_PRICE_EXPORT_MILLION=1 node --test scripts/tests/price-export-million-roundtrip.test.mjs`.
- No new customer upload was fabricated in production. The 1,000-row production setting is proven by the running worker; new production file throughput remains a separate observation from staging throughput.
- The full-scale ingestion test completed without errors, but exceeded the proposed ten-minute target. Further orchestration changes need separate restart/replay evidence; this release preserves the workflow semantics.


## Prepared price files: publication snapshots, not repeated exports

The user explicitly requested that an unchanged price list be created once, then downloaded as a ready file until relevant prices change. The earlier 7m03 VAG observation measures cold Excel preparation, not file transfer. Reducing that preparation time alone does not satisfy this requirement.

The prepared-file contract keeps immutable private Storage objects across the seven-day access-receipt lifetime. A complete, matching, still-present object receives a fresh authorized receipt when necessary. Short-lived signed URLs, current portal entitlement, customer-specific pricing and the private bucket remain in force. Exact tenant/profile/version admission is serialized to prevent concurrent clicks from building duplicate files. Missing or incomplete objects regenerate through the existing fenced writer.

New price jobs use `publication-v1`. Its version changes with price publication pointers, legacy commercial source revisions, effective validity boundaries (including inclusive expiry), product identity/lifecycle, replacements or relevant customer pricing. It does not change simply because a date rolls over or a catalog worker updates images, weights, origins, tariffs or descriptions. **Descriptions in a prepared price file are a snapshot captured with the file and refresh on its next relevant price/lifecycle version.** Normal catalog exports retain their existing freshness contract. Legacy in-flight jobs retain their original version reader.

Current schema-v4 files may be adopted without another build only when their old complete-source fingerprint still matches the current source, the new commercial source fence agrees, and all referenced private objects have the recorded sizes. Old files are not blindly relabeled.

Previously requested admin and customer profiles are durable. Publication/pricing/scope/identity/replacement events queue their refresh transactionally; the existing exact-target minute scheduler re-resolves current actor, invite and account pricing and starts at most one automatic cold generation at a time. A fifteen-minute reconciliation check also detects temporal transitions and missed external events. A crashed preparation claim expires and can be reclaimed; an unavailable profile yields to the others. New, never-requested profiles still require their first preparation. This avoids generating every possible margin/customer combination speculatively.

No additional hosting service, plan, memory allocation or database tier is introduced. A ready download still includes authorization/signing and network transfer; a universal two-second browser guarantee is not asserted.

Rollout evidence for this phase: 49 local contract, authorization, cache, validity-boundary, continuation and recovery checks passed. All three migrations applied to staging; its 999,997-row source-version check took 50.256 ms. Staging runtime and production rollout verification are recorded after their respective gates, not inferred from these local results.
