import { useState } from "react";
import { supabaseClient } from "../../infrastructure/api/supabaseClient";
import { Button } from "../components/common/Button";
import { Input } from "../components/common/Input";

type LoginPageProps = {
  onSuccess: () => void;
  recoveryMode?: boolean;
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

export function LoginPage({ onSuccess, recoveryMode = false }: LoginPageProps) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const [forgotMode, setForgotMode] = useState(false);

  async function handleLogin() {
    setLoading(true);
    setError("");
    setMessage("");
    const candidates = authEmailCandidates(email);
    let loginError: Error | null = new Error("Invalid login credentials");

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
      setError("Enter your user name or email first.");
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

    setMessage("Reset email sent. Open the link in your inbox to set a new password.");
  }

  async function handleResetPassword() {
    if (!password.trim()) {
      setError("Enter a new password.");
      return;
    }
    if (password !== confirmPassword) {
      setError("Passwords do not match.");
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

  const title = recoveryMode ? "Reset Password" : "Next Master";
  const description = recoveryMode
    ? "Enter your new password to finish recovery."
    : "Login with your existing Supabase account to view real cloud data.";

  return (
    <div className="login-shell">
      <div className="login-card">
        <div>
          <h1>{title}</h1>
          <p>{description}</p>
        </div>
        {!recoveryMode ? (
          <Input label="Email or User Name" value={email} onChange={setEmail} placeholder="importer or name@company.com" />
        ) : null}
        <Input
          label={recoveryMode ? "New Password" : "Password"}
          type={showPassword ? "text" : "password"}
          value={password}
          onChange={setPassword}
          placeholder={recoveryMode ? "New password" : "Password"}
        />
        {recoveryMode ? (
          <Input
            label="Confirm Password"
            type="password"
            value={confirmPassword}
            onChange={setConfirmPassword}
            placeholder="Repeat password"
          />
        ) : null}
        <div className="login-options">
          {!recoveryMode ? <span /> : <span />}
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={showPassword}
              onChange={(event) => setShowPassword(event.target.checked)}
            />
            <span>Show password</span>
          </label>
        </div>
        {error ? <div className="error-text">{error}</div> : null}
        {message ? <div className="success-text">{message}</div> : null}
        {recoveryMode ? (
          <Button onClick={handleResetPassword} disabled={loading}>
            {loading ? "Saving..." : "Save new password"}
          </Button>
        ) : forgotMode ? (
          <>
            <Button onClick={handleForgotPassword} disabled={loading}>
              {loading ? "Sending..." : "Send reset email"}
            </Button>
            <button
              className="text-button"
              onClick={() => {
                setForgotMode(false);
                setError("");
                setMessage("");
              }}
            >
              Back to sign in
            </button>
          </>
        ) : (
          <>
            <Button onClick={handleLogin} disabled={loading}>
              {loading ? "Signing in..." : "Sign in"}
            </Button>
            <button
              className="text-button"
              onClick={() => {
                setForgotMode(true);
                setError("");
                setMessage("");
              }}
            >
              Forgot password?
            </button>
          </>
        )}
      </div>
    </div>
  );
}
