# Core Architecture

This repo has one core rule: source must live in an owned surface, and every surface has a protocol chain.

## Physical Tree

- `apps/web/src/modules/admin`
- `apps/web/src/modules/portal`
- `apps/web/src/modules/warehouse`
- `apps/web/src/modules/catalog`
- `apps/web/src/modules/shared`
- `netlify/functions/_shared/auth`
- `netlify/functions/_shared/catalog`
- `netlify/functions/_shared/core`
- `netlify/functions/_shared/portal`
- `netlify/functions/_shared/pricing`
- `netlify/functions/_shared/warehouse`
- `scripts/audit`
- `scripts/maintenance`
- `scripts/ops`
- `scripts/shared`
- `scripts/sync`

## Protocol Chain

1. Capture authority from the source of truth.
2. Normalize canonical fields before write.
3. Validate required fields before persistence.
4. Persist only normalized values.
5. Render from persisted state, not from raw capture.
6. Export/download from the same canonical model.
7. Deploy only after build and module checks pass.
8. Stress-test the touched surface before calling it stable.

## Surface Rules

- Admin owns internal operations and control-plane flows.
- Portal owns customer/vendor scoped flows.
- Warehouse owns scan, stock, packing, and movement flows.
- Catalog is the central product core and must carry mandatory technical metadata.
- Shared code may be reused, but business logic must stay inside the owning surface.

## Mandatory Catalog Rule

Any new brand fetch must write the canonical catalog shape:

- product code
- brand
- EAN
- description
- image
- OEM
- vehicle
- vehicle model
- engine code
- market segment
- tariff / HS code
- origin
- weight
- lifecycle state
- replacement / supersession metadata

If a source cannot provide a mandatory field, the fetch stays incomplete and must not silently downgrade the row.
