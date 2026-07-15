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
import { useI18n } from "../../i18n/I18nProvider";

type VendorTab = "Other Details" | "Address" | "Contact Persons" | "Custom Fields" | "Reporting Tags" | "Remarks";

export function VendorsPage() {
  const { t } = useI18n();
  const p = (key: string, params?: Record<string, string | number>) => t(`purchases.${key}`, params);
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
          actionFeedback.fail(caught instanceof Error ? caught.message : p("vendors.errors.loadFailed"));
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
          actionFeedback.fail(caught instanceof Error ? caught.message : p("vendors.errors.statementLoadFailed"));
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
      { key: "date", header: p("columns.date"), render: (row: AccountStatementRow) => row.date || "-" },
      { key: "type", header: p("columns.type"), render: (row: AccountStatementRow) => row.document_type ? p(`vendors.statement.documentTypes.${row.document_type.toLowerCase()}`) : "-" },
      { key: "document", header: p("columns.document"), render: (row: AccountStatementRow) => row.document_no || "-" },
      { key: "due", header: p("columns.dueDate"), render: (row: AccountStatementRow) => row.due_date || "-" },
      { key: "status", header: p("columns.status"), render: (row: AccountStatementRow) => (row.status ? p(`statuses.${String(row.status).toLowerCase()}`) : "-") },
      { key: "subtotal", header: p("columns.subtotal"), render: (row: AccountStatementRow) => `${row.subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "discount", header: p("columns.discount"), render: (row: AccountStatementRow) => `${row.discount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "shipping", header: p("columns.shipping"), render: (row: AccountStatementRow) => `${row.shipping.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "total", header: p("columns.total"), render: (row: AccountStatementRow) => `${row.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
    ],
    [t],
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
    actionFeedback.succeed(p("vendors.feedback.newDraftReady"));
  }

  async function handleSave() {
    if (!draft) return;
    const displayName = draft.display_name.trim() || draft.company_name.trim() || `${draft.first_name} ${draft.last_name}`.trim();
    if (!displayName) {
      actionFeedback.fail(p("vendors.errors.displayOrCompanyRequired"));
      return;
    }

    try {
      setSaving(true);
      actionFeedback.begin(p("vendors.feedback.savingVendor", { vendor: displayName }));
      const saved = await upsertVendor({ ...draft, display_name: displayName });
      const rows = await fetchVendors();
      setVendors(rows);
      setSelectedId(saved.id);
      setDraft(saved);
      actionFeedback.succeed(p("vendors.feedback.vendorSaved", { vendor: displayName }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : p("vendors.errors.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (selectedVendor) {
      setDraft(selectedVendor);
      actionFeedback.succeed(p("vendors.feedback.changesReverted"));
      return;
    }
    const next = createEmptyCloudVendor(vendors);
    setDraft(next);
    setSelectedId(next.id);
  }

  async function handleDelete() {
    if (!draft?.id) return;
    if (!confirm(p("vendors.confirm.delete", { vendor: draft.display_name || draft.company_name || draft.vendor_number }))) return;
    try {
      actionFeedback.begin(p("vendors.feedback.deletingVendor", { vendor: draft.display_name || draft.company_name || draft.vendor_number }));
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
      actionFeedback.succeed(p("vendors.feedback.vendorDeleted"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : p("vendors.errors.deleteFailed"));
    }
  }

  if (activeMode === "Supplier Prices") {
    return (
      <div className="page-stack">
        <div className="module-tabs">
          {(["Vendor Directory", "Supplier Prices"] as const).map((item) => (
            <button key={item} className={`module-tab${activeMode === item ? " active" : ""}`} onClick={() => setActiveMode(item)}>
              {item === "Vendor Directory" ? p("vendors.tabs.directory") : p("vendors.tabs.supplierPrices")}
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
              {item === "Vendor Directory" ? p("vendors.tabs.directory") : p("vendors.tabs.supplierPrices")}
            </button>
          ))}
        </div>
      <div className="customers-shell">
        <aside className="customers-sidebar">
          <div className="customers-sidebar__header">
            <h3>{p("vendors.title")}</h3>
            <Button className="button--compact" onClick={handleAddNew}>
              {p("vendors.actions.addVendor")}
            </Button>
          </div>
          <div className="customers-list">
            {loading ? (
              <div className="empty-state">{p("vendors.loading")}</div>
            ) : vendors.length ? (
              vendors.map((vendor) => (
                <button key={vendor.id} className={`customers-list__item${selectedId === vendor.id ? " active" : ""}`} onClick={() => handleSelectVendor(vendor)}>
                  <strong>{vendor.display_name || vendor.company_name || vendor.vendor_number}</strong>
                  <span>{vendor.vendor_number}</span>
                </button>
              ))
            ) : (
              <div className="empty-state">{p("vendors.empty")}</div>
            )}
          </div>
        </aside>

        <section className="customers-editor">
          <div className="customers-editor__header">
            <h2>{p("vendors.editVendor")}</h2>
            <div className="toolbar">
              <Button variant="secondary" onClick={handleCancel}>
                {t("common.cancel")}
              </Button>
              <Button variant="secondary" className="danger-button" onClick={() => void handleDelete()}>
                {t("common.delete")}
              </Button>
              <Button onClick={() => void handleSave()} busy={saving} busyLabel={t("common.saving")}>
                {t("common.save")}
              </Button>
            </div>
          </div>
          {draft ? (
            <div className="customers-form">
              <div className="customers-edit-card">
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.vendorType")}</div>
                  <div className="customers-radio-group">
                    {(["Business", "Individual"] as const).map((item) => (
                      <label key={item} className="customers-radio">
                        <input type="radio" checked={draft.vendor_type === item} onChange={() => updateDraft({ vendor_type: item })} />
                        <span>{p(`vendors.vendorTypes.${item.toLowerCase()}`)}</span>
                      </label>
                    ))}
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.primaryContact")}</div>
                  <div className="customers-inline-fields customers-inline-fields--contact">
                    <label className="field customer-field customer-field--salutation">
                      <select className="field__input" value={draft.salutation} onChange={(event) => updateDraft({ salutation: event.target.value })}>
                        <option value="">{p("vendors.fields.salutation")}</option>
                        <option value="Mr.">{p("vendors.salutations.mr")}</option>
                        <option value="Ms.">{p("vendors.salutations.ms")}</option>
                        <option value="Mrs.">{p("vendors.salutations.mrs")}</option>
                        <option value="Company">{p("vendors.salutations.company")}</option>
                      </select>
                    </label>
                    <Input value={draft.first_name} onChange={(value) => updateDraft({ first_name: value })} placeholder={p("vendors.fields.firstName")} />
                    <Input value={draft.last_name} onChange={(value) => updateDraft({ last_name: value })} placeholder={p("vendors.fields.lastName")} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.companyName")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.company_name} onChange={(value) => updateDraft({ company_name: value })} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label customers-form-row__label--required">{p("vendors.fields.displayName")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.display_name} onChange={(value) => updateDraft({ display_name: value })} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.emailAddress")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <Input value={draft.email} onChange={(value) => updateDraft({ email: value })} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label customers-form-row__label--required">{p("vendors.fields.vendorNumber")}</div>
                  <div className="customers-field-wrap customers-field-wrap--medium">
                    <Input value={draft.vendor_number} onChange={(value) => updateDraft({ vendor_number: value })} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.phone")}</div>
                  <div className="customers-inline-fields customers-inline-fields--phone">
                    <Input value={draft.work_phone} onChange={(value) => updateDraft({ work_phone: value })} placeholder={p("vendors.fields.workPhone")} />
                    <Input value={draft.mobile_phone} onChange={(value) => updateDraft({ mobile_phone: value })} placeholder={p("vendors.fields.mobile")} />
                  </div>
                </div>
                <div className="customers-form-row">
                  <div className="customers-form-row__label">{p("vendors.fields.vendorLanguage")}</div>
                  <div className="customers-field-wrap customers-field-wrap--wide">
                    <label className="field customer-field">
                      <select className="field__input" value={draft.language} onChange={(event) => updateDraft({ language: event.target.value })}>
                        <option value="English">{p("vendors.languages.english")}</option>
                        <option value="Turkish">{p("vendors.languages.turkish")}</option>
                        <option value="Russian">{p("vendors.languages.russian")}</option>
                        <option value="German">{p("vendors.languages.german")}</option>
                      </select>
                    </label>
                  </div>
                </div>
              </div>
              <div className="customers-tabs">
                {tabs.map((tab) => (
                  <button key={tab} className={`customers-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
                    {p(`vendors.tabs.${tab.replace(/\s+/g, "").replace(/^./, (char) => char.toLowerCase())}`)}
                  </button>
                ))}
              </div>
              <div className="customers-tab-panel">
                {activeTab === "Other Details" ? (
                  <div className="customers-edit-card customers-edit-card--narrow">
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{p("vendors.fields.taxRate")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <label className="field customer-field">
                          <select className="field__input" value={draft.tax_rate} onChange={(event) => updateDraft({ tax_rate: event.target.value })}>
                            <option value="">{p("vendors.fields.selectTax")}</option>
                            <option value="0%">0%</option>
                            <option value="10%">10%</option>
                            <option value="20%">20%</option>
                          </select>
                        </label>
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{p("vendors.fields.companyId")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <Input value={draft.company_id} onChange={(value) => updateDraft({ company_id: value })} />
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{p("vendors.fields.currency")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <label className="field customer-field">
                          <select className="field__input" value={draft.currency} onChange={(event) => updateDraft({ currency: event.target.value })}>
                            <option value="EUR">{p("vendors.currencies.eur")}</option>
                            <option value="USD">{p("vendors.currencies.usd")}</option>
                            <option value="TRY">{p("vendors.currencies.try")}</option>
                          </select>
                        </label>
                      </div>
                    </div>
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{p("vendors.fields.paymentTerms")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <label className="field customer-field">
                          <select className="field__input" value={draft.payment_terms} onChange={(event) => updateDraft({ payment_terms: event.target.value })}>
                            <option value="Cash in Advance">{p("vendors.paymentTerms.cashInAdvance")}</option>
                            <option value="Due on Receipt">{p("vendors.paymentTerms.dueOnReceipt")}</option>
                            <option value="Net 7">{p("vendors.paymentTerms.net7")}</option>
                            <option value="Net 15">{p("vendors.paymentTerms.net15")}</option>
                            <option value="Net 30">{p("vendors.paymentTerms.net30")}</option>
                            <option value="Net 60">{p("vendors.paymentTerms.net60")}</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeTab === "Address" ? (
                  <div className="customers-edit-card customers-edit-card--narrow">
                    <div className="customers-form-row customers-form-row--top">
                      <div className="customers-form-row__label">{p("vendors.fields.billingAddress")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <label className="field customer-field">
                          <textarea className="field__input field__input--textarea" value={draft.billing_address} onChange={(event) => updateDraft({ billing_address: event.target.value })} />
                        </label>
                      </div>
                    </div>
                    <div className="customers-form-row customers-form-row--top">
                      <div className="customers-form-row__label">{p("vendors.fields.shippingAddress")}</div>
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
                      <div className="customers-form-row__label">{p("vendors.fields.contactPersons")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <label className="field customer-field">
                          <textarea className="field__input field__input--textarea" value={draft.contact_persons} onChange={(event) => updateDraft({ contact_persons: event.target.value })} placeholder={p("vendors.placeholders.contactPersons")} />
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeTab === "Custom Fields" ? (
                  <div className="customers-edit-card customers-edit-card--narrow">
                    <div className="customers-form-row customers-form-row--top">
                      <div className="customers-form-row__label">{p("vendors.fields.customFields")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <label className="field customer-field">
                          <textarea className="field__input field__input--textarea" value={draft.custom_fields} onChange={(event) => updateDraft({ custom_fields: event.target.value })} placeholder={p("vendors.placeholders.customFields")} />
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeTab === "Reporting Tags" ? (
                  <div className="customers-edit-card customers-edit-card--narrow">
                    <div className="customers-form-row customers-form-row--top">
                      <div className="customers-form-row__label">{p("vendors.fields.reportingTags")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <label className="field customer-field">
                          <textarea className="field__input field__input--textarea" value={draft.reporting_tags} onChange={(event) => updateDraft({ reporting_tags: event.target.value })} placeholder={p("vendors.placeholders.reportingTags")} />
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}
                {activeTab === "Remarks" ? (
                  <div className="customers-edit-card customers-edit-card--narrow">
                    <div className="customers-form-row customers-form-row--top">
                      <div className="customers-form-row__label">{p("vendors.fields.remarks")}</div>
                      <div className="customers-field-wrap customers-field-wrap--full">
                        <label className="field customer-field">
                          <textarea className="field__input field__input--textarea" value={draft.remarks} onChange={(event) => updateDraft({ remarks: event.target.value })} placeholder={p("vendors.placeholders.remarks")} />
                        </label>
                      </div>
                    </div>
                  </div>
                ) : null}
              </div>
              <SectionCard title={p("vendors.statement.title")}>
                <div className="toolbar toolbar--wrap">
                  <Select
                    label={p("vendors.statement.period")}
                    value={statementPeriodType}
                    options={[
                      { value: "monthly", label: p("vendors.statement.periods.monthly") },
                      { value: "quarterly", label: p("vendors.statement.periods.quarterly") },
                      { value: "yearly", label: p("vendors.statement.periods.yearly") },
                    ]}
                    onChange={(value) => setStatementPeriodType(value as StatementPeriodType)}
                  />
                  <Input label={p("vendors.statement.anchorDate")} type="date" value={statementAnchorDate} onChange={setStatementAnchorDate} />
                  <Button
                    disabled={loadingStatement}
                    variant="secondary"
                    onClick={() =>
                      openAccountStatementPrintWindow({
                        title: p("vendors.statement.printTitle", { vendor: selectedVendor?.display_name || selectedVendor?.company_name || "" }),
                        company: companyProfiles[0] || null,
                        partyName: selectedVendor?.display_name || selectedVendor?.company_name || "",
                        billingAddress: selectedVendor?.billing_address || "",
                        shippingAddress: selectedVendor?.shipping_address || "",
                        periodLabel: getStatementPeriodLabel(statementPeriodType, statementAnchorDate),
                        rows: vendorStatementRows,
                      })
                    }
                  >
                    {p("actions.printPdf")}
                  </Button>
                </div>
                {loadingStatement ? <div className="empty-state">{p("vendors.statement.loading")}</div> : null}
                <div className="meta-row">
                  <span>{p("vendors.statement.rows", { count: vendorStatementRows.length.toLocaleString("en-US") })}</span>
                  <span>{getStatementPeriodLabel(statementPeriodType, statementAnchorDate)}</span>
                </div>
                <DataTable rows={vendorStatementRows} columns={statementColumns} emptyText={p("vendors.statement.empty")} />
              </SectionCard>
            </div>
          ) : null}
        </section>
      </div>
    </div>
  );
}
