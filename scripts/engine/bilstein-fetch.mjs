import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { chromium } from 'playwright';

console.error(
  'BLOCKED: This legacy script writes directly to catalog_products. ' +
  'Use scripts/catalog/run-bilstein-group-observation-adapter.mjs for review-only observations, ' +
  'or the authenticated Bilstein stage-only portal flow for product identities.'
);
process.exit(1);

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

function clean(s) {
  return (s || '').trim();
}

function normalize(s) {
  return (s || '').toUpperCase().replace(/\W/g, '');
}

async function run() {
  console.log("🚀 BILSTEIN FETCH START");

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();

  const { data } = await supabase
    .from('catalog_products')
    .select('id, product_code')
    .limit(50); // küçük batch

  console.log(`📦 TO PROCESS: ${data.length}`);

  let updated = 0;

  for (const row of data) {

    try {
      const searchUrl = `https://partsfinder.bilsteingroup.com/en/search?t=a&q=${row.product_code}`;

      await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });

      // ürün linkini bul
      const link = await page.locator('a[href*="/en/article/"]').first().getAttribute('href');

      if (!link) {
        console.log(`❌ NOT FOUND: ${row.product_code}`);
        continue;
      }

      const fullUrl = "https://partsfinder.bilsteingroup.com" + link;

      await page.goto(fullUrl, { waitUntil: 'domcontentloaded' });

      const html = await page.content();

      // 🔥 OEM çek
      const oemMatches = [...html.matchAll(/\b\d{7,12}\b/g)];
      const oems = [...new Set(oemMatches.map(m => normalize(m[0])))];

      // 🔥 EAN
      const eanMatch = html.match(/\b\d{13}\b/);
      const ean = eanMatch ? eanMatch[0] : null;

      // 🔥 DESCRIPTION (basit)
      const descMatch = html.match(/<h1[^>]*>(.*?)<\/h1>/i);
      const description = descMatch ? clean(descMatch[1]) : null;

      await supabase
        .from('catalog_products')
        .update({
          normalized_oem: oems.join(',') || null,
          ean: ean,
          description: description
        })
        .eq('id', row.id);

      updated++;

      console.log(`⚡ ${row.product_code} → OEM:${oems.length}`);

      // anti-ban
      await new Promise(r => setTimeout(r, 1200));

    } catch (err) {
      console.log(`❌ ERROR: ${row.product_code}`);
    }
  }

  await browser.close();

  console.log(`🏁 DONE → UPDATED: ${updated}`);
}

run();
