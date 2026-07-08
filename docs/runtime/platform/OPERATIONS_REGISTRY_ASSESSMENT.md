# PLAT-002E Operations Registry Assessment

Status: Assessment only
Program: Phase 5 - System Mastery / Platformization
Decision: Registry is useful later, but not yet required as a runtime system

## Executive Conclusion

Next-Master does need an Operations Registry concept, but not as a new runtime write system yet.

The current platform already knows enough to register operations in code: Import Engine defines canonical staged-import contracts, Operations Engine defines canonical status/readiness semantics, and the runtime owns concrete job surfaces such as supplier import, catalog import, reporting refresh, and customer price replace. What is still missing is not a registry database. What is missing is a stable enough shared contract to justify central registration beyond code-level metadata.

So the safest decision is:

- **Yes**, define a registry concept.
- **No**, do not introduce a DB-backed operational registry yet.
- **Yes**, keep the first slice code-only and adapter-first.

## 1. What is an operation?

An operation is a long-running, operator-visible unit of work that has:

- a known owner domain,
- a stable operation type,
- a start time,
- progress or row counts when applicable,
- a current status,
- a readiness result,
- a possible retry/cancel/fail action,
- and a business meaning separate from mere technical execution.

Current runtime examples:

- supplier import finalize,
- supplier catalog sync,
- supplier rollup refresh,
- catalog import,
- reporting refresh,
- customer price replace.

An operation is not generic CRUD, not a random background task, and not a domain truth write path by itself.

## 2. Candidate operation list

The registry should eventually register at least these operations:

| Operation | Domain | Current evidence | Why register |
| --- | --- | --- | --- |
| Supplier Import | Supplier | `supplier_price_import_runs` | High-value long-running workflow with retry and background follow-up |
| Supplier Catalog Sync | Supplier / Catalog | `catalog_sync_status` | Non-blocking follow-up with business warning semantics |
| Supplier Rollup Refresh | Supplier / Reporting | `supplier_price_rollup_refresh_runs` | Rebuild job with operator visibility |
| Catalog Import | Catalog | `catalog_import_runs` | Staged import workflow with validation/finalize lifecycle |
| Reporting Refresh | Reporting | `reporting_core_refresh_runs` | Rebuild/projection refresh with duration and outcome |
| Customer Price Replace | Pricing | staged replace RPC boundary | Commercially sensitive staged replace operation |

Possible future operations:

- inventory rebuild,
- portal sync,
- AI indexing,
- export generation,
- rule refresh,
- document generation,
- financial close / refresh jobs.

## 3. Required metadata

Every operation should eventually declare:

- operation id,
- operation type,
- owner domain,
- owner label,
- source type,
- status,
- readiness,
- progress percent,
- staged rows,
- processed rows,
- warning count,
- error count,
- started at,
- updated at,
- finished at,
- retry count,
- last error,
- action availability.

Adapter-specific metadata may exist, but it must not become required by the generic engine UI.

## 4. Registry scope

### Recommended scope

The registry should initially be **code-only** and live as a static contract layer near the shared engine types.

Recommended responsibilities:

- declare known operation types,
- declare domain ownership,
- declare which adapter provides status,
- declare which actions are safe,
- declare which UI surfaces may show the operation,
- declare readiness semantics,
- declare whether the operation is purely informational or business-blocking.

### What it should own

- operation type definitions,
- canonical owner mapping,
- action metadata,
- visibility rules,
- readiness contract,
- adapter bindings,
- status vocabulary reference.

### What it must never own

- domain truth,
- domain validation,
- RPC execution,
- DB transaction logic,
- queue dispatch,
- retry implementation,
- background execution,
- authorization policy,
- business decision logic.

## 5. Registry model

Recommended data contract:

```ts
type OperationRegistryEntry = {
  operationType: string;
  domain: string;
  owner: string;
  source: "import" | "operations" | "reporting" | "pricing" | "custom";
  statusAdapter: string;
  readinessAdapter: string;
  actionPolicy: {
    retry: boolean;
    cancel: boolean;
    fail: boolean;
  };
  visibility: "ops-panel" | "domain-page" | "both";
  blockingMeaning: "business-blocking" | "warning-only" | "informational";
};
```

This should remain a TypeScript contract first. A DB table would be premature unless operations registration must be administered at runtime, which is not yet evidenced.

## 6. Registry relationship to other layers

### Operations Engine

Operations Registry is a supporting contract for Operations Engine.

Relationship:

- Registry says what exists.
- Operations Engine says what it means right now.

### Import Engine

Import Engine should register staged import sessions as operation types, but it should not depend on the registry for execution.

### Dashboard / Operations UI

The UI should consume registry-backed summaries and action policies, but the UI must not define the registry itself.

### Domain RPCs

Domain RPCs remain the only source of truth execution.

The registry must only reference them as safe action endpoints or adapters.

## 7. Why registry too early is risky

Main risks:

1. **Premature abstraction**
   A registry that is broader than the proven patterns will become another config table with no operational value.

2. **False centralization**
   It could look canonical while the actual workflows are still domain-specific and evolving.

3. **Coupling to unstable semantics**
   Status and readiness still differ by domain. A premature registry may freeze the wrong model.

4. **DB-backed governance overhead**
   A persistent registry would add migration and admin overhead before the platform contract is stable.

5. **Duplicate control plane risk**
   If it starts owning action execution or queue routing, it will compete with domain RPCs and the Operations Engine.

## 8. Smallest safe first slice

Smallest safe slice:

1. Add a code-only registry type file.
2. Enumerate operation types and owners.
3. Bind them to status/readiness mappers.
4. Keep the registry read-only.
5. Use it only to drive Operations Engine summaries.
6. Do not add DB tables, admin pages, or runtime writes.

This lets the platform describe operations centrally without creating a new persistence layer too early.

## 9. Recommended scope

Recommended scope for the registry right now:

- TypeScript-only contracts.
- Read-only metadata.
- Adapter declarations.
- UI projection hints.
- Safe action policy declarations.

Not recommended yet:

- DB-backed registry tables,
- runtime-administered registry records,
- execution routing,
- central retry execution,
- cross-domain workflow orchestration.

## 10. Non-goals

The registry must not:

- replace Import Engine,
- replace Operations Engine,
- replace domain blueprints,
- own truth or readiness decisions,
- become a workflow engine,
- become a background worker,
- become a hidden control plane.

## 11. Implementation roadmap

Recommended slices:

| Slice | Recommendation | Reason |
| --- | --- | --- |
| PLAT-002F | Code-only registry types | Safest entry point |
| PLAT-002G | Registry-backed operations summaries | Lets the UI consume a shared contract |
| PLAT-002H | Supplier pilot registration | Highest evidence domain |
| PLAT-002I | Catalog import registration | Second staged-import proof point |
| PLAT-002J | Reporting refresh registration | Extends to projection jobs |
| PLAT-002K | Customer price replace registration | Covers commercial replace flow |
| PLAT-002L | DB-backed registry review | Only if runtime administration becomes necessary |

## Final Answer

Yes, Next-Master should eventually have an Operations Registry, but the current platform should treat it as a code-level contract, not a database-driven control plane.

That is the smallest safe move.
