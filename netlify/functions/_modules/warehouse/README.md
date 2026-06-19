# Warehouse Function Boundary

Warehouse partner functions are external API endpoints for stock feeds and order submission.

Expected function families:
- `warehouse-*`
- `admin-warehouse-*` for internal configuration only.

Required controls:
- External endpoints must use `readPartnerApiKey` and `enforcePartnerRequestSecurity`.
- Admin configuration endpoints must use `requireCallerProfile`.
- Partner access must be warehouse scoped.
