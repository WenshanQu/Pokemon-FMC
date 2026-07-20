// Weekly price refresh for the JPRICE table in index.html.
// Reads PriceCharting pages through the r.jina.ai reader proxy (PriceCharting itself
// is Cloudflare-protected). SAFE BY DESIGN:
//   - only rewrites the `const JPRICE={...};` JSON blob, never any card structure
//   - skips anything it cannot fetch or parse
//   - validates (JSON re-parses + card count unchanged) before writing
// Coverage is driven by scripts/price-sources.json (JPRICE key -> PriceCharting URL).

import { readFileSync, writeFileSync } from 'node:fs';

const FX = 1.292;            // USD -> SGD, matches the site's fx
const HTML = 'index.html';
const SOURCES = 'scripts/price-sources.json';
const round2 = n => Math.round(n * 100) / 100;

async function fetchText(url) {
  const res = await fetch('https://r.jina.ai/' + url, { headers: { Accept: 'text/plain' } });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

function parsePrices(text) {
  const grab = re => {
    const m = text.match(re);
    if (!m) return null;
    const n = parseFloat(m[1].replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  };
  // PriceCharting's price-summary tokens render as the label glued to the price,
  // e.g. "Ungraded$15.00" / "PSA 10$1,383.75". Require the "$" to sit right next to
  // the label (0-2 spaces) so we never grab an eBay sold-listing price that merely
  // contains "PSA 10 ... $50,000" somewhere in its title.
  const raw = grab(/Ungraded[\s ]{0,2}\$([0-9][0-9,]*\.?[0-9]*)/i);
  const psa = grab(/PSA[\s ]*10[\s ]{0,2}\$([0-9][0-9,]*\.?[0-9]*)/i);
  return { raw, psa };
}

async function main() {
  const html = readFileSync(HTML, 'utf8');
  const sources = JSON.parse(readFileSync(SOURCES, 'utf8'));

  const m = html.match(/const JPRICE=(\{.*?\});/s);
  if (!m) { console.error('JPRICE block not found'); process.exit(1); }
  const jprice = JSON.parse(m[1]);
  const cardsBefore = (html.match(/name: "/g) || []).length;

  // Match keys by Unicode NFC form (the "é" in "Pokémon VS" can differ between files),
  // but always update via the ORIGINAL JPRICE key so the page keeps working.
  const norm = s => s.normalize('NFC');
  const jkeys = Object.keys(jprice);

  let changed = 0;
  for (const [srcKey, url] of Object.entries(sources)) {
    if (srcKey.startsWith('_')) continue;         // skip _comment
    const key = jkeys.find(k => norm(k) === norm(srcKey));
    if (!key) { console.log('skip (key not in JPRICE):', srcKey); continue; }
    try {
      const { raw, psa } = parsePrices(await fetchText(url));
      if (raw == null) { console.log('skip (no raw price parsed):', key); continue; }
      const e = jprice[key];
      const pu = psa != null ? psa : e.pu;        // keep old PSA10 if page has none
      const next = { ru: raw, pu, r: round2(raw * FX), p: pu != null ? round2(pu * FX) : null };
      if (e.ru !== next.ru || e.pu !== next.pu) {
        jprice[key] = next; changed++;
        console.log('updated', key, '-> raw', raw, 'psa', pu);
      }
    } catch (err) {
      console.log('error', key, err.message);
    }
    await new Promise(r => setTimeout(r, 3000));   // gentle on the proxy
  }

  if (changed === 0) { console.log('no changes'); return; }

  const newHtml = html.replace(/const JPRICE=\{.*?\};/s, () => 'const JPRICE=' + JSON.stringify(jprice) + ';');

  // validate before writing
  const check = newHtml.match(/const JPRICE=(\{.*?\});/s);
  const cardsAfter = (newHtml.match(/name: "/g) || []).length;
  if (!check || cardsAfter !== cardsBefore) { console.error('validation failed — aborting'); process.exit(1); }
  JSON.parse(check[1]);   // throws if the new blob is not valid JSON

  writeFileSync(HTML, newHtml);
  console.log('done —', changed, 'price(s) updated');
}

main().catch(e => { console.error(e); process.exit(1); });
