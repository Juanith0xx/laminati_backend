// Diagnóstico de una ficha Abet. No usa base de datos.
// Uso: node scripts/abet/debug-abet-page.js "<URL>" [--block] [--headful]
//   --block : aplica el mismo bloqueo de recursos que el importador
// Mide cuánto tarda en aparecer el botón "Download panel format".
import { chromium } from "playwright";

const url = process.argv[2];
const headful = process.argv.includes("--headful");
const block = process.argv.includes("--block");

if (!url) {
  console.error('Uso: node debug-abet-page.js "<URL>" [--block] [--headful]');
  process.exit(1);
}

const BLOCKED_URL_PATTERN =
  /elementor|gravityforms|recaptcha|iubenda|umami\.|unpkg\.com|cloudflareinsights|plugins\/mailin|wpconnect-gf-sendinblue|google-analytics|googletagmanager|doubleclick|facebook\.(net|com)|hotjar|clarity\.ms|youtube/i;

const t0 = Date.now();
const since = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`;

const browser = await chromium.launch({ headless: !headful });
const context = await browser.newContext({
  locale: "en-US",
  userAgent: "Mozilla/5.0 Laminatiword Catalog Importer",
  acceptDownloads: true,
});
const page = await context.newPage();

if (block) {
  await page.route("**/*", (route) => {
    const r = route.request();
    const t = r.resourceType();
    if (t === "image" || t === "media" || t === "font" || BLOCKED_URL_PATTERN.test(r.url())) {
      return route.abort();
    }
    return route.continue();
  });
}

console.log(`Bloqueo: ${block ? "SÍ" : "NO"}`);

page.on("pageerror", (e) => console.log(`[pageerror ${since()}] ${String(e.message).slice(0, 160)}`));

try {
  await page.goto(url, { waitUntil: "commit", timeout: 30000 });
  console.log(`[${since()}] commit OK`);
} catch (e) {
  console.log(`[${since()}] goto error: ${e.message.split("\n")[0]}`);
}

const pattern = /Download panel format|Descargar formato del panel|Scarica formato pannello/i;
let found = null;
let lastState = "";

for (let i = 0; i < 360; i += 1) {
  const state = await page.evaluate(() => document.readyState).catch(() => "?");
  if (state !== lastState) {
    console.log(`[${since()}] readyState=${state}`);
    lastState = state;
  }

  const matches = page.getByText(pattern, { exact: false });
  const count = await matches.count().catch(() => 0);
  for (let k = 0; k < count; k += 1) {
    if (await matches.nth(k).isVisible({ timeout: 200 }).catch(() => false)) {
      found = since();
      break;
    }
  }
  if (found) break;
  await new Promise((r) => setTimeout(r, 500));
}

console.log(found ? `\nBOTÓN VISIBLE a los ${found}` : "\nEl botón NO apareció en 180 s");

const info = await page
  .evaluate(() => {
    const text = String(document.body?.innerText || "");
    return {
      title: document.title,
      textLength: text.length,
      downloadLines: (text.match(/.{0,50}(download|descarg|scarica).{0,60}/gi) || []).slice(0, 8),
    };
  })
  .catch((e) => ({ error: e.message }));
console.log(JSON.stringify(info, null, 2));

const shot = `/tmp/abet-debug-page-${block ? "blocked" : "full"}.png`;
await page.screenshot({ path: shot }).catch(() => {});
console.log(`Captura: ${shot}`);

await browser.close();
