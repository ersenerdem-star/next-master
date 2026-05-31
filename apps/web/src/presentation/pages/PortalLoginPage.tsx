import { useEffect, useState } from "react";
import type { PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";

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
    <div className="login-screen portal-screen">
      <div className="login-card portal-card">
        <div className="portal-login-brand">
          <div className="portal-login-brand__logo" aria-hidden="true">
            NM
          </div>
          <div className="portal-login-brand__copy">
            <span>Drive Console</span>
            <strong>Next Master</strong>
          </div>
        </div>
        <h1>Portal Access</h1>
        <p>Sign in with your portal email and password.</p>
        <Input label="Portal Email" value={email} onChange={setEmail} placeholder="vendor@company.com" />
        <Input label="Password" type="password" value={password} onChange={setPassword} placeholder="Portal password" />
        {error ? <div className="error-text">{error}</div> : null}
        <Button busy={loading} busyLabel="Signing in..." onClick={() => void handleSubmit()}>
          Sign In
        </Button>
      </div>
    </div>
  );
}
