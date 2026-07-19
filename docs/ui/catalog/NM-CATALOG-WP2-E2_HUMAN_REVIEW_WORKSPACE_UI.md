# NM-CATALOG-WP2-E2 Human Review Workspace UI

Status: Draft v1

Domain: UI / Catalog

Phase: Human Review Workspace

Work Package: NM-CATALOG-WP2-E2

## Purpose

The Catalog Observation Review workspace is the read-only human-facing surface for catalog observation comparison and recommendation evidence.

The UI helps a reviewer understand the Product value, observed value, source evidence, comparison result, and recommendation state. It does not create decisions, apply values, publish Product updates, rerun acquisition, or persist recommendation state.

## Route

Route:

`/catalog/observation-review`

Navigation:

Catalog navigation entry: `Observation Review`

Turkish label: `Gozlem Inceleme`

## Authorized Roles

Allowed:

- `admin`
- `superadmin`

Blocked:

- `sales`
- `viewer`
- unknown or empty role

The navigation entry is hidden for unauthorized roles. Direct route access is also blocked through the established app role guard.

## Runtime Call Chain

The UI runtime chain is:

1. Catalog navigation entry is selected.
2. App route changes to `/catalog/observation-review`.
3. App role guard confirms `admin` or `superadmin`.
4. `CatalogObservationReviewPage` loads.
5. `fetchCatalogObservationReview()` resolves the authenticated active organization through the existing organization API context.
6. The API client obtains the current Supabase auth session token.
7. The client sends a GET request to `/api/catalog/observation-review`.
8. Request query includes:
   - `organization_id`
   - `run_id`
   - `limit`
   - `cursor` when present
   - `field_family` when selected
   - `comparison_result` when selected
   - `recommendation` when selected
9. The server returns `catalog-observation-review.v1`.
10. The page renders summary metrics, review list rows, and the detail panel from the server response.

The UI does not query observation data directly from browser Supabase table clients.

## Fixed Pilot Run

Pilot run:

`11581bfd-3a12-43d5-bb39-d6aa09e3bd96`

The run ID is kept as one named UI configuration constant for this phase.

## Page Structure

The workspace contains:

- page header with read-only status
- read-only phase notice
- summary metric strip
- server-backed filters
- cursor-paginated review list
- detail panel for the selected item

Expected pilot totals:

- review items: 6
- `LIKELY_ACCEPT`: 5
- `MANUAL_REQUIRED`: 1
- `AUTO_SAFE`: 0

Summary metrics rendered:

- total review items
- enrichment candidates
- conflicts
- likely accept
- manual required
- likely reject
- insufficient evidence
- high-confidence recommendation

## Filters

Supported filters:

- field family
- comparison result
- recommendation
- page size
- limit
- cursor

Every visible filter is transmitted to the API. The UI does not fake full-dataset filtering in the browser.

URL query parameters preserve:

- `field_family`
- `comparison_result`
- `recommendation`
- `limit`
- `cursor`
- `selected`

## Pagination

The workspace uses the API cursor model.

Forward pagination is shown when `page.next_cursor` is returned. Backward pagination is not invented by the UI because the current API contract does not define it.

## Review List

The desktop list shows:

- status / priority
- Product code
- brand name
- field family
- current Product value
- observed value
- comparison result
- recommendation
- score
- source and evidence reference
- created date
- details action

Rows are keyboard-selectable and use stable item keys derived from observation or queue identity.

Missing values are shown as `-` or localized empty labels instead of raw null, undefined, or empty strings.

## Detail Panel

The detail panel shows:

- Product code
- normalized Product code
- Product ID when available
- brand name
- current Product value
- observed source value
- normalized current value
- normalized observed value
- comparison result
- comparison reason
- recommendation
- score
- winning rule
- explanation
- positive factors
- negative factors
- recommendation fingerprint
- source display name
- source key
- trust level
- trust score
- observation confidence
- evidence reference
- evidence completeness
- observed date
- evidence URL
- run status
- reviewer
- decision

Reviewer is displayed as `Not assigned` when the API returns null.

Decision is displayed as `Not decided` when the API returns null.

## Evidence Link Handling

Evidence URL is rendered only when present.

Evidence links open in a new browser context with:

`target="_blank"`

`rel="noopener noreferrer"`

The link is descriptive and the full value remains inspectable.

## Recommendation Semantics

Recommendation labels are advisory.

`AUTO_SAFE` is displayed as a high-confidence recommendation. It is not approval language and does not imply publication or mutation authority.

Forbidden UI language:

- Approved
- Accepted
- Applied
- Published
- Verified truth
- Safe to publish

No Accept, Reject, Approve, Apply, or Publish control exists in this phase.

## Read-Only Boundary

This workspace does not:

- mutate Product data
- mutate observation data
- mutate review data
- create a review decision
- persist a recommendation
- apply canonical values
- rerun acquisition
- publish changes
- execute backfill
- execute migrations

Refresh repeats the same authenticated GET request only.

## Context Preservation

The workspace preserves review context through URL state.

On detail close:

- filters remain unchanged
- cursor remains unchanged
- the selected query parameter is cleared
- focus returns to the originating row when possible
- the page does not navigate back to Catalog home

On refresh:

- filters remain unchanged
- cursor remains unchanged
- selection is retained when the selected item still exists

## Accessibility

The workspace uses:

- semantic headings through the shared page shell
- labelled filters
- text labels independent from color
- keyboard-selectable rows
- visible focus state
- accessible close action
- sanitized error state
- loading and empty states through shared primitives

## Validation

Required validation:

- targeted WP2-E2 API contract test
- targeted WP2-E2 UI contract test
- repository build for `apps/web`
- `git diff --check`
- `git diff --cached --check`
- static no-mutation proof over the UI page and API client
- authenticated runtime proof when an admin or superadmin browser session is available

Runtime proof should verify:

- route loads
- navigation entry is visible for authorized roles
- unauthorized route access is blocked
- GET `/api/catalog/observation-review` is used
- no mutation request is made
- no direct browser Supabase observation query is made
- six review items render
- five likely accept recommendations render
- one manual required item renders
- zero auto safe items render
- status and details columns render
- detail panel shows evidence and recommendation explanation
- reviewer displays as not assigned
- decision displays as not decided
- filters and cursor remain stable
- detail close preserves context

## Artifact Path

Runtime validation artifacts should be captured under:

`/Users/ersen/Developer/NextMaster/artifacts/wp2e2-review-ui-<timestamp>/`

If authenticated runtime validation is not available during implementation, the limitation must be reported explicitly rather than simulated.

## Product Criterion

This UI follows the Next-Master scale criterion:

Would this feature work across 5 countries, 10 languages, and 100 companies?

The answer depends on the UI consuming runtime truth through the API contract, keeping labels internationalized, keeping organization context explicit, and avoiding local recommendation or Product mutation logic.
