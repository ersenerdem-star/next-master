# Mobile Warehouse Rollout

This project now supports two mobile delivery paths for warehouse staff.

## 1. Fastest rollout: installable PWA

Use this first for warehouse workers.

- Deploy the web app to a live HTTPS domain.
- Give warehouse workers only the warehouse role so they see only the `Depo / Inventory` flow.
- Staff opens the live link on their own phone or company phone.
- Android install:
  - Open the link in Chrome.
  - Tap `Install App`.
- iPhone install:
  - Open the link in Safari.
  - Tap `Share`.
  - Tap `Add to Home Screen`.

Why this is the primary rollout path:

- Camera scan already works with the existing browser scanner flow.
- No App Store review is required.
- Updates go live from the same production deployment.
- Warehouse users keep a simple home-screen app icon.

## 2. Native package path: Android and iOS wrapper

This repo now includes Capacitor scaffolding so the same app can be wrapped as Android and iOS apps.

Current commands:

- `npm run mobile:icons`
- `npm run mobile:add:android`
- `npm run mobile:add:ios`
- `npm run mobile:sync`
- `npm run mobile:open:android`
- `npm run mobile:open:ios`

Recommended sequence:

1. `npm run mobile:icons`
2. `npm run mobile:add:android`
3. `npm run mobile:add:ios`
4. `npm run mobile:sync`
5. Open Android Studio / Xcode with the `mobile:open:*` commands.
6. Test barcode scan, login, receive, packing, and print/export on physical devices.

## Important note about the scanner

The current warehouse scanner uses browser camera APIs. That is correct for the PWA path and should be tested first.

For App Store / Play Store release, do physical-device validation before publishing:

- camera permission prompt
- rear camera selection
- barcode scan speed
- low-light scan performance
- background/resume behavior

If native wrapper scan quality is not good enough, the next step is to switch the scanner layer from browser camera decoding to a native Capacitor barcode plugin.

## Current iOS note

The repo can scaffold and sync the iOS project now.

- This machine synced iOS using Swift Package Manager.
- If another Mac falls back to CocoaPods, install CocoaPods there before opening the Xcode workspace.

## How to present it to warehouse staff

Use a very simple rollout:

1. Give each worker a user with warehouse role.
2. Send only the production install link.
3. Tell them one rule: open the home-screen app, then enter only the `Depo` menu.
4. Train only three actions first:
   - receive item
   - pack item
   - stock check
5. Keep supervisor users on desktop/tablet for queue, assignment, and control.

## Distribution recommendation

Use this order:

- Phase A: PWA install to real phones
- Phase B: warehouse floor test with 5-10 users
- Phase C: native Android package
- Phase D: native iOS package if the iPhone fleet needs MDM/App Store delivery

This is the lowest-risk path because operations can start before store packaging is finalized.
