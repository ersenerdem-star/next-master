type NamedLogoAsset = {
  label: string;
  src: string;
};

type LogoPreset = {
  match: RegExp;
  label: string;
  wordmark: string;
  bgFrom: string;
  bgTo: string;
  fg: string;
  stroke?: string;
};

const LOGO_PRESETS: LogoPreset[] = [
  { match: /bosch/i, label: "Bosch", wordmark: "BOSCH", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /\bate\b/i, label: "ATE", wordmark: "ATE", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /donaldson/i, label: "Donaldson", wordmark: "DONALDSON", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#c81e1e", stroke: "#fca5a5" },
  { match: /wabco/i, label: "WABCO", wordmark: "WABCO", bgFrom: "#ecfeff", bgTo: "#ffffff", fg: "#0f766e", stroke: "#67e8f9" },
  { match: /\bzf\b/i, label: "ZF", wordmark: "ZF", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /lemforder/i, label: "Lemforder", wordmark: "LEMFORDER", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#4338ca", stroke: "#a5b4fc" },
  { match: /sachs/i, label: "Sachs", wordmark: "SACHS", bgFrom: "#f5f3ff", bgTo: "#ffffff", fg: "#6d28d9", stroke: "#c4b5fd" },
  { match: /boge/i, label: "Boge", wordmark: "BOGE", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /mann/i, label: "MANN", wordmark: "MANN", bgFrom: "#fefce8", bgTo: "#ffffff", fg: "#a16207", stroke: "#fde047" },
  { match: /febi/i, label: "febi", wordmark: "FEBI", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#b91c1c", stroke: "#fca5a5" },
  { match: /\bfte\b/i, label: "FTE", wordmark: "FTE", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#1e3a8a", stroke: "#93c5fd" },
  { match: /\bswf\b/i, label: "SWF", wordmark: "SWF", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /\btrw\b/i, label: "TRW", wordmark: "TRW", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1e40af", stroke: "#93c5fd" },
  { match: /hella/i, label: "Hella", wordmark: "HELLA", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#bfdbfe" },
  { match: /hepu/i, label: "HEPU", wordmark: "HEPU", bgFrom: "#f0fdf4", bgTo: "#ffffff", fg: "#15803d", stroke: "#86efac" },
  { match: /mercedes|benz/i, label: "Mercedes-Benz", wordmark: "MB", bgFrom: "#f3f4f6", bgTo: "#ffffff", fg: "#111827", stroke: "#cbd5e1" },
  { match: /\bman\b/i, label: "MAN", wordmark: "MAN", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /volvo/i, label: "Volvo", wordmark: "VOLVO", bgFrom: "#ecfeff", bgTo: "#ffffff", fg: "#0f766e", stroke: "#99f6e4" },
  { match: /\bdaf\b/i, label: "DAF", wordmark: "DAF", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /scania/i, label: "Scania", wordmark: "SCANIA", bgFrom: "#f0fdf4", bgTo: "#ffffff", fg: "#166534", stroke: "#86efac" },
  { match: /volkswagen|(^|\s)vw(\s|$)/i, label: "Volkswagen", wordmark: "VW", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#4338ca", stroke: "#a5b4fc" },
  { match: /\baudi\b/i, label: "Audi", wordmark: "AUDI", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /\bbmw\b/i, label: "BMW", wordmark: "BMW", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /\bford\b/i, label: "Ford", wordmark: "FORD", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /\bnissan\b/i, label: "Nissan", wordmark: "NISSAN", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#334155", stroke: "#cbd5e1" },
  { match: /renault/i, label: "Renault", wordmark: "RENAULT", bgFrom: "#fefce8", bgTo: "#ffffff", fg: "#a16207", stroke: "#fde047" },
  { match: /\biveco\b/i, label: "Iveco", wordmark: "IVECO", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#334155", stroke: "#cbd5e1" },
];

function encodeSvg(svg: string) {
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function buildSvgPreset(preset: LogoPreset) {
  const fontSize = preset.wordmark.length > 8 ? "16" : preset.wordmark.length > 5 ? "22" : "28";
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="${preset.label}">
      <defs>
        <linearGradient id="g" x1="0" x2="1" y1="0" y2="1">
          <stop offset="0%" stop-color="${preset.bgFrom}" />
          <stop offset="100%" stop-color="${preset.bgTo}" />
        </linearGradient>
      </defs>
      <rect x="4" y="4" width="112" height="112" rx="26" fill="url(#g)" stroke="${preset.stroke || "#dbe3f0"}" stroke-width="4"/>
      <rect x="16" y="16" width="88" height="88" rx="20" fill="rgba(255,255,255,0.82)" />
      <text x="60" y="67" text-anchor="middle" font-family="Arial, Helvetica, sans-serif" font-size="${fontSize}" font-weight="800" letter-spacing="1.5" fill="${preset.fg}">
        ${preset.wordmark}
      </text>
    </svg>
  `;
  return encodeSvg(svg);
}

function findPreset(value: string) {
  const text = String(value || "").trim();
  if (!text) return null;
  return LOGO_PRESETS.find((preset) => preset.match.test(text)) || null;
}

export function resolveNamedLogo(value: string | null | undefined): NamedLogoAsset | null {
  const preset = findPreset(String(value || ""));
  if (!preset) return null;
  return {
    label: preset.label,
    src: buildSvgPreset(preset),
  };
}
