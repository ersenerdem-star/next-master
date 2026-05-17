import type { ButtonHTMLAttributes, ReactNode } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary";
  busy?: boolean;
  busyLabel?: string;
};

export function Button({ children, variant = "primary", className = "", busy = false, busyLabel, disabled, ...props }: ButtonProps) {
  return (
    <button
      {...props}
      disabled={disabled || busy}
      aria-busy={busy}
      className={`button button--${variant} ${busy ? "button--busy" : ""} ${className}`.trim()}
    >
      {busy ? (
        <span className="button__content">
          <span className="button__spinner" aria-hidden="true" />
          <span>{busyLabel || children}</span>
        </span>
      ) : (
        <span className="button__content">{children}</span>
      )}
    </button>
  );
}
