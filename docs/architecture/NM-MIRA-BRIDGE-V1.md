# NM-MIRA Bridge v1

Status: proposed implementation contract for the Next-Master review-only MIRA queue.

This bridge connects an authenticated external MIRA worker to the existing `mira_missions` queue. It carries mission evidence and a debrief only. It cannot write Catalog products, apply observations, publish data, or expand authority.

## Production gate

The Netlify function keeps the bridge disabled unless all of these variables are configured:

- `MIRA_BRIDGE_ENABLED=1`
- `MIRA_BRIDGE_HMAC_SECRET` (at least 32 characters; scoped to this bridge, never a Supabase service-role key)
- `MIRA_BRIDGE_ORGANIZATION_ID` (the single organization allowed to claim and complete missions)

The database migration `20260810090000_mira_online_mission_bridge.sql` must be applied before enabling the function.

## Signed claim

`GET /api/mira-missions?bridge=claim&missionId=<claimed mission UUID>`

Headers:

- `x-mira-timestamp`: Unix seconds or milliseconds
- `x-mira-signature`: lowercase HMAC-SHA256 hex
- `x-mira-bridge-id`: stable worker identifier (`dimbax-scout`)

The signature canonical string is:

```text
METHOD
PATH
sorted percent-encoded query
timestamp header
SHA256(raw body)
```

`missionId` is mandatory. The server atomically claims only that exact queued mission for the allow-listed organization and changes it to `processing`; missing/invalid IDs return `400`, unknown IDs return `404`, and an already claimed or terminal mission returns `409`. No direct table access is granted to browser users.

## Signed result

`POST /api/mira-missions?bridge=result`

Required headers include the claim headers plus `x-mira-idempotency`, a stable key for this mission attempt. The body is:

```json
{
  "protocolVersion": "mira-bridge.v1",
  "missionId": "<claimed mission UUID>",
  "organizationId": "<allow-listed organization UUID>",
  "terminalStatus": "completed",
  "result": {
    "outcome": "observed",
    "candidateCount": 50,
    "knowledgeGapCount": 0,
    "negativeReasons": [],
    "summary": "..."
  },
  "debrief": {
    "contractVersion": "v0",
    "debriefFingerprint": "sha256:...",
    "payload": {}
  },
  "guarantees": {
    "catalogWrite": false,
    "apply": false,
    "authorityExpansion": false,
    "credentialsIncluded": false
  }
}
```

Only `completed`, `partial`, `blocked`, and `cancelled` are accepted as terminal statuses. The mission must already be `processing` from the signed exact-ID claim; an unclaimed or terminal mission is rejected. The server validates the mission and organization, bounds counts/reasons/payload size, redacts local filesystem references, and uses the idempotency key to make retries safe. A second, different terminal result is rejected with `409`.

The browser MIRA desk reads the resulting `result`, `negativeReasons`, candidate/knowledge-gap counts, debrief fingerprint, and status from the existing authenticated list endpoint. These values remain review-only evidence until an explicit human workflow is added later.
