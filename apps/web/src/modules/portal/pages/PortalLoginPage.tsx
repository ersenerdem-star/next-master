import { useEffect, useState } from "react";
import type { PortalSnapshot } from "../../../types/portalSession";
import { Button } from "../../../presentation/components/common/Button";
import { DakarLoginShowcase } from "../../../presentation/components/common/DakarLoginShowcase";
import { Input } from "../../../presentation/components/common/Input";

type PortalLoginPageProps = {
  onSuccess: (session: PortalSnapshot) => void;
};

export function PortalLoginPage({ onSuccess }: PortalLoginPageProps) {
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
      setError("Enter portal email.");
      return;
    }
    if (!password.trim()) {
      setError("Enter portal password.");
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
        throw new Error(data?.error || "Portal login failed");
      }
      onSuccess(data.snapshot as PortalSnapshot);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Portal login failed");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="portal-shell portal-shell--login">
      <div className="login-layout login-layout--portal">
        <DakarLoginShowcase
          theme="portal"
          brandLabel="Drive Console"
          brandName="Next Master"
          fallbackMonogram="NM"
        />
        <div className="login-card portal-login-card">
          <div className="login-card__eyebrow">Portal Sign-In</div>
          <h1>Portal Access</h1>
          <p>Sign in.</p>
          <form
            className="portal-login-form"
            onSubmit={(event) => {
              event.preventDefault();
              void handleSubmit();
            }}
          >
            <Input label="Portal Email" value={email} onChange={setEmail} placeholder="vendor@company.com" />
            <Input label="Password" type="password" value={password} onChange={setPassword} placeholder="Portal password" />
            {error ? <div className="error-text">{error}</div> : null}
            <Button busy={loading} busyLabel="Signing in..." onClick={() => void handleSubmit()}>
              Sign In
            </Button>
          </form>
        </div>
      </div>
    </div>
  );
}
