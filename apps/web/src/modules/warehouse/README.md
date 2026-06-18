# Warehouse Module Boundary

Purpose: inventory execution, scanning, packing, stock movement, and partner warehouse API.

Owns:
- Scan center, barcode/EAN aliases, purchase receive, stock movements, transfers, packing/loading.
- Warehouse worker UI and warehouse-scoped role behavior.
- External warehouse feed/order-submit integration surfaces.

Must not own:
- Portal customer pricing.
- Admin user management outside warehouse API client administration.
- Sales-order financial document layout except stock/packing data handoff.

Rules:
- Warehouse UI must stay usable independently of catalog sync and portal traffic.
- External warehouse API must require partner API key and optional HMAC/IP checks.
- Internal warehouse actions must be scoped by user role and organization.
