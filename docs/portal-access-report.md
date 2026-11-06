# Portal access report

Reports → Portal Access is restricted to active organization admins and superadmins. The endpoint verifies the Auth user and revocation state; its read-only RPC independently checks the administrator role and current organization. The RPC deliberately uses security definer rights to read the otherwise inaccessible audit table. No direct table grants were added.

Rows contain observed time, account name, portal email, event, result, country, IP and a bounded reason. No password, session token, full metadata or user-agent is returned. Query parameters cannot choose an organization. Date ranges are limited to 366 days, pages to 250 rows and browser Excel exports to 10,000 rows. An `asOf` anchor keeps pagination and exports stable while new events are appended.

Events:

- `portal_login`: explicit password authentication.
- `portal_session_resume`: validation of an existing signed cookie, including service failures as failed outcomes.
- `portal_logout`: verified explicit logout. Invalid/missing cookies are cleared but do not fabricate an actor or successful logout event.
- `portal_session_rejected`: observed invalid/expired, inactive or wrong-domain session rejection. It is not an inferred expiry timestamp.

Legacy `portal_login` events lack authentication-method metadata and are displayed as legacy login/session validation. Historical logout and country are not backfilled. Unattributed historical failures with no organization are excluded, rather than assigned from a submitted email. Future failures receive organization context only from the configured seller domain.

New authentication events use trusted Netlify `Context.ip` and `Context.geo.country.code`. Country codes are stored in `country_code` with `country_source=netlify_geo`; unavailable country remains null. Request country/IP headers cannot override these new event fields. No external IP geolocation service is called. IP country describes network egress and may differ from the user's physical location, such as with VPN use.

Event logs do not establish currently-online users, browser-close timestamps or paired session durations. Sessions are custom sliding signed cookies, not Supabase staff Auth sessions. Audit writes have a 2.5 second deadline and are best effort so logging outages do not block login/logout.

Tests: `portal-access-report-sql.test.mjs`, `portal-access-report-endpoint.test.mts`, `portal-access-report-ui.test.mts`, `portal-access-audit-events.test.mts`.
