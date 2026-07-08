# Next-Master Implementation Standards

Status: Phase 5 canonical implementation standard.

Purpose: define the required engineering discipline for implementation work in Next-Master. This document is a standard, not a feature plan.

## 1. Work Package Types

### DISC
Domain Mastery / Blueprint

Use when the goal is to understand a domain, reconstruct a blueprint, or document the real system before changing it.

Examples:

- Catalog blueprint
- Sales order runtime map
- End-to-end flow discovery

### PLAT
Platformization / shared engine

Use when repeated patterns should become reusable engines or shared platform behavior.

Examples:

- Import engine
- Export engine
- Job/operations status engine
- Commercial rule engine

### BIZ
Business Value / commercial intelligence

Use when the work package primarily improves commercial truth, decision quality, or revenue/cost outcomes.

Examples:

- pricing intelligence
- quote decision support
- portal commercial visibility

### OPS
Operational visibility / status / health

Use when the goal is to surface long-running process state, queue progress, job health, or operator confidence.

Examples:

- supplier import status
- background sync status
- rollup refresh status

### FIX
Production incident / bug fix

Use when the system is failing in production and the work is a safe correction.

Examples:

- timeout fix
- authorization drift fix
- runtime build failure fix

### GOV
Repository / worktree / governance

Use when the work concerns workspace hygiene, repository correctness, deployment source integrity, or standardization.

Examples:

- clean worktree setup
- deploy source review
- migration ordering review

## 2. Standard Work Package Flow

Every implementation work package should follow this sequence:

1. Workspace verification.
2. Domain ownership check.
3. Blueprint check.
4. Source of truth check.
5. Runtime call-chain check.
6. Minimal slice definition.
7. Implementation.
8. Validation.
9. Commit.
10. Deploy readiness.
11. Smoke test.
12. Business acceptance.

No step may be skipped when it is relevant to the package type.

## 3. Mandatory Gates

The following gates are mandatory:

- No work in the wrong workspace.
- No implementation without a domain owner.
- No direct mutation where a boundary or RPC is required.
- No dirty-worktree deploy source.
- No feature without business value.
- No dashboard/detail overload.
- No hidden background process without a status surface.

Additional governance rules:

- No assumption may become implementation.
- No production truth may be silently rewritten.
- No historical ledger may be rewritten without an approved reversal model.
- No cross-domain change may hide the owning domain.

## 4. File Ownership Rules

### UI

- UI pages live in `apps/web/src/presentation/pages/`.
- Shared UI primitives live in `apps/web/src/presentation/components/common/`.
- UI layout and shell logic live in `apps/web/src/presentation/layout/`.
- A page may own multiple sub-tabs, but if it exceeds clear domain boundaries it becomes a split candidate.

### API

- Domain APIs live in `apps/web/src/infrastructure/api/`.
- API files should map to one canonical domain whenever possible.
- Cross-domain helpers must state their primary owner.

### Shared Engines

- Shared engines live in `apps/web/src/shared/` or `apps/web/src/domain/shared/` until a domain-specific module exists.
- Reusable behavior must not be duplicated across page files.

### Migrations

- Database migrations live in `supabase/migrations/`.
- Production-safe SQL review must happen before deploy.

### Docs

- Runtime docs live in `docs/runtime/`.
- Domain blueprints live in `docs/runtime/blueprints/`.
- Incident notes and deploy notes live under `docs/runtime/` or `docs/ops/` if they are runtime-facing.

### Runtime Blueprints

- Blueprints define observed system reality for a domain.
- Blueprints are canonical references for later implementation.

### Incidents / Runbooks

- Incidents and runbooks should explain failure, diagnosis, mitigation, and verification.
- They must not mix with feature design.

## 5. Migration Rules

- Filename format: `YYYYMMDD_NNN_description.sql`.
- Sequence must be zero-padded.
- Sorted order proof is required before deployment.
- One database concern per migration.
- Do not use `zz` or `999` except for an already-approved emergency exception.
- Forward-fix is preferred over rollback when safe.
- Migrations must be reviewed for dependency order, transaction safety, and runtime compatibility.

## 6. UX Rules

- Decision First.
- Show Confidence Before Complexity.
- Visual Noise = UX Bug.
- Progressive disclosure.
- Default screen must answer: Can I continue?
- Operational detail stays hidden until needed.

Practical implications:

- A user should not have to guess whether a job is done.
- Failure states must explain the problem and the next safe action.
- Long-running work must show progress or last-known status.

## 7. Operations Rules

- Every long-running process must expose status.
- Status should include started, finished, error, and progress fields where applicable.
- Retry must be available where safe.
- The user must not need to ask whether the process finished.

Preferred status surfaces:

- idle
- pending
- running
- failed
- completed

## 8. Platformization Rules

- Repeated patterns become engine candidates.
- Import, export, job, rule, and status engines are preferred over copy-paste.
- Feature-specific code must not become permanent platform logic.
- Shared engines must be introduced only when the pattern is genuinely repeated.

Canonical engine candidates:

- Import Engine
- Export Engine
- Job / Operations Status Engine
- Commercial Rule Engine

## 9. Validation Rules

Every implementation package must validate what it changed.

Minimum validation set:

- build
- diff check
- migration review
- app deploy check
- DB confirmation
- smoke test
- business acceptance

Validation must prove behavior, not only code presence.

## 10. Definition of Done

A work package is not done until:

- code is committed
- build passes
- deploy source is clean
- migrations are confirmed if needed
- smoke passes
- business outcome is accepted

## 11. Examples

### Supplier Import Incident

Right:

- classify as FIX
- isolate the runtime path
- keep supplier-price finalize atomic where required
- expose background status when work continues after commit
- validate with the real production scale case

Wrong:

- treat a production timeout as a design discussion only
- hide background completion from operators
- modify unrelated catalog behavior while fixing supplier import

### Catalog Blueprint

Right:

- classify as DISC
- document the real runtime, truth owners, and consumers
- identify extension points before refactoring

Wrong:

- move files before understanding ownership
- invent a new Catalog engine before the blueprint is accepted

### Wrong vs Right Task Framing

Wrong:

- "Refactor the whole Sales area while you are there."
- "Add a dashboard and figure out the data later."
- "Assume the right repo is open."

Right:

- "Verify workspace, then implement the smallest safe slice."
- "Describe the current truth first, then propose a bounded change."
- "Validate against runtime evidence before calling it done."

## 12. Implementation Checklist

Before changing code:

- confirm the repo and worktree
- identify the owning domain
- read the blueprint or create one if missing
- verify truth owner and call chain
- define the smallest safe slice
- confirm validation plan
- confirm rollback / forward-fix plan

After changing code:

- run diff check
- run build
- run smoke verification
- confirm deploy source state
- confirm business acceptance

## 13. Operational Principle

The standard principle of Phase 5 is:

> Preserve commercial truth, reduce hidden coupling, and make runtime behavior visible before optimizing anything.
