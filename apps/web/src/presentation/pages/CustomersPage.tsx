import { useEffect, useMemo, useState } from "react";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { DataTable } from "../components/common/DataTable";
import { Select } from "../components/common/Select";
import { SectionCard } from "../components/common/SectionCard";
import { fetchCompanyProfiles } from "../../infrastructure/api/companyProfilesApi";
import { createEmptyCloudCustomer, deleteCustomer, fetchCustomers, upsertCustomer } from "../../infrastructure/api/customersApi";
import { fetchInvoicesByCustomerNames, fetchPaymentsReceivedByCustomerNames } from "../../infrastructure/api/ordersApi";
import { getStatementPeriodLabel, isDateInStatementPeriod, openAccountStatementPrintWindow, type AccountStatementRow, type StatementPeriodType } from "../../shared/accountStatementPrint";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { LocalInvoice, LocalPaymentReceived } from "../../types/orders";

type CustomerTab = "Other Details" | "Address" | "Contact Persons" | "Custom Fields" | "Reporting Tags" | "Remarks";

export function CustomersPage() {
  const actionFeedback = useActionFeedback();
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<LocalCustomer | null>(null);
  const [activeTab, setActiveTab] = useState<CustomerTab>("Other Details");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [invoices, setInvoices] = useState<LocalInvoice[]>([]);
  const [paymentsReceived, setPaymentsReceived] = useState<LocalPaymentReceived[]>([]);
  const [statementPeriodType, setStatementPeriodType] = useState<StatementPeriodType>("monthly");
  const [statementAnchorDate, setStatementAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        const [rows, companyRows] = await Promise.all([fetchCustomers(), fetchCompanyProfiles()]);
        if (cancelled) return;
        setCustomers(rows);
        setCompanyProfiles(companyRows);
        if (rows[0]) {
          setSelectedId(rows[0].id);
          setDraft(rows[0]);
        } else {
          const next = createEmptyCloudCustomer();
          setDraft(next);
          setSelectedId(next.id);
        }
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Customers load failed");
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback]);

  const tabs: CustomerTab[] = ["Other Details", "Address", "Contact Persons", "Custom Fields", "Reporting Tags", "Remarks"];
  const selectedCustomer = useMemo(() => customers.find((item) => item.id === selectedId) || null, [customers, selectedId]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedCustomer) {
        setInvoices([]);
        setPaymentsReceived([]);
        return;
      }

      const names = [selectedCustomer.display_name, selectedCustomer.company_name].map((item) => item.trim()).filter(Boolean);
      if (!names.length) {
        setInvoices([]);
        setPaymentsReceived([]);
        return;
      }

      try {
        setLoadingStatement(true);
        const [invoiceRows, paymentRows] = await Promise.all([
          fetchInvoicesByCustomerNames(names),
          fetchPaymentsReceivedByCustomerNames(names),
        ]);
        if (cancelled) return;
        setInvoices(invoiceRows);
        setPaymentsReceived(paymentRows);
      } catch (caught) {
        if (!cancelled) {
          setInvoices([]);
          setPaymentsReceived([]);
          actionFeedback.fail(caught instanceof Error ? caught.message : "Customer statement load failed");
        }
      } finally {
        if (!cancelled) setLoadingStatement(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, selectedCustomer]);

  async function refreshCustomers(nextSelectedId?: string) {
    const rows = await fetchCustomers();
    setCustomers(rows);
    if (rows.length) {
      const selected = (nextSelectedId && rows.find((item) => item.id === nextSelectedId)) || rows[0];
      setSelectedId(selected.id);
      setDraft(selected);
      return;
    }

    const next = createEmptyCloudCustomer(rows);
    setSelectedId(next.id);
    setDraft(next);
  }

  const customerStatementRows = useMemo(() => {
    if (!selectedCustomer) return [] as AccountStatementRow[];
    const names = new Set(
      [selectedCustomer.display_name, selectedCustomer.company_name]
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.toLowerCase()),
    );

    const invoiceRows = invoices
      .filter((invoice) => names.has((invoice.customer_name || "").trim().toLowerCase()))
      .filter((invoice) => isDateInStatementPeriod(invoice.quote_date, statementPeriodType, statementAnchorDate))
      .map((invoice) => ({
        document_type: "Invoice",
        date: invoice.quote_date,
        document_no: invoice.id,
        due_date: invoice.due_date,
        status: invoice.status,
        currency: invoice.currency,
        subtotal: invoice.subtotal,
        discount: invoice.discount_amount,
        shipping: invoice.shipping_cost,
        total: invoice.total_amount,
      }));

    const paymentRows = paymentsReceived
      .filter((payment) => names.has((payment.customer_name || "").trim().toLowerCase()))
      .filter((payment) => isDateInStatementPeriod(payment.received_date, statementPeriodType, statementAnchorDate))
      .map((payment) => ({
        document_type: "Payment",
        date: payment.received_date,
        document_no: payment.id,
        due_date: "",
        status: payment.status,
        currency: payment.currency,
        subtotal: 0,
        discount: 0,
        shipping: 0,
        total: -Math.abs(payment.amount),
      }));

    return [...invoiceRows, ...paymentRows]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [selectedCustomer, invoices, paymentsReceived, statementPeriodType, statementAnchorDate]);

  const statementColumns = useMemo(
    () => [
      { key: "date", header: "Date", render: (row: AccountStatementRow) => row.date || "-" },
      { key: "type", header: "Type", render: (row: AccountStatementRow) => row.document_type || "-" },
      { key: "document", header: "Document", render: (row: AccountStatementRow) => row.document_no || "-" },
      { key: "due", header: "Due Date", render: (row: AccountStatementRow) => row.due_date || "-" },
      { key: "status", header: "Status", render: (row: AccountStatementRow) => row.status || "-" },
      { key: "subtotal", header: "Subtotal", render: (row: AccountStatementRow) => `${row.subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "discount", header: "Discount", render: (row: AccountStatementRow) => `${row.discount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "shipping", header: "Shipping", render: (row: AccountStatementRow) => `${row.shipping.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "total", header: "Total", render: (row: AccountStatementRow) => `${row.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
    ],
    [],
  );

  function updateDraft(patch: Partial<LocalCustomer>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function handleSelectCustomer(customer: LocalCustomer) {
    setSelectedId(customer.id);
    setDraft(customer);
  }

  function handleAddNew() {
    const next = createEmptyCloudCustomer(customers);
    setSelectedId(next.id);
    setDraft(next);
    setActiveTab("Other Details");
    actionFeedback.succeed("New customer draft ready.");
  }

  async function handleSave() {
    if (!draft) return;
    const displayName = draft.display_name.trim() || draft.company_name.trim() || `${draft.first_name} ${draft.last_name}`.trim();
    if (!displayName) {
      actionFeedback.fail("Display Name or Company Name is required.");
      return;
    }
    if (!draft.price_list_type) {
      actionFeedback.fail("Price List is required.");
      return;
    }
    if (draft.price_list_type === "Other" && draft.price_list_margin_percent == null) {
      actionFeedback.fail("Price List Margin % is required when Price List is Other.");
      return;
    }

    try {
      setSaving(true);
      actionFeedback.begin(`Saving customer ${displayName}...`);
      const saved = await upsertCustomer({ ...draft, display_name: displayName });
      const rows = await fetchCustomers();
      setCustomers(rows);
      setSelectedId(saved.id);
      setDraft(saved);
      actionFeedback.succeed(`Customer ${displayName} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Customer save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (selectedCustomer) {
      setDraft(selectedCustomer);
      actionFeedback.succeed("Customer changes reverted.");
      return;
    }
    const next = createEmptyCloudCustomer(customers);
    setDraft(next);
    setSelectedId(next.id);
  }

  async function handleDelete() {
    if (!draft?.id) return;
    if (!confirm(`Delete customer ${draft.display_name || draft.company_name || draft.customer_number}?`)) return;
    try {
      actionFeedback.begin(`Deleting customer ${draft.display_name || draft.company_name || draft.customer_number}...`);
      await deleteCustomer(draft.id);
      await refreshCustomers();
      actionFeedback.succeed("Customer deleted.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Customer delete failed");
    }
  }

  return (
    <div className="customers-shell">
      <aside className="customers-sidebar">
        <div className="customers-sidebar__header">
          <h3>Customers</h3>
          <Button className="button--compact" onClick={handleAddNew}>
            + Add Customer
          </Button>
        </div>
        <div className="customers-list">
          {loading ? (
            <div className="empty-state">Loading customers...</div>
          ) : customers.length ? (
            customers.map((customer) => (
              <button
                key={customer.id}
                className={`customers-list__item${selectedId === customer.id ? " active" : ""}`}
                onClick={() => handleSelectCustomer(customer)}
              >
                <strong>{customer.display_name || customer.company_name || customer.customer_number}</strong>
                <span>{customer.customer_number}</span>
              </button>
            ))
          ) : (
            <div className="empty-state">No customers yet.</div>
          )}
        </div>
      </aside>

      <section className="customers-editor">
        <div className="customers-editor__header">
          <h2>Edit Customer</h2>
          <div className="toolbar">
            <Button variant="secondary" onClick={handleCancel}>
              Cancel
            </Button>
            <Button variant="secondary" className="danger-button" onClick={() => void handleDelete()}>
              Delete
            </Button>
            <Button onClick={() => void handleSave()} busy={saving} busyLabel="Saving...">
              Save
            </Button>
          </div>
        </div>

        {draft ? (
          <div className="customers-form">
            <div className="customers-edit-card">
              <div className="customers-form-row">
                <div className="customers-form-row__label">Customer Type</div>
                <div className="customers-radio-group">
                  {(["Business", "Individual"] as const).map((item) => (
                    <label key={item} className="customers-radio">
                      <input type="radio" checked={draft.customer_type === item} onChange={() => updateDraft({ customer_type: item })} />
                      <span>{item}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">Primary Contact</div>
                <div className="customers-inline-fields customers-inline-fields--contact">
                  <label className="field customer-field customer-field--salutation">
                    <select className="field__input" value={draft.salutation} onChange={(event) => updateDraft({ salutation: event.target.value })}>
                      <option value="">Salutation</option>
                      <option value="Mr.">Mr.</option>
                      <option value="Ms.">Ms.</option>
                      <option value="Mrs.">Mrs.</option>
                      <option value="Company">Company</option>
                    </select>
                  </label>
                  <Input value={draft.first_name} onChange={(value) => updateDraft({ first_name: value })} placeholder="First Name" />
                  <Input value={draft.last_name} onChange={(value) => updateDraft({ last_name: value })} placeholder="Last Name" />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">Company Name</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.company_name} onChange={(value) => updateDraft({ company_name: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label customers-form-row__label customers-form-row__label--required">Display Name</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.display_name} onChange={(value) => updateDraft({ display_name: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">Email Address</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.email} onChange={(value) => updateDraft({ email: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label customers-form-row__label--required">Customer Number</div>
                <div className="customers-field-wrap customers-field-wrap--medium">
                  <Input value={draft.customer_number} onChange={(value) => updateDraft({ customer_number: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">Phone</div>
                <div className="customers-inline-fields customers-inline-fields--phone">
                  <Input value={draft.work_phone} onChange={(value) => updateDraft({ work_phone: value })} placeholder="Work Phone" />
                  <Input value={draft.mobile_phone} onChange={(value) => updateDraft({ mobile_phone: value })} placeholder="Mobile" />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">Customer Language</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <label className="field customer-field">
                    <select className="field__input" value={draft.language} onChange={(event) => updateDraft({ language: event.target.value })}>
                      <option value="English">English</option>
                      <option value="Turkish">Turkish</option>
                      <option value="Russian">Russian</option>
                      <option value="German">German</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>

            <div className="customers-tabs">
              {tabs.map((tab) => (
                <button key={tab} className={`customers-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
                  {tab}
                </button>
              ))}
            </div>

            <div className="customers-tab-panel">
              {activeTab === "Other Details" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Tax Rate</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.tax_rate} onChange={(event) => updateDraft({ tax_rate: event.target.value })}>
                          <option value="">Select a Tax</option>
                          <option value="0%">0%</option>
                          <option value="10%">10%</option>
                          <option value="20%">20%</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Company ID</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <Input value={draft.company_id} onChange={(value) => updateDraft({ company_id: value })} />
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Currency</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.currency} onChange={(event) => updateDraft({ currency: event.target.value })}>
                          <option value="EUR">EUR - Euro</option>
                          <option value="USD">USD - US Dollar</option>
                          <option value="TRY">TRY - Turkish Lira</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Payment Terms</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.payment_terms} onChange={(event) => updateDraft({ payment_terms: event.target.value })}>
                          <option value="Cash in Advance">Cash in Advance</option>
                          <option value="Due on Receipt">Due on Receipt</option>
                          <option value="Net 7">Net 7</option>
                          <option value="Net 15">Net 15</option>
                          <option value="Net 30">Net 30</option>
                          <option value="Net 60">Net 60</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Contract Nr</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <Input value={draft.contract_nr} onChange={(value) => updateDraft({ contract_nr: value })} />
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Main Seller</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select
                          className="field__input"
                          value={draft.seller_company_profile_id}
                          onChange={(event) => updateDraft({ seller_company_profile_id: event.target.value })}
                        >
                          <option value="">Default company profile</option>
                          {companyProfiles.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.companyName}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">Price List</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select
                          className="field__input"
                          value={draft.price_list_type}
                          onChange={(event) => {
                            const nextType = event.target.value as LocalCustomer["price_list_type"];
                            updateDraft({
                              price_list_type: nextType,
                              portal_c_price_mode: nextType === "C" ? "standard" : draft.portal_c_price_mode,
                            });
                          }}
                        >
                          <option value="">Select price list</option>
                          <option value="A">A Price List</option>
                          <option value="B">B Price List</option>
                          <option value="C">C Price List</option>
                          <option value="Other">Other</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  {draft.price_list_type && draft.price_list_type !== "C" ? (
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">C Price Rule</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <label className="field customer-field">
                          <select
                            className="field__input"
                            value={draft.portal_c_price_mode}
                            onChange={(event) => updateDraft({ portal_c_price_mode: event.target.value as LocalCustomer["portal_c_price_mode"] })}
                          >
                            <option value="standard">Use selected account price list only</option>
                            <option value="prefer_c_when_available">Use C prices where available</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  ) : null}
                  {draft.price_list_type === "Other" ? (
                    <div className="customers-form-row">
                      <div className="customers-form-row__label customers-form-row__label--required">Price List Margin %</div>
                      <div className="customers-field-wrap customers-field-wrap--medium">
                        <Input
                          value={draft.price_list_margin_percent == null ? "" : String(draft.price_list_margin_percent)}
                          onChange={(value) =>
                            updateDraft({
                              price_list_margin_percent: value.trim()
                                ? Number(value.replace(",", ".")) || 0
                                : null,
                            })
                          }
                          placeholder="12,50"
                        />
                      </div>
                    </div>
                  ) : null}
                </div>
              ) : null}

              {activeTab === "Address" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Billing Address</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.billing_address} onChange={(event) => updateDraft({ billing_address: event.target.value })} />
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Shipping Address</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.shipping_address} onChange={(event) => updateDraft({ shipping_address: event.target.value })} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Contact Persons" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Contact Persons</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.contact_persons} onChange={(event) => updateDraft({ contact_persons: event.target.value })} placeholder="Name, role, phone, email..." />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Custom Fields" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Custom Fields</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.custom_fields} onChange={(event) => updateDraft({ custom_fields: event.target.value })} placeholder="Internal custom field notes..." />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Reporting Tags" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Reporting Tags</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.reporting_tags} onChange={(event) => updateDraft({ reporting_tags: event.target.value })} placeholder="Region, channel, sales owner..." />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Remarks" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">Remarks</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.remarks} onChange={(event) => updateDraft({ remarks: event.target.value })} placeholder="Any customer remarks..." />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <SectionCard title="Account Statement">
                <div className="toolbar toolbar--wrap">
                  <Select
                    label="Period"
                  value={statementPeriodType}
                  options={[
                    { value: "monthly", label: "Monthly" },
                    { value: "quarterly", label: "Quarterly" },
                    { value: "yearly", label: "Yearly" },
                  ]}
                  onChange={(value) => setStatementPeriodType(value as StatementPeriodType)}
                  />
                  <Input label="Anchor Date" type="date" value={statementAnchorDate} onChange={setStatementAnchorDate} />
                  <Button
                    disabled={loadingStatement}
                    variant="secondary"
                    onClick={() =>
                      openAccountStatementPrintWindow({
                      title: `Customer Statement - ${selectedCustomer?.display_name || selectedCustomer?.company_name || ""}`,
                      company: companyProfiles[0] || null,
                      partyName: selectedCustomer?.display_name || selectedCustomer?.company_name || "",
                      billingAddress: selectedCustomer?.billing_address || "",
                      shippingAddress: selectedCustomer?.shipping_address || "",
                      periodLabel: getStatementPeriodLabel(statementPeriodType, statementAnchorDate),
                      rows: customerStatementRows,
                    })
                  }
                  >
                    Print / PDF
                  </Button>
                </div>
                {loadingStatement ? <div className="empty-state">Loading customer statement...</div> : null}
                <div className="meta-row">
                  <span>{customerStatementRows.length.toLocaleString("en-US")} statement rows</span>
                  <span>{getStatementPeriodLabel(statementPeriodType, statementAnchorDate)}</span>
              </div>
              <DataTable rows={customerStatementRows} columns={statementColumns} emptyText="No invoice activity in the selected period." />
            </SectionCard>
          </div>
        ) : null}
      </section>
    </div>
  );
}
