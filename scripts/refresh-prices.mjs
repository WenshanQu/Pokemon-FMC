// Weekly price refresh for index.html.
//
// Sources (both plain-fetchable, no API key, not Cloudflare-blocked):
//   * EN cards -> Limitless TCG   https://limitlesstcg.com/cards/<code>/<number>
//                 (TCGplayer market price, USD, ungraded). Set-code map: scripts/limitless-sets.json
//   * JP cards -> snkrdunk         https://snkrdunk.com/en/trading-cards/<id>
//                 (market price, SGD, ungraded). ID map: scripts/snkr-ids.json
//
// Only the RAW / ungraded price is updated. PSA10 (graded) has no scrapable source, so
// existing PSA10 numbers are left untouched.
//
// SAFE BY DESIGN:
//   - EN prices are edited entry-by-entry inside the CARDS array; only the numbers inside
//     each card's `unl:{ rawUSD, rawSGD }` are touched, nothing structural.
//   - JP prices only rewrite the `const JPRICE={...};` JSON blob.
//   - Anything that can't be fetched / parsed / mapped is skipped.
//   - Before writing, it validates the card count and JPRICE JSON are still intact.

import { readFileSync, writeFileSync } from 'node:fs';

const FX = 1.292;                 // USD -> SGD (matches the site)
const HTML = 'index.html';
const UA = { 'User-Agent': 'Mozilla/5.0 (compatible; fmc-price-bot/1.0)' };
const round2 = n => Math.round(n * 100) / 100;
const sleep = ms => new Promise(r => setTimeout(r, ms));

const LIMITLESS_SETS = JSON.parse(readFileSync('scripts/limitless-sets.json', 'utf8'));
const SNKR_IDS = JSON.parse(readFileSync('scripts/snkr-ids.json', 'utf8'));

async function fetchText(url) {
  const res = await fetch(url, { headers: UA, redirect: 'follow' });
  if (!res.ok) throw new Error('HTTP ' + res.status);
  return res.text();
}

// ---- price extractors -------------------------------------------------------
function limitlessUSD(html) {
  // primary market price shown on the card page
  const m = html.match(/<span class="card-price usd">\s*\$([0-9][0-9,]*\.?[0-9]*)/i);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function snkrSGD(html) {
  // analytics blob: {"currency":"SGD",...,"price":97,...}
  const m = html.match(/"currency":"SGD"[^}]*?"price":([0-9]+(?:\.[0-9]+)?)/);
  if (!m) return null;
  const n = parseFloat(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

// ---- CARDS / entry helpers --------------------------------------------------
const field = (e, name) => {
  const m = e.match(new RegExp(name + ':\\s*"([^"]*)"'));
  return m ? m[1] : '';
};
const numField = e => {
  const m = e.match(/number:\s*"?([^,"}]+)"?/);
  return m ? m[1].trim() : '';
};

async function main() {
  const html = readFileSync(HTML, 'utf8');
  const cardsStart = html.indexOf('const CARDS = [') + 'const CARDS = ['.length;
  const cardsEnd = html.indexOf('];', cardsStart);
  const inner = html.slice(cardsStart, cardsEnd);
  const namesBefore = (html.match(/name: "/g) || []).length;

  const entries = inner.split(/(?=\{\s*(?:imgAlt|art|name):)/).filter(s => s.trimStart().startsWith('{'));

  // ---------- EN: update inline unl prices via Limitless ----------
  let enChanged = 0, enFail = 0;
  const enSkipSet = new Set();
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (/jp:\s*true/.test(e)) continue;
    if (!/unl:\s*\{[^}]*rawUSD:/.test(e)) continue;      // no unl raw price to update
    const set = field(e, 'set');
    const code = LIMITLESS_SETS[set];
    if (!code || code.startsWith('_')) { if (set) enSkipSet.add(set); continue; }
    const num = numField(e).replace(/^0+(?=\d)/, '');     // limitless uses printed number, no leading zeros
    if (!/^[A-Za-z]*\d+[A-Za-z0-9-]*$/.test(num)) continue;
    try {
      const usd = limitlessUSD(await fetchText(`https://limitlesstcg.com/cards/${code}/${num}`));
      if (usd == null) { enFail++; continue; }
      const sgd = round2(usd * FX);
      const ne = e
        .replace(/(unl:\s*\{[^}]*?rawUSD:\s*)[0-9.]+/, `$1${usd}`)
        .replace(/(unl:\s*\{[^}]*?rawSGD:\s*)[0-9.]+/, `$1${sgd}`);
      if (ne !== e) { entries[i] = ne; enChanged++; console.log(`EN  ${set} #${num} -> $${usd} (S$${sgd})`); }
    } catch (err) { enFail++; console.log(`EN  err ${set} #${num}: ${err.message}`); }
    await sleep(400);
  }
  if (enSkipSet.size) console.log('EN  unmapped sets skipped:', [...enSkipSet].join(', '));

  const newInner = '\r\n  ' + entries.join('');
  let out = html.slice(0, cardsStart) + newInner + html.slice(cardsEnd);

  // ---------- JP: update JPRICE blob via snkrdunk ----------
  const jm = out.match(/const JPRICE=(\{.*?\});/s);
  if (!jm) { console.error('JPRICE block not found'); process.exit(1); }
  const jprice = JSON.parse(jm[1]);
  let jpChanged = 0;
  for (const [key, id] of Object.entries(SNKR_IDS)) {
    if (key.startsWith('_')) continue;
    try {
      const sgd = snkrSGD(await fetchText(`https://snkrdunk.com/en/trading-cards/${id}`));
      if (sgd == null) { console.log(`JP  no price: ${key}`); continue; }
      const usd = round2(sgd / FX);
      const prev = jprice[key] || {};
      const next = { r: sgd, ru: usd, p: prev.p ?? null, pu: prev.pu ?? null };
      if (prev.r !== next.r || prev.ru !== next.ru) {
        jprice[key] = next; jpChanged++; console.log(`JP  ${key} -> S$${sgd} ($${usd})`);
      }
    } catch (err) { console.log(`JP  err ${key}: ${err.message}`); }
    await sleep(400);
  }
  out = out.replace(/const JPRICE=\{.*?\};/s, () => 'const JPRICE=' + JSON.stringify(jprice) + ';');

  // ---------- validate + write ----------
  const namesAfter = (out.match(/name: "/g) || []).length;
  const jcheck = out.match(/const JPRICE=(\{.*?\});/s);
  if (namesAfter !== namesBefore) { console.error(`ABORT: card count changed ${namesBefore} -> ${namesAfter}`); process.exit(1); }
  if (!jcheck) { console.error('ABORT: JPRICE missing after edit'); process.exit(1); }
  JSON.parse(jcheck[1]);   // throws if invalid

  if (enChanged === 0 && jpChanged === 0) { console.log('No price changes.'); return; }
  writeFileSync(HTML, out);
  console.log(`Done — EN updated ${enChanged}, JP updated ${jpChanged}, EN misses ${enFail}.`);
}

main().catch(e => { console.error(e); process.exit(1); });
