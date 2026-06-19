# Portal Function Boundary

Portal functions are public internet endpoints but must authenticate via portal invite/session before returning private data.

Expected function families:
- `portal-*`

Required controls:
- Portal rate limit for login/data/search/prepare/submit/download paths.
- Portal invite/session verification.
- Organization plus customer/vendor isolation.
- Audit event on meaningful access, failure, and submission.

Performance rule:
- Large price/search requests must batch and soft-fail optional enrichment.
