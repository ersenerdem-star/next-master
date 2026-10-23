# Import/export optimization results — 23 October 2026

This implements the first measured changes from [the performance review](IMPORT_EXPORT_PERFORMANCE_REVIEW_20261023.md). Work was performed in `/Users/ersen/.codex/worktrees/supplier-catalog-enrichment/next-master`, branch `codex/denso-catalog-resume`; the original dirty checkout was preserved. This includes measured configuration changes and prepared-file lifecycle changes, with unchanged price calculations, explicit publication rules and durable ingestion workflow semantics.

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

Rollout evidence for this phase: 52 local contract, authorization, cache, validity-boundary, bulk revision, event-fairness, continuation and recovery checks passed. All six migrations applied to staging and production. The staging 999,997-row source-version check took 50.256 ms. Runtime evidence follows; it is distinct from local tests.


### Prepared-file runtime acceptance

Staging deployment `6adb8c35b7a04b3f3f4ca74a` runs UI/functions source `fcda1e4a`. Exact-target automatic schedule metadata confirms the minute recovery/preparation tick. Its worker is EU-West-1 with 1,024 MB, as reported by the actual deployed function metadata; no resource increase was made.

- A real QA-authenticated 999,997-row admin request adopted existing verified workbook `0296d1da-7e9e-420c-82be-a348b7f8dec9` as receipt `20ffb058-717a-4c74-b101-eeab9ec4d0b7`, already finalized and `cached:true`. The request took 4.841 seconds including authorization/admission. **This is a ready-file API response measurement, not full file transfer time.**
- Eight parallel, real authorized API requests for one isolated three-row/margin profile returned HTTP 200 and the same job `b283bb5a-af5b-43c7-8d00-9a300068b0a8`; one snapshot was created. Combined request wall time was 3.920 seconds. The actual saved workbook read back prices 11.70, 23.40 and 35.10 EUR.
- Only the named staging fixture supplier/brand `PERF Prepared Files 20261023` was changed: first buy price 10 → 12 EUR at 16:34:12.048 UTC. Without a download request or manual scheduler invocation, job `2fd1ee92-c7e7-4649-b5ea-bdd02a52ff18` was created at 16:35:07.306 and ready at 16:35:10.318, about 58.27 seconds after the change. Reading the actual new Excel verified 14.04, 23.40 and 35.10 EUR at the same 17% margin; SHA-256 `82860f90e6ec9d090306667899db84dc102269d444e8274588a051ac93a379c0`.
- A second fixture profile was also prepared automatically. Its newly created access receipt `e6c29322-f789-4eab-a242-7c3cfa4a9fc6` was temporarily expired for testing. The real start API returned fresh finalized receipt `164fc47a-2ee7-4c28-984a-6833225984ba`, `cached:true`, in 3.382 seconds, referencing the exact same 6,146-byte private object. Original expiry was restored; no workbook was deleted or regenerated.
- A multi-row legacy insert exposed an existing revision trigger bug: `DISTINCT` included volatile `clock_timestamp()`, so one scope could be inserted multiple times. The scoped fix uses statement-stable timestamps. A 500-row insert/update/delete regression verifies one revision per affected brand/statement; the actual staging fixture then inserted successfully.
- Live portal session/default-card refreshes exposed no-op UPDATE events that repeatedly dirtied every profile. The follow-up migration compares actual relevant fields and selects never/least-recently checked profiles before ties on ID. Local regression and a real staging no-op session update verified zero requeues. Production reconciliation then advanced from Donaldson to Bosch, Corteco and Mercedes with unchanged revision 11, rather than repeatedly selecting one brand. Failure backoff remains fifteen minutes, including events arriving during a failed claim.

### Production prepared-file proof

Production deployment `6adb8e06dddcd44db89092fe` serves UI/functions source `fcda1e4ad086c6459150f4705da6c878766dd673`; the follow-up DB event/fairness migration is recorded in source `22593a89`. All four pre-existing client feature gates remain enabled. The worker is EU-West-1 / 1,024 MB; the site's other functions retain their region. Private server-only RPC grants were reread: anonymous and authenticated roles cannot execute admission, source-version or preparation-claim RPCs.

The existing authenticated Chrome admin requested VAG and saved through the native picker as `admin-prepared-vag-20261023.xlsx`. New finalized receipt `01c9e563-d9dc-4669-9774-9079a77c8cde` was created/finalized at 16:48:58.462/16:48:58.463 UTC, with `started_at` null and **zero snapshots for this receipt**. It references the original immutable object. The actual saved file is 40,511,355 bytes / 1,615,023 rows and SHA-256 `1cacdf77b16170a0a61f6dddb46519563d53420ae46f952fcf12c5be3579fb30`, identical to the previously fully parsed workbook. No seven-minute generation was started by this download.

The existing authenticated Ersen customer requested Bosch and saved `portal-prepared-bosch-20261023.xlsx` through the same native picker flow. Audit event 16:51:46.782 UTC records `cached:true`, job `c2ad5987-4128-49ff-a69a-b31fe1a9bb20`. Its `started_at` is null and creation/finalization were 16:51:46.354/16:51:46.355. The 1,289,517-byte / 46,773-row saved file is byte-identical to the prior fully verified customer workbook, SHA-256 `f45b103ffbba7d165ebe453fd435d2b2a5b4ff1ea520ae7649e4feaf1db9c8f3`. A different Bosch customer profile was independently prepared by the scheduler; it is not treated as the same customer pricing.

At the post-release observation, 26 known profiles were registered, four had been reconciled and no profile errors were recorded. Initial preparation of the remaining profiles continues through the deployed scheduler. This is not a claim that every possible customer/brand/margin combination is already prepared. Production publication pointers remained 25; the same before/after digest recipe returned `4eaf8d8b33082e2f235687a3f8c503e1`. No production price publication, customer margin edit or DBOS reset was performed.

Security advisors were reread after rollout. The three new metadata tables intentionally have default-deny RLS with no browser policies; direct browser grants are absent and only narrow server paths access them. The repository-wide secret scanner still flags three pre-existing local Docker test connection templates interpolating random passwords; none is introduced by these changes, and no scanner suppression or credential change was made.

### Applied migration receipts

MCP allocates hosted history versions when each migration is applied. Match these by name and SQL content; local CLI-generated filenames have different timestamps. Do not replay the create-table migrations blindly as pending solely because hosted timestamps differ.

| Migration | Local filename timestamp | Staging history version | Production history version |
| --- | --- | --- | --- |
| prepared_price_list_artifact_versions | 20261023160816 | 20261023161751 | 20261023163919 |
| prepared_price_list_admission_and_prewarm | 20261023160946 | 20261023161759 | 20261023163933 |
| prepared_price_artifact_adoption_and_events | 20261023161916 | 20261023162125 | 20261023163938 |
| prepared_price_prewarm_failure_backoff | 20261023162831 | 20261023162851 | 20261023163943 |
| supplier_price_revision_distinct_scopes | 20261023162929 | 20261023163033 | 20261023163948 |
| prepared_price_profile_event_fairness | 20261023164519 | 20261023164655 | 20261023164736 |

## Sales-order price lookup follow-up: canonical SACHS article keys

Order `SO-20261023-8705` contained eight unpriced SACHS lines using six-digit article presentation codes such as `311.409`; the current published prices use `311409`. The 13 October exact-SKU change (`fe03c501`) replaced the single-line reader's former alphanumeric normalization with punctuation-preserving exact matching to protect distinct products such as `61/1` and `611`. The ZF registry's whitespace-only policy dates to `2abc469d`. The SACHS presentation alias was not represented at the quote lookup boundary.

The shared price-code canonicalizer now accepts only SACHS numeric `DDD.DDD` as `DDDDDD`, retains leading zeros, and preserves other SACHS families and other brands' meaningful punctuation. CSV import, single-line resolution and explicit sales-order resync use this boundary. Uploaded `requestedCode` remains intact; the resolved lookup code is canonical. This does not rewrite catalog products, supplier rows, historical invoices, publication pointers or saved order prices outside an explicit application action.

Resync also bounds price lookups to four concurrent requests and shares exact brand/SKU reads across duplicate order lines while retaining each line's quantity and supplier selection. Its result reports newly filled, still-unpriced and failed-lookup counts instead of an unconditional completion label. Existing-price preservation and fail-closed explicit repricing remain covered.

Validation: 33 focused import, single-line, resync, supplier-commercial and exact-SKU tests passed; TypeScript/Vite production build passed. These local checks are separate from the subsequent production deployment and authenticated runtime acceptance.

Production acceptance: Netlify deployment `6adb9e21c1b09cabbf4ca734` (`production`, `ready`) published source `1c7bc02edc5b1e6db96f514b9fc21c31dc66a6f7` at 17:49:35 UTC. Public version metadata confirms this commit, production target and the same four enabled client features. Deployment uploaded 44 client files and zero changed functions, preserving the export worker and scheduler implementation.

Authenticated Chrome opened the actual draft `SO-20261023-8705` and invoked Resync from catalog with both Fill blanks only and Keep prices checked. At 17:51:25 UTC the saved order contained all 237 original lines: 15 newly priced lines (eight SACHS, seven Delphi), 170 priced lines total, 67 still unpriced and zero lookup failures. A before/after comparison by stable line ID found no changed buy price, sell price, supplier selection or quantity on the original 155 priced lines, and no quantity changes across all 237 lines. Original uploaded SACHS codes remain in `requestedCode`; `resolvedCode` uses the six-digit canonical article. The order remains a draft. All 25 publication pointers retain digest `4eaf8d8b33082e2f235687a3f8c503e1`. No price publication or source activation was performed. Receipt: `scripts/ops/evidence/sales-order-canonical-codes-production-20261023.json`; screenshot/build/deploy logs: `artifacts/batch-optimization-20261023/order-canonical-*`.
