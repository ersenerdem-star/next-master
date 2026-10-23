# Import/export performance review — 23 October 2026

Scope: compare the successful V3 staging engine with the currently deployed production paths, and define reviewable optimization conditions. This review does not change production settings, deployment versions, DBOS history, publication pointers, or order prices.

## Findings

The engines are connected and used. Production supplier releases record `duckdb-validation-v3`; source verification, durable handoff and batch receipts exist. Render shows the production supplier worker deployed at `8f3fe51cd765e39c04868953c03ab762e31c0e61`, deployment `dep-dbb64kqgjjms73d5pr30`, on 1 CPU / 2 GB. Its five core worker/source/version files match the current checkout. Live Environment confirms `SUPPLIER_PRICE_LOCAL_STREAM_ENABLED=1` and `SUPPLIER_PRICE_SHADOW_BATCH_SIZE=250`.

Price-list export runs through `portal-export-worker-background` on Netlify for both admin and customer lists. Render's supplier upgrade therefore does not add CPU or memory to the price-list Excel writer. A durable export workflow module exists in the repository, but the deployed price-list handler calls the Netlify bridge; the module's existence is not proof of a live Render/DBOS export integration.

### Staging evidence versus production

| Observation | Verified result | Interpretation |
| --- | --- | --- |
| Staging Clevite admin export, 14 October | 999,997 rows; best successful job 341.57 seconds | A complete file was produced in 5m42s; this is not browser transfer time alone. |
| Staging Clevite customer export, 14 October | 999,997 rows; job `203f8f96-0f8f-44a7-94a8-afac2ba4c43b`; 523.71 seconds | Authenticated customer export completed in 8m44s. File parity was checked in the original acceptance. |
| Staging Clevite upload acceptance | Source verified at 13:55:25 UTC; initial validation receipt at 15:16:21 UTC; 1,000 batches | The source transfer was about two minutes. End-to-end validation included preparation, a failed heartbeat and controlled recovery; the first acceptance took about 83 minutes from session creation. A later revalidation changed the live `validated_at`, so it must not replace the original acceptance receipt when timing this run. |
| Production Mercedes upload, 21 October | 1,443,855 rows; 5,776 batches of at most 250 rows; verification-to-validation 44m04s | More batches than the staging configuration. All batch attempts were 1; repeated retries do not explain this completed run. |
| Production Delphi upload, 23 October | 28,151 rows; 113 batches; 46.37 seconds after source acceptance | The same 250-row configuration remains active today. |
| Production VAG export, 19 October | 1,615,023 rows; 52m46s job wall time | This is an incident/recovery duration, not clean continuous throughput. |

The production VAG snapshot completed at 09:19:28 UTC, approximately 13 minutes after job creation. At 09:19:56 the old DuckDB CSV auto-detection rejected the correctly quoted `FOLIA3,5` code. At 09:29:15 a later attempt failed with `EXPORT_TUS_HTTP_400`. The final successful invocation started at 09:55:14 and ran for 240,291 ms, ending at the recorded 09:59:14 finalization. These errors and recovery gaps must not be attributed to CPU speed. Commit `aa1c4e2a` pins the internal CSV dialect explicitly and is included in the current deployed client/functions revision; current code keeps strict parsing and does not skip bad rows.

### Configuration and work amplification

The reviewed staging upload used 1,000-row batches; both committed Render Blueprints still specify 1,000. The live production environment is 250. Mercedes therefore used 5,776 batches instead of the 1,444 required at 1,000 rows. Changing that setting would reduce the number of batch turns by 75%; it does not prove a 75% runtime reduction.

The compact workflow performs separate lease-owner, claim, manifest, scan/stage, heartbeat and finalize steps per batch, with durable checkpoints. Additional database/HTTP round trips remain even when the row insert itself is fast. Current Postgres statistics show 474 stage-v2 calls averaging 46 ms; these are aggregate current statistics, not a complete reconstruction of the historical Mercedes run. Mercedes batch wall time averaged 353 ms, with p95 470 ms. The remaining time includes network, durable orchestration and other steps; it cannot all be assigned to one cause without per-stage runtime measurements.

Export uses 5,000-row authorized snapshot pages, then reads the sealed snapshot, sorts/projects with DuckDB, writes/verifies partitions, assembles XLSX and uploads the immutable artifact. Today’s Bosch job has 10 committed pages / 46,773 rows: page timing sums are 19.526s pricing RPC, 2.824s replacement lookup, 5.659s snapshot insert and 35.349s total page wall time. Complete export preparation was 57.019s. The pricing, transaction and page values overlap; they must not be added together.

Netlify reports production functions in `us-east-1`, staging in `us-east-2`; database connections use the EU-West Supabase pooler, while Render is Frankfurt. This is an optimization opportunity across both environments, not proof that region alone caused the production regression.

`netlify.toml` assigns 2 GB to `admin-export-background`, which serves catalog/master/supplier exports. It does not assign memory to `portal-export-worker-background`, the function serving both price-list audiences. The historical VAG invocation reported 1,009 MB usage. The effective current per-function allocation was not returned by the attempted provider API read; source configuration and historical peak alone are not a current allocation measurement. Netlify documents a 1,024 MB default, per-function resource controls on eligible Pro/Enterprise plans and a fixed 15-minute background invocation limit. A database compute upgrade cannot extend that limit.

Four important SQL definitions are byte-identical between staging and production: both price-list page functions, stage-v2 and source-version calculation. The DuckDB completion function differs: staging also has an origin-variant contract. That is a functional acceptance difference requiring explicit coverage, not evidence that copying all staging SQL is a safe performance fix.

## Optimization sequence and release conditions

| Priority | Concrete candidate | Required evidence before production |
| --- | --- | --- |
| 1 | Compare upload batches 250 → 500 → 1,000, retaining one worker | Same exact immutable file, same commercial fields and parser version. Measure source preparation, each batch phase, DBOS/history latency, SQL time, payload bytes, retries and final integrity. 1,000 is already within the service's hard limit. |
| 1 | Deploy a reviewed batch setting for new uploads | No in-flight old-batch workflow or prepared manifest may be rebound. Preserve successful checkpoints and publication pointers. Recheck the live environment after deployment; the Blueprint alone is insufficient. |
| 1 | Retest million-row export using the currently fixed CSV/Storage path | Reuse staging Clevite with current code, then a controlled production real-brand export. Include comma/quote/newline SKUs and files larger than one Excel sheet. Separate cold generation from cached file retrieval. |
| 2 | Reduce upload orchestration round trips where measurements justify it | Any combined lease/stage/progress operation must preserve ownership, exact replay, immutable-source identity, row counts and error diagnostics. Give changed durable workflow semantics a new version; do not alter replay of old jobs. |
| 2 | Test price-list worker resources and EU proximity independently | Read effective allocation and current CPU/memory first. Change the function that actually builds price lists. Compare region and resources one at a time, preserving signed handoffs, production-only gates, auth and pricing fences. Increased memory changes billing; it is not a free global speed switch. |
| 2 | Measure every export stage and continuation gap | Retain per-job timestamps for authorization/version, snapshot, DuckDB materialization, partition creation, XLSX assembly, artifact transfer and recovery. A finalized job's total alone cannot identify the bottleneck. |
| 3 | Consider a continuously running Render export worker only if necessary | The existing DBOS export module must first be connected through guarded auth/context, durable admission, artifact receipts and current-price fencing. Prove same prices/files and restart continuation; do not treat an unused module as a production capability. |

### Proposed acceptance targets (not measured promises)

- 50,000-row cold price-list export: at most 60 seconds in the agreed test profile.
- 999,997-row cold customer export: restore the approximately 9-minute proven staging result, with an initial upper bound of 10 minutes under comparable conditions.
- 1,000,000-row supplier validation: target 10 minutes, subject to the controlled batch comparison. Current evidence does not prove that target achievable by changing one setting.
- Cached export: return the existing valid artifact without regenerating rows; measure network transfer separately.
- A single ambiguous code must yield an actionable review result and must not stall unrelated catalog work. Export row integrity still forbids silently skipping a priced row.
- No missing/duplicate source identities, exact expected row counts and price/profile parity, preserved explicit origins/tariffs/lifecycle fields, no pricing-publication change during export, and successful restart/lease-expiry recovery.
- Start with one active job, then two concurrent users. Compare median and slow cases; do not announce p95 capacity from a handful of samples.

Do not solve these symptoms by increasing every timeout, disabling certificate verification, removing authorization/version checks, resetting DBOS history or purchasing another tier before measuring the responsible stage.

## Evidence

- Original staging acceptance: `scripts/ops/evidence/price-engine-export-matrix-20261014.json` and `scripts/ops/evidence/supplier-compact-history-v3-recovery-20261014.json`.
- Fresh read-only runtime/SQL comparison and bounded historical Netlify logs: `artifacts/engine-performance-review-20261023/`.
- Current timing and direct Storage transfer checks: `artifacts/transfer-performance-20261023/`.
- Current live settings were read in the authenticated Render service UI; no Edit/Save, restart, deployment, export retry or publication was performed during this review.
- Official provider limits: https://docs.netlify.com/build/functions/configuration/ .
