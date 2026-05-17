import { useEffect, useState } from "react";
import type { PortalSnapshot } from "../../types/portalSession";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";

type PortalLoginPageProps = {
  onSuccess: (session: PortalSnapshot) => void;
};

export function PortalLoginPage({ onSuccess }: PortalLoginPageProps) {
  const [email, setEmail] = useState("");
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const inviteToken = params.get("token") || "";
    if (inviteToken) setToken(inviteToken);
  }, []);

  async function handleSubmit() {
    if (!email.trim()) {
      setError("Enter portal email.");
      return;
    }
    if (!token.trim()) {
      setError("Enter invite token.");
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
          token: token.trim(),
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
        <h1>Portal Access</h1>
        <p>Sign in with your invited portal email and token.</p>
        <Input label="Portal Email" value={email} onChange={setEmail} placeholder="vendor@company.com" />
        <Input label="Invite Token" value={token} onChange={setToken} placeholder="Paste invite token" />
        {error ? <div className="error-text">{error}</div> : null}
        <Button busy={loading} busyLabel="Signing in..." onClick={() => void handleSubmit()}>
          Sign In
        </Button>
      </div>
    </div>
  );
}
