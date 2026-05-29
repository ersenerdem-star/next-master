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
import { deliverQueuedEmails, fetchEmailTemplates, fetchOutboundEmails, queuePortalInviteEmail, setOutboundEmailStatus, upsertEmailTemplate } from "../../infrastructure/api/emailTemplatesApi";
import { createEmptyCloudPortalInvite, deletePortalInvite, fetchPortalInvites, issuePortalInviteToken, markPortalInviteSent, setPortalInviteStatus, upsertPortalInvite } from "../../infrastructure/api/portalInvitesApi";
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
  const [emailTemplates, setEmailTemplates] = useState<EmailTemplate[]>([]);
  const [selectedTemplateKey, setSelectedTemplateKey] = useState("");
  const [emailTemplateDraft, setEmailTemplateDraft] = useState<EmailTemplate | null>(null);
  const [outboundEmails, setOutboundEmails] = useState<OutboundEmail[]>([]);
  const [emailTemplateStatus, setEmailTemplateStatus] = useState("");
  const [customers, setCustomers] = useState<LocalCustomer[]>([]);
  const [vendors, setVendors] = useState<LocalVendor[]>([]);
  const [loggingOut, setLoggingOut] = useState(false);
  const [savingCompanyProfile, setSavingCompanyProfile] = useState(false);
  const [passwordBusyUserId, setPasswordBusyUserId] = useState("");
  const [creatingUser, setCreatingUser] = useState(false);
  const [savingUserId, setSavingUserId] = useState("");
  const [deletingUserId, setDeletingUserId] = useState("");
  const [sendingPortalInviteId, setSendingPortalInviteId] = useState("");
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
  const newUserValidationMessage = !newUserEmail ? "Email is required." : "";
  const canCreateUser = !creatingUser && !newUserValidationMessage;
  const editUserEmail = editUserDraft?.email.trim().toLowerCase() || "";
  const editUserValidationMessage = editUserDraft && !editUserEmail ? "Email is required." : "";

  useEffect(() => {
    setActiveTab(initialTab);
  }, [initialTab]);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const [companyRows, portalRows, customerRows, vendorRows, templateRows, outboundRows] = await Promise.all([
          fetchCompanyProfiles(),
          fetchPortalInvites(),
          fetchCustomers(),
          fetchVendors(),
          fetchEmailTemplates(),
          fetchOutboundEmails(),
        ]);
        if (cancelled) return;
        setCompanyProfiles(companyRows);
        setPortalInvites(portalRows);
        setCustomers(customerRows);
        setVendors(vendorRows);
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
          actionFeedback.fail(caught instanceof Error ? caught.message : "Settings data load failed");
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
          setUsersError(caught instanceof Error ? caught.message : "Users load failed");
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

  const userColumns = [
    { key: "email", header: "Email", render: (row: OrgUser) => row.email },
    { key: "name", header: "Name", render: (row: OrgUser) => row.full_name || "-" },
    {
      key: "presence",
      header: "Presence",
      render: (row: OrgUser) => {
        const presence = getPresenceStatus(row.last_seen_at);
        return (
          <span className={`presence-badge presence-badge--${presence.tone}`}>
            <span className="presence-dot" />
            {presence.label}
          </span>
        );
      },
    },
    { key: "role", header: "Role", render: (row: OrgUser) => row.role },
    { key: "active", header: "Active", render: (row: OrgUser) => (row.is_active ? "Yes" : "No") },
    { key: "quotes", header: "Quotes", render: (row: OrgUser) => row.quote_count ?? 0 },
    { key: "lastSeen", header: "Last Seen", render: (row: OrgUser) => row.last_seen_at || "-" },
    {
      key: "password",
      header: "Password",
      render: (row: OrgUser) => (
        <div className="inline-password-reset">
          <input
            className="inline-password-reset__input"
            type="password"
            placeholder="New password"
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
            busyLabel="Updating..."
            disabled={!passwordResetAvailable}
            onClick={async () => {
              if (!passwordResetAvailable) {
                setPasswordStatus("Password reset works only in deployed app or Netlify dev.");
                return;
              }
              const password = (passwordDrafts[row.user_id] || "").trim();
              if (password.length < 8) {
                setPasswordStatus("Password must be at least 8 characters.");
                return;
              }

              try {
                setPasswordStatus("");
                setPasswordBusyUserId(row.user_id);
                actionFeedback.begin(`Updating password for ${row.email}...`);
                await resetOrgUserPassword(row.user_id, password);
                setPasswordDrafts((current) => ({ ...current, [row.user_id]: "" }));
                setPasswordStatus(`Password updated for ${row.email}.`);
                actionFeedback.succeed(`Password updated for ${row.email}.`);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Password reset failed";
                setPasswordStatus(message);
                actionFeedback.fail(message);
              } finally {
                setPasswordBusyUserId("");
              }
            }}
          >
            Update
          </Button>
        </div>
      ),
    },
    {
      key: "actions",
      header: "Actions",
      render: (row: OrgUser) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={() => {
              setEditUserDraft({
                userId: row.user_id,
                email: row.email,
                fullName: row.full_name || "",
                role: (row.role === "superadmin" || row.role === "admin" || row.role === "sales" || row.role === "viewer" ? row.role : "sales") as EditUserDraft["role"],
                isActive: row.is_active,
              });
              setUserActionStatus(`Editing ${row.email}`);
            }}
          >
            Edit
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            busy={deletingUserId === row.user_id}
            busyLabel="Deleting..."
            disabled={row.user_id === state.userId}
            onClick={async () => {
              if (row.user_id === state.userId) {
                setUserActionStatus("You cannot delete your own account.");
                return;
              }
              if (!window.confirm(`Delete user ${row.email}?`)) {
                return;
              }

              try {
                setDeletingUserId(row.user_id);
                setUserActionStatus("");
                actionFeedback.begin(`Deleting ${row.email}...`);
                await deleteOrgUser(row.user_id);
                const nextUsers = await fetchOrgUsers();
                setUsers(nextUsers);
                setUserActionStatus(`User deleted: ${row.email}`);
                actionFeedback.succeed(`User deleted: ${row.email}`);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "User delete failed";
                setUserActionStatus(message);
                actionFeedback.fail(message);
              } finally {
                setDeletingUserId("");
              }
            }}
          >
            Delete
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
    setCompanyProfileStatus("New company profile ready.");
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
    { key: "template", header: "Template", render: (row: OutboundEmail) => row.template_key },
    { key: "recipient", header: "Recipient", render: (row: OutboundEmail) => row.recipient_name || "-" },
    { key: "email", header: "Email", render: (row: OutboundEmail) => row.recipient_email || "-" },
    { key: "related", header: "Related", render: (row: OutboundEmail) => `${row.related_type || "-"} ${row.related_id || ""}`.trim() },
    { key: "status", header: "Status", render: (row: OutboundEmail) => row.status },
    { key: "updated", header: "Updated", render: (row: OutboundEmail) => row.updated_at || "-" },
    {
      key: "actions",
      header: "Actions",
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
                setEmailTemplateStatus(caught instanceof Error ? caught.message : "Open related record failed");
              }
            }}
          >
            Open Related
          </Button>
          {row.status === "failed" ? (
            <Button
              variant="secondary"
              className="button--compact"
              onClick={async () => {
                try {
                  actionFeedback.begin(`Retrying email to ${row.recipient_email}...`);
                  await setOutboundEmailStatus([row.id], "queued");
                  const result = await deliverQueuedEmails([row.id]);
                  setOutboundEmails(await fetchOutboundEmails());
                  const message = `Retry processed: ${result.sentCount} sent, ${result.failedCount} failed.`;
                  setEmailTemplateStatus(message);
                  actionFeedback.succeed(message);
                } catch (caught) {
                  const message = caught instanceof Error ? caught.message : "Retry failed";
                  setEmailTemplateStatus(message);
                  actionFeedback.fail(message);
                }
              }}
            >
              Retry Failed
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
    { key: "type", header: "Type", render: (row: PortalInvite) => row.party_type },
    { key: "party", header: "Party", render: (row: PortalInvite) => row.party_name || "-" },
    { key: "email", header: "Email", render: (row: PortalInvite) => row.email || "-" },
    { key: "contact", header: "Contact", render: (row: PortalInvite) => row.contact_name || "-" },
    { key: "status", header: "Status", render: (row: PortalInvite) => row.status },
    { key: "sent", header: "Last Sent", render: (row: PortalInvite) => row.last_sent_at || "-" },
    {
      key: "actions",
      header: "Actions",
      render: (row: PortalInvite) => (
        <div className="inline-actions">
          <Button
            variant="secondary"
            className="button--compact"
            busy={sendingPortalInviteId === row.id}
            busyLabel="Sending..."
            onClick={async () => {
              try {
                setSendingPortalInviteId(row.id);
                const companyName = companyProfile.companyName || companyProfiles[0]?.companyName || "Next Master";
                const issued = await issuePortalInviteToken(row.id);
                const queued = await queuePortalInviteEmail(issued.invite, companyName, window.location.origin, issued.token);
                const delivery = await deliverQueuedEmails([queued.id]);
                const sent = delivery.sentCount > 0 ? await markPortalInviteSent(row.id) : null;
                setPortalInvites(await fetchPortalInvites());
                setOutboundEmails(await fetchOutboundEmails());
                setPortalStatus(
                  sent
                    ? `Invitation sent to ${row.email}.`
                    : `Invitation queued for ${row.email}, but delivery did not complete on this runtime.`,
                );
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : "Invitation queue failed");
              } finally {
                setSendingPortalInviteId("");
              }
            }}
          >
            {row.status === "invited" || row.status === "active" ? "Resend Invite" : "Send Invite"}
          </Button>
          <Button
            variant="secondary"
            className="button--compact"
            busy={changingPortalStatusId === row.id}
            busyLabel={row.status === "disabled" ? "Enabling..." : "Revoking..."}
            onClick={async () => {
              try {
                setChangingPortalStatusId(row.id);
                const nextStatus = row.status === "disabled" ? "draft" : "disabled";
                await setPortalInviteStatus(row.id, nextStatus);
                setPortalInvites(await fetchPortalInvites());
                setPortalStatus(nextStatus === "disabled" ? `Portal access revoked for ${row.party_name}.` : `Portal access re-enabled for ${row.party_name}.`);
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : "Portal invite status update failed");
              } finally {
                setChangingPortalStatusId("");
              }
            }}
          >
            {row.status === "disabled" ? "Enable" : "Revoke"}
          </Button>
          <Button
            variant="secondary"
            className="button--compact danger-button"
            onClick={async () => {
              try {
                await deletePortalInvite(row.id);
                setPortalInvites(await fetchPortalInvites());
                setPortalStatus("Portal invite deleted.");
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : "Portal invite delete failed");
              }
            }}
          >
            Delete
          </Button>
        </div>
      ),
    },
  ];

  return (
    <div className="page-stack">
      {activeTab === "session" ? <SectionCard title="Session Settings">
        <div className="settings-grid">
          <div className="settings-item">
            <span className="settings-label">App</span>
            <strong>Next Master</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Environment</span>
            <strong>Live Cloud</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Signed in as</span>
            <strong>{state.email || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">Role</span>
            <strong>{state.role || "-"}</strong>
          </div>
          <div className="settings-item">
            <span className="settings-label">User ID</span>
            <strong className="settings-mono">{state.userId || "-"}</strong>
          </div>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={loggingOut}
            busyLabel="Logging out..."
            onClick={async () => {
              try {
                setLoggingOut(true);
                actionFeedback.begin("Logging out...");
                await onLogout?.();
                actionFeedback.succeed("Logged out.");
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Logout failed";
                actionFeedback.fail(message);
              } finally {
                setLoggingOut(false);
              }
            }}
          >
            Logout
          </Button>
        </div>
      </SectionCard> : null}
      {activeTab === "users" && isSuperadminRole(state.role) && !passwordResetAvailable ? (
        <SectionCard title="User Password Reset">
          <div className="warning-text">User admin actions depend on serverless admin endpoints. Use deployed app or Netlify dev instead of plain localhost.</div>
        </SectionCard>
      ) : null}
      {activeTab === "users" && isSuperadminRole(state.role) ? (
        <SectionCard title="Users">
          {editUserDraft ? (
            <div className="settings-grid settings-grid--user-edit">
              <Input
                label="Edit Email"
                value={editUserDraft.email}
                placeholder="user@company.com"
                onChange={(value) => setEditUserDraft((current) => (current ? { ...current, email: value } : current))}
              />
              <Input
                label="Edit Full Name"
                value={editUserDraft.fullName}
                placeholder="Full name"
                onChange={(value) => setEditUserDraft((current) => (current ? { ...current, fullName: value } : current))}
              />
              <Select
                label="Edit Role"
                value={editUserDraft.role}
                options={[
                  { value: "superadmin", label: "Superadmin" },
                  { value: "admin", label: "Admin" },
                  { value: "sales", label: "Sales" },
                  { value: "viewer", label: "Viewer" },
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
                <span className="field__label">Active user</span>
              </label>
              <div className="field field--actions">
                <span className="field__label">Edit User</span>
                <div className="inline-actions">
                  <Button
                    busy={savingUserId === editUserDraft.userId}
                    busyLabel="Saving..."
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
                        actionFeedback.begin(`Saving ${editUserEmail}...`);
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
                        const message = `User updated: ${editUserEmail}`;
                        setUserActionStatus(message);
                        actionFeedback.succeed(message);
                      } catch (caught) {
                        const message = caught instanceof Error ? caught.message : "User update failed";
                        setUserActionStatus(message);
                        actionFeedback.fail(message);
                      } finally {
                        setSavingUserId("");
                      }
                    }}
                  >
                    Save User
                  </Button>
                  <Button
                    variant="secondary"
                    onClick={() => {
                      setEditUserDraft(null);
                      setUserActionStatus("");
                    }}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            </div>
          ) : null}
          <div className="settings-grid">
            <Input
              label="Email"
              value={newUserDraft.email}
              placeholder="user@company.com"
              onChange={(value) => setNewUserDraft((current) => ({ ...current, email: value }))}
              onEnter={() => {
                const button = document.getElementById("settings-add-user-button");
                if (button instanceof HTMLButtonElement) button.click();
              }}
            />
            <Input
              label="Full Name"
              value={newUserDraft.fullName}
              placeholder="Full name"
              onChange={(value) => setNewUserDraft((current) => ({ ...current, fullName: value }))}
              onEnter={() => {
                const button = document.getElementById("settings-add-user-button");
                if (button instanceof HTMLButtonElement) button.click();
              }}
            />
            <Select
              label="Role"
              value={newUserDraft.role}
              options={[
                { value: "admin", label: "Admin" },
                { value: "sales", label: "Sales" },
                { value: "viewer", label: "Viewer" },
              ]}
              onChange={(value) => setNewUserDraft((current) => ({ ...current, role: value as NewUserDraft["role"] }))}
            />
            <label className="field checkbox-field">
              <input
                type="checkbox"
                checked={newUserDraft.isActive}
                onChange={(event) => setNewUserDraft((current) => ({ ...current, isActive: event.target.checked }))}
              />
              <span className="field__label">Active user</span>
            </label>
            <div className="field field--actions">
              <span className="field__label">Create User</span>
              <Button
                id="settings-add-user-button"
                disabled={!canCreateUser}
                busy={creatingUser}
                busyLabel="Creating..."
                onClick={async () => {
                  if (newUserValidationMessage) {
                    setUserActionStatus(newUserValidationMessage);
                    return;
                  }

                  try {
                    setCreatingUser(true);
                    setUserActionStatus("");
                    actionFeedback.begin(`Creating user ${newUserEmail}...`);
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
                        ? `User created: ${newUserEmail}. Welcome email queued but delivery failed: ${created.welcomeEmailError}`
                        : `User created: ${newUserEmail}. Set password email sent.`;
                    setUserActionStatus(message);
                    actionFeedback.succeed(message);
                  } catch (caught) {
                    const message = caught instanceof Error ? caught.message : "User create failed";
                    setUserActionStatus(message);
                    actionFeedback.fail(message);
                  } finally {
                    setCreatingUser(false);
                  }
                }}
              >
                Add User
              </Button>
            </div>
          </div>
          <div className="meta-row">
            <span>System generates a random temporary password.</span>
            <span>User receives a set password email and defines their own password on first access.</span>
          </div>
          {editUserValidationMessage ? <div className="error-text">{editUserValidationMessage}</div> : null}
          {newUserValidationMessage ? <div className="error-text">{newUserValidationMessage}</div> : null}
          <div className="settings-grid settings-stats-grid">
            <div className="settings-item">
              <span className="settings-label">Online Now</span>
              <strong>{onlineNow}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Recently Active</span>
              <strong>{recentlyActive}</strong>
            </div>
            <div className="settings-item">
              <span className="settings-label">Offline</span>
              <strong>{offline}</strong>
            </div>
          </div>
          <div className="meta-row">
            <span>{users.length.toLocaleString("en-US")} users loaded</span>
            <span>{loadingUsers ? "Loading users..." : usersError || userActionStatus || passwordStatus || "Admin can add, delete, and update user passwords here."}</span>
          </div>
          <DataTable rows={users} columns={userColumns} emptyText={loadingUsers ? "Loading users..." : "No organization users found."} />
        </SectionCard>
      ) : null}
      {activeTab === "companies" ? <SectionCard title="Company Profile">
        <div className="toolbar toolbar--wrap">
          <Select
            label="Saved Companies"
            value={selectedCompanyId}
            options={[
              { value: "", label: companyProfiles.length ? "Select company" : "No companies yet" },
              ...companyProfiles.map((item) => ({ value: item.id, label: item.companyName })),
            ]}
            onChange={(value) => {
              setSelectedCompanyId(value);
              const selected = companyProfiles.find((item) => item.id === value);
              if (selected) setCompanyProfile(selected);
            }}
          />
          <Button variant="secondary" onClick={startNewCompanyProfile}>
            Add Company
          </Button>
          <Button
            variant="secondary"
            className="danger-button"
            onClick={async () => {
              if (!companyProfile.id || !companyProfiles.some((item) => item.id === companyProfile.id)) {
                setCompanyProfileStatus("Save this company first before deleting.");
                return;
              }
              try {
                actionFeedback.begin(`Deleting company ${companyProfile.companyName || companyProfile.id}...`);
                await deleteCompanyProfileById(companyProfile.id);
                const next = await fetchCompanyProfiles();
                setCompanyProfiles(next);
                if (next[0]) {
                  setSelectedCompanyId(next[0].id);
                  setCompanyProfile(next[0]);
                } else {
                  startNewCompanyProfile();
                }
                setCompanyProfileStatus("Company profile deleted.");
                actionFeedback.succeed("Company profile deleted.");
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Company profile delete failed";
                setCompanyProfileStatus(message);
                actionFeedback.fail(message);
              }
            }}
          >
            Delete Company
          </Button>
        </div>
        <div className="settings-grid">
          <div className="field">
            <label className="field__label">Company Name</label>
            <input className="field__input" value={companyProfile.companyName} onChange={(event) => updateCompanyField("companyName", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Email</label>
            <input className="field__input" value={companyProfile.email} onChange={(event) => updateCompanyField("email", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Phone</label>
            <input className="field__input" value={companyProfile.phone} onChange={(event) => updateCompanyField("phone", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Website</label>
            <input className="field__input" value={companyProfile.website} onChange={(event) => updateCompanyField("website", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Tax Office</label>
            <input className="field__input" value={companyProfile.taxOffice} onChange={(event) => updateCompanyField("taxOffice", event.target.value)} />
          </div>
          <div className="field">
            <label className="field__label">Tax Number</label>
            <input className="field__input" value={companyProfile.taxNumber} onChange={(event) => updateCompanyField("taxNumber", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">Address</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.address} onChange={(event) => updateCompanyField("address", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">Bank Details</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.bankDetails} onChange={(event) => updateCompanyField("bankDetails", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">Footer Note</label>
            <textarea className="field__input field__input--textarea" value={companyProfile.footerNote} onChange={(event) => updateCompanyField("footerNote", event.target.value)} />
          </div>
          <div className="field field--full">
            <label className="field__label">Company Logo</label>
            <div className="logo-settings">
              <input type="file" accept="image/*" onChange={(event) => void handleLogoFile(event.target.files?.[0] || null)} />
              {companyProfile.logoDataUrl ? <img className="logo-preview" src={companyProfile.logoDataUrl} alt="Company logo preview" /> : null}
              <div className="inline-actions">
                <Button variant="secondary" onClick={() => updateCompanyField("logoDataUrl", "")}>
                  Clear Logo
                </Button>
                <Button
                  busy={savingCompanyProfile}
                  busyLabel="Saving..."
                  onClick={async () => {
                    try {
                      setSavingCompanyProfile(true);
                      actionFeedback.begin("Saving company profile...");
                      const savedProfile = await upsertCompanyProfile(companyProfile);
                      const next = await fetchCompanyProfiles();
                      setCompanyProfiles(next);
                      const saved = next.find((item) => item.id === savedProfile.id) || next[0];
                      if (saved) {
                        setSelectedCompanyId(saved.id);
                        setCompanyProfile(saved);
                      }
                      setCompanyProfileStatus("Company profile saved.");
                      actionFeedback.succeed("Company profile saved.");
                    } catch (caught) {
                      const message = caught instanceof Error ? caught.message : "Company profile save failed";
                      setCompanyProfileStatus(message);
                      actionFeedback.fail(message);
                    } finally {
                      setSavingCompanyProfile(false);
                    }
                  }}
                >
                  Save Company Profile
                </Button>
              </div>
              {companyProfileStatus ? <span className="success-text">{companyProfileStatus}</span> : null}
            </div>
          </div>
        </div>
      </SectionCard> : null}
      {activeTab === "portals" ? <SectionCard title="Customer & Vendor Portal Access">
        <div className="settings-grid">
          <Select
            label="Portal Type"
            value={portalDraft.party_type}
            options={[
              { value: "customer", label: "Customer" },
              { value: "vendor", label: "Vendor" },
            ]}
            onChange={(value) => updatePortalField("party_type", value as PortalInvite["party_type"])}
          />
          {portalDraft.party_type === "customer" ? (
            <Select
              label="Customer"
              value={portalDraft.customer_id}
              options={[{ value: "", label: "Select customer" }, ...customerOptions]}
              onChange={(value) => {
                const selected = customers.find((item) => item.id === value);
                updatePortalField("customer_id", value);
                updatePortalField("vendor_id", "");
                updatePortalField("party_name", selected?.display_name || selected?.company_name || "");
              }}
            />
          ) : (
            <Select
              label="Vendor"
              value={portalDraft.vendor_id}
              options={[{ value: "", label: "Select vendor" }, ...vendorOptions]}
              onChange={(value) => {
                const selected = vendors.find((item) => item.id === value);
                updatePortalField("vendor_id", value);
                updatePortalField("customer_id", "");
                updatePortalField("party_name", selected?.display_name || selected?.company_name || "");
              }}
            />
          )}
          <Input label="Portal Email" value={portalDraft.email} onChange={(value) => updatePortalField("email", value)} />
          <Input label="Contact Name" value={portalDraft.contact_name} onChange={(value) => updatePortalField("contact_name", value)} />
        </div>
        <div className="settings-grid">
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_account} onChange={(event) => updatePortalAccess("can_view_account", event.target.checked)} />
            <span className="field__label">View account balance</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_invoices} onChange={(event) => updatePortalAccess("can_view_invoices", event.target.checked)} />
            <span className="field__label">View invoices</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_payments} onChange={(event) => updatePortalAccess("can_view_payments", event.target.checked)} />
            <span className="field__label">View payments</span>
          </label>
          <label className="field checkbox-field">
            <input type="checkbox" checked={portalDraft.access.can_view_orders} onChange={(event) => updatePortalAccess("can_view_orders", event.target.checked)} />
            <span className="field__label">View orders</span>
          </label>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            onClick={async () => {
              const missingPartyBinding =
                portalDraft.party_type === "customer" ? !portalDraft.customer_id.trim() : !portalDraft.vendor_id.trim();
              if (!portalDraft.party_name.trim() || missingPartyBinding) {
                setPortalStatus("Select customer or enter vendor name.");
                return;
              }
              if (!portalDraft.email.trim()) {
                setPortalStatus("Enter portal email.");
                return;
              }
              try {
                const saved = await upsertPortalInvite(portalDraft);
                setPortalInvites(await fetchPortalInvites());
                setPortalDraft(createEmptyCloudPortalInvite());
                setPortalStatus(`Portal access saved for ${saved.party_name}.`);
              } catch (caught) {
                setPortalStatus(caught instanceof Error ? caught.message : "Portal access save failed");
              }
            }}
          >
            Save Portal Access
          </Button>
          <Button variant="secondary" onClick={() => setPortalDraft(createEmptyCloudPortalInvite())}>
            New Invite
          </Button>
        </div>
        {portalStatus ? <div className="success-text">{portalStatus}</div> : null}
        <div className="meta-row">
          <span>{portalInvites.length.toLocaleString("en-US")} portal records</span>
          <span>Portal access is bound to the selected party record. Send Invite rotates a short-lived token, queues mail, then tries delivery.</span>
        </div>
        <DataTable rows={portalInvites} columns={portalColumns} emptyText="No customer or vendor portal invite prepared yet." />
      </SectionCard> : null}
      {activeTab === "templates" ? <SectionCard title="Email Templates">
        <div className="settings-grid">
          <Select
            label="Template"
            value={selectedTemplateKey}
            options={emailTemplates.map((item) => ({ value: item.template_key, label: item.template_name }))}
            onChange={(value) => {
              setSelectedTemplateKey(value);
              const selected = emailTemplates.find((item) => item.template_key === value) || null;
              setEmailTemplateDraft(selected);
            }}
          />
          <Input
            label="Template Name"
            value={emailTemplateDraft?.template_name || ""}
            onChange={(value) => updateEmailTemplateField("template_name", value)}
          />
          <Input
            label="Subject"
            value={emailTemplateDraft?.subject || ""}
            onChange={(value) => updateEmailTemplateField("subject", value)}
          />
          <div className="field field--full">
            <label className="field__label">Body</label>
            <textarea
              className="field__input field__input--textarea"
              value={emailTemplateDraft?.body || ""}
              onChange={(event) => updateEmailTemplateField("body", event.target.value)}
            />
          </div>
        </div>
        <div className="meta-row">
          <span>Available tokens depend on template type.</span>
          <span>Examples: {`{{party_name}} {{portal_link}} {{invite_token}} {{purchase_order_no}} {{company_name}} {{full_name}} {{user_email}} {{login_link}} {{set_password_link}}`}</span>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            onClick={async () => {
              if (!emailTemplateDraft) return;
              try {
                actionFeedback.begin(`Saving template ${emailTemplateDraft.template_name}...`);
                const saved = await upsertEmailTemplate(emailTemplateDraft);
                const next = await fetchEmailTemplates();
                setEmailTemplates(next);
                setSelectedTemplateKey(saved.template_key);
                setEmailTemplateDraft(next.find((item) => item.template_key === saved.template_key) || saved);
                setEmailTemplateStatus(`Template saved: ${saved.template_name}.`);
                actionFeedback.succeed(`Template saved: ${saved.template_name}.`);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Email template save failed";
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              }
            }}
          >
            Save Email Template
          </Button>
        </div>
        {emailTemplateStatus ? <div className="success-text">{emailTemplateStatus}</div> : null}
      </SectionCard> : null}
      {activeTab === "emails" ? <SectionCard title="Outgoing Emails">
        <div className="meta-row">
          <span>{filteredOutboundEmails.length.toLocaleString("en-US")} emails shown / {outboundEmails.length.toLocaleString("en-US")} total</span>
          <span>Queued mail is delivered by Netlify function when email environment variables are configured.</span>
        </div>
        <div className="toolbar toolbar--wrap">
          <Select
            label="Status Filter"
            value={emailStatusFilter}
            options={[
              { value: "all", label: `All (${emailCounts.all})` },
              { value: "queued", label: `Queued (${emailCounts.queued})` },
              { value: "sent", label: `Sent (${emailCounts.sent})` },
              { value: "failed", label: `Failed (${emailCounts.failed})` },
              { value: "draft", label: `Draft (${emailCounts.draft})` },
            ]}
            onChange={(value) => setEmailStatusFilter(value as "all" | OutboundEmail["status"])}
          />
          <Input label="Search" value={emailSearch} onChange={setEmailSearch} placeholder="recipient, email, subject, related..." />
          <Input label="Date From" type="date" value={emailDateFrom} onChange={setEmailDateFrom} />
          <Input label="Date To" type="date" value={emailDateTo} onChange={setEmailDateTo} />
          <Button
            variant="secondary"
            onClick={async () => {
              const failedIds = outboundEmails.filter((item) => item.status === "failed").map((item) => item.id);
              if (!failedIds.length) {
                setEmailTemplateStatus("No failed emails to retry.");
                return;
              }
              try {
                setSendingQueuedEmails(true);
                actionFeedback.begin(`Retrying ${failedIds.length.toLocaleString("en-US")} failed emails...`);
                await setOutboundEmailStatus(failedIds, "queued");
                const result = await deliverQueuedEmails(failedIds);
                setOutboundEmails(await fetchOutboundEmails());
                const message = `Retry processed: ${result.sentCount} sent, ${result.failedCount} failed.`;
                setEmailTemplateStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Retry failed emails failed";
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingQueuedEmails(false);
              }
            }}
          >
            Retry Failed
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
            Export Excel
          </Button>
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={sendingQueuedEmails}
            busyLabel="Sending..."
            onClick={async () => {
              try {
                setSendingQueuedEmails(true);
                actionFeedback.begin("Sending queued emails...");
                const result = await deliverQueuedEmails(
                  outboundEmails.filter((item) => item.status === "queued").map((item) => item.id),
                );
                setOutboundEmails(await fetchOutboundEmails());
                const message = `Queued emails processed: ${result.sentCount} sent, ${result.failedCount} failed.`;
                setEmailTemplateStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Queued email delivery failed";
                setEmailTemplateStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingQueuedEmails(false);
              }
            }}
          >
            Send Queued Emails
          </Button>
        </div>
        <DataTable rows={filteredOutboundEmails} columns={outboundColumns} emptyText="No outbound emails match the current filter." />
      </SectionCard> : null}
      {activeTab === "diagnostics" ? <SectionCard title="Diagnostics">
        <div className="toolbar toolbar--wrap">
          <Button
            busy={diagnosticsBusy}
            busyLabel="Running..."
            onClick={async () => {
              try {
                setDiagnosticsBusy(true);
                setDiagnosticsStatus("");
                actionFeedback.begin("Running diagnostics...");
                const result = await fetchAdminDiagnostics();
                setDiagnostics(result);
                setDiagnosticsStatus("Diagnostics loaded.");
                actionFeedback.succeed("Diagnostics loaded.");
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Diagnostics failed";
                setDiagnosticsStatus(message);
                actionFeedback.fail(message);
              } finally {
                setDiagnosticsBusy(false);
              }
            }}
          >
            Run Diagnostics
          </Button>
        </div>
        {diagnostics ? (
          <>
            <div className="settings-grid settings-stats-grid">
              <div className="settings-item">
                <span className="settings-label">Site URL</span>
                <strong>{diagnostics.runtime.siteUrl || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Function Region</span>
                <strong>{diagnostics.runtime.functionRegion || "-"}</strong>
              </div>
              <div className="settings-item">
                <span className="settings-label">Email From</span>
                <strong>{diagnostics.env.emailFromValue || "-"}</strong>
              </div>
            </div>
            <div className="settings-grid settings-stats-grid">
              {[
                ["Supabase URL", diagnostics.env.supabaseUrl],
                ["Anon Key", diagnostics.env.supabaseAnonKey],
                ["Service Role", diagnostics.env.serviceRoleKey],
                ["Resend API", diagnostics.env.resendApiKey],
                ["Email From", diagnostics.env.emailFrom],
                ["Auth Check", diagnostics.checks.auth.ok],
                ["Database Check", diagnostics.checks.database.ok],
                ["Email Check", diagnostics.checks.email.ok],
              ].map(([label, ok]) => (
                <div key={String(label)} className="settings-item">
                  <span className="settings-label">{label}</span>
                  <strong className={ok ? "success-text" : "warning-text"}>{ok ? "OK" : "Missing"}</strong>
                </div>
              ))}
            </div>
            <div className="meta-row">
              <span>{diagnostics.checks.auth.detail}</span>
              <span>{diagnostics.checks.database.detail}</span>
            </div>
            <div className="meta-row">
              <span>{diagnostics.checks.email.detail}</span>
              <span>Use test email to validate Resend delivery from production credentials.</span>
            </div>
          </>
        ) : (
          <div className="meta-row">
            <span>No diagnostics snapshot yet.</span>
            <span>Run diagnostics to validate production runtime, Supabase access, and Resend configuration.</span>
          </div>
        )}
        <div className="settings-grid">
          <Input label="Test Email Recipient" value={testEmail} onChange={setTestEmail} />
        </div>
        <div className="toolbar toolbar--wrap">
          <Button
            variant="secondary"
            busy={sendingTestEmail}
            busyLabel="Sending..."
            onClick={async () => {
              if (!testEmail.trim()) {
                setDiagnosticsStatus("Enter a test recipient email.");
                return;
              }
              try {
                setSendingTestEmail(true);
                setDiagnosticsStatus("");
                actionFeedback.begin(`Sending test email to ${testEmail}...`);
                const result = await sendAdminTestEmail(testEmail.trim());
                const message = `Test email sent to ${result.email}.`;
                setDiagnosticsStatus(message);
                actionFeedback.succeed(message);
              } catch (caught) {
                const message = caught instanceof Error ? caught.message : "Test email send failed";
                setDiagnosticsStatus(message);
                actionFeedback.fail(message);
              } finally {
                setSendingTestEmail(false);
              }
            }}
          >
            Send Test Email
          </Button>
        </div>
        {diagnosticsStatus ? <div className="success-text">{diagnosticsStatus}</div> : null}
      </SectionCard> : null}
    </div>
  );
}
