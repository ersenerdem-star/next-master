type NamedLogoAsset = {
  label: string;
  src: string;
};

type LogoPreset = {
  match: RegExp;
  label: string;
  wordmark: string;
  assetSrc?: string;
  bgFrom: string;
  bgTo: string;
  fg: string;
  stroke?: string;
};

const LOGO_PRESETS: LogoPreset[] = [
  { match: /bosch/i, label: "Bosch", wordmark: "BOSCH", assetSrc: "/brand-logos/bosch_logo.png", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /\bate\b/i, label: "ATE", wordmark: "ATE", assetSrc: "/brand-logos/ate_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /donaldson/i, label: "Donaldson", wordmark: "DONALDSON", assetSrc: "/brand-logos/donaldson_logo.png", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#c81e1e", stroke: "#fca5a5" },
  { match: /wabco/i, label: "WABCO", wordmark: "WABCO", assetSrc: "/brand-logos/wabco_logo.png", bgFrom: "#ecfeff", bgTo: "#ffffff", fg: "#0f766e", stroke: "#67e8f9" },
  { match: /\bzf\b/i, label: "ZF", wordmark: "ZF", assetSrc: "/brand-logos/zf_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /lemforder/i, label: "Lemforder", wordmark: "LEMFORDER", assetSrc: "/brand-logos/lemforder_logo.jpg", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#4338ca", stroke: "#a5b4fc" },
  { match: /sachs/i, label: "Sachs", wordmark: "SACHS", assetSrc: "/brand-logos/sachs_logo.png", bgFrom: "#f5f3ff", bgTo: "#ffffff", fg: "#6d28d9", stroke: "#c4b5fd" },
  { match: /boge/i, label: "Boge", wordmark: "BOGE", assetSrc: "/brand-logos/boge_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /mann/i, label: "MANN", wordmark: "MANN", assetSrc: "/brand-logos/mann_logo.png", bgFrom: "#fefce8", bgTo: "#ffffff", fg: "#a16207", stroke: "#fde047" },
  { match: /febi/i, label: "febi", wordmark: "FEBI", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#b91c1c", stroke: "#fca5a5" },
  { match: /\bfte\b/i, label: "FTE", wordmark: "FTE", assetSrc: "/brand-logos/fte_logo.png", bgFrom: "#eef2ff", bgTo: "#ffffff", fg: "#1e3a8a", stroke: "#93c5fd" },
  { match: /\bswf\b/i, label: "SWF", wordmark: "SWF", assetSrc: "/brand-logos/swf_logo.jpg", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /\btrw\b/i, label: "TRW", wordmark: "TRW", assetSrc: "/brand-logos/trw_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1e40af", stroke: "#93c5fd" },
  { match: /hella/i, label: "Hella", wordmark: "HELLA", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#bfdbfe" },
  { match: /hepu/i, label: "HEPU", wordmark: "HEPU", assetSrc: "/brand-logos/hepu_logo.png", bgFrom: "#f0fdf4", bgTo: "#ffffff", fg: "#15803d", stroke: "#86efac" },
  { match: /valeo/i, label: "Valeo", wordmark: "VALEO", assetSrc: "/brand-logos/valeo_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /skf/i, label: "SKF", wordmark: "SKF", assetSrc: "/brand-logos/skf_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /nrf/i, label: "NRF", wordmark: "NRF", assetSrc: "/brand-logos/nrf_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /nissens/i, label: "Nissens", wordmark: "NISSENS", assetSrc: "/brand-logos/nissens_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /master\s*power/i, label: "Master Power", wordmark: "MASTER POWER", assetSrc: "/brand-logos/masterpower_logo.png", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#c2410c", stroke: "#fdba74" },
  { match: /meyle/i, label: "Meyle", wordmark: "MEYLE", assetSrc: "/brand-logos/meyle_logo.svg", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#111827", stroke: "#cbd5e1" },
  { match: /mahle/i, label: "Mahle", wordmark: "MAHLE", assetSrc: "/brand-logos/mahle_logo.jpg", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /payen/i, label: "Payen", wordmark: "PAYEN", assetSrc: "/brand-logos/payen_logo.jpg", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#111827", stroke: "#fdba74" },
  { match: /jurid/i, label: "Jurid", wordmark: "JURID", assetSrc: "/brand-logos/jurid_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /goetze/i, label: "Goetze", wordmark: "GOETZE", assetSrc: "/brand-logos/goetze_logo.png", bgFrom: "#fefce8", bgTo: "#ffffff", fg: "#111827", stroke: "#fde047" },
  { match: /glyco/i, label: "Glyco", wordmark: "GLYCO", assetSrc: "/brand-logos/glyco_logo.jpg", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#b91c1c", stroke: "#fca5a5" },
  { match: /nural/i, label: "Nural", wordmark: "NURAL", assetSrc: "/brand-logos/nural_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#111827", stroke: "#cbd5e1" },
  { match: /ferodo/i, label: "Ferodo", wordmark: "FERODO", assetSrc: "/brand-logos/ferodo_logo.png", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#111827", stroke: "#fca5a5" },
  { match: /champion/i, label: "Champion", wordmark: "CHAMPION", assetSrc: "/brand-logos/champion_logo.png", bgFrom: "#fff7ed", bgTo: "#ffffff", fg: "#111827", stroke: "#fdba74" },
  { match: /beru/i, label: "Beru", wordmark: "BERU", assetSrc: "/brand-logos/beru_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#111827", stroke: "#cbd5e1" },
  { match: /(^|\\s)ae(\\s|$)|ae parts/i, label: "AE", wordmark: "AE", assetSrc: "/brand-logos/ae_logo.png", bgFrom: "#eff6ff", bgTo: "#ffffff", fg: "#1d4ed8", stroke: "#93c5fd" },
  { match: /fp\\s*diesel|fp-diesel/i, label: "FP Diesel", wordmark: "FP DIESEL", assetSrc: "/brand-logos/fpdiesel_logo.png", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#111827", stroke: "#fca5a5" },
  { match: /luk/i, label: "LuK", wordmark: "LUK", assetSrc: "/brand-logos/luk_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /ina/i, label: "INA", wordmark: "INA", assetSrc: "/brand-logos/ina_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /fag/i, label: "FAG", wordmark: "FAG", assetSrc: "/brand-logos/fag_logo.jpg", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /knorr/i, label: "Knorr", wordmark: "KNORR", assetSrc: "/brand-logos/knorr_logo.png", bgFrom: "#f8fafc", bgTo: "#ffffff", fg: "#0f172a", stroke: "#cbd5e1" },
  { match: /brembo/i, label: "Brembo", wordmark: "BREMBO", assetSrc: "/brand-logos/brembo_logo.svg", bgFrom: "#fef2f2", bgTo: "#ffffff", fg: "#b91c1c", stroke: "#fca5a5" },
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
    src: preset.assetSrc || buildSvgPreset(preset),
  };
}
