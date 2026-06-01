import { execFileSync } from "node:child_process";

function runCommand(command, args) {
  return String(execFileSync(command, args, { encoding: "utf8" }) || "").trim();
}

function resolveEnvValue(name) {
  const direct = String(process.env[name] || "").trim();
  if (direct) return direct;
  return runCommand("npx", ["netlify", "env:get", name]);
}

function parseArgs(argv) {
  const options = {
    email: "",
    apply: false,
  };
  for (const rawArg of argv) {
    const arg = String(rawArg || "").trim();
    if (!arg) continue;
    if (arg.startsWith("--email=")) {
      options.email = arg.slice("--email=".length).trim().toLowerCase();
      continue;
    }
    if (arg === "--apply") {
      options.apply = true;
    }
  }
  return options;
}

function serviceRoleHeaders(serviceRoleKey) {
  return {
    apikey: serviceRoleKey,
    Authorization: `Bearer ${serviceRoleKey}`,
    "Content-Type": "application/json",
  };
}

function buildRestUrl(supabaseUrl, table, params = {}) {
  const url = new URL(`/rest/v1/${table}`, supabaseUrl);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === "") continue;
    url.searchParams.set(key, String(value));
  }
  return url;
}

function toTimestamp(value) {
  const parsed = Date.parse(String(value || ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function hasHash(row) {
  return Boolean(String(row.invite_token_hash || "").trim());
}

function normalizeStatus(value) {
  return String(value || "").trim().toLowerCase();
}

function isUsablePasswordRow(row) {
  const status = normalizeStatus(row.status);
  if (status === "disabled") return false;
  if (!hasHash(row)) return false;
  return status === "active" || status === "invited" || status === "draft";
}

function scopeKey(row) {
  const customerId = String(row.customer_id || "").trim();
  const vendorId = String(row.vendor_id || "").trim();
  return [String(row.organization_id || ""), String(row.party_type || ""), customerId || vendorId || "__none__"].join("::");
}

async function fetchInvites(supabaseUrl, serviceRoleKey, email) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "portal_invites", {
      select:
        "id,organization_id,party_type,party_name,customer_id,vendor_id,email,contact_name,status,invite_token_hash,last_sent_at,expires_at,last_used_at,updated_at",
      email: `ilike.${email}`,
      order: "updated_at.desc",
      limit: "100",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new Error(`Invite lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Invite lookup returned unexpected payload.");
  return rows;
}

async function fetchCustomers(supabaseUrl, serviceRoleKey, email) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "customers", {
      select: "id,organization_id,display_name,company_name,email",
      email: `ilike.${email}`,
      limit: "100",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new Error(`Customer lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Customer lookup returned unexpected payload.");
  return rows;
}

async function fetchOrganizationCustomers(supabaseUrl, serviceRoleKey, organizationId) {
  const response = await fetch(
    buildRestUrl(supabaseUrl, "customers", {
      select: "id,organization_id,display_name,company_name,email",
      organization_id: `eq.${organizationId}`,
      limit: "2000",
    }),
    {
      headers: serviceRoleHeaders(serviceRoleKey),
    },
  );
  if (!response.ok) {
    throw new Error(`Organization customer lookup failed: ${response.status} ${await response.text()}`);
  }
  const rows = await response.json();
  if (!Array.isArray(rows)) throw new Error("Organization customer lookup returned unexpected payload.");
  return rows;
}

function normalizeText(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

async function patchInvite(supabaseUrl, serviceRoleKey, inviteId, payload) {
  const response = await fetch(buildRestUrl(supabaseUrl, "portal_invites", { id: `eq.${inviteId}` }), {
    method: "PATCH",
    headers: serviceRoleHeaders(serviceRoleKey),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`Invite patch failed for ${inviteId}: ${response.status} ${await response.text()}`);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.email) {
    throw new Error("Usage: node scripts/repair-portal-invite.mjs --email=<email> [--apply]");
  }

  const supabaseUrl = resolveEnvValue("SUPABASE_URL");
  const serviceRoleKey = resolveEnvValue("SUPABASE_SERVICE_ROLE_KEY");
  if (!supabaseUrl || !serviceRoleKey) {
    throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  }

  const rows = await fetchInvites(supabaseUrl, serviceRoleKey, options.email);
  const customers = await fetchCustomers(supabaseUrl, serviceRoleKey, options.email).catch(() => []);
  const orgCustomerCache = new Map();
  const grouped = new Map();
  for (const row of rows) {
    const key = scopeKey(row);
    const group = grouped.get(key) || [];
    group.push(row);
    grouped.set(key, group);
  }

  const repairs = [];
  for (const [key, group] of grouped.entries()) {
    const usable = group.find((row) => isUsablePasswordRow(row));
    const canonicalRow = usable || [...group].sort((left, right) => toTimestamp(right.updated_at) - toTimestamp(left.updated_at))[0] || null;
    if (canonicalRow && canonicalRow.party_type === "customer" && !String(canonicalRow.customer_id || "").trim()) {
      const organizationId = String(canonicalRow.organization_id || "");
      if (organizationId && !orgCustomerCache.has(organizationId)) {
        orgCustomerCache.set(
          organizationId,
          await fetchOrganizationCustomers(supabaseUrl, serviceRoleKey, organizationId).catch(() => []),
        );
      }
      const organizationCustomers = orgCustomerCache.get(organizationId) || [];
      const scopedCustomers = customers.filter((customer) => {
        if (String(customer.organization_id || "") !== String(canonicalRow.organization_id || "")) return false;
        const partyName = String(canonicalRow.party_name || "").trim().toLowerCase();
        const displayName = String(customer.display_name || "").trim().toLowerCase();
        const companyName = String(customer.company_name || "").trim().toLowerCase();
        return !partyName || partyName === displayName || partyName === companyName;
      });
      const partyName = normalizeText(canonicalRow.party_name);
      const nameMatches =
        scopedCustomers.length === 1
          ? scopedCustomers
          : organizationCustomers.filter((customer) => {
              return partyName && (normalizeText(customer.display_name) === partyName || normalizeText(customer.company_name) === partyName);
            });
      if (nameMatches.length === 1) {
        repairs.push({
          key,
          targetId: String(canonicalRow.id || ""),
          payload: {
            email: options.email,
            customer_id: String(nameMatches[0].id || ""),
            updated_at: new Date().toISOString(),
          },
        });
      }
    }

    if (usable) continue;

    const disabledWithHash = [...group]
      .filter((row) => normalizeStatus(row.status) === "disabled" && hasHash(row))
      .sort((left, right) => toTimestamp(right.updated_at) - toTimestamp(left.updated_at))[0];
    if (!disabledWithHash) continue;

    repairs.push({
      key,
      targetId: String(disabledWithHash.id || ""),
      payload: {
        email: options.email,
        status: "active",
        expires_at: null,
        updated_at: new Date().toISOString(),
      },
    });
  }

  const output = {
    email: options.email,
    rowCount: rows.length,
    customerMatches: customers,
    rows: rows.map((row) => ({
      id: row.id,
      organization_id: row.organization_id,
      party_type: row.party_type,
      customer_id: row.customer_id,
      vendor_id: row.vendor_id,
      status: row.status,
      has_hash: hasHash(row),
      email: row.email,
      updated_at: row.updated_at,
      last_sent_at: row.last_sent_at,
      last_used_at: row.last_used_at,
      scope_key: scopeKey(row),
      password_ready: isUsablePasswordRow(row),
    })),
    repairs,
    applied: false,
  };

  if (options.apply && repairs.length) {
    for (const repair of repairs) {
      await patchInvite(supabaseUrl, serviceRoleKey, repair.targetId, repair.payload);
    }
    output.applied = true;
  }

  console.log(JSON.stringify(output, null, 2));
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
