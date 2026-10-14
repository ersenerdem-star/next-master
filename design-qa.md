# Next Master workspace redesign QA

source visual truth:
- Admin direction: `/Users/ersen/.codex/generated_images/01a13166-fc00-7230-a6e4-9424204fbd53/exec-dbc69148-a23b-4e6d-9f0f-33ffbc711c97.png`
- Customer direction: `/Users/ersen/.codex/generated_images/01a13166-fc00-7230-a6e4-9424204fbd53/exec-90aaa115-afc6-4226-9075-da10dd34493c.png`

implementation target: `http://localhost:4173/`
intended viewport: 1440 x 1024 CSS px
state: local build opened successfully. The admin login surface was visually inspected locally; the portal route remains on its local session bootstrap and an authenticated customer session was not transferred from the production origin.

## Findings

- [P1] Authenticated visual comparison is blocked. The selected designs target the admin supplier/report workspace and the authenticated customer portal; the local preview can render the admin login but cannot reach authenticated workspaces, while the portal route remains on its local session bootstrap. A production screenshot was inspected for the current portal, but it cannot serve as the local implementation capture.
- [P2] Responsive and interactive state comparison remains pending. The local build needs an authenticated capture for the supplier upload modal, report tabs, portal search, and mobile navigation.

## Implementation checklist

- [x] Add grouped admin navigation labels.
- [x] Recompose supplier upload controls into browse/export and action groups.
- [x] Add supplier release path rail and operational hero.
- [x] Add reports command banner.
- [x] Replace the portal fixed-sidebar presentation with a single top navigation treatment on desktop.
- [x] Hide build/branch metadata from the customer workspace header.
- [x] Recompose the admin login around the selected operations-console concept.
- [x] Recompose the customer login around the selected customer pricing concept.
- [x] Run `npm run build --workspace apps/web` successfully.
- [ ] Capture authenticated local admin and customer views after login/session setup.
- [ ] Run visual comparison at desktop and mobile breakpoints.

final result: blocked
