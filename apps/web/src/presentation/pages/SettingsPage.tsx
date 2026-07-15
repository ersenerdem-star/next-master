import { useEffect, useState } from "react";
import {
  createOrgUser,
  deleteOrgUser,
  fetchAdminDiagnostics,
  isPasswordResetAvailable,
  resetOrgUserPassword,
  sendAdminTestEmail,
  updateOrgUser,
  type AdminDiagnostics,
} from "../../infrastructure/api/adminApi";
import { createEmptyCloudCompanyProfile, deleteCompanyProfileById, fetchCompanyProfiles, upsertCompanyProfile } from "../../infrastructure/api/companyProfilesApi";
import { fetchCustomers } from "../../infrastructure/api/customersApi";
import { deliverQueuedEmails, fetchEmailTemplates, fetchOutboundEmails, sendPortalInviteEmail, setOutboundEmailStatus, upsertEmailTemplate } from "../../infrastructure/api/emailTemplatesApi";
import {
  clearPortalInvitePassword,
  createEmptyCloudPortalInvite,
  deletePortalInvite,
  fetchPortalInvites,
  markPortalInviteSent,
  setPortalInvitePassword,
  setPortalInviteStatus,
  upsertPortalInvite,
} from "../../infrastructure/api/portalInvitesApi";
import { fetchCloudBrands } from "../../infrastructure/api/brandsApi";
import type { BrandOption } from "../../types/brand";
import { fetchAppSession } from "../../infrastructure/api/appSessionApi";
import { fetchOrgUsers, getPresenceStatus } from "../../infrastructure/api/usersApi";
import { fetchVendors } from "../../infrastructure/api/vendorsApi";
import { emptyCompanyProfile } from "../../shared/companyProfile";
import type { CompanyProfile } from "../../types/company";
import type { LocalCustomer } from "../../types/customers";
import type { EmailTemplate, OutboundEmail } from "../../types/emailTemplates";
import type { PortalInvite } from "../../types/portal";
import type { OrgUser } from "../../types/users";
import type { LocalVendor } from "../../types/vendors";
import { useActionFeedback } from "../components/common/ActionFeedback";
import { Button } from "../components/common/Button";
import { SectionCard } from "../components/common/SectionCard";
import { DataTable } from "../components/common/DataTable";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { buildXlsxBlob, downloadBlob } from "../../shared/xlsx";
import { includesLooseText } from "../../domain/shared/normalize";
import { isSuperadminRole } from "../../shared/roles";
import { useI18n } from "../../i18n/I18nProvider";

type SettingsState = {
  email: string;
  userId: string;
  role: string;
};

type NewUserDraft = {
  email: string;
  fullName: string;
  role: "admin" | "sales" | "viewer";
  isActive: boolean;
};

type EditUserDraft = {
  userId: string;
  email: string;
  fullName: string;
  role: "superadmin" | "admin" | "sales" | "viewer";
  isActive: boolean;
};

type SettingsPageProps = {
  onLogout?: () => void | Promise<void>;
  initialTab?: "session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics";
  onOpenRelatedRecord?: (relatedType: string, relatedId: string) => void;
};

export function SettingsPage({ onLogout, initialTab = "session", onOpenRelatedRecord }: SettingsPageProps) {
  const { t } = useI18n();
  const s = (key: string, params?: Record<string, string | number>) => t(`settings.${key}`, params);
  const actionFeedback = useActionFeedback();
  const [activeTab, setActiveTab] = useState<"session" | "users" | "companies" | "portals" | "templates" | "emails" | "diagnostics">(initialTab);
  const [state, setState] = useState<SettingsState>({ email: "", userId: "", role: "" });
  const [users, setUsers] = useState<OrgUser[]>([]);
  const [usersError, setUsersError] = useState("");
  const [loadingUsers, setLoadingUsers] = useState(false);
  const [passwordDrafts, setPasswordDrafts] = useState<Record<string, string>>({});
  const [passwordStatus, setPasswordStatus] = useState("");
  const [userActionStatus, setUserActionStatus] = useState("");
  const [newUserDraft, setNewUserDraft] = useState<NewUserDraft>({
    email: "",
    fullName: "",
    role: "sales",
    isActive: true,
  });
  const [companyProfile, setCompanyProfile] = useState<CompanyProfile>(emptyCompanyProfile);
  const [companyProfiles, setCompanyProfiles] = useState<CompanyProfile[]>([]);
  const [portalInvites, setPortalInvites] = useState<PortalInvite[]>([]);
  const [portalDraft, setPortalDraft] = useState<PortalInvite>(() => createEmptyCloudPortalInvite());
  const [selectedCompanyId, setSelectedCompanyId] = useState("");
  const [companyProfileStatus, setCompanyProfileStatus] = useState("");
  const [portalStatus, setPortalStatus] = useState("");
  const [portalPasswordDrafts, setPortalPasswordDrafts] = useState<Record<string, string>>({});
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [emailTemplateDraft, setEmailTemplateDraft] = useState<EmailTemplate | null>(null);
  const [outboundEmails, setOutboundEmails] = useState<OutboundEmail[]>([]);
  const [emailTemplateStatus, setEmailTemplateStatus] = useState("");
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [vendors, setVendors] = useState<LocalVendor[]>([]);
  const [brandOptions, setBrandOptions] = useState<BrandOption[]>([]);
  const [loggingOut, setLoggingOut] = useState(false);
  const [savingCompanyProfile, setSavingCompanyProfile] = useState(false);
  const [passwordBusyUserId, setPasswordBusyUserId] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [savingUserId, setSavingUserId] = useState("");
  const [deletingUserId, setDeletingUserId] = useState("");
  const [sendingPortalInviteId, setSendingPortalInviteId] = useState("");
  const [portalPasswordBusyId, setPortalPasswordBusyId] = useState("");
  const [sendingQueuedEmails, setSendingQueuedEmails] = useState(false);
  const [changingPortalStatusId, setChangingPortalStatusId] = useState("");
  const [diagnostics, setDiagnostics] = useState<AdminDiagnostics | null>(null);
  const [diagnosticsBusy, setDiagnosticsBusy] = useState(false);
  const [diagnosticsStatus, setDiagnosticsStatus] = useState("");
  const [testEmail, setTestEmail] = useState("");
  const [sendingTestEmail, setSendingTestEmail] = useState(false);
  const [emailStatusFilter, setEmailStatusFilter] = useState<"all" | OutboundEmail["status"]>("all");
  const [emailSearch, setEmailSearch] = useState("");
  const [emailDateFrom, setEmailDateFrom] = useState("");
  const [emailDateTo, setEmailDateTo] = useState("");
  const [editUserDraft, setEditUserDraft] = useState<EditUserDraft | null>(null);
  const passwordResetAvailable = isPasswordResetAvailable();
  const newUserEmail = newUserDraft.email.trim().toLowerCase();
  const newUserValidationMessage = !newUserEmail ? s("users.validation.emailRequired") : "";
  const canCreateUser = !creatingUser && !newUserValidationMessage;
  const editUserEmail = editUserDraft?.email.trim().toLowerCase() || "";
  const editUserValidationMessage = editUserDraft && !editUserEmail ? s("users.validation.emailRequired") : "";

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [companyRows, portalRows, customerRows, vendorRows, brandRows, templateRows, outboundRows] = await Promise.all([
          fetchCompanyProfiles(),
          fetchPortalInvites(),
          fetchCustomers(),
          fetchVendors(),
          fetchCloudBrands(),
          fetchEmailTemplates(),
          fetchOutboundEmails(),
        ]);
        if (cancelled) return;
        setCompanyProfiles(companyRows);
        setPortalInvites(portalRows);
        setCustomers(customerRows);
        setVendors(vendorRows);
        setBrandOptions(brandRows);
        setEmailTemplates(templateRows);
        setOutboundEmails(outboundRows);
        if (templateRows[0]) {
          setSelectedTemplateKey(templateRows[0].template_key);
          setEmailTemplateDraft(templateRows[0]);
        }
        if (companyRows[0]) {
          setSelectedCompanyId(companyRows[0].id);
          setCompanyProfile(companyRows[0]);
        } else {
          setCompanyProfile(createEmptyCloudCompanyProfile());
        }
      } catch (caught) {
        if (!cancelled) {
          actionFeedback.fail(caught instanceof Error ? caught.message : s("errors.dataLoadFailed"));
        }
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, [actionFeedback]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      const session = await fetchAppSession();
      if (cancelled) return;
      setState({
        email: session.email || "",
        userId: session.userId || "",
        role: session.role || "",
      });
    }

    run();
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      if (state.role && !isSuperadminRole(state.role)) return;
      setLoadingUsers(true);
      setUsersError("");
      try {
        const result = await fetchOrgUsers();
        if (!cancelled) setUsers(result);
      } catch (caught) {
        if (!cancelled) {
          setUsers([]);
          setUsersError(caught instanceof Error ? caught.message : s("users.errors.loadFailed"));
        }
      } finally {
        if (!cancelled) setLoadingUsers(false);
      }
    }

    if (activeTab !== "users") return () => void 0;

    void run();
    const intervalId = window.setInterval(() => {
      void run();
    }, 60 * 1000);
    const handleFocus = () => {
      void run();
    };
    window.addEventListener("focus", handleFocus);

    return () => {
      cancelled = true;
      window.clearInterval(intervalId);
      window.removeEventListener("focus", handleFocus);
    };
  }, [state.role, activeTab]);

  useEffect(() => {
    if (state.email && !testEmail) {
      setTestEmail(state.email);
    }
  }, [state.email, testEmail]);

  function openUserEditor(row: OrgUser) {
    setEditUserDraft({
      userId: row.user_id,
      email: row.email,
      fullName: row.full_name || "",
      role: (row.role === "superadmin" || row.role === "admin" || row.role === "sales" || row.role === "viewer" ? row.role : "sales") as EditUserDraft["role"],
      isActive: row.is_active,
    });
    setUserActionStatus(s("users.feedback.editing", { email: row.email }));
  }

  const userColumns = [
    {
      key: "email",
      header: s("columns.email"),
      render: (row: OrgUser) => (
        <button
          type="button"
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openUserEditor(row);
          }}
        >
          {row.email}
        </button>
      ),
    },
    {
      key: "name",
      header: s("columns.name"),
      render: (row: OrgUser) => (
        <button
          type="button"
          className="text-button"
          onClick={(event) => {
            event.stopPropagation();
            openUserEditor(row);
          }}
        >
          {row.full_name || "-"}
        </button>
      ),
    },
    {
      key: "presence",
      header: s("columns.presence"),
      render: (row: OrgUser) => {
        const presence = getPresenceStatus(row.last_seen_at);
        return (
          <span className={`presence-badge presence-badge--${presence.tone}`}>
            <span className="presence-dot" />
            {s(`users.presence.${presence.tone}`)}
          </span>
        );
      },
    },
    { key: "role", header: s("columns.role"), render: (row: OrgUser) => s(`roles.${String(row.role || "viewer").toLowerCase()}`) },
    { key: "active", header: s("columns.active"), render: (row: OrgUser) => (row.is_active ? s("values.yes") : s("values.no")) },
    { key: "quotes", header: s("columns.quotes"), render: (row: OrgUser) => row.quote_count ?? 0 },
    { key: "lastSeen", header: s("columns.lastSeen"), render: (row: OrgUser) => row.last_seen_at || "-" },
    {
      key: "password",
      header: s("columns.password"),
      render: (row: OrgUser) => (
        <div className="inline-password-reset">
          <input
            className="inline-password-reset__input"
            type="password"
            placeholder={s("users.placeholders.newPassword")}
            value={passwordDrafts[row.user_id] || ""}
            onChange={(event) =>
              setPasswordDrafts((current) => ({
                ...current,
                [row.user_id]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.parentElement?.querySelector("button")?.click();
              }
            }}
          />
          <Button
            variant="secondary"
            busy={passwordBusyUserId === row.user_id}
            busyLabel={s("busy.updating")}
            disabled={!passwordResetAvailable}
            onClick={async () => {
              if (!passwordResetAvailable) {
                setPasswordStatus(s("users.passwordReset.deployedOnly"));
                return;
              }
              const password = (passwordDrafts[row.user_id] || "").trim();
              if (password.length < 8) {
                setPasswordStatus(s("users.passwordReset.minLength"));
                return;
              }

              try {
                setPasswordStatus("");
                setPasswordBusyUserId(row.user_id);
                actionFeedback.begin(s("users.passwordReset.updating", { email: row.email }));
                await resetOrgUserPassword(row.user_id, password);
                setPasswordDrafts((current) => ({ ...current, [row.user_id]: "" }));
                setPasswordStatus(s("users.passwordReset.updated", { email: row.email }));
                actionFeedback.succeed(s("users.passwordReset.updated", { email: row.email }));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("users.passwordReset.failed");
                setPasswordStatus(message);
                actionFeedback.fail(message);
              } finally {
                setPasswordBusyUserId("");
              }
            }}
          >
            {s("actions.update")}
          </Button>
        </div>
      ),
    },
    {
      key: "actions",
      header: s("columns.actions"),
      render: (row: OrgUser) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={() => openUserEditor(row)}
          >
            {s("actions.edit")}
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            busy={deletingUserId === row.user_id}
            busyLabel={s("busy.deleting")}
            disabled={row.user_id === state.userId}
            onClick={async () => {
              if (row.user_id === state.userId) {
                setUserActionStatus(s("users.errors.cannotDeleteOwnAccount"));
                return;
              }
              if (!window.confirm(s("users.confirm.delete", { email: row.email }))) {
                return;
              }

              try {
                setDeletingUserId(row.user_id);
                setUserActionStatus("");
                actionFeedback.begin(s("users.feedback.deleting", { email: row.email }));
                await deleteOrgUser(row.user_id);
                const nextUsers = await fetchOrgUsers();
                setUsers(nextUsers);
                setUserActionStatus(s("users.feedback.deleted", { email: row.email }));
                actionFeedback.succeed(s("users.feedback.deleted", { email: row.email }));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("users.errors.deleteFailed");
                setUserActionStatus(message);
                actionFeedback.fail(message);
              } finally {
                setDeletingUserId("");
              }
            }}
          >
            {t("common.delete")}
          </Button>
        </div>
      ),
    },
  ];

  const onlineNow = users.filter((user) => getPresenceStatus(user.last_seen_at).tone === "online").length;
  const recentlyActive = users.filter((user) => getPresenceStatus(user.last_seen_at).tone === "recent").length;
  const offline = users.filter((user) => getPresenceStatus(user.last_seen_at).tone === "offline").length;

  function updateCompanyField<K extends keyof CompanyProfile>(key: K, value: CompanyProfile[K]) {
    setCompanyProfile((current) => ({
      ...current,
      [key]: value,
    }));
  }

  async function handleLogoFile(file: File | null) {
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      updateCompanyField("logoDataUrl", String(reader.result || ""));
    };
    reader.readAsDataURL(file);
  }

  function startNewCompanyProfile() {
    const next = createEmptyCloudCompanyProfile();
    setSelectedCompanyId(next.id);
    setCompanyProfile(next);
    setCompanyProfileStatus(s("companies.feedback.newProfileReady"));
  }

  function updatePortalField<K extends keyof PortalInvite>(key: K, value: PortalInvite[K]) {
    setPortalDraft((current) => ({ ...current, [key]: value }));
  }

  function updatePortalAccess(key: keyof PortalInvite["access"], value: boolean) {
    setPortalDraft((current) => ({
      ...current,
      access: {
        ...current.access,
        [key]: value,
      },
    }));
  }

  function togglePortalAllowedBrand(brandId: string, checked: boolean) {
    setPortalDraft((current) => {
      const nextSet = new Set((current.allowed_brand_ids || []).map((value) => String(value || "").trim()).filter(Boolean));
      if (checked) nextSet.add(brandId);
      else nextSet.delete(brandId);
      return {
        ...current,
        allowed_brand_ids: [...nextSet],
      };
    });
  }

  function updateEmailTemplateField<K extends keyof EmailTemplate>(key: K, value: EmailTemplate[K]) {
    setEmailTemplateDraft((current) => (current ? { ...current, [key]: value } : current));
  }

  const customerOptions = customers.map((item) => ({
    value: item.id,
    label: item.display_name || item.company_name,
  }));
  const vendorOptions = vendors.map((item) => ({
    value: item.id,
    label: item.display_name || item.company_name,
  }));

  const outboundColumns = [
    { key: "template", header: s("columns.template"), render: (row: OutboundEmail) => row.template_key },
    { key: "recipient", header: s("columns.recipient"), render: (row: OutboundEmail) => row.recipient_name || "-" },
    { key: "email", header: s("columns.email"), render: (row: OutboundEmail) => row.recipient_email || "-" },
    { key: "related", header: s("columns.related"), render: (row: OutboundEmail) => `${row.related_type || "-"} ${row.related_id || ""}`.trim() },
    { key: "status", header: s("columns.status"), render: (row: OutboundEmail) => s(`emails.statuses.${String(row.status || "").toLowerCase()}`) },
    { key: "updated", header: s("columns.updated"), render: (row: OutboundEmail) => row.updated_at || "-" },
    {
      key: "actions",
      header: s("columns.actions"),
      render: (row: OutboundEmail) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact"
            onClick={async () => {
              try {
                if (row.related_type === "portal_invite") {
                  setActiveTab("portals");
                  const selected = portalInvites.find((item) => item.id === row.related_id);
                  if (selected) setPortalDraft(selected);
                } else if (row.related_type === "user") {
                  setActiveTab("users");
                } else {
                  onOpenRelatedRecord?.(row.related_type, row.related_id);
                }
              } catch (caught) {
                setEmailTemplateStatus(caught instanceof Error ? caught.message : s("emails.errors.openRelatedFailed"));
              }
            }}
          >
            {s("emails.actions.openRelated")}
          </Button>
          {row.status === "failed" ? (
            <Button
              variant="secondary"
              className="button--compact"
              onClick={async () => {
                try {
                  actionFeedback.begin(s("emails.feedback.retryingEmail", { email: row.recipient_email }));
                  await setOutboundEmailStatus([row.id], "queued");
                  const result = await deliverQueuedEmails([row.id]);
                  setOutboundEmails(await fetchOutboundEmails());
                  const message = s("emails.feedback.retryProcessed", { sent: result.sentCount, failed: result.failedCount });
                  setEmailTemplateStatus(message);
                  actionFeedback.succeed(message);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : s("emails.errors.retryFailed");
                  setEmailTemplateStatus(message);
                  actionFeedback.fail(message);
                }
              }}
            >
              {s("emails.actions.retryFailed")}
            </Button>
          ) : null}
        </div>
      ),
    },
  ];

  const emailCounts = {
    all: outboundEmails.length,
    draft: outboundEmails.filter((item) => item.status === "draft").length,
    queued: outboundEmails.filter((item) => item.status === "queued").length,
    sent: outboundEmails.filter((item) => item.status === "sent").length,
    failed: outboundEmails.filter((item) => item.status === "failed").length,
  };

  const filteredOutboundEmails = outboundEmails.filter((item) => {
    if (emailStatusFilter !== "all" && item.status !== emailStatusFilter) return false;

    const haystack = [
      item.template_key,
      item.recipient_name,
      item.recipient_email,
      item.related_type,
      item.related_id,
      item.subject,
    ]
      .join(" ")
      .toLowerCase();

    if (emailSearch.trim() && !includesLooseText(haystack, emailSearch)) return false;

    const compareDate = (item.updated_at || item.created_at || "").slice(0, 10);
    if (emailDateFrom && compareDate && compareDate < emailDateFrom) return false;
    if (emailDateTo && compareDate && compareDate > emailDateTo) return false;

    return true;
  });

  const portalColumns = [
    { key: "type", header: s("columns.type"), render: (row: PortalInvite) => s(`portal.types.${row.party_type}`) },
    { key: "party", header: s("columns.party"), render: (row: PortalInvite) => row.party_name || "-" },
    {
      key: "brandScope",
      header: s("portal.fields.brandScope"),
      render: (row: PortalInvite) =>
        row.allowed_brand_ids.length
          ? s("portal.brandScope.selected", { count: row.allowed_brand_ids.length })
          : s("portal.brandScope.allBrands"),
    },
    { key: "email", header: s("columns.email"), render: (row: PortalInvite) => row.email || "-" },
    { key: "contact", header: s("columns.contact"), render: (row: PortalInvite) => row.contact_name || "-" },
    { key: "status", header: s("columns.status"), render: (row: PortalInvite) => s(`portal.statuses.${String(row.status || "").toLowerCase()}`) },
    { key: "passwordStatus", header: s("columns.password"), render: (row: PortalInvite) => (row.has_password ? s("portal.password.configured") : s("portal.password.missing")) },
    { key: "sent", header: s("columns.lastSent"), render: (row: PortalInvite) => row.last_sent_at || "-" },
    {
      key: "passwordActions",
      header: s("portal.fields.portalPassword"),
      render: (row: PortalInvite) => (
        <div className="inline-password-reset">
          <input
            className="inline-password-reset__input"
            type="password"
            placeholder={row.has_password ? s("portal.placeholders.updatePassword") : s("portal.placeholders.setPassword")}
            value={portalPasswordDrafts[row.id] || ""}
            onChange={(event) =>
              setPortalPasswordDrafts((current) => ({
                ...current,
                [row.id]: event.target.value,
              }))
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                event.currentTarget.parentElement?.querySelector("button")?.click();
              }
            }}
          />
          <Button
            variant="secondary"
            className="button--compact"
            busy={portalPasswordBusyId === row.id}
            busyLabel={t("common.saving")}
            onClick={async () => {
              const password = String(portalPasswordDrafts[row.id] || "").trim();
              if (password.length < 8) {
                setPortalStatus(s("portal.password.minLength"));
                return;
              }
              try {
                setPortalPasswordBusyId(row.id);
                const updated = await setPortalInvitePassword(row.id, password);
                setPortalInvites(await fetchPortalInvites());
                setPortalPasswordDrafts((current) => ({ ...current, [row.id]: "" }));
                setPortalStatus(updated ? s("portal.password.savedFor", { party: row.party_name }) : s("portal.password.saved"));
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.password.saveFailed"));
              } finally {
                setPortalPasswordBusyId("");
              }
            }}
          >
            {row.has_password ? s("actions.update") : s("actions.set")}
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            busy={portalPasswordBusyId === `clear:${row.id}`}
            busyLabel={s("busy.clearing")}
            disabled={!row.has_password}
            onClick={async () => {
              if (!row.has_password) return;
              try {
                setPortalPasswordBusyId(`clear:${row.id}`);
                await clearPortalInvitePassword(row.id);
                setPortalInvites(await fetchPortalInvites());
                setPortalPasswordDrafts((current) => ({ ...current, [row.id]: "" }));
                setPortalStatus(s("portal.password.clearedFor", { party: row.party_name }));
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.password.clearFailed"));
              } finally {
                setPortalPasswordBusyId("");
              }
            }}
          >
            {s("actions.clear")}
          </Button>
        </div>
      ),
    },
    {
      key: "actions",
      header: s("columns.actions"),
      render: (row: PortalInvite) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact"
            busy={sendingPortalInviteId === row.id}
            busyLabel={t("common.sending")}
            onClick={async () => {
              if (!row.has_password) {
                setPortalStatus(s("portal.errors.passwordRequiredBeforeSend", { party: row.party_name }));
                return;
              }
              try {
                setSendingPortalInviteId(row.id);
                const companyName = companyProfile.companyName || companyProfiles[0]?.companyName || "Next Master";
                const delivery = await sendPortalInviteEmail(row.id, companyName, window.location.origin, {
                  email: row.email,
                  party_type: row.party_type,
                  customer_id: row.customer_id,
                  vendor_id: row.vendor_id,
                });
                setPortalInvites(await fetchPortalInvites());
                setOutboundEmails(await fetchOutboundEmails());
                setPortalStatus(
                  delivery.sent
                    ? s("portal.feedback.invitationSent", { email: row.email })
                    : s("portal.feedback.invitationQueuedRuntimeIncomplete", { email: row.email }),
                );
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.errors.invitationQueueFailed"));
              } finally {
                setSendingPortalInviteId("");
              }
            }}
          >
            {row.status === "invited" || row.status === "active" ? s("portal.actions.resendInvite") : s("portal.actions.sendInvite")}
          </Button>
          <Button
            variant="secondary"
            className="button--compact"
            busy={changingPortalStatusId === row.id}
            busyLabel={row.status === "disabled" ? s("busy.enabling") : s("busy.revoking")}
            onClick={async () => {
              try {
                setChangingPortalStatusId(row.id);
                const nextStatus = row.status === "disabled" ? "draft" : "disabled";
                await setPortalInviteStatus(row.id, nextStatus);
                setPortalInvites(await fetchPortalInvites());
                setPortalStatus(nextStatus === "disabled" ? s("portal.feedback.revokedFor", { party: row.party_name }) : s("portal.feedback.reenabledFor", { party: row.party_name }));
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.errors.statusUpdateFailed"));
              } finally {
                setChangingPortalStatusId("");
              }
            }}
          >
            {row.status === "disabled" ? s("actions.enable") : s("actions.revoke")}
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={async () => {
              try {
                await deletePortalInvite(row.id);
                setPortalInvites(await fetchPortalInvites());
                setPortalStatus(s("portal.feedback.deleted"));
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.errors.deleteFailed"));
              }
            }}
          >
            {t("common.delete")}
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="page-stack">
      {activeTab === "session" ? <SectionCard title={s("session.title")}>
        <div className="settings-grid">
          <div className="settings-item">
            <span className="settings-label">{s("session.app")}</span>
            <strong>Next Master</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{s("session.environment")}</span>
            <strong>{s("session.liveCloud")}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{s("session.signedInAs")}</span>
            <strong>{state.email || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{s("columns.role")}</span>
            <strong>{state.role || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">{s("columns.userId")}</span>
            <strong className="settings-mono">{state.userId || "-"}</strong>
          </div>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={loggingOut}
            busyLabel={s("session.loggingOut")}
            onClick={async () => {
              try {
                setLoggingOut(true);
                actionFeedback.begin(s("session.loggingOut"));
                await onLogout?.();
                actionFeedback.succeed(s("session.loggedOut"));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("session.logoutFailed");
                actionFeedback.fail(message);
              } finally {
                setLoggingOut(false);
              }
            }}
          >
            {s("session.logout")}
          </Button>
        </div>
      </SectionCard> : null}
      {activeTab === "users" && isSuperadminRole(state.role) && !passwordResetAvailable ? (
        <SectionCard title={s("users.passwordReset.title")}>
          <div className="warning-text">{s("users.passwordReset.serverlessWarning")}</div>
        </SectionCard>
      ) : null}
      {activeTab === "users" && isSuperadminRole(state.role) ? (
        <SectionCard title={s("users.title")}>
          {editUserDraft ? (
            <div className="settings-grid settings-grid--user-edit">
              <Input
                label={s("users.fields.editEmail")}
                value={editUserDraft.email}
                placeholder="user@company.com"
                onChange={(value) => setEditUserDraft((current) => (current ? { ...current, email: value } : current))}
              />
              <Input
                label={s("users.fields.editFullName")}
                value={editUserDraft.fullName}
                placeholder={s("users.placeholders.fullName")}
                onChange={(value) => setEditUserDraft((current) => (current ? { ...current, fullName: value } : current))}
              />
              <Select
                label={s("users.fields.editRole")}
                value={editUserDraft.role}
                options={[
                  { value: "superadmin", label: s("roles.superadmin") },
                  { value: "admin", label: s("roles.admin") },
                  { value: "sales", label: s("roles.sales") },
                  { value: "viewer", label: s("roles.viewer") },
                ]}
                onChange={(value) =>
                  setEditUserDraft((current) => (current ? { ...current, role: value as EditUserDraft["role"] } : current))
                }
              />
              <label className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={editUserDraft.isActive}
                  onChange={(event) =>
                    setEditUserDraft((current) => (current ? { ...current, isActive: event.target.checked } : current))
                  }
                />
                <span className="field__label">{s("users.fields.activeUser")}</span>
              </label>
              <div className="field field--actions">
                <span className="field__label">{s("users.fields.editUser")}</span>
                <div className="inline-actions">
                  <Button
                    busy={savingUserId === editUserDraft.userId}
                    busyLabel={t("common.saving")}
                    disabled={Boolean(editUserValidationMessage)}
                    onClick={async () => {
                      if (!editUserDraft) return;
                      if (editUserValidationMessage) {
                        setUserActionStatus(editUserValidationMessage);
                        return;
                      }
                      try {
                        setSavingUserId(editUserDraft.userId);
                        setUserActionStatus("");
                        actionFeedback.begin(s("users.feedback.saving", { email: editUserEmail }));
                        await updateOrgUser({
                          userId: editUserDraft.userId,
                          email: editUserEmail,
                          fullName: editUserDraft.fullName.trim(),
                          role: editUserDraft.role,
                          isActive: editUserDraft.isActive,
                        });
                        const nextUsers = await fetchOrgUsers();
                        setUsers(nextUsers);
                        setEditUserDraft(null);
                        const message = s("users.feedback.updated", { email: editUserEmail });
                        setUserActionStatus(message);
                        actionFeedback.succeed(message);
                      } catch (caught) {
                        const message = caught instanceof Error ? caught.message : s("users.errors.updateFailed");
                        setUserActionStatus(message);
                        actionFeedback.fail(message);
                      } finally {
                        setSavingUserId("");
                      }
                    }}
                  >
                    {s("users.actions.saveUser")}
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditUserDraft(null);
                      setUserActionStatus("");
                    }}
                  >
                    {t("common.cancel")}
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="settings-grid">
            <Input
              label={s("columns.email")}
              value={newUserDraft.email}
              placeholder="user@company.com"
              onChange={(value) => setNewUserDraft((current) => ({ ...current, email: value }))}
              onEnter={() => {
                const button = document.getElementById("settings-add-user-button");
                if (button instanceof HTMLButtonElement) button.click();
              }}
            />
            <Input
              label={s("users.fields.fullName")}
              value={newUserDraft.fullName}
              placeholder={s("users.placeholders.fullName")}
              onChange={(value) => setNewUserDraft((current) => ({ ...current, fullName: value }))}
              onEnter={() => {
                const button = document.getElementById("settings-add-user-button");
                if (button instanceof HTMLButtonElement) button.click();
              }}
            />
            <Select
              label={s("columns.role")}
              value={newUserDraft.role}
              options={[
                { value: "admin", label: s("roles.admin") },
                { value: "sales", label: s("roles.sales") },
                { value: "viewer", label: s("roles.viewer") },
              ]}
              onChange={(value) => setNewUserDraft((current) => ({ ...current, role: value as NewUserDraft["role"] }))}
            />
            <label className="field checkbox-field">
              <input
                type="checkbox"
                checked={newUserDraft.isActive}
                onChange={(event) => setNewUserDraft((current) => ({ ...current, isActive: event.target.checked }))}
              />
              <span className="field__label">{s("users.fields.activeUser")}</span>
            </label>
            <div className="field field--actions">
              <span className="field__label">{s("users.fields.createUser")}</span>
              <Button
                id="settings-add-user-button"
                disabled={!canCreateUser}
                busy={creatingUser}
                busyLabel={s("busy.creating")}
                onClick={async () => {
                  if (newUserValidationMessage) {
                    setUserActionStatus(newUserValidationMessage);
                    return;
                  }

                  try {
                    setCreatingUser(true);
                    setUserActionStatus("");
                    actionFeedback.begin(s("users.feedback.creating", { email: newUserEmail }));
                    const created = await createOrgUser({
                      email: newUserEmail,
                      fullName: newUserDraft.fullName.trim(),
                      role: newUserDraft.role,
                      isActive: newUserDraft.isActive,
                    });
                    if (created.welcomeEmailId) {
                      await deliverQueuedEmails([created.welcomeEmailId]);
                    }
                    const nextUsers = await fetchOrgUsers();
                    setUsers(nextUsers);
                    setOutboundEmails(await fetchOutboundEmails());
                    setNewUserDraft({
                      email: "",
                      fullName: "",
                      role: "sales",
                      isActive: true,
                    });
                    const message =
                      created.welcomeEmailError
                        ? s("users.feedback.createdWithEmailFailure", { email: newUserEmail, error: created.welcomeEmailError })
                        : s("users.feedback.created", { email: newUserEmail });
                    setUserActionStatus(message);
                    actionFeedback.succeed(message);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : s("users.errors.createFailed");
                    setUserActionStatus(message);
                    actionFeedback.fail(message);
                  } finally {
                    setCreatingUser(false);
                  }
                }}
              >
                {s("users.actions.addUser")}
              </Button>
            </div>
          </div>
          <div className="meta-row">
            <span>{s("users.meta.temporaryPassword")}</span>
            <span>{s("users.meta.setPasswordEmail")}</span>
          </div>
          {editUserValidationMessage ? <div className="error-text">{editUserValidationMessage}</div> : null}
          {newUserValidationMessage ? <div className="error-text">{newUserValidationMessage}</div> : null}
          <div className="settings-grid settings-stats-grid">
            <div className="settings-item">
              <span className="settings-label">{s("users.presence.onlineNow")}</span>
              <strong>{onlineNow}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">{s("users.presence.recentlyActive")}</span>
              <strong>{recentlyActive}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">{s("users.presence.offline")}</span>
              <strong>{offline}</strong>
            </div>
          </div>
          <div className="meta-row">
            <span>{s("users.meta.loaded", { count: users.length.toLocaleString("en-US") })}</span>
            <span>{loadingUsers ? s("users.loading") : usersError || userActionStatus || passwordStatus || s("users.meta.adminHelp")}</span>
          </div>
          <DataTable
            rows={users}
            columns={userColumns}
            emptyText={loadingUsers ? s("users.loading") : s("users.empty")}
            onRowClick={(row) => openUserEditor(row)}
          />
        </SectionCard>
      ) : null}
      {activeTab === "companies" ? <SectionCard title={s("companies.title")}>
        <div className="toolbar toolbar--wrap">
          <Select
            label={s("companies.fields.savedCompanies")}
            value={selectedCompanyId}
            options={[
              { value: "", label: companyProfiles.length ? s("companies.placeholders.selectCompany") : s("companies.empty.noCompanies") },
              ...companyProfiles.map((item) => ({ value: item.id, label: item.companyName })),
            ]}
            onChange={(value) => {
              setSelectedCompanyId(value);
              const selected = companyProfiles.find((item) => item.id === value);
              if (selected) setCompanyProfile(selected);
            }}
          />
          <Button variant="secondary" onClick={startNewCompanyProfile}>
            {s("companies.actions.addCompany")}
          </Button>
          <Button
            variant="secondary"
            className="danger-button"
            onClick={async () => {
              if (!companyProfile.id || !companyProfiles.some((item) => item.id === companyProfile.id)) {
                setCompanyProfileStatus(s("companies.errors.saveBeforeDelete"));
                return;
              }
              try {
                actionFeedback.begin(s("companies.feedback.deleting", { company: companyProfile.companyName || companyProfile.id }));
                await deleteCompanyProfileById(companyProfile.id);
                const next = await fetchCompanyProfiles();
                setCompanyProfiles(next);
                if (next[0]) {
                  setSelectedCompanyId(next[0].id);
                  setCompanyProfile(next[0]);
                } else {
                  startNewCompanyProfile();
                }
                setCompanyProfileStatus(s("companies.feedback.deleted"));
                actionFeedback.succeed(s("companies.feedback.deleted"));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("companies.errors.deleteFailed");
                setCompanyProfileStatus(message);
                actionFeedback.fail(message);
              }
            }}
          >
            {s("companies.actions.deleteCompany")}
          </Button>
        </div>
        <div className="settings-grid">
          <div className="field">
            <label className="field__label">{s("companies.fields.companyName")}</label>
            <input className="field__input" value={companyProfile.companyName} onChange={(event) => updateCompanyField("companyName", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{s("columns.email")}</label>
            <input className="field__input" value={companyProfile.email} onChange={(event) => updateCompanyField("email", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{s("companies.fields.phone")}</label>
            <input className="field__input" value={companyProfile.phone} onChange={(event) => updateCompanyField("phone", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{s("companies.fields.website")}</label>
            <input className="field__input" value={companyProfile.website} onChange={(event) => updateCompanyField("website", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{s("companies.fields.taxOffice")}</label>
            <input className="field__input" value={companyProfile.taxOffice} onChange={(event) => updateCompanyField("taxOffice", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">{s("companies.fields.taxNumber")}</label>
            <input className="field__input" value={companyProfile.taxNumber} onChange={(event) => updateCompanyField("taxNumber", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">{s("companies.fields.address")}</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.address} onChange={(event) => updateCompanyField("address", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">{s("companies.fields.bankDetails")}</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.bankDetails} onChange={(event) => updateCompanyField("bankDetails", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">{s("companies.fields.footerNote")}</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.footerNote} onChange={(event) => updateCompanyField("footerNote", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">{s("companies.fields.companyLogo")}</label>
            <div className="logo-settings">
              <input type="file" accept="image/*" onChange={(event) => void handleLogoFile(event.target.files?.[0] || null)} />
              {companyProfile.logoDataUrl ? <img className="logo-preview" src={companyProfile.logoDataUrl} alt={s("companies.logoPreviewAlt")} /> : null}
              <div className="inline-actions">
                <Button variant="secondary" onClick={() => updateCompanyField("logoDataUrl", "")}>
                  {s("companies.actions.clearLogo")}
                </Button>
                <Button
                  busy={savingCompanyProfile}
                  busyLabel={t("common.saving")}
                  onClick={async () => {
                    try {
                      setSavingCompanyProfile(true);
                      actionFeedback.begin(s("companies.feedback.saving"));
                      const savedProfile = await upsertCompanyProfile(companyProfile);
                      const next = await fetchCompanyProfiles();
                      setCompanyProfiles(next);
                      const saved = next.find((item) => item.id === savedProfile.id) || next[0];
                      if (saved) {
                        setSelectedCompanyId(saved.id);
                        setCompanyProfile(saved);
                      }
                      setCompanyProfileStatus(s("companies.feedback.saved"));
                      actionFeedback.succeed(s("companies.feedback.saved"));
                    } catch (caught) {
                      const message = caught instanceof Error ? caught.message : s("companies.errors.saveFailed");
                      setCompanyProfileStatus(message);
                      actionFeedback.fail(message);
                    } finally {
                      setSavingCompanyProfile(false);
                    }
                  }}
                >
                  {s("companies.actions.saveCompanyProfile")}
                </Button>
              </div>
              {companyProfileStatus ? <span className="success-text">{companyProfileStatus}</span> : null}
            </div>
          </div>
        </div>
      </SectionCard> : null}
      {activeTab === "portals" ? <SectionCard title={s("portal.title")}>
        <div className="settings-grid">
          <Select
            label={s("portal.fields.portalType")}
            value={portalDraft.party_type}
            options={[
              { value: "customer", label: s("portal.types.customer") },
              { value: "vendor", label: s("portal.types.vendor") },
            ]}
            onChange={(value) => updatePortalField("party_type", value as PortalInvite["party_type"])}
          />
          {portalDraft.party_type === "customer" ? (
            <Select
              label={s("portal.types.customer")}
              value={portalDraft.customer_id}
              options={[{ value: "", label: s("portal.placeholders.selectCustomer") }, ...customerOptions]}
              onChange={(value) => {
                const selected = customers.find((item) => item.id === value);
                updatePortalField("customer_id", value);
                updatePortalField("vendor_id", "");
                updatePortalField("party_name", selected?.display_name || selected?.company_name || "");
              }}
            />
          ) : (
            <Select
              label={s("portal.types.vendor")}
              value={portalDraft.vendor_id}
              options={[{ value: "", label: s("portal.placeholders.selectVendor") }, ...vendorOptions]}
              onChange={(value) => {
                const selected = vendors.find((item) => item.id === value);
                updatePortalField("vendor_id", value);
                updatePortalField("customer_id", "");
                updatePortalField("party_name", selected?.display_name || selected?.company_name || "");
              }}
            />
          )}
          <Input label={s("portal.fields.portalEmail")} value={portalDraft.email} onChange={(value) => updatePortalField("email", value)} />
          <Input label={s("portal.fields.contactName")} value={portalDraft.contact_name} onChange={(value) => updatePortalField("contact_name", value)} />
        </div>
        <div className="settings-grid">
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_account} onChange={(event) => updatePortalAccess("can_view_account", event.target.checked)} />
            <span className="field__label">{s("portal.access.viewAccountBalance")}</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_invoices} onChange={(event) => updatePortalAccess("can_view_invoices", event.target.checked)} />
            <span className="field__label">{s("portal.access.viewInvoices")}</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_payments} onChange={(event) => updatePortalAccess("can_view_payments", event.target.checked)} />
            <span className="field__label">{s("portal.access.viewPayments")}</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_orders} onChange={(event) => updatePortalAccess("can_view_orders", event.target.checked)} />
            <span className="field__label">{s("portal.access.viewOrders")}</span>
          </label>
        </div>
        <div className="field">
          <span className="field__label">{s("portal.fields.brandScope")}</span>
          <div className="meta-row">
            <span>{portalDraft.allowed_brand_ids.length ? s("portal.brandScope.brandSelected", { count: portalDraft.allowed_brand_ids.length }) : s("portal.brandScope.allBrands")}</span>
            <Button variant="secondary" className="button--compact" onClick={() => updatePortalField("allowed_brand_ids", [])}>
              {s("portal.actions.clearScope")}
            </Button>
          </div>
          <div className="settings-grid">
            {brandOptions.map((brand) => (
              <label key={brand.id} className="field checkbox-field">
                <input
                  type="checkbox"
                  checked={portalDraft.allowed_brand_ids.includes(brand.id)}
                  onChange={(event) => togglePortalAllowedBrand(brand.id, event.target.checked)}
                />
                <span className="field__label">{brand.name}</span>
              </label>
            ))}
          </div>
          <span className="field__help">
            {s("portal.help.brandScope")}
          </span>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            onClick={async () => {
              const missingPartyBinding =
                portalDraft.party_type === "customer" ? !portalDraft.customer_id.trim() : !portalDraft.vendor_id.trim();
              if (!portalDraft.party_name.trim() || missingPartyBinding) {
                setPortalStatus(s("portal.errors.partyRequired"));
                return;
              }
              if (!portalDraft.email.trim()) {
                setPortalStatus(s("portal.errors.emailRequired"));
                return;
              }
              try {
                const saved = await upsertPortalInvite(portalDraft);
                setPortalInvites(await fetchPortalInvites());
                setPortalDraft(createEmptyCloudPortalInvite());
                setPortalStatus(s("portal.feedback.savedFor", { party: saved.party_name }));
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : s("portal.errors.saveFailed"));
              }
            }}
          >
            {s("portal.actions.saveAccess")}
          </Button>
          <Button variant="secondary" onClick={() => setPortalDraft(createEmptyCloudPortalInvite())}>
            {s("portal.actions.newInvite")}
          </Button>
        </div>
        {portalStatus ? <div className="success-text">{portalStatus}</div> : null}
        <div className="meta-row">
          <span>{s("portal.meta.records", { count: portalInvites.length.toLocaleString("en-US") })}</span>
          <span>{s("portal.meta.accessHelp")}</span>
        </div>
        <DataTable rows={portalInvites} columns={portalColumns} emptyText={s("portal.empty.noInvites")} />
      </SectionCard> : null}
      {activeTab === "templates" ? <SectionCard title={s("templates.title")}>
        <div className="settings-grid">
          <Select
            label={s("templates.fields.template")}
            value={selectedTemplateKey}
            options={emailTemplates.map((item) => ({ value: item.template_key, label: item.template_name }))}
            onChange={(value) => {
              setSelectedTemplateKey(value);
              const selected = emailTemplates.find((item) => item.template_key === value) || null;
              setEmailTemplateDraft(selected);
            }}
          />
          <Input
            label={s("templates.fields.templateName")}
            value={emailTemplateDraft?.template_name || ""}
            onChange={(value) => updateEmailTemplateField("template_name", value)}
          />
          <Input
            label={s("templates.fields.subject")}
            value={emailTemplateDraft?.subject || ""}
            onChange={(value) => updateEmailTemplateField("subject", value)}
          />
          <div className="field field--full">
            <label className="field__label">{s("templates.fields.body")}</label>
            <textarea
              className="field__input field__input--textarea"
              value={emailTemplateDraft?.body || ""}
              onChange={(event) => updateEmailTemplateField("body", event.target.value)}
            />
          </div>
        </div>
        <div className="meta-row">
          <span>{s("templates.meta.variablesDependOnType")}</span>
          <span>{s("templates.meta.examples")}: {`{{party_name}} {{portal_link}} {{purchase_order_no}} {{company_name}} {{full_name}} {{user_email}} {{login_link}} {{set_password_link}}`}</span>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            onClick={async () => {
              if (!emailTemplateDraft) return;
              try {
                actionFeedback.begin(s("templates.feedback.saving", { template: emailTemplateDraft.template_name }));
                const saved = await upsertEmailTemplate(emailTemplateDraft);
                const next = await fetchEmailTemplates();
                setEmailTemplates(next);
                setSelectedTemplateKey(saved.template_key);
                setEmailTemplateDraft(next.find((item) => item.template_key === saved.template_key) || saved);
                setEmailTemplateStatus(s("templates.feedback.saved", { template: saved.template_name }));
                actionFeedback.succeed(s("templates.feedback.saved", { template: saved.template_name }));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("templates.errors.saveFailed");
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              }
            }}
          >
            {s("templates.actions.saveTemplate")}
          </Button>
        </div>
        {emailTemplateStatus ? <div className="success-text">{emailTemplateStatus}</div> : null}
      </SectionCard> : null}
      {activeTab === "emails" ? <SectionCard title={s("emails.title")}>
        <div className="meta-row">
          <span>{s("emails.meta.shown", { shown: filteredOutboundEmails.length.toLocaleString("en-US"), total: outboundEmails.length.toLocaleString("en-US") })}</span>
          <span>{s("emails.meta.deliveryHelp")}</span>
        </div>
        <div className="toolbar toolbar--wrap">
          <Select
            label={s("emails.fields.statusFilter")}
            value={emailStatusFilter}
            options={[
              { value: "all", label: s("emails.filters.all", { count: emailCounts.all }) },
              { value: "queued", label: s("emails.filters.queued", { count: emailCounts.queued }) },
              { value: "sent", label: s("emails.filters.sent", { count: emailCounts.sent }) },
              { value: "failed", label: s("emails.filters.failed", { count: emailCounts.failed }) },
              { value: "draft", label: s("emails.filters.draft", { count: emailCounts.draft }) },
            ]}
            onChange={(value) => setEmailStatusFilter(value as "all" | OutboundEmail["status"])}
          />
          <Input label={s("fields.search")} value={emailSearch} onChange={setEmailSearch} placeholder={s("emails.placeholders.search")} />
          <Input label={s("fields.dateFrom")} type="date" value={emailDateFrom} onChange={setEmailDateFrom} />
          <Input label={s("fields.dateTo")} type="date" value={emailDateTo} onChange={setEmailDateTo} />
          <Button
            variant="secondary"
            onClick={async () => {
              const failedIds = outboundEmails.filter((item) => item.status === "failed").map((item) => item.id);
              if (!failedIds.length) {
                setEmailTemplateStatus(s("emails.errors.noFailedEmails"));
                return;
              }
              try {
                setSendingQueuedEmails(true);
                actionFeedback.begin(s("emails.feedback.retryingFailed", { count: failedIds.length.toLocaleString("en-US") }));
                await setOutboundEmailStatus(failedIds, "queued");
                const result = await deliverQueuedEmails(failedIds);
                setOutboundEmails(await fetchOutboundEmails());
                const message = s("emails.feedback.retryProcessed", { sent: result.sentCount, failed: result.failedCount });
                setEmailTemplateStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("emails.errors.retryFailedEmailsFailed");
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingQueuedEmails(false);
              }
            }}
          >
            {s("emails.actions.retryFailed")}
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              const rows = [
                ["Template", "Recipient", "Email", "Related Type", "Related ID", "Status", "Subject", "Updated", "Sent At"],
                ...filteredOutboundEmails.map((item) => [
                  item.template_key,
                  item.recipient_name,
                  item.recipient_email,
                  item.related_type,
                  item.related_id,
                  item.status,
                  item.subject,
                  item.updated_at,
                  item.sent_at,
                ]),
              ];
              const blob = buildXlsxBlob("outgoing_emails", rows);
              downloadBlob(`outgoing-emails-${new Date().toISOString().slice(0, 10)}.xlsx`, blob);
            }}
          >
            {s("actions.exportExcel")}
          </Button>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={sendingQueuedEmails}
            busyLabel={t("common.sending")}
            onClick={async () => {
              try {
                setSendingQueuedEmails(true);
                actionFeedback.begin(s("emails.feedback.sendingQueued"));
                const result = await deliverQueuedEmails(
                  outboundEmails.filter((item) => item.status === "queued").map((item) => item.id),
                );
                setOutboundEmails(await fetchOutboundEmails());
                const message = s("emails.feedback.queuedProcessed", { sent: result.sentCount, failed: result.failedCount });
                setEmailTemplateStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("emails.errors.queuedDeliveryFailed");
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingQueuedEmails(false);
              }
            }}
          >
            {s("emails.actions.sendQueued")}
          </Button>
        </div>
        <DataTable rows={filteredOutboundEmails} columns={outboundColumns} emptyText={s("emails.empty.noMatches")} />
      </SectionCard> : null}
      {activeTab === "diagnostics" ? <SectionCard title={s("diagnostics.title")}>
        <div className="toolbar toolbar--wrap">
          <Button
            busy={diagnosticsBusy}
            busyLabel={s("busy.running")}
            onClick={async () => {
              try {
                setDiagnosticsBusy(true);
                setDiagnosticsStatus("");
                actionFeedback.begin(s("diagnostics.feedback.running"));
                const result = await fetchAdminDiagnostics();
                setDiagnostics(result);
                setDiagnosticsStatus(s("diagnostics.feedback.loaded"));
                actionFeedback.succeed(s("diagnostics.feedback.loaded"));
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("diagnostics.errors.failed");
                setDiagnosticsStatus(message);
                actionFeedback.fail(message);
              } finally {
                setDiagnosticsBusy(false);
              }
            }}
          >
            {s("diagnostics.actions.run")}
          </Button>
        </div>
        {diagnostics ? (
          <>
            <div className="settings-grid settings-stats-grid">
              <div className="settings-item">
                <span className="settings-label">{s("diagnostics.fields.siteUrl")}</span>
                <strong>{diagnostics.runtime.siteUrl || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{s("diagnostics.fields.functionRegion")}</span>
                <strong>{diagnostics.runtime.functionRegion || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">{s("diagnostics.fields.emailFrom")}</span>
                <strong>{diagnostics.env.emailFromValue || "-"}</strong>
              </div>
            </div>
            <div className="settings-grid settings-stats-grid">
              {[
                [s("diagnostics.fields.supabaseUrl"), diagnostics.env.supabaseUrl],
                [s("diagnostics.fields.anonKey"), diagnostics.env.supabaseAnonKey],
                [s("diagnostics.fields.serviceRole"), diagnostics.env.serviceRoleKey],
                [s("diagnostics.fields.resendApi"), diagnostics.env.resendApiKey],
                [s("diagnostics.fields.emailFrom"), diagnostics.env.emailFrom],
                [s("diagnostics.fields.authCheck"), diagnostics.checks.auth.ok],
                [s("diagnostics.fields.databaseCheck"), diagnostics.checks.database.ok],
                [s("diagnostics.fields.emailCheck"), diagnostics.checks.email.ok],
              ].map(([label, ok]) => (
                <div key={String(label)} className="settings-item">
                  <span className="settings-label">{label}</span>
                  <strong className={ok ? "success-text" : "warning-text"}>{ok ? s("diagnostics.values.ok") : s("diagnostics.values.missing")}</strong>
                </div>
              ))}
            </div>
            <div className="meta-row">
              <span>{diagnostics.checks.auth.detail}</span>
              <span>{diagnostics.checks.database.detail}</span>
            </div>
            <div className="meta-row">
              <span>{diagnostics.checks.email.detail}</span>
              <span>{s("diagnostics.meta.testEmailHelp")}</span>
            </div>
          </>
        ) : (
          <div className="meta-row">
            <span>{s("diagnostics.empty.noSnapshot")}</span>
            <span>{s("diagnostics.empty.runHelp")}</span>
          </div>
        )}
        <div className="settings-grid">
          <Input label={s("diagnostics.fields.testEmailRecipient")} value={testEmail} onChange={setTestEmail} />
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={sendingTestEmail}
            busyLabel={t("common.sending")}
            onClick={async () => {
              if (!testEmail.trim()) {
                setDiagnosticsStatus(s("diagnostics.errors.testRecipientRequired"));
                return;
              }
              try {
                setSendingTestEmail(true);
                setDiagnosticsStatus("");
                actionFeedback.begin(s("diagnostics.feedback.sendingTestEmail", { email: testEmail }));
                const result = await sendAdminTestEmail(testEmail.trim());
                const message = s("diagnostics.feedback.testEmailSent", { email: result.email || testEmail.trim() });
                setDiagnosticsStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : s("diagnostics.errors.testEmailFailed");
                setDiagnosticsStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingTestEmail(false);
              }
            }}
          >
            {s("diagnostics.actions.sendTestEmail")}
          </Button>
        </div>
        {diagnosticsStatus ? <div className="success-text">{diagnosticsStatus}</div> : null}
      </SectionCard> : null}
    </div>
  );
}
