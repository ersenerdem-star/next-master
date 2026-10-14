# Next Master workspace redesign QA

source visual truth:
- Admin direction: `/Users/ersen/.codex/generated_images/01a13166-fc00-7230-a6e4-9424204fbd53/exec-dbc69148-a23b-4e6d-9f0f-33ffbc711c97.png`
- Customer direction: `/Users/ersen/.codex/generated_images/01a13166-fc00-7230-a6e4-9424204fbd53/exec-90aaa115-afc6-4226-9075-da10dd34493c.png`

implementation target: `https://portal.next-master.com/`
intended viewport: desktop production viewport with responsive mobile smoke check
state: production deploy `6ad00e795150d063af7cc4dc` was inspected in authenticated Chrome after the deploy. The live build reports commit `480f6a52`. The raw source photos were not present in the repository, so clean hero assets were produced from the selected reference directions and wired separately for admin and customer surfaces.

## Findings

- [x] The authenticated admin overview and Supplier Prices surface now use the selected light brake-disc/technical-drawing direction.
- [x] The authenticated customer home and both login surfaces now use the selected dark networked-vehicle/parts direction instead of the shared legacy brake image.
- [x] Production Chrome verification confirmed the new assets load with HTTP 200 and the customer search hero, admin supplier hero, and admin overview hero render after session restoration.
- [x] Responsive mobile CSS smoke check completed after a temporary 390 x 844 viewport override; the browser viewport was restored afterward.

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
- [x] Capture authenticated production admin and customer views after login/session setup.
- [x] Run visual comparison at desktop and mobile breakpoints.

final result: passed
