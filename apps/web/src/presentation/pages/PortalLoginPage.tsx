import { useEffect, useState } from "react";
import type { PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";
import { Select } from "../components/common/Select";
import { useI18n, type LocaleCode } from "../../i18n/I18nProvider";

type PortalLoginPageProps = {
  onSuccess: (session: PortalSnapshot) => void;
};

export function PortalLoginPage({ onSuccess }: PortalLoginPageProps) {
  const { locale, localeOptions, setLocale, t } = useI18n();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteEmail = params.get("email") || "";
    if (inviteEmail) setEmail(inviteEmail);
  }, []);

  async function handleSubmit() {
    if (!email.trim()) {
      setError(t("auth.portalEnterEmail"));
      return;
    }
    if (!password.trim()) {
      setError(t("auth.portalEnterPassword"));
      return;
    }

    try {
      setLoading(true);
      setError("");
      const response = await fetch("/api/portal-login", {
        method: "POST",
        credentials: "same-origin",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: email.trim(),
          password: password.trim(),
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.error || t("auth.portalLoginFailed"));
      }
      onSuccess(data.snapshot as PortalSnapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : t("auth.portalLoginFailed"));
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="login-screen portal-screen">
      <div className="login-card portal-card">
        <div className="portal-login-brand">
          <div className="portal-login-brand__logo" aria-hidden="true">
            NM
          </div>
          <div className="portal-login-brand__copy">
            <span>{t("nav.driveConsole")}</span>
            <strong>Next Master</strong>
          </div>
        </div>
        <h1>{t("auth.portalAccessTitle")}</h1>
        <p>{t("auth.portalDescription")}</p>
        <Input label={t("auth.portalEmail")} value={email} onChange={setEmail} placeholder={t("auth.portalEmailPlaceholder")} />
        <Input label={t("auth.portalPassword")} type="password" value={password} onChange={setPassword} placeholder={t("auth.portalPassword")} />
        {error ? <div className="error-text">{error}</div> : null}
        <div className="login-options">
          <Select
            label={t("common.language")}
            value={locale}
            options={localeOptions}
            onChange={(value) => setLocale(value as LocaleCode)}
            fieldClassName="field--mini"
          />
          <span />
        </div>
        <Button busy={loading} busyLabel={t("auth.signingIn")} onClick={() => void handleSubmit()}>
          {loading ? t("auth.signingIn") : t("auth.signIn")}
        </Button>
      </div>
    </div>
  );
}
