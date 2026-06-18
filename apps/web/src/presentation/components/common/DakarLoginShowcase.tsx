import { resolveNamedLogo } from "./logoAssets";

type DakarLoginShowcaseProps = {
  theme?: "admin" | "portal";
  brandLabel: string;
  brandName: string;
  logoDataUrl?: string;
  fallbackMonogram: string;
  headline?: string;
  description?: string;
};

const marqueeBrands = [
  "Bosch",
  "Mahle",
  "MANN",
  "Donaldson",
  "ZF",
  "Sachs",
  "Meyle",
  "TRW",
  "Valeo",
  "ATE",
  "Knorr",
  "WABCO",
  "Ferodo",
  "Beru",
  "Champion",
  "Boge",
  "HEPU",
  "SKF",
  "NRF",
  "Nissens",
  "Payen",
  "Jurid",
  "Goetze",
  "Glyco",
  "Nural",
  "LuK",
  "INA",
  "FAG",
  "Brembo",
];

function renderLogoTile(brand: string, index: number) {
  const logo = resolveNamedLogo(brand);
  const title = logo?.label || brand;
  return (
    <div key={`${brand}-${index}`} className="dakar-showcase__marquee-item" title={title}>
      <div className="dakar-showcase__marquee-card">
        {logo ? <img src={logo.src} alt={title} className="dakar-showcase__logo-image" /> : <span>{brand}</span>}
      </div>
    </div>
  );
}

function renderLogoLane(brands: string[], laneIndex: number, reverse = false) {
  return (
    <div
      key={`lane-${laneIndex}`}
      className={`dakar-showcase__marquee-lane${reverse ? " dakar-showcase__marquee-lane--reverse" : ""}`}
      style={{ ["--marquee-lane" as string]: laneIndex }}
    >
      <div className="dakar-showcase__marquee-track">
        {brands.map((brand, index) => renderLogoTile(brand, laneIndex * 100 + index))}
        {brands.map((brand, index) => renderLogoTile(brand, laneIndex * 100 + index + brands.length))}
      </div>
    </div>
  );
}

export function DakarLoginShowcase({
  theme = "admin",
  brandLabel,
  brandName,
  logoDataUrl = "",
  fallbackMonogram,
  headline = "",
  description = "",
}: DakarLoginShowcaseProps) {
  const showCopy = Boolean(String(headline).trim() || String(description).trim());
  const logoLanes = [
    marqueeBrands.slice(0, 10),
    marqueeBrands.slice(10, 20),
    marqueeBrands.slice(20),
  ];

  return (
    <section
      className={`dakar-showcase dakar-showcase--${theme}${showCopy ? "" : " dakar-showcase--no-copy"}`}
      aria-label="Animated brand logo marquee"
    >
      <div className="dakar-showcase__header">
        <div className={`dakar-showcase__logo${logoDataUrl ? " dakar-showcase__logo--image" : ""}`} aria-hidden="true">
          {logoDataUrl ? <img src={logoDataUrl} alt="" className="dakar-showcase__logo-image" /> : fallbackMonogram}
        </div>
        <div className="dakar-showcase__brand-copy">
          <span>{brandLabel}</span>
          <strong>{brandName}</strong>
        </div>
        <div className="dakar-showcase__loop-indicator">
          <span className="dakar-showcase__live-dot" />
          Live shelf
        </div>
      </div>

      {showCopy ? (
        <div className="dakar-showcase__copy">
          <span className="dakar-showcase__eyebrow">Brand marquee</span>
          {headline ? <h2>{headline}</h2> : null}
          {description ? <p>{description}</p> : null}
        </div>
      ) : null}

      <div className="dakar-showcase__media" aria-hidden="true">
        <div className="dakar-showcase__ambient dakar-showcase__ambient--one" />
        <div className="dakar-showcase__ambient dakar-showcase__ambient--two" />
        <div className="dakar-showcase__grid" />
        <div className="dakar-showcase__marquee" aria-hidden="true">
          {logoLanes.map((laneBrands, index) => renderLogoLane(laneBrands, index, index % 2 === 1))}
        </div>
      </div>
    </section>
  );
}
