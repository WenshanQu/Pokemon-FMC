# Pokémon "Find My Card" — AI Working Guide

**Read this fully before touching card data.** It is the single source of truth for how this
project's data, images, prices, and UI work, and for the exact editing method that keeps the file
from breaking. A fresh Claude session should be able to continue work seamlessly from this file alone.

> This file lives at the repo root and is auto-loaded by Claude Code every session. If a future
> chat doesn't seem to have it, tell it: **"阅读仓库根目录的 CLAUDE.md"**.

---

## 0. What the project is

A **single self-contained static web app** that tracks one collector's Pokémon cards for six
families and their trainer variants. Deployed on GitHub Pages: **https://wenshanqu.github.io/Pokemon-FMC/**

- Families: **Meowth, Psyduck, Slowpoke, Slowbro, Slowking, Quagsire** — plus named variants that
  still belong to a family by name (`Misty's Psyduck`, `Team Rocket's Meowth`, `Giovanni's Meowth`,
  `Sabrina's Psyduck`, `Slowking ex`, `Slowpoke & Psyduck-GX`, …). Anything else → `其他`.
- The app has two views: **库** (library/search, browse by set) and **图鉴** (dex, grouped by family
  and by *illustration*).

### Files
| Path | Purpose |
|------|---------|
| `index.html` | The **entire app + all data**. `const CARDS = [...]` (~481 entries) and `const JPRICE = {...}`. |
| `sw.js` | PWA service worker. `CACHE='fmc-v2'`; HTML network-first, images cache-first. |
| `manifest.webmanifest`, `icons/` | PWA manifest + app icons (root `icons/`, distinct from `images/icons/`). |
| `images/` | All card images. `images/icons/` holds the 6 dex family sprites. |
| `scripts/refresh-prices.mjs` + `scripts/*.json` | Weekly price refresher (see §5). |
| `.github/workflows/refresh-prices.yml` | Monday cron that runs the refresher. |
| `archive/check.html` | **Retired** art-verification tool. No longer maintained — do not sync it. |

---

## 1. Card entry schema

Each element of `CARDS` is one printing of one card. **English and Japanese cards use different
fields.** An entry object **must start with `art:`, `imgAlt:`, or `name:`** (the parser in §6 and the
price refresher split on that — an object starting with any other key gets merged into its neighbor).

### English (EN) card
```js
{ art: "z18",                 // OPTIONAL illustration-group id (see §4)
  name: "Slowbro", number: 54, total: 106, set: "Great Encounters",
  numDisplay: "086",          // OPTIONAL — shown instead of number when present
  holo: true,                 // OPTIONAL finish flag
  // --- exactly ONE count model: ---
  //  A) dual-print set (has 1st Edition + Unlimited): qty1ed: N, qtyUnl: M   (NO no1ed)
  //  B) single-print / promo:                          no1ed: true, qty: N
  //                                              OR    promo: true,  qty: N
  missing: "1ED",             // OPTIONAL, "1ED"|"UNL"|"BOTH" — legacy cosmetic note, NOT read by logic
  img: "images/<hash>.png",
  prices: { ed1: { rawUSD, rawSGD, psaUSD, psaSGD } | null,
            unl: { rawUSD, rawSGD, psaUSD, psaSGD } | null },
  priceDate: "YYYY-MM-DD", fx: 1.292 }
```

### Japanese (JP) card
```js
{ art: "z18",                 // OPTIONAL illustration-group id
  name: "Slowbro", number: "086",           // string or number
  numDisplay: "DPBP#086",     // OPTIONAL pretty number
  set: "Moonlit Pursuit", jp: true,
  vintage: true, rar: "C",    // OPTIONAL: vintage flag + rarity ("C"/"U"/"Holo"/"R"/"AR"…)
  holo: true,                 // OPTIONAL
  img: "images/jp_....png",
  own: { n: <#common copies>, h: <#holo/AR copies> },
  pc: "https://www.pricecharting.com/..." }  // OPTIONAL live-price URL override
```

Key facts:
- **`fx = 1.292`** (USD→SGD). EN: `rawSGD = rawUSD × 1.292`. JP price is stored in SGD (`r`) with
  `ru = r / 1.292`.
- **JP prices are NOT in the entry** — they live in `JPRICE` (see §5).
- `imgAlt: true` → renders a small **"代图"** badge, meaning "this entry borrows another version's
  image because the real scan isn't sourced yet."
- `fam: "<Family>"` → **family override** for cards whose name doesn't contain the family word
  (e.g. `Here Comes Team Rocket!` uses `fam: "Meowth"`). Put `fam` **after** `name`, never first.

---

## 2. Ownership & count semantics

`isOwned(c)`:
- JP → `own.n + own.h > 0`
- EN dual (not `no1ed`, not `promo`) → `qty1ed + qtyUnl > 0`
- EN single (`no1ed` or `promo`) → `qty > 0`

`ownInfo(c)` label:
- JP → `普通×n · 闪×h`
- EN single → `持有 ×q`
- EN dual → `1ED×a · 无印×b`

**JP count convention:** put **common** copies in `n`, **holo / AR / reverse-holo** copies in `h`.
A holo-only promo you own 2 of → `own {n:0, h:2}`. A plain common you own 3 of → `{n:3, h:0}`.
(For EN, `holo:true` marks the finish; the count model is separate.)

### Updating an existing entry's quantity (the most common task)
1. `grep` the card to find it (anchor on set + number, or the img filename).
2. JP → change `own:{n,h}`. EN single → change `qty`. EN dual → change `qty1ed`/`qtyUnl`.
3. "加一张/+1" means increment the current value — **read the current value first, never assume 0.**
   Watch for double-application if the user re-sends a batch (compare against git log).
4. Edit via the method in §6, then verify.

---

## 3. The two views & the dex grouping

- **图鉴 (dex)** groups cards so that every printing sharing the **same illustration** appears as ONE
  tile; clicking it opens a **group-detail** panel listing all versions (image, set/#/language,
  finish badge 普通/✦闪, owned qty, a **复制** locator button, and a **实时价 ↗** live-price link).
  **No prices are shown in the dex** — only the live link.
- **库 (library)** is the flat searchable list, grouped by set.
- Grouping logic (`renderDex` → `mergeKey`):
  - `art` present → key is `"ART|"+art` (overrides everything).
  - else key is `name|canonSet` (or `name|canonSet|number` if that set holds >1 card per language).
  - `canonSet` (the `CANON` map) normalizes JP set aliases to their EN set name so EN+JP land together.

---

## 4. Art groups (illustration merging) — the core mechanic

`art: "<id>"` binds different printings of the **same artwork** (across language, set, finish) into
one dex group. Ids are arbitrary short strings (`z18`, `m117`, `pAR28`, `m203ir`…).

- **Merge two groups** → pick the surviving id, reassign the other's members:
  `.Replace('art: "OLD"', 'art: "NEW"')` (String.Replace hits all occurrences).
  **First `grep 'art: "OLD"'` and read every member** — reassigning drags *all* of them, so make sure
  the whole group really shares the art (don't merge a stray card).
- **Split** cards out of a wrongly-merged group → give the ones to pull out a **brand-new unused id**.
- **Tag an untagged entry** → a card with no `art` groups by name+set; to merge it with others, add an
  `art` to it *and* to the others.
- A standalone new card with no `art` forms its own dex group automatically — fine for unique promos.

---

## 5. Prices

- **EN** prices live inline in each entry's `prices` (raw + PSA10, USD + SGD).
- **JP** prices live in `const JPRICE = {...}`, keyed:
  - vintage: `"<set>/<number>/<name>"`  (e.g. `"Pokémon VS/058/141/Misty's Quagsire"`)
  - modern:  `"<set>/<number>"`         (e.g. `"S10P/16"`)
  - value: `{ r: rawSGD, ru: rawUSD, p: psaSGD, pu: psaUSD }` (any may be `null`).
  A JP entry with no matching JPRICE key simply shows no price table — that's allowed.
- **Weekly auto-refresh** (`.github/workflows/refresh-prices.yml` → `scripts/refresh-prices.mjs`,
  Mondays): EN raw price from **Limitless** (`scripts/limitless-sets.json` maps set name → Limitless
  code), JP raw price from **snkrdunk** (`scripts/snkr-ids.json` maps a JPRICE key → snkrdunk card id).
  Only raw/ungraded is updated; PSA numbers are left alone. Anything unmapped is skipped. **Extend
  those two JSON files** whenever you confirm a set code or a snkrdunk id.
- **Live-price link** in the UI: `pcUrl()` builds a PriceCharting search `pokemon <name> <number>`.
  For split-finish cards (e.g. Slowbro 82 common+holo) keep the query to just name+number — **no extra
  words**. A `pc:` field on an entry overrides the generated URL.

---

## 6. Editing method — DO IT THIS WAY (avoids corrupting the file)

**Environment:** Windows. PowerShell is primary and reliable for file writes; Bash is available for
`git`/`grep`/`curl`. The file is **CRLF**, UTF-8 without BOM.

**Rules**
1. **Anchor on unique strings, never blind line numbers.** The **img filename** is the best unique
   anchor for an entry. EN entries are **multi-line** (fields wrap); JP entries are **single-line**.
2. For multi-line anchors, build the newline in: `$nl = "`r`n"` and concatenate
   `'    field...,' + $nl + '    img: "images/....png",'`.
3. Edit the whole file with `[IO.File]::ReadAllText` / `.Replace(old,new)` / `[IO.File]::WriteAllText`
   (UTF-8 no BOM preserves glyphs like **δ**). Build non-ASCII by code point: `[char]0x03B4` = δ.
4. To iterate entries programmatically, split the array:
   ```powershell
   $si=$c.IndexOf('const CARDS = [')+15; $ei=$c.IndexOf('];',$si)
   $entries=[regex]::Split($c.Substring($si,$ei-$si),'(?=\{\s*(?:imgAlt|art|name):)') |
            ? { $_.TrimStart().StartsWith('{') }
   ```
   (Same split the price refresher uses — hence the "entry must start with art/imgAlt/name" rule.)
5. **Insert a new card** right before the CARDS closing `];`:
   `$c = $c.Substring(0,$ei) + $newEntry + $c.Substring($ei)` (recompute `$ei` after other edits).
6. **Verify every batch before trusting it** (a helper that records misses and aborts the write is
   ideal): (a) `name: "` occurrence count changed by exactly the expected delta;
   (b) `{` vs `}` **balanced** inside the array; (c) grep that each specific edit landed;
   (d) no entry accidentally starts with a key other than art/imgAlt/name.
7. Keep working scripts in the **scratchpad**, not the repo.

**Reusable batch skeleton** (adapt per task):
```powershell
$f='c:\Users\wensh\OneDrive\Desktop\Pokemon FMC\index.html'
$c=[IO.File]::ReadAllText($f); $before=([regex]::Matches($c,'name: "')).Count; $fail=@(); $nl="`r`n"
function Rep($old,$new){ if(-not $script:c.Contains($old)){$script:fail+=$old.Substring(0,60);return}; $script:c=$script:c.Replace($old,$new) }
# ... Rep 'anchor old' 'anchor new'  (one per change) ...
# ... inserts before ']' ...
if($fail.Count){ "FAILED:"; $fail; "ABORT"; exit 1 }
$arr=$c.Substring($c.IndexOf('const CARDS = ['),$c.IndexOf('];',$c.IndexOf('const CARDS = ['))-$c.IndexOf('const CARDS = ['))
"balanced="+(([regex]::Matches($arr,'\{')).Count -eq ([regex]::Matches($arr,'\}')).Count)
[IO.File]::WriteAllText($f,$c)
"names $before -> "+([regex]::Matches($c,'name: "')).Count
```

> If PowerShell ever returns `EPERM uv_spawn`, it's transient — just retry the call.

---

## 7. Adding a new card — checklist

1. Gather: name, set, number, language, finish, count, and **does it share art** with an existing entry?
2. Get a **real image** (§8–§9). Save to `images/` with a clear name
   (`jp_<mon>_<set>_<num>.<ext>`, or reuse the existing hash style). **View the file to confirm the
   card identity, number, and finish — never trust the filename or source blindly.**
3. If landscape/padded (snkrdunk bg-removed webp is 856×625), **crop** to the card face (§8).
4. Decide `art`: same illustration as an existing card → shared id (tag the old entry too if needed);
   otherwise omit (standalone) or new id.
5. Insert before `];`, object starting with `art:`/`name:`. Set counts (JP `own`, EN `qty*`).
6. Verify (§6) and commit (§11).

---

## 8. Images & cropping

- Prefer real HQ scans; replace EN-placeholder "代图" JP images when a real scan appears.
- **tcgplayer** (best general source, EN + "Japan" products):
  `https://tcgplayer-cdn.tcgplayer.com/product/<productId>_in_1000x1000.jpg` — ~500×700, clean, no
  crop. Get `<productId>` from the tcgplayer URL the user gives.
- **snkrdunk** `https://snkrdunk.com/en/trading-cards/<id>`: `og:image` is
  `.../upload_bg_removed/...webp?size=l` — transparent bg, usually **856×625 landscape** with the card
  small/off-center → **must crop**. The title gives the JP set/number; the page has the SGD price.
- **pokellector / jp.pokellector**: page contains `den-cards.pokellector.com/<n>/<Name>.<SET>.<num>.<id>.png`
  — clean transparent PNG.
- **limitless** card image: `og:image` → `...digitaloceanspaces.com/tpc/<SET>/<SET>_<n>_R_JP_SM.png`
  (small but clean). Great when you only need a catalog thumbnail.
- **Crop (WPF, trims transparent/black borders to the card face)** — keep the script in scratchpad;
  the shape is: load via `BitmapDecoder` → `FormatConvertedBitmap`(Bgra32) → scan pixels for
  `alpha > 20` (bg-removed) to find the bounding box → `CroppedBitmap` → `PngBitmapEncoder`. Output a
  ~0.71-ratio `..._c.png`. (Full example last used at
  `scratchpad/crop_delta.ps1` — recreate as needed.)
- If a filename you replaced keeps showing a stale image in the app, bump `CACHE` in `sw.js`
  (`fmc-v2`→`fmc-v3`) to force clients to drop cached images.

---

## 9. Source directory (from experience)

**Usable — fetch with a normal `-A "Mozilla/5.0"` UA:**
- `tcgplayer-cdn.tcgplayer.com` — images by product id (EN & Japan). **First choice.**
- `snkrdunk.com/en/trading-cards/<id>` — JP images (crop) + SGD price. Id isn't derivable; take it
  from the link the user provides.
- `limitlesstcg.com` — `/cards/<CODE>/<n>` (EN, has USD price) and `/cards/jp/<SET>/<n>` (JP). The JP
  **set lists** are the best way to find a JP counterpart's number (scan the Japanese card titles).
- `den-cards.pokellector.com` (via `pokellector.com` / `jp.pokellector.com`) — clean transparent PNGs.
- `manasource.net` / sg-manapro (Shopify `cdn/shop/files`) — JP singles images.
- `public.getcollectr.com/public-assets/products/product_<id>.jpg` — card images.
- `collectorlegion.com` + crystalcommerce CDNs — EN reverse-holo images.
- `collectorsrealm` (`cdn/shop/files/<id>.jpg`), `pokumon` (templcdn), `tcgrepublic` — misc singles.
- `raw.githubusercontent.com/PokeAPI/sprites/.../pokemon/<dexno>.png` — Pokémon sprites (used for the
  dex family icons: Meowth 52, Psyduck 54, Slowpoke 79, Slowbro 80, Slowking 199, Quagsire 195).

**Blocked (Cloudflare 403 — don't scrape; ask the user for an alternate link):**
- `pricecharting.com` (fine as a **link** target, not scrapable), `ebay.com` listing pages,
  `tcgcollector.com`, `pokecardex` images, `pokemon-card.com` direct, some Bulbapedia image pages.
- **Rule of thumb:** if the user hands you a PriceCharting link for a card we need an *image/price* of,
  that source is blocked — ask them for a **tcgplayer / snkrdunk / pokellector** link instead.

---

## 10. Finding an EN↔JP counterpart

- A modern EN set usually maps to one or two JP sets. Scan `limitlesstcg.com/cards/jp/<SET>` titles.
  Japanese name prefixes: `カスミの`=Misty's, `ロケット団の`=Team Rocket's, `サカキの`=Giovanni's,
  `ナツメの`=Sabrina's. Pokémon: `ニャース`=Meowth, `コダック`=Psyduck, `ヤドン`=Slowpoke,
  `ヤドラン`=Slowbro, `ヤドキング`=Slowking, `ヌオー`=Quagsire.
- Known mappings seen so far: **Destined Rivals (SV10 EN) = JP「ロケット団の栄光」Glory of Team Rocket
  (SV10) + 「熱風のアリーナ」Hot Air Arena (SV9a)**; Great Encounters (EN) = JP DP4「月光の追跡」
  Moonlit Pursuit + DP5; Ancient Origins = XY7; and the `CANON` map in `index.html` lists many more.
- Confirm by **viewing both images**, then merge with a shared `art` id.

---

## 11. Commit & deploy

- Use **bash `git`** (PowerShell git can report false success). Branch **`main`** → GitHub Pages
  deploys on push. Push only when the user asks, or per standing instruction for this repo.
- Commit message: summarize per-family what changed; end with:
  `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`
- After a data edit, just commit+push — the SW is network-first for HTML so clients update. Bump
  `CACHE` in `sw.js` only to force-refresh cached **images**.
- The CRLF/LF warning on commit is harmless.

---

## 12. UI / style guide

- **Dex family header:** big **Fredoka** title (`.dex-fam`, 30px / 25px mobile), a **46px pixel
  sprite** icon (`images/icons/<fam>.png`, `.dex-fam-icon`), and a `已有 X / Y` progress line + bar.
  Adding a family → add its sprite to `images/icons/`, plus entries in `FAM_ORDER` **and** `FAM_ICON`.
- **Finish badges:** holo → gold `✦ 闪`; a non-holo that shares a group with a holo → gray `普通`.
- **Group-detail cells:** image, set, `#num/total`, language chip (JP/ENG), finish badge, `代图` badge
  if `imgAlt`, owned label, a `⧉ 复制` button (copies a locator string), and a `实时价 ↗` link.
- Theme: CSS custom properties (`--text`, `--text-dim`, …), light + dark aware. Fredoka from Google
  Fonts (external requests are fine on GitHub Pages).
- Keep it uncluttered; match the existing spacing/rounding when adding UI.

---

## 13. Snapshot (update opportunistically)

~481 card entries · `fx = 1.292` · family order Meowth → Psyduck → Slowpoke → Slowbro → Slowking →
Quagsire → 其他 · price refresh runs Mondays · `check.html` retired to `archive/`.
