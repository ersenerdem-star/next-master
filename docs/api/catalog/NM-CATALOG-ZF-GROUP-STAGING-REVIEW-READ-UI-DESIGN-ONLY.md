# NM-CATALOG-ZF-GROUP-STAGING-REVIEW-READ-UI-DESIGN-ONLY

## Status

`Accepted — design only; UI source, route wiring, deployment, and production enablement require separate approval`

Design date: `2026-07-27`

Owner: `Catalog Core / Catalog Core Human Review`

Canonical read API: `GET /api/catalog/zf-group/staging-review`

## 1. Purpose and boundary

This package defines a future read-only UI for inspecting ZF Group staging
evidence. It does not create a UI route, add a navigation item, change the
API, create staging data, or authorize a review decision, Guardian action,
canonical Product mutation, or Apply operation.

The existing `Observation Review` screen is not reused as-is because it
contains decision, reversal, and Apply-oriented controls. The future ZF
surface must be a visually distinct evidence workspace with no decision
controls rendered, disabled, or hidden behind an action menu.

## 2. Future surface

| Concern | Design decision |
|---|---|
| Future client path | `/catalog/zf-group/staging-review` |
| API invocation | `GET /api/catalog/zf-group/staging-review` only |
| Navigation placement | A separate `ZF Staging Evidence` item under the read-only Observation Review group |
| Page title | `ZF Group Staging Evidence` |
| Safety label | Persistent `Read-only evidence — not canonical Catalog data` badge |
| Data owner | Catalog Core / External Observation Runtime |
| Tenant source | Authenticated caller profile; no tenant selector in the UI |
| Data state | Candidate/staging evidence only; never presented as Product data |

The navigation label must make the distinction from the existing decision
workspace explicit. A user must not infer that opening this page grants review
or Apply authority.

## 3. API contract consumed by the UI

The client consumes the already-proven production route and must preserve its
caller-token boundary:

- obtain the current session through the existing Supabase client;
- send only the caller Bearer token and publishable/anonymous key;
- never send `SUPABASE_SERVICE_ROLE_KEY` or any privileged credential;
- derive the tenant only on the server from the authenticated profile;
- reject tenant selectors, unknown query fields, duplicate fields, malformed
  UUIDs, and invalid limits before rendering a result;
- treat `organization_id` in the response as a server assertion to display only
  as a non-sensitive binding indicator, not as a user-editable filter.

The response contract is `catalog-zf-staging-review.v1` with:

- `organization_id`;
- `schema_version`;
- `items` containing the exact 44-column review projection;
- `page.limit`, `page.cursor`, `page.next_cursor`, `page.has_more`, and
  `page.returned_count`.

Allowed query controls are limited to `candidate_id`, `run_id`, `brand`,
`latest_event_type`, `quarantine`, `limit`, and the opaque `cursor`. No
organization, tenant, product, review-decision, Guardian, or Apply control is
exposed.

## 4. Information architecture

### Summary strip

The page opens with four read-only indicators:

1. `Returned candidates`;
2. `Current page size`;
3. `More evidence available`;
4. `Last observed` derived from the visible page only.

These are page facts, not global catalog health claims. The UI must not infer a
total catalog count from a bounded page.

### Filter bar

The filter bar contains only the accepted API filters:

- Brand;
- Run ID;
- Candidate ID;
- Lifecycle/event state;
- Quarantine state;
- Page size.

The cursor is controlled by Previous/Next paging and is never editable as raw
text. Changing any filter clears the cursor and starts a new bounded read.

### Evidence table

The first viewport prioritizes:

- proposed display code and normalized code;
- brand;
- lifecycle status and quarantine class;
- description, EAN, HS code, origin, and weight;
- OEM and vehicle application presence;
- official source and observed-at timestamp;
- latest staging event;
- evidence completeness state.

The table must use an explicit `—` value for absent optional evidence and must
not convert missing data into a canonical value.

### Detail drawer

Selecting one candidate opens a bounded, scrollable read-only drawer with:

- complete candidate evidence fields;
- official source URL and image evidence reference as safe external links;
- replacement and supersession candidates;
- fitment and engine facts;
- provenance fields: evidence hash, payload fingerprint, observation
  fingerprint, source schema version, runtime commit, deploy ID, run ID, job ID,
  source ID, and contract version;
- latest event and limitation flags;
- a fixed message: `Evidence only — no Catalog write or Apply action is available.`

No edit field, decision modal, reviewer-note field, approval button, reversal
button, Guardian control, or Apply link is permitted in this drawer.

## 5. State and error behavior

| State | UI behavior |
|---|---|
| Loading | Skeleton table and non-interactive filter controls |
| Empty page | Explain that no staging evidence matches the bounded filters; do not suggest Product creation |
| `401` | Session-expired message with sign-in recovery; no data retained |
| `403` | Access denied message; no tenant or role details revealed |
| `400` | Explain that the filter was rejected and clear the offending control |
| `409` | Show contract/version mismatch and stop pagination |
| `503` | Show temporary read-unavailable state with retry button |
| Network timeout | Keep the last safe page visible with stale indicator; retry remains GET-only |

The retry button may repeat the unchanged GET request. It must not create a
queue, scheduler, fallback write, or alternative tenant request.

## 6. Security and redaction requirements

- The UI never displays access tokens, API keys, private URLs, service-role
  values, raw credentials, or unrestricted customer provenance.
- The UI logs only status, bounded route name, schema version, and sanitized
  error code; it does not log Authorization headers or response payloads.
- All links are validated as `http`/`https` evidence references before render.
- The browser client uses the existing caller session and publishable key only.
- The UI cannot call RPC, mutation endpoints, provider connectors, direct table
  APIs, Guardian, review decision, or Apply surfaces.
- The page must remain safe if staging is empty, partially populated, or
  contains quarantined evidence.

## 7. Responsive and accessibility decisions

- Desktop uses a bounded table with a scrollable detail drawer.
- Narrow screens switch to stacked candidate cards and a full-width detail
  sheet; no drawer may exceed the viewport.
- Keyboard focus moves into the detail sheet and returns to the selected row on
  close.
- The read-only badge, loading state, errors, empty state, and pagination have
  accessible names and status announcements.
- Color is never the only signal for quarantine, lifecycle, or evidence
  completeness.

## 8. Test and evidence plan for a future implementation package

The implementation package must prove:

| Gate | Required proof |
|---|---|
| Route and navigation | Correct future path; no collision with decision workspace |
| Auth boundary | Caller token only; no service-role or static secret reference |
| Tenant isolation | Response tenant binding and no tenant selector |
| Allowlist | Exactly the accepted 44-column projection is rendered |
| Unknown field/selector | UI and API reject unsupported filters |
| Empty/partial evidence | Safe placeholders; no inferred canonical data |
| Error handling | `401`, `403`, `400`, `409`, `503`, timeout states |
| No-write boundary | No POST/PUT/PATCH/DELETE/RPC/provider call from the UI package |
| Redaction | Browser logs, errors, exports, and screenshots contain no secrets |
| Responsive UX | Drawer/sheet remains viewport-bounded and keyboard reachable |

Validation must use fixtures or the already-proven empty production read. It
must not create staging rows, decisions, Products, Guardian records, or Apply
events.

## 9. Explicit non-actions

This design does not authorize:

- UI source implementation;
- new route wiring or API client changes;
- database, migration, RLS, grant, or projection changes;
- staging-data population or provider invocation;
- human review decisions, Guardian, Product creation, or Apply;
- new credential or environment variable;
- deployment or production enablement.

## 10. Next package

`NM-CATALOG-ZF-GROUP-STAGING-REVIEW-READ-UI-SOURCE-IMPLEMENTATION`

That package must be separately named and explicitly accepted before any UI
source, test, route wiring, or local implementation begins.
