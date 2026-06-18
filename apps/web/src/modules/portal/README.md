# Portal Module Boundary

Purpose: customer and vendor self-service access.

Owns:
- Portal login, session refresh, price-list download, order search, order prepare, submit, and documents.
- Customer/vendor data isolation and customer-specific pricing behavior.
- Portal cache and retry behavior for customer-facing performance.

Must not own:
- Admin-only catalog mutation, imports, user management, or diagnostics.
- Warehouse partner API clients.
- Internal role/session logic except through portal session credentials.

Rules:
- Portal requests must use portal invite/session context, not admin user state.
- Every portal data query must be scoped by organization and invite/customer/vendor context.
- Heavy pricing/search work must batch and fail soft so one slow lookup does not break the whole basket.
