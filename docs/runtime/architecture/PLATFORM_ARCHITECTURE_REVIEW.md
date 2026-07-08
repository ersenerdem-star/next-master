# ARCH-001 Platform Architecture Review

Status: architecture review only
Program: Phase 5 - System Mastery / Platformization

## Executive Answer

Yes, Next-Master can safely evolve into a Business Operating System with the current platform architecture, but only if the platform remains adapter-first and one-way:

Business Domains -> Platform Engines -> Shared Runtime -> Infrastructure

That direction is already visible in the runtime docs and shared modules. The main risk is not the existence of Import Engine or Operations Engine. The risk is letting either engine absorb domain truth, domain RPC execution, or business decisions.

Current evidence shows the right separation is emerging:

- `docs/runtime/blueprints/CATALOG_BLUEPRINT.md` keeps Catalog as domain truth.
- `docs/runtime/platform/IMPORT_ENGINE_BLUEPRINT.md` scopes Import Engine to staged imports only.
- `docs/runtime/platform/OPERATIONS_ENGINE_BLUEPRINT.md` scopes Operations Engine to visibility, readiness, retry, and audit only.
- `apps/web/src/shared/importEngine.ts`, `apps/web/src/shared/operationsEngine.ts`, and the mapper files are pure shared contracts, not truth owners.

## Evidence Base

Reviewed artifacts:

- `docs/runtime/blueprints/CATALOG_BLUEPRINT.md`
- `docs/runtime/platform/IMPORT_ENGINE_ASSESSMENT.md`
- `docs/runtime/platform/IMPORT_ENGINE_BLUEPRINT.md`
- `docs/runtime/platform/OPERATIONS_ENGINE_ASSESSMENT.md`
- `docs/runtime/platform/OPERATIONS_ENGINE_BLUEPRINT.md`
- `docs/runtime/DOMAIN_OWNERSHIP_INDEX.md`
- `apps/web/src/shared/importEngine.ts`
- `apps/web/src/shared/supplierImportStatusMapper.ts`
- `apps/web/src/shared/operationsEngine.ts`
- `apps/web/src/shared/operationsStatusMapper.ts`
- `apps/web/src/infrastructure/api/importApi.ts`
- `apps/web/src/infrastructure/api/suppliersApi.ts`
- `apps/web/src/presentation/pages/DashboardPage.tsx`
- `netlify/functions/app-rpc.mts`

## 1. Architecture Layers

Expected direction:

Business Domains -> Platform Engines -> Shared Runtime -> Infrastructure

### Review

This direction is correct.

Current runtime evidence supports it:

- Domain blueprints define observed business reality before platformization.
- Import Engine blueprint narrows a repeated staged-import pattern into a platform boundary.
- Operations Engine blueprint narrows long-running status/progress/retry into a platform boundary.
- Shared runtime modules hold pure types, status helpers, and mappers.
- Infrastructure modules and `app-rpc` still perform execution and routing.

### What is still imperfect

- The platform layer is still physically located inside `apps/web/src/shared/` and API wrappers, not in a dedicated engine runtime package.
- Operations projection is still supplier-centered in `DashboardPage` and `suppliersApi`.
- `app-rpc.mts` still contains special-case queue dispatch branches.

Those are acceptable for Phase 5 only if they remain adapter-level and pure.

## 2. Responsibility Matrix

### Import Engine

| Aspect | Current responsibility | Should own | Must never own | Future ownership |
| --- | --- | --- | --- | --- |
| Import sessions | Staged import runs, status, finalize lifecycle | Run/session contract, parser, normalizer, stage, validate, preview, finalize, recovery | Quote import, portal basket import, ad hoc CRUD uploads, background jobs with no staged origin | Catalog Import, Supplier Import, and future staged import adapters |
| Truth mutation | Finalize staged rows into domain truth | Atomic staged finalize only | Domain business logic, cross-domain truth mutation, direct UI control | Adapter-facing finalize contracts only |
| Background work | Supplier catalog sync and rollup follow-up after finalize | Queue follow-up jobs required by staged import semantics | Generic background job executor | Background job metadata for staged imports |
| Status | Import lifecycle and readiness | Canonical import status/readiness mapping | Generic operations dashboard semantics | Pure import status projection |

### Operations Engine

| Aspect | Current responsibility | Should own | Must never own | Future ownership |
| --- | --- | --- | --- | --- |
| Status surface | Supplier-centric operations rows, readiness, retry actions | Canonical operation summaries, readiness, progress, warnings, audit, retry descriptors | Truth mutation, domain validation, business decisions | All long-running status/progress surfaces |
| Readiness | Customer price readiness / warning semantics | Business readiness vs technical completion | Domain-specific transaction logic | Central operation readiness projection |
| Retry/cancel/fail | Retry affordances on failed supplier rows | Safe action descriptors and projections | Generic execution of retries without domain support | Read-only coordination and safe action routing |
| Projection | Dashboard rows and summaries | Canonical projection facade | Direct table ownership | Central operations status UI feed |

## 3. Boundary Review

### Where Import Engine ends

Import Engine ends when a staged import session has:

- begun,
- parsed and normalized rows,
- staged those rows,
- validated them,
- previewed proposed changes,
- finalized truth,
- and queued any required background follow-up work.

It may also expose retry/cancel/fail states for that staged session.

It does not continue into generic job tracking outside a staged-import context.

### Where Operations Engine begins

Operations Engine begins where operators need a canonical answer to:

- Can I continue?
- Is it done?
- Is something blocked?
- Is retry safe?

It consumes operation summaries from domain adapters and presents readiness, warnings, progress, and retryability.

### Can responsibility leak?

Yes, if either engine starts to own the other’s concerns.

Leak patterns to avoid:

- Import Engine growing a generic operations dashboard.
- Operations Engine growing staged-import finalize logic.
- Import Engine owning generic retry orchestration for unrelated jobs.
- Operations Engine owning truth mutation or business validation.

### Can duplicate logic appear?

Yes, but only in controlled adapter form.

Current safe duplication examples:

- Import status mapping -> Operations status mapping.
- Supplier readiness mapping -> Operations readiness mapping.

That duplication is acceptable while the engine contracts are still being proven, because the domain semantics are not identical.

Unacceptable duplication:

- two engines inventing different truth for the same domain action,
- two engines reimplementing the same write path,
- two engines competing for the same operation id or retry contract.

## 4. Future Engine Map

| Engine | Recommendation | Why |
| --- | --- | --- |
| Export Engine | Recommended | Repeated document/export behavior already exists and is a clear platform candidate |
| Rule Engine | Recommended | Commercial normalization, quote resolution, and pricing behavior are repeating rule surfaces |
| Workflow Engine | Optional | Useful later for orchestration, but current needs are still mostly status/readiness rather than full workflow orchestration |
| Notification Engine | Optional | Email and queued notifications exist, but the need is narrower than Import/Operations right now |
| Document Engine | Optional | Document generation exists, but export/document concerns can still be handled by a lighter export boundary for now |
| Search Engine | Optional | Search behavior is repeated across catalog and commercial views, but not yet broad enough to force a new engine |
| Forecast Engine | Too early | Forecasting is not yet a repeated runtime pattern with enough evidence |
| Commercial Intelligence Engine | Optional | The master/comparison/reporting surfaces suggest a future candidate, but the platform contract is not yet stable enough to extract it now |
| Financial Intelligence Engine | Too early | Finance reporting and document boundaries are still being hardened; do not split this yet |

## 5. Dependency Rules

Legal dependency direction:

Business Domain -> Platform Engine -> Shared Runtime -> Infrastructure

### Should Operations depend on Import?

Only on Import Engine shared contracts or read-only summaries, not on import execution paths.

### Should Import depend on Operations?

No.

Import may emit status that Operations consumes, but it must not depend on Operations for execution, finalize, validation, or recovery.

### Can engines depend on each other?

Direct cyclic engine dependencies should not exist.

Allowed:

- pure shared contracts,
- read-only adapters,
- canonical status/readiness mappers.

Not allowed:

- engine A calling engine B’s write path,
- engine A using engine B as a hidden control plane,
- circular retries or status ownership.

## 6. Coupling Review

### Tight coupling

- `DashboardPage.tsx` still composes supplier operations status directly.
- `suppliersApi.ts` still owns both data fetch and status projection logic.
- `app-rpc.mts` still contains queue special cases for supplier catalog sync and rollup refresh.

### Acceptable coupling

- Import Engine summary types feeding Operations Engine mappers.
- Supplier-specific readiness logic feeding a canonical operations summary.
- Shared pure helpers in `apps/web/src/shared/`.

### Future risk

- If every new background job gets bespoke status columns and bespoke UI, the Operations Engine will become a second name for the same fragmentation.
- If every domain invents its own readiness semantics without a canonical mapper, readiness will drift from status.

### Cyclic dependency risk

The biggest cycle to avoid is:

Operations UI -> Import execution -> Operations summary -> Import execution

That must stay broken by one-way adapters.

## 7. Platform Readiness

The platform foundation is mature enough to continue extracting engines.

Why:

- The domain model is documented.
- Import Engine exists as a scoped staged-import platform.
- Operations Engine exists as a scoped visibility/readiness platform.
- Shared type modules now separate canonical status contracts from domain-specific runtime code.
- The current work has already proven that small adapter slices can be introduced without runtime behavior changes.

Why not to accelerate too far:

- The layer is still forming physically.
- The dashboard and gateway still contain domain-specific glue.
- A few status semantics remain domain-specific and should not be flattened too early.

Conclusion: continue platformization, but only through adapter-first slices.

## 8. Phase 5 Roadmap Review

Recommended safe path:

1. Continue with PLAT work, not another ARCH review.
2. Keep extracting pure shared contracts and read-only mappers first.
3. Add registry/projection slices before any generic executor.
4. Add more engines only when there is clear repetition and evidence.

### Next work recommendation

Choose the next PLAT slice, not another architecture review.

If the choice is between repeating architecture review or continuing platformization, continue platformization.

If the next PLAT slice is small and adapter-first, it is the safest path.

## Final Recommendation

Next-Master can safely evolve into a Business Operating System if the architecture keeps these rules:

- domains own truth,
- platform engines own shared status/readiness/projection,
- shared runtime owns pure contracts and helpers,
- infrastructure owns execution and transport,
- no engine mutates another engine’s truth,
- no generic engine becomes a hidden business rule layer.

Current architecture is correct in direction and ready for more platformization, but only with disciplined boundaries.
