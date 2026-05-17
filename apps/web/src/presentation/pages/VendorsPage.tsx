import { useEffect, useMemo, useState } from "react";
import { fetchBillsBySupplierNames, fetchPaymentsMadeBySupplierNames } from "../../infrastructure/api/ordersApi";
import { fetchCompanyProfiles } from "../../infrastructure/api/companyProfilesApi";
import { createEmptyCloudVendor, deleteVendor, fetchVendors, upsertVendor } from "../../infrastructure/api/vendorsApi";
import { getStatementPeriodLabel, isDateInStatementPeriod, openAccountStatementPrintWindow, type AccountStatementRow, type StatementPeriodType } from "../../shared/accountStatementPrint";
import type { CompanyProfile } from "../../types/company";
import type { LocalBill, LocalPaymentMade } from "../../types/orders";
import type { LocalVendor } from "../../types/vendors";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { SectionCard } from "../components/common/SectionCard";
import { Select } from "../components/common/Select";
import { SuppliersPage } from "./SuppliersPage";

type VendorTab = "Other Details" | "Address" | "Contact Persons" | "Custom Fields" | "Reporting Tags" | "Remarks";

export function VendorsPage() {
  const actionFeedback = useActionFeedback();
  const [activeMode, setActiveMode] = useState<"Vendor Directory" | "Supplier Prices">("Vendor Directory");
  const [vendors, setVendors] = useState<LocalVendor[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<LocalVendor | null>(null);
  const [activeTab, setActiveTab] = useState<VendorTab>("Other Details");
  const [saving, setSaving] = useState(false);
  const [loading, setLoading] = useState(false);
  const [loadingStatement, setLoadingStatement] = useState(false);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [bills, setBills] = useState<LocalBill[]>([]);
  const [paymentsMade, setPaymentsMade] = useState<LocalPaymentMade[]>([]);
  const [statementPeriodType, setStatementPeriodType] = useState<StatementPeriodType>("monthly");
  const [statementAnchorDate, setStatementAnchorDate] = useState(() => new Date().toISOString().slice(0, 10));

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        setLoading(true);
        const [rows, companyRows] = await Promise.all([fetchVendors(), fetchCompanyProfiles()]);
        if (cancelled) return;
        setVendors(rows);
        setCompanyProfiles(companyRows);
        if (rows[0]) {
          setSelectedId(rows[0].id);
          setDraft(rows[0]);
        } else {
          const next = createEmptyCloudVendor();
          setDraft(next);
          setSelectedId(next.id);
        }
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : "Vendors load failed");
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

  const selectedVendor = useMemo(() => vendors.find((item) => item.id === selectedId) || null, [vendors, selectedId]);
  const tabs: VendorTab[] = ["Other Details", "Address", "Contact Persons", "Custom Fields", "Reporting Tags", "Remarks"];

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (!selectedVendor) {
        setBills([]);
        setPaymentsMade([]);
        return;
      }

      const names = [selectedVendor.display_name, selectedVendor.company_name].map((item) => item.trim()).filter(Boolean);
      if (!names.length) {
        setBills([]);
        setPaymentsMade([]);
        return;
      }

      try {
        setLoadingStatement(true);
        const [billRows, paymentRows] = await Promise.all([
          fetchBillsBySupplierNames(names),
          fetchPaymentsMadeBySupplierNames(names),
        ]);
        if (cancelled) return;
        setBills(billRows);
        setPaymentsMade(paymentRows);
      } catch (caught) {
        if (!cancelled) {
          setBills([]);
          setPaymentsMade([]);
          actionFeedback.fail(caught instanceof Error ? caught.message : "Vendor statement load failed");
        }
      } finally {
        if (!cancelled) setLoadingStatement(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, selectedVendor]);

  const vendorStatementRows = useMemo(() => {
    if (!selectedVendor) return [] as AccountStatementRow[];
    const names = new Set(
      [selectedVendor.display_name, selectedVendor.company_name]
        .map((item) => item.trim())
        .filter(Boolean)
        .map((item) => item.toLowerCase()),
    );
    const billRows = bills
      .filter((bill) => names.has((bill.supplier_name || "").trim().toLowerCase()))
      .filter((bill) => isDateInStatementPeriod(bill.bill_date, statementPeriodType, statementAnchorDate))
      .map((bill) => ({
        document_type: "Bill",
        date: bill.bill_date,
        document_no: bill.id,
        due_date: bill.due_date,
        status: bill.status,
        currency: bill.currency,
        subtotal: bill.subtotal,
        discount: bill.discount_amount,
        shipping: bill.shipping_cost,
        total: bill.total_amount,
      }));

    const paymentRows = paymentsMade
      .filter((payment) => names.has((payment.supplier_name || "").trim().toLowerCase()))
      .filter((payment) => isDateInStatementPeriod(payment.payment_date, statementPeriodType, statementAnchorDate))
      .map((payment) => ({
        document_type: "Payment",
        date: payment.payment_date,
        document_no: payment.id,
        due_date: "",
        status: payment.status,
        currency: payment.currency,
        subtotal: 0,
        discount: 0,
        shipping: 0,
        total: -Math.abs(payment.amount),
      }));

    return [...billRows, ...paymentRows]
      .sort((a, b) => String(a.date).localeCompare(String(b.date)));
  }, [selectedVendor, bills, paymentsMade, statementPeriodType, statementAnchorDate]);

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

  function updateDraft(patch: Partial<LocalVendor>) {
    setDraft((current) => (current ? { ...current, ...patch } : current));
  }

  function handleSelectVendor(vendor: LocalVendor) {
    setSelectedId(vendor.id);
    setDraft(vendor);
  }

  function handleAddNew() {
    const next = createEmptyCloudVendor(vendors);
    setSelectedId(next.id);
    setDraft(next);
    setActiveTab("Other Details");
    actionFeedback.succeed("New vendor draft ready.");
  }

  async function handleSave() {
    if (!draft) return;
    const displayName = draft.display_name.trim() || draft.company_name.trim() || `${draft.first_name} ${draft.last_name}`.trim();
    if (!displayName) {
      actionFeedback.fail("Display Name or Company Name is required.");
      return;
    }

    try {
      setSaving(true);
      actionFeedback.begin(`Saving vendor ${displayName}...`);
      const saved = await upsertVendor({ ...draft, display_name: displayName });
      const rows = await fetchVendors();
      setVendors(rows);
      setSelectedId(saved.id);
      setDraft(saved);
      actionFeedback.succeed(`Vendor ${displayName} saved.`);
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Vendor save failed");
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (selectedVendor) {
      setDraft(selectedVendor);
      actionFeedback.succeed("Vendor changes reverted.");
      return;
    }
    const next = createEmptyCloudVendor(vendors);
    setDraft(next);
    setSelectedId(next.id);
  }

  async function handleDelete() {
    if (!draft?.id) return;
    if (!confirm(`Delete vendor ${draft.display_name || draft.company_name || draft.vendor_number}?`)) return;
    try {
      actionFeedback.begin(`Deleting vendor ${draft.display_name || draft.company_name || draft.vendor_number}...`);
      await deleteVendor(draft.id);
      const rows = await fetchVendors();
      setVendors(rows);
      if (rows[0]) {
        setSelectedId(rows[0].id);
        setDraft(rows[0]);
      } else {
        const next = createEmptyCloudVendor([]);
        setSelectedId(next.id);
        setDraft(next);
      }
      actionFeedback.succeed("Vendor deleted.");
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : "Vendor delete failed");
    }
  }

  if (activeMode === "Supplier Prices") {
    return (
      <div className="page-stack">
        <div className="module-tabs">
          {(["Vendor Directory", "Supplier Prices"] as const).map((item) => (
            <button key={item} className={`module-tab${activeMode === item ? " active" : ""}`} onClick={() => setActiveMode(item)}>
              {item}
            </button>
          ))}
        </div>
        <SuppliersPage />
      </div>
    );
  }

  return (
    <div className="page-stack">
      <div className="module-tabs">
        {(["Vendor Directory", "Supplier Prices"] as const).map((item) => (
          <button key={item} className={`module-tab${activeMode === item ? " active" : ""}`} onClick={() => setActiveMode(item)}>
            {item}
          </button>
        ))}
      </div>
      <div className="customers-shell">
        <aside className="customers-sidebar">
          <div className="customers-sidebar__header">
            <h3>Vendors</h3>
            <Button className="button--compact" onClick={handleAddNew}>
              + Add Vendor
            </Button>
          </div>
          <div className="customers-list">
            {loading ? (
              <div className="empty-state">Loading vendors...</div>
            ) : vendors.length ? (
              vendors.map((vendor) => (
                <button key={vendor.id} className={`customers-list__item${selectedId === vendor.id ? " active" : ""}`} onClick={() => handleSelectVendor(vendor)}>
                  <strong>{vendor.display_name || vendor.company_name || vendor.vendor_number}</strong>
                  <span>{vendor.vendor_number}</span>
                </button>
              ))
            ) : (
              <div className="empty-state">No vendors yet.</div>
            )}
          </div>
        </aside>

        <section className="customers-editor">
          <div className="customers-editor__header">
            <h2>Edit Vendor</h2>
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
                  <div className="customers-form-row__label">Vendor Type</div>
                  <div className="customers-radio-group">
                    {(["Business", "Individual"] as const).map((item) => (
                      <label key={item} className="customers-radio">
                        <input type="radio" checked={draft.vendor_type === item} onChange={() => updateDraft({ vendor_type: item })} />
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
                  <div className="customers-form-row__label customers-form-row__label--required">Display Name</div>
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
                  <div className="customers-form-row__label customers-form-row__label--required">Vendor Number</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input value={draft.vendor_number} onChange={(value) => updateDraft({ vendor_number: value })} />
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
                  <div className="customers-form-row__label">Vendor Language</div>
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
                          <textarea className="field__input field__input--textarea" value={draft.reporting_tags} onChange={(event) => updateDraft({ reporting_tags: event.target.value })} placeholder="Region, channel, buyer..." />
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
                          <textarea className="field__input field__input--textarea" value={draft.remarks} onChange={(event) => updateDraft({ remarks: event.target.value })} placeholder="Any vendor remarks..." />
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
                        title: `Vendor Statement - ${selectedVendor?.display_name || selectedVendor?.company_name || ""}`,
                        company: companyProfiles[0] || null,
                        partyName: selectedVendor?.display_name || selectedVendor?.company_name || "",
                        billingAddress: selectedVendor?.billing_address || "",
                        shippingAddress: selectedVendor?.shipping_address || "",
                        periodLabel: getStatementPeriodLabel(statementPeriodType, statementAnchorDate),
                        rows: vendorStatementRows,
                      })
                    }
                  >
                    Print / PDF
                  </Button>
                </div>
                {loadingStatement ? <div className="empty-state">Loading vendor statement...</div> : null}
                <div className="meta-row">
                  <span>{vendorStatementRows.length.toLocaleString("en-US")} statement rows</span>
                  <span>{getStatementPeriodLabel(statementPeriodType, statementAnchorDate)}</span>
                </div>
                <DataTable rows={vendorStatementRows} columns={statementColumns} emptyText="No bill activity in the selected period." />
              </SectionCard>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
