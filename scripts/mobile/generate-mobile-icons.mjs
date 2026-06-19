import fs from "node:fs/promises";
import path from "node:path";
import sharp from "sharp";

const rootDir = "/Users/ersen/Documents/Codex/2026-05-11-quote-desk-next-mvp";
const iconDir = path.join(rootDir, "apps/web/public/icons");

function buildIconSvg(size, padding = 0) {
  const inner = size - padding * 2;
  const tileRadius = Math.round(inner * 0.16);
  const stripeY = padding + inner * 0.68;
  return `
  <svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" xmlns="http://www.w3.org/2000/svg">
    <defs>
      <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#0b1d39" />
        <stop offset="100%" stop-color="#1c8bb8" />
      </linearGradient>
      <linearGradient id="panel" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="#ffffff" stop-opacity="0.98" />
        <stop offset="100%" stop-color="#dff4fb" stop-opacity="0.94" />
      </linearGradient>
    </defs>
    <rect x="0" y="0" width="${size}" height="${size}" rx="${Math.round(size * 0.22)}" fill="url(#bg)" />
    <rect x="${padding}" y="${padding}" width="${inner}" height="${inner}" rx="${tileRadius}" fill="url(#panel)" />
    <rect x="${padding + inner * 0.14}" y="${padding + inner * 0.2}" width="${inner * 0.72}" height="${inner * 0.08}" rx="${inner * 0.04}" fill="#0f5f83" opacity="0.28" />
    <rect x="${padding + inner * 0.14}" y="${padding + inner * 0.34}" width="${inner * 0.52}" height="${inner * 0.08}" rx="${inner * 0.04}" fill="#0f5f83" opacity="0.22" />
    <rect x="${padding + inner * 0.14}" y="${stripeY}" width="${inner * 0.72}" height="${inner * 0.16}" rx="${inner * 0.08}" fill="#0b1d39" opacity="0.92" />
    <text x="${size / 2}" y="${padding + inner * 0.58}" text-anchor="middle" font-size="${Math.round(inner * 0.3)}" font-family="Arial, Helvetica, sans-serif" font-weight="700" fill="#0b1d39">NM</text>
    <text x="${size / 2}" y="${stripeY + inner * 0.11}" text-anchor="middle" font-size="${Math.round(inner * 0.095)}" font-family="Arial, Helvetica, sans-serif" font-weight="700" letter-spacing="${Math.max(1, Math.round(inner * 0.01))}" fill="#ffffff">WAREHOUSE</text>
  </svg>
  `;
}

async function writeIcon(name, size, padding = 0) {
  const targetPath = path.join(iconDir, name);
  const svg = buildIconSvg(size, padding);
  await sharp(Buffer.from(svg)).png().toFile(targetPath);
  return targetPath;
}

async function main() {
  await fs.mkdir(iconDir, { recursive: true });
  await writeIcon("icon-192.png", 192, 0);
  await writeIcon("icon-512.png", 512, 0);
  await writeIcon("icon-maskable-512.png", 512, 56);
  await writeIcon("apple-touch-icon.png", 180, 12);
  await writeIcon("favicon-64.png", 64, 0);
  process.stdout.write(`Mobile icons generated in ${iconDir}\n`);
}

await main();
