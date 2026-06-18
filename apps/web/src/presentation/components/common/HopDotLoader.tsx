import type { CSSProperties, ReactNode } from "react";

type HopDotLoaderProps = {
  className?: string;
  decorative?: boolean;
  label?: ReactNode;
  size?: "sm" | "md" | "lg";
  tone?: "accent" | "current" | "warm";
};

export function HopDotLoader({
  className = "",
  decorative = false,
  label,
  size = "md",
  tone = "accent",
}: HopDotLoaderProps) {
  return (
    <span
      className={`hopdot-loader hopdot-loader--${size} hopdot-loader--${tone} ${className}`.trim()}
      aria-hidden={decorative ? true : undefined}
      aria-live={decorative || !label ? undefined : "polite"}
      role={decorative || !label ? undefined : "status"}
    >
      <span className="hopdot-loader__dots" aria-hidden="true">
        <span className="hopdot-loader__dot" style={{ "--hopdot-index": 0 } as CSSProperties} />
        <span className="hopdot-loader__dot" style={{ "--hopdot-index": 1 } as CSSProperties} />
        <span className="hopdot-loader__dot" style={{ "--hopdot-index": 2 } as CSSProperties} />
      </span>
      {label ? <span className="hopdot-loader__label">{label}</span> : null}
    </span>
  );
}

export function LoadingScreen({ message }: { message: ReactNode }) {
  return (
    <div className="loading-screen">
      <div className="loading-screen__panel">
        <HopDotLoader label={message} size="lg" tone="accent" />
      </div>
    </div>
  );
}
