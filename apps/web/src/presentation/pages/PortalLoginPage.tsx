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
    <div className="portal-shell--login">
      <div className="portal-login-layout">
        <section className="portal-login-visual" aria-label={t("nav.driveConsole")}>
          <div className="portal-login-visual__copy">
            <span className="portal-login-visual__eyebrow">
              {locale === "tr" ? "Müşteri fiyat çalışma alanı" : "Customer pricing workspace"}
            </span>
            <h1>
              {locale === "tr"
                ? "Doğru parçayı, doğru fiyatla daha hızlı bulun."
                : "Find the right part at the right price, faster."}
            </h1>
            <p>
              {locale === "tr"
                ? "Güncel fiyat listeleri, belge akışı ve siparişe hazır parça bilgileri tek güvenli çalışma alanında."
                : "Current price lists, documents and order-ready part information in one secure workspace."}
            </p>
          </div>
          <div className="portal-login-visual__proof" aria-label={locale === "tr" ? "Portal özellikleri" : "Portal capabilities"}>
            <span>{locale === "tr" ? "Güncel fiyatlar" : "Current prices"}</span>
            <span>{locale === "tr" ? "Hızlı arama" : "Fast search"}</span>
            <span>{locale === "tr" ? "Güvenli erişim" : "Secure access"}</span>
          </div>
        </section>
        <div className="portal-login-card">
          <div className="portal-login-brand">
            <div className="portal-login-brand__logo" aria-hidden="true">
              NM
            </div>
            <div className="portal-login-brand__copy">
              <span>{t("nav.driveConsole")}</span>
              <strong>Next Master</strong>
            </div>
          </div>
          <div className="portal-login-card__intro">
            <span>{locale === "tr" ? "Müşteri portalı" : "Customer portal"}</span>
            <h2>{t("auth.portalAccessTitle")}</h2>
            <p>{t("auth.portalDescription")}</p>
          </div>
          <div className="portal-login-form">
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
            <div className="inline-actions">
              <Button busy={loading} busyLabel={t("auth.signingIn")} onClick={() => void handleSubmit()}>
                {loading ? t("auth.signingIn") : t("auth.signIn")}
              </Button>
            </div>
          </div>
          <p className="portal-login-card__privacy">
            {locale === "tr"
              ? "Portal erişiminiz hesabınıza özel tutulur. Sorun yaşarsanız yöneticinizle iletişime geçin."
              : "Your portal access is private to your account. Contact your administrator if you need help."}
          </p>
        </div>
      </div>
    </div>
  );
}
