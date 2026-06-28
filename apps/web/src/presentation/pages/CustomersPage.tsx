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
import { useI18n } from "../../i18n/I18nProvider";

type CustomerTab = "Other Details" | "Address" | "Contact Persons" | "Custom Fields" | "Reporting Tags" | "Remarks";

export function CustomersPage() {
  const { t, locale } = useI18n();
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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.customers.loadFailed"));
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, t]);

  const tabs: CustomerTab[] = ["Other Details", "Address", "Contact Persons", "Custom Fields", "Reporting Tags", "Remarks"];
  const selectedCustomer = useMemo(() => customers.find((item) => item.id === selectedId) || null, [customers, selectedId]);

  const customerTabLabels: Record<CustomerTab, string> = {
    "Other Details": t("sales.customers.tabs.otherDetails"),
    Address: t("sales.customers.tabs.address"),
    "Contact Persons": t("sales.customers.tabs.contactPersons"),
    "Custom Fields": t("sales.customers.tabs.customFields"),
    "Reporting Tags": t("sales.customers.tabs.reportingTags"),
    Remarks: t("sales.customers.tabs.remarks"),
  };

  const statementDocumentTypeLabels: Record<string, string> = {
    Invoice: t("sales.customers.statement.invoice"),
    Payment: t("sales.customers.statement.payment"),
  };

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
          actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.customers.statementLoadFailed"));
        }
      } finally {
        if (!cancelled) setLoadingStatement(false);
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback, selectedCustomer, t]);

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
      { key: "date", header: t("sales.customers.statement.date"), render: (row: AccountStatementRow) => row.date || "-" },
      { key: "type", header: t("sales.customers.statement.type"), render: (row: AccountStatementRow) => statementDocumentTypeLabels[row.document_type || ""] || row.document_type || "-" },
      { key: "document", header: t("sales.customers.statement.document"), render: (row: AccountStatementRow) => row.document_no || "-" },
      { key: "due", header: t("sales.customers.statement.dueDate"), render: (row: AccountStatementRow) => row.due_date || "-" },
      { key: "status", header: t("sales.customers.statement.status"), render: (row: AccountStatementRow) => row.status ? t(`sales.statuses.${row.status}`) : "-" },
      { key: "subtotal", header: t("sales.customers.statement.subtotal"), render: (row: AccountStatementRow) => `${row.subtotal.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "discount", header: t("sales.customers.statement.discount"), render: (row: AccountStatementRow) => `${row.discount.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "shipping", header: t("sales.customers.statement.shipping"), render: (row: AccountStatementRow) => `${row.shipping.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
      { key: "total", header: t("sales.customers.statement.total"), render: (row: AccountStatementRow) => `${row.total.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${row.currency}` },
    ],
    [statementDocumentTypeLabels, t],
  );

  const visibleStatementPeriodLabel = useMemo(() => {
    const parsed = new Date(`${statementAnchorDate}T00:00:00`);
    if (Number.isNaN(parsed.getTime())) return getStatementPeriodLabel(statementPeriodType, statementAnchorDate);
    const year = parsed.getFullYear();
    if (statementPeriodType === "monthly") {
      return new Intl.DateTimeFormat(locale === "tr" ? "tr-TR" : "en-US", { month: "long", year: "numeric" }).format(parsed);
    }
    if (statementPeriodType === "quarterly") {
      const quarter = Math.floor(parsed.getMonth() / 3) + 1;
      return t("sales.customers.statement.periodLabelQuarter", { quarter, year });
    }
    return String(year);
  }, [locale, statementAnchorDate, statementPeriodType, t]);

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
    actionFeedback.succeed(t("sales.customers.newDraftReady"));
  }

  async function handleSave() {
    if (!draft) return;
    const displayName = draft.display_name.trim() || draft.company_name.trim() || `${draft.first_name} ${draft.last_name}`.trim();
    const normalizedSellerProfileId =
      draft.seller_company_profile_id && companyProfiles.some((item) => item.id === draft.seller_company_profile_id)
        ? draft.seller_company_profile_id
        : "";
    if (!displayName) {
      actionFeedback.fail(t("sales.customers.displayOrCompanyRequired"));
      return;
    }
    if (!draft.price_list_type) {
      actionFeedback.fail(t("sales.customers.priceListRequired"));
      return;
    }
    if (draft.price_list_type === "Other" && draft.price_list_margin_percent == null) {
      actionFeedback.fail(t("sales.customers.priceListMarginRequired"));
      return;
    }

    try {
      setSaving(true);
      actionFeedback.begin(t("sales.customers.savingCustomer", { customerName: displayName }));
      const saved = await upsertCustomer({
        ...draft,
        display_name: displayName,
        seller_company_profile_id: normalizedSellerProfileId,
      });
      const rows = await fetchCustomers();
      setCustomers(rows);
      setSelectedId(saved.id);
      setDraft(saved);
      actionFeedback.succeed(t("sales.customers.customerSaved", { customerName: displayName }));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.customers.saveFailed"));
    } finally {
      setSaving(false);
    }
  }

  function handleCancel() {
    if (selectedCustomer) {
      setDraft(selectedCustomer);
      actionFeedback.succeed(t("sales.customers.changesReverted"));
      return;
    }
    const next = createEmptyCloudCustomer(customers);
    setDraft(next);
    setSelectedId(next.id);
  }

  async function handleDelete() {
    if (!draft?.id) return;
    const customerLabel = draft.display_name || draft.company_name || draft.customer_number;
    if (!confirm(t("sales.customers.deleteConfirm", { customerName: customerLabel }))) return;
    try {
      actionFeedback.begin(t("sales.customers.deletingCustomer", { customerName: customerLabel }));
      await deleteCustomer(draft.id);
      await refreshCustomers();
      actionFeedback.succeed(t("sales.customers.customerDeleted"));
    } catch (caught) {
      actionFeedback.fail(caught instanceof Error ? caught.message : t("sales.customers.deleteFailed"));
    }
  }

  return (
    <div className="customers-shell">
      <aside className="customers-sidebar">
        <div className="customers-sidebar__header">
          <h3>{t("sales.customers.title")}</h3>
          <Button className="button--compact" onClick={handleAddNew}>
            + {t("sales.customers.addCustomer")}
          </Button>
        </div>
        <div className="customers-list">
          {loading ? (
            <div className="empty-state">{t("sales.customers.loading")}</div>
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
            <div className="empty-state">{t("sales.customers.empty")}</div>
          )}
        </div>
      </aside>

      <section className="customers-editor">
        <div className="customers-editor__header">
          <h2>{t("sales.customers.editCustomer")}</h2>
          <div className="toolbar">
            <Button variant="secondary" onClick={handleCancel}>
              {t("sales.customers.cancel")}
            </Button>
            <Button variant="secondary" className="danger-button" onClick={() => void handleDelete()}>
              {t("common.delete")}
            </Button>
            <Button onClick={() => void handleSave()} busy={saving} busyLabel={t("common.saving")}>
              {t("sales.customers.save")}
            </Button>
          </div>
        </div>

        {draft ? (
          <div className="customers-form">
            <div className="customers-edit-card">
              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.customerType")}</div>
                <div className="customers-radio-group">
                  {(["Business", "Individual"] as const).map((item) => (
                    <label key={item} className="customers-radio">
                      <input type="radio" checked={draft.customer_type === item} onChange={() => updateDraft({ customer_type: item })} />
                      <span>{t(`sales.customers.customerTypes.${item}`)}</span>
                    </label>
                  ))}
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.primaryContact")}</div>
                <div className="customers-inline-fields customers-inline-fields--contact">
                  <label className="field customer-field customer-field--salutation">
                    <select className="field__input" value={draft.salutation} onChange={(event) => updateDraft({ salutation: event.target.value })}>
                      <option value="">{t("sales.customers.salutation")}</option>
                      <option value="Mr.">{t("sales.customers.salutations.mr")}</option>
                      <option value="Ms.">{t("sales.customers.salutations.ms")}</option>
                      <option value="Mrs.">{t("sales.customers.salutations.mrs")}</option>
                      <option value="Company">{t("sales.customers.salutations.company")}</option>
                    </select>
                  </label>
                  <Input value={draft.first_name} onChange={(value) => updateDraft({ first_name: value })} placeholder={t("sales.customers.firstName")} />
                  <Input value={draft.last_name} onChange={(value) => updateDraft({ last_name: value })} placeholder={t("sales.customers.lastName")} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.companyName")}</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.company_name} onChange={(value) => updateDraft({ company_name: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label customers-form-row__label customers-form-row__label--required">{t("sales.customers.displayName")}</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.display_name} onChange={(value) => updateDraft({ display_name: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.emailAddress")}</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <Input value={draft.email} onChange={(value) => updateDraft({ email: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label customers-form-row__label--required">{t("sales.customers.customerNumber")}</div>
                <div className="customers-field-wrap customers-field-wrap--medium">
                  <Input value={draft.customer_number} onChange={(value) => updateDraft({ customer_number: value })} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.phone")}</div>
                <div className="customers-inline-fields customers-inline-fields--phone">
                  <Input value={draft.work_phone} onChange={(value) => updateDraft({ work_phone: value })} placeholder={t("sales.customers.workPhone")} />
                  <Input value={draft.mobile_phone} onChange={(value) => updateDraft({ mobile_phone: value })} placeholder={t("sales.customers.mobile")} />
                </div>
              </div>

              <div className="customers-form-row">
                <div className="customers-form-row__label">{t("sales.customers.customerLanguage")}</div>
                <div className="customers-field-wrap customers-field-wrap--wide">
                  <label className="field customer-field">
                    <select className="field__input" value={draft.language} onChange={(event) => updateDraft({ language: event.target.value })}>
                      <option value="English">{t("sales.customers.languages.english")}</option>
                      <option value="Turkish">{t("sales.customers.languages.turkish")}</option>
                      <option value="Russian">{t("sales.customers.languages.russian")}</option>
                      <option value="German">{t("sales.customers.languages.german")}</option>
                    </select>
                  </label>
                </div>
              </div>
            </div>

            <div className="customers-tabs">
              {tabs.map((tab) => (
                <button key={tab} className={`customers-tab${activeTab === tab ? " active" : ""}`} onClick={() => setActiveTab(tab)}>
                  {customerTabLabels[tab]}
                </button>
              ))}
            </div>

            <div className="customers-tab-panel">
              {activeTab === "Other Details" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.taxRate")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.tax_rate} onChange={(event) => updateDraft({ tax_rate: event.target.value })}>
                          <option value="">{t("sales.customers.selectTax")}</option>
                          <option value="0%">0%</option>
                          <option value="10%">10%</option>
                          <option value="20%">20%</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.companyId")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <Input value={draft.company_id} onChange={(value) => updateDraft({ company_id: value })} />
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.currency")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.currency} onChange={(event) => updateDraft({ currency: event.target.value })}>
                          <option value="EUR">{t("sales.customers.currencies.eur")}</option>
                          <option value="USD">{t("sales.customers.currencies.usd")}</option>
                          <option value="TRY">{t("sales.customers.currencies.try")}</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.paymentTerms")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select className="field__input" value={draft.payment_terms} onChange={(event) => updateDraft({ payment_terms: event.target.value })}>
                          <option value="Cash in Advance">{t("sales.customers.paymentTerms.cashInAdvance")}</option>
                          <option value="Due on Receipt">{t("sales.customers.paymentTerms.dueOnReceipt")}</option>
                          <option value="Net 7">{t("sales.customers.paymentTerms.net7")}</option>
                          <option value="Net 15">{t("sales.customers.paymentTerms.net15")}</option>
                          <option value="Net 30">{t("sales.customers.paymentTerms.net30")}</option>
                          <option value="Net 60">{t("sales.customers.paymentTerms.net60")}</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.contractNr")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <Input value={draft.contract_nr} onChange={(value) => updateDraft({ contract_nr: value })} />
                    </div>
                  </div>
                  <div className="customers-form-row">
                    <div className="customers-form-row__label">{t("sales.customers.mainSeller")}</div>
                    <div className="customers-field-wrap customers-field-wrap--wide">
                      <label className="field customer-field">
                        <select
                          className="field__input"
                          value={draft.seller_company_profile_id}
                          onChange={(event) => updateDraft({ seller_company_profile_id: event.target.value })}
                        >
                          <option value="">{t("sales.customers.defaultCompanyProfile")}</option>
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
                    <div className="customers-form-row__label">{t("sales.customers.priceList")}</div>
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
                          <option value="">{t("sales.customers.selectPriceList")}</option>
                          <option value="A">{t("sales.customers.priceLists.a")}</option>
                          <option value="B">{t("sales.customers.priceLists.b")}</option>
                          <option value="C">{t("sales.customers.priceLists.c")}</option>
                          <option value="Other">{t("sales.customers.priceLists.other")}</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  {draft.price_list_type && draft.price_list_type !== "C" ? (
                    <div className="customers-form-row">
                      <div className="customers-form-row__label">{t("sales.customers.cPriceRule")}</div>
                      <div className="customers-field-wrap customers-field-wrap--wide">
                        <label className="field customer-field">
                          <select
                            className="field__input"
                            value={draft.portal_c_price_mode}
                            onChange={(event) => updateDraft({ portal_c_price_mode: event.target.value as LocalCustomer["portal_c_price_mode"] })}
                          >
                            <option value="standard">{t("sales.customers.cPriceRules.standard")}</option>
                            <option value="prefer_c_when_available">{t("sales.customers.cPriceRules.preferCWhenAvailable")}</option>
                          </select>
                        </label>
                      </div>
                    </div>
                  ) : null}
                  {draft.price_list_type === "Other" ? (
                    <div className="customers-form-row">
                      <div className="customers-form-row__label customers-form-row__label--required">{t("sales.customers.priceListMargin")}</div>
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
                    <div className="customers-form-row__label">{t("sales.customers.billingAddress")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.billing_address} onChange={(event) => updateDraft({ billing_address: event.target.value })} />
                      </label>
                    </div>
                  </div>
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("sales.customers.shippingAddress")}</div>
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
                    <div className="customers-form-row__label">{t("sales.customers.contactPersons")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.contact_persons} onChange={(event) => updateDraft({ contact_persons: event.target.value })} placeholder={t("sales.customers.contactPersonsPlaceholder")} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Custom Fields" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("sales.customers.customFields")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.custom_fields} onChange={(event) => updateDraft({ custom_fields: event.target.value })} placeholder={t("sales.customers.customFieldsPlaceholder")} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Reporting Tags" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("sales.customers.reportingTags")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.reporting_tags} onChange={(event) => updateDraft({ reporting_tags: event.target.value })} placeholder={t("sales.customers.reportingTagsPlaceholder")} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}

              {activeTab === "Remarks" ? (
                <div className="customers-edit-card customers-edit-card--narrow">
                  <div className="customers-form-row customers-form-row--top">
                    <div className="customers-form-row__label">{t("sales.customers.remarks")}</div>
                    <div className="customers-field-wrap customers-field-wrap--full">
                      <label className="field customer-field">
                        <textarea className="field__input field__input--textarea" value={draft.remarks} onChange={(event) => updateDraft({ remarks: event.target.value })} placeholder={t("sales.customers.remarksPlaceholder")} />
                      </label>
                    </div>
                  </div>
                </div>
              ) : null}
            </div>

            <SectionCard title={t("sales.customers.statement.title")}>
                <div className="toolbar toolbar--wrap">
                  <Select
                    label={t("sales.customers.statement.period")}
                  value={statementPeriodType}
                  options={[
                    { value: "monthly", label: t("sales.customers.statement.periods.monthly") },
                    { value: "quarterly", label: t("sales.customers.statement.periods.quarterly") },
                    { value: "yearly", label: t("sales.customers.statement.periods.yearly") },
                  ]}
                  onChange={(value) => setStatementPeriodType(value as StatementPeriodType)}
                  />
                  <Input label={t("sales.customers.statement.anchorDate")} type="date" value={statementAnchorDate} onChange={setStatementAnchorDate} />
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
                    {t("sales.customers.statement.printPdf")}
                  </Button>
                </div>
                {loadingStatement ? <div className="empty-state">{t("sales.customers.statement.loading")}</div> : null}
                <div className="meta-row">
                  <span>{t("sales.customers.statement.rowCount", { count: customerStatementRows.length.toLocaleString("en-US") })}</span>
                  <span>{visibleStatementPeriodLabel}</span>
              </div>
              <DataTable rows={customerStatementRows} columns={statementColumns} emptyText={t("sales.customers.statement.empty")} />
            </SectionCard>
          </div>
        ) : null}
      </section>
    </div>
  );
}
