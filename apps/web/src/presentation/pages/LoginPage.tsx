import { useEffect, useState } from "react";
import { supabaseClient } from "../../infrastructure/api/supabaseClient";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { useI18n, type LocaleCode } from "../../i18n/I18nProvider";

type LoginPageProps = {
  onSuccess: () => void;
  recoveryMode?: boolean;
};

type AdminLoginBranding = {
  companyName: string;
  logoDataUrl: string;
  label: string;
};

function normalizeLoginName(value: string) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "")
    .replace(/[^a-z0-9._-]/g, "");
}

function authEmailCandidates(value: string) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return [];
  if (raw.includes("@")) return [raw];
  const login = normalizeLoginName(raw);
  return login
    ? [
        `${login}@users.ersenquotedesk.local`,
        `${login}@ersenquotedesk.com`,
      ]
    : [];
}

function buildLoginInitials(value: string) {
  return String(value || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((token) => token[0]?.toUpperCase() || "")
    .join("")
    .slice(0, 2) || "AO";
}

export function LoginPage({ onSuccess, recoveryMode = false }: LoginPageProps) {
  const { locale, localeOptions, setLocale, t } = useI18n();
  const [branding, setBranding] = useState<AdminLoginBranding>({
    companyName: "Asad Otomotiv",
    logoDataUrl: "",
    label: "",
  });
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [forgotMode, setForgotMode] = useState(false);

  useEffect(() => {
    let cancelled = false;

    async function run() {
      try {
        const response = await fetch("/api/admin-login-branding");
        if (!response.ok) return;
        const payload = (await response.json()) as { branding?: AdminLoginBranding };
        if (!cancelled && payload.branding) {
          setBranding(payload.branding);
        }
      } catch {
        return;
      }
    }

    void run();
    return () => {
      cancelled = true;
    };
  }, []);

  async function handleLogin() {
    setLoading(true);
    setError("");
    setMessage("");
    const candidates = authEmailCandidates(email);
    let loginError: Error | null = new Error(t("auth.invalidLoginCredentials"));

    for (const candidate of candidates) {
      const { error } = await supabaseClient.auth.signInWithPassword({
        email: candidate,
        password,
      });
      if (!error) {
        loginError = null;
        break;
      }
      loginError = error;
    }

    setLoading(false);
    if (loginError) {
      setError(loginError.message);
      return;
    }
    onSuccess();
  }

  async function handleForgotPassword() {
    if (!email.trim()) {
      setError(t("auth.enterUserNameFirst"));
      return;
    }

    const targetEmail = authEmailCandidates(email)[0] || email.trim();
    setLoading(true);
    setError("");
    setMessage("");
    const { error: resetError } = await supabaseClient.auth.resetPasswordForEmail(targetEmail, {
      redirectTo: window.location.origin,
    });
    setLoading(false);

    if (resetError) {
      setError(resetError.message);
      return;
    }

    setMessage(t("auth.resetEmailSent"));
  }

  async function handleResetPassword() {
    if (!password.trim()) {
      setError(t("auth.enterNewPassword"));
      return;
    }
    if (password !== confirmPassword) {
      setError(t("auth.passwordsDoNotMatch"));
      return;
    }

    setLoading(true);
    setError("");
    setMessage("");
    const { error: updateError } = await supabaseClient.auth.updateUser({
      password,
    });
    setLoading(false);

    if (updateError) {
      setError(updateError.message);
      return;
    }

    window.history.replaceState({}, document.title, window.location.pathname);
    onSuccess();
  }

  const title = recoveryMode ? t("auth.resetPassword") : "Next Master";
  const description = recoveryMode
    ? t("auth.resetPasswordDescription")
    : t("auth.loginDescription");
  const brandingLabel = branding.label || t("auth.adminWorkspace");
  const loginInitials = buildLoginInitials(branding.companyName);

  return (
    <div className="login-shell login-shell--admin">
      <div className="login-card">
        {!recoveryMode ? (
          <div className="login-brand">
            <div className={`login-brand__logo${branding.logoDataUrl ? " login-brand__logo--image" : ""}`} aria-hidden="true">
              {branding.logoDataUrl ? <img src={branding.logoDataUrl} alt="" className="login-brand__logo-image" /> : loginInitials}
            </div>
            <div className="login-brand__copy">
              <span>{brandingLabel}</span>
              <strong>{branding.companyName}</strong>
            </div>
          </div>
        ) : null}
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {!recoveryMode ? (
          <Input
            label={t("auth.emailOrUserName")}
            value={email}
            onChange={setEmail}
            placeholder={t("auth.emailOrUserNamePlaceholder")}
          />
        ) : null}
        <Input
          label={recoveryMode ? t("auth.newPassword") : t("auth.password")}
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          placeholder={recoveryMode ? t("auth.newPassword") : t("auth.password")}
        />
        {recoveryMode ? (
          <Input
            label={t("auth.confirmPassword")}
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder={t("auth.confirmPassword")}
          />
        ) : null}
        <div className="login-options">
          <Select
            label={t("common.language")}
            value={locale}
            options={localeOptions}
            onChange={(value) => setLocale(value as LocaleCode)}
            fieldClassName="field--mini"
          />
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />
            <span>{t("auth.showPassword")}</span>
          </label>
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        {message ? <div className="success-text">{message}</div> : null}
        {recoveryMode ? (
          <Button onClick={handleResetPassword} disabled={loading}>
            {loading ? t("common.saving") : t("auth.saveNewPassword")}
          </Button>
        ) : forgotMode ? (
          <>
            <Button onClick={handleForgotPassword} disabled={loading}>
              {loading ? t("common.sending") : t("auth.sendResetEmail")}
            </Button>
            <button
              className="text-button"
              onClick={() => {
                setForgotMode(false);
                setError("");
                setMessage("");
              }}
            >
              {t("auth.backToSignIn")}
            </button>
          </>
        ) : (
          <>
            <Button onClick={handleLogin} disabled={loading}>
              {loading ? t("auth.signingIn") : t("auth.signIn")}
            </Button>
            <button
              className="text-button"
              onClick={() => {
                setForgotMode(true);
                setError("");
                setMessage("");
              }}
            >
              {t("auth.forgotPassword")}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
