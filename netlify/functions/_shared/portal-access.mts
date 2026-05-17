import { buildRestUrl, getJson, serviceRoleHeaders } from "./http.mts";

type PortalInviteRow = {
  id: string;
  organization_id: string;
  party_type: "customer" | "vendor";
  party_name: string;
  email: string;
  contact_name: string;
  status: "draft" | "invited" | "active" | "disabled";
  invite_token: string;
  last_sent_at: string | null;
  access_can_view_account: boolean;
  access_can_view_invoices: boolean;
  access_can_view_payments: boolean;
  access_can_view_orders: boolean;
};

async function fetchFirst<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  const rows = await getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
  return rows[0] || null;
}

async function fetchAll<T>(supabaseUrl: string, serviceRoleKey: string, table: string, params: Record<string, string>) {
  return getJson<Array<T>>(buildRestUrl(supabaseUrl, table, params), {
    headers: serviceRoleHeaders(serviceRoleKey),
  });
}

function toNumber(value: unknown) {
  return Number(value ?? 0) || 0;
}

export async function validatePortalInvite(supabaseUrl: string, serviceRoleKey: string, email: string, token: string) {
  const invite = await fetchFirst<PortalInviteRow>(supabaseUrl, serviceRoleKey, "portal_invites", {
    select:
      "id,organization_id,party_type,party_name,email,contact_name,status,invite_token,last_sent_at,access_can_view_account,access_can_view_invoices,access_can_view_payments,access_can_view_orders",
    email: `eq.${email}`,
    invite_token: `eq.${token}`,
  });

  if (!invite || invite.status === "disabled") {
    throw new Error("Portal invite not found or disabled");
  }

  if (invite.status !== "active") {
    await fetch(buildRestUrl(supabaseUrl, "portal_invites", { id: `eq.${invite.id}` }), {
      method: "PATCH",
      headers: serviceRoleHeaders(serviceRoleKey),
      body: JSON.stringify({
        status: "active",
        updated_at: new Date().toISOString(),
      }),
    });
  }

  return invite;
}

export async function buildPortalSnapshot(supabaseUrl: string, serviceRoleKey: string, invite: PortalInviteRow) {
  const companyProfile = await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "company_profiles", {
    select: "id,company_name,email,phone,website,address,bank_details,tax_office,tax_number,footer_note,logo_data_url",
    organization_id: `eq.${invite.organization_id}`,
    order: "updated_at.desc",
    limit: "1",
  });

  if (invite.party_type === "customer") {
    const customer =
      (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
        select:
          "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,price_list_type,remarks",
        organization_id: `eq.${invite.organization_id}`,
        display_name: `eq.${invite.party_name}`,
      })) ||
      (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "customers", {
        select:
          "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,contract_nr,price_list_type,remarks",
        organization_id: `eq.${invite.organization_id}`,
        company_name: `eq.${invite.party_name}`,
      }));

    const salesOrders = invite.access_can_view_orders
      ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "sales_orders", {
          select:
            "id,sales_order_no,customer_name,quote_date,currency,status,sales_total,purchase_total,profit_total,margin_percent,updated_at",
          organization_id: `eq.${invite.organization_id}`,
          customer_name: `eq.${invite.party_name}`,
          order: "updated_at.desc",
        })
      : [];

    const invoices = invite.access_can_view_invoices
      ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "invoices", {
          select: "id,sales_order_no,customer_name,quote_date,currency,status,total_amount,due_date,payment_terms,updated_at",
          organization_id: `eq.${invite.organization_id}`,
          customer_name: `eq.${invite.party_name}`,
          order: "updated_at.desc",
        })
      : [];

    const paymentsReceived = invite.access_can_view_payments
      ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_received", {
          select: "id,invoice_no,customer_name,status,received_date,method,reference_no,amount,currency,updated_at",
          organization_id: `eq.${invite.organization_id}`,
          customer_name: `eq.${invite.party_name}`,
          order: "updated_at.desc",
        })
      : [];

    const accountRows = [
      ...invoices.map((row) => ({
      document_no: String(row.id || row.sales_order_no || ""),
      document_type: "Invoice",
      document_date: String(row.quote_date || ""),
      due_date: String(row.due_date || ""),
      status: String(row.status || ""),
      amount: toNumber(row.total_amount),
      currency: String(row.currency || customer?.currency || "EUR"),
      })),
      ...paymentsReceived.map((row) => ({
        document_no: String(row.id || row.invoice_no || ""),
        document_type: "Payment",
        document_date: String(row.received_date || ""),
        due_date: "",
        status: String(row.status || ""),
        amount: -Math.abs(toNumber(row.amount)),
        currency: String(row.currency || customer?.currency || "EUR"),
      })),
    ];

    return {
      invite: {
        id: invite.id,
        party_type: invite.party_type,
        party_name: invite.party_name,
        email: invite.email,
        contact_name: invite.contact_name,
        status: "active",
        access: {
          can_view_account: invite.access_can_view_account,
          can_view_invoices: invite.access_can_view_invoices,
          can_view_payments: invite.access_can_view_payments,
          can_view_orders: invite.access_can_view_orders,
        },
      },
      companyProfile,
      customer,
      salesOrders,
      invoices,
      purchaseOrders: [],
      bills: [],
      paymentsReceived,
      paymentsMade: [],
      accountSummary: {
        currency: String(customer?.currency || invoices[0]?.currency || "EUR"),
        totalDocuments: accountRows.length,
        totalAmount: accountRows.reduce((sum, row) => sum + row.amount, 0),
        openAmount: accountRows.filter((row) => !["void"].includes(row.status.toLowerCase())).reduce((sum, row) => sum + row.amount, 0),
        paymentCount: paymentsReceived.length,
      },
      accountRows,
    };
  }

  const vendor =
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendors", {
      select: "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,remarks",
      organization_id: `eq.${invite.organization_id}`,
      display_name: `eq.${invite.party_name}`,
    })) ||
    (await fetchFirst<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "vendors", {
      select: "id,display_name,company_name,email,work_phone,mobile_phone,billing_address,shipping_address,currency,payment_terms,remarks",
      organization_id: `eq.${invite.organization_id}`,
      company_name: `eq.${invite.party_name}`,
    }));

  const purchaseOrders = invite.access_can_view_orders
    ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "purchase_orders", {
        select: "id,sales_order_no,supplier_name,customer_name,status,currency,total_amount,line_count,updated_at",
        organization_id: `eq.${invite.organization_id}`,
        supplier_name: `eq.${invite.party_name}`,
        order: "updated_at.desc",
      })
    : [];

  const bills = invite.access_can_view_invoices
    ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "bills", {
        select: "id,purchase_order_no,supplier_name,status,currency,total_amount,bill_date,due_date,payment_terms,updated_at",
        organization_id: `eq.${invite.organization_id}`,
        supplier_name: `eq.${invite.party_name}`,
        order: "updated_at.desc",
      })
    : [];

  const paymentsMade = invite.access_can_view_payments
    ? await fetchAll<Record<string, unknown>>(supabaseUrl, serviceRoleKey, "payments_made", {
        select: "id,bill_no,supplier_name,status,payment_date,method,reference_no,amount,currency,updated_at",
        organization_id: `eq.${invite.organization_id}`,
        supplier_name: `eq.${invite.party_name}`,
        order: "updated_at.desc",
      })
    : [];

  const accountRows = [
    ...bills.map((row) => ({
    document_no: String(row.id || row.purchase_order_no || ""),
    document_type: "Bill",
    document_date: String(row.bill_date || ""),
    due_date: String(row.due_date || ""),
    status: String(row.status || ""),
    amount: toNumber(row.total_amount),
    currency: String(row.currency || vendor?.currency || "EUR"),
    })),
    ...paymentsMade.map((row) => ({
      document_no: String(row.id || row.bill_no || ""),
      document_type: "Payment",
      document_date: String(row.payment_date || ""),
      due_date: "",
      status: String(row.status || ""),
      amount: -Math.abs(toNumber(row.amount)),
      currency: String(row.currency || vendor?.currency || "EUR"),
    })),
  ];

  return {
    invite: {
      id: invite.id,
      party_type: invite.party_type,
      party_name: invite.party_name,
      email: invite.email,
      contact_name: invite.contact_name,
      status: "active",
      access: {
        can_view_account: invite.access_can_view_account,
        can_view_invoices: invite.access_can_view_invoices,
        can_view_payments: invite.access_can_view_payments,
        can_view_orders: invite.access_can_view_orders,
      },
    },
    companyProfile,
    customer: null,
    vendor,
    salesOrders: [],
    invoices: [],
    purchaseOrders,
    bills,
    paymentsReceived: [],
    paymentsMade,
    accountSummary: {
      currency: String(vendor?.currency || bills[0]?.currency || "EUR"),
      totalDocuments: accountRows.length,
      totalAmount: accountRows.reduce((sum, row) => sum + row.amount, 0),
      openAmount: accountRows.filter((row) => !["void"].includes(row.status.toLowerCase())).reduce((sum, row) => sum + row.amount, 0),
      paymentCount: paymentsMade.length,
    },
    accountRows,
  };
}
