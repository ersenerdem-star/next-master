## Hengst official import

This import path is for official Hengst pages saved from a real browser.

### Why this exists

`hengstconnect.com` serves product data in the browser, but server-side fetches are currently blocked by Cloudflare `403`. Because of that, Netlify functions cannot run a normal official crawler for Hengst right now.

### Product code rule

Use the visible title code as the catalog `product_code`.

Example:

- product title: `E340H D247`
- item number: `2377130000`

Write:

- `product_code = E340H D247`
- `internal_item_number = 2377130000`

Do not use the numeric item number as the main catalog code.

### Capture pages from Safari

The fastest path is to capture the live Safari tab HTML directly.

1. Open one or more official Hengst product pages in Safari.
2. Run:

```bash
node scripts/capture-hengst-pages-from-safari.mjs
```

This captures the current front Hengst tab into:

- `docs/hengst-imports/captures/<timestamp>/`

If you want to capture every open Hengst tab in Safari:

```bash
node scripts/capture-hengst-pages-from-safari.mjs --all-tabs
```

Then import that capture folder with:

```bash
node scripts/import-brand-from-hengst-pages.mjs --source-dir=/absolute/path/to/capture/folder
```

### Save pages manually from Safari

If you prefer manual files:

1. Open the official Hengst product page in Safari.
2. Save the page as either:
   - `.webarchive`
   - `.html`
3. Put the saved product pages into one folder.

The importer supports:

- `.webarchive`
- `.html`
- `.htm`
- `.xhtml`

### Run the importer

From the repo root:

```bash
node scripts/import-brand-from-hengst-pages.mjs --source-dir=/absolute/path/to/saved/hengst/pages
```

This creates a CSV summary and a JSON summary under:

- `docs/hengst-imports/`

To import into `catalog_products`:

```bash
SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... node scripts/import-brand-from-hengst-pages.mjs --source-dir=/absolute/path/to/saved/hengst/pages --import
```

### Imported fields

The importer reads official page content and extracts:

- `product_code`
- `internal_item_number`
- `description`
- `OEM`
- `vehicle`
- `image_url`
- `detail_url`

### Notes

- Duplicate product pages are collapsed by normalized `product_code`.
- If the same product appears in multiple saved files, the importer keeps the richest merged row.
