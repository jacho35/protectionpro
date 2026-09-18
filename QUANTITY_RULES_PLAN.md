# Material + labour rates and quantity rules ("Quantity from") — implementation plan

Status: **built** (2026-09-18), all seven steps verified headless; not committed.
Decided at the start of the build: the Qty column shows the measured (net) quantity
and labour is paid on it; waste adds to material only. Design canvas for the rate
library UI: https://claude.ai/artifact/RFaP6U2GeRfWxp6wFp2BEc.

## Why

The Bill of quantities (`boq.js`) only counts what is drawn or scheduled: Demand,
site/floor plans, the single-line diagram and DB schedules. Real bills also carry
items nobody draws: meter boxes, warning tape, earth electrodes, testing &
commissioning, P&Gs, contingencies. Today they can only be added as custom rate
items with no quantity. This phase gives every rate-library item a **Quantity from**
rule so those lines are counted from what the project already measures.

It also splits every price into **material** and **labour** (§A). Today each item
has one rate. Contractors price supply and installation separately, and clients
compare them separately, so every bill line carries both.

## Decisions already made (do not re-ask)

1. **Percentage lines are in scope and configurable.** Each percentage item picks its
   own percent and what it is calculated on (the total, or any chosen sections), and
   can be switched off per project.
2. **No per-cable accessory lines.** Glands, lugs and so on are not itemised. The
   existing per-cable `TRM-` termination lines stay the only termination items, and
   are simply called "terminations". Don't add termination counts as a basis.
3. **Ship a few starter items** with rules but **no rates** (see §6).
4. **Every rate item and every bill line has a material cost and a labour cost**
   (§A). Added 2026-09-18.

## A. Material and labour on every line (build this first)

**Rates (`rates.js`)**
- `L.items[key]` gains **`labour`** (a number, per unit, like `rate`). The existing
  **`rate` field stays and means the material rate**, so saved projects,
  "Save as my default" and older exported sheets keep working with no migration.
  An old all-in rate becomes the material rate with no labour. Say so once in the
  rate library banner: "Rates entered before labour was split out count as
  material. Move the labour part into the Labour column."
- `Rates.get(key)` returns `{ rate, labour, waste, supplier }`. `rate` and `labour`
  are each `number | null`. `set(key, 'labour', v)` behaves like `'rate'`, and
  `_prune` keeps an item that has only a labour rate.
- **Priced** = at least one of material or labour is entered. An item with neither is
  "no rate" (the existing flag and menu badge). An item with only one of them is
  priced, with the other shown as "—". It is not flagged: labour-only items
  (`LAB-*`, testing & commissioning) and supply-only items are normal.
- Default labour for labour-type items: `LAB-*` keys show their price in the
  Labour column. `Rates.CATS` / catalogue entries get a `priceIn: 'labour'` hint so
  the Add item dialog and the import put a single rate in the right column.
- Terminations: the termination-tab note changes from "the rate is for one cable
  end, complete: gland, lugs, shroud and labour" to **material** = gland, lugs,
  shroud; **labour** = making off the end. There is still one `TRM-` line per cable.

**Waste.** Waste is extra material that is bought but not installed, so it applies to
**material only**. Labour is paid on the measured (net) quantity.
- Material amount = measured qty × (1 + waste %) × material rate
- Labour amount = measured qty × labour rate
- The **Qty** column shows the **measured (net)** quantity. This is a change from
  today, where the Qty column includes waste.
- The material cell's tooltip reads "incl. 5 % waste (1 050 m bought)".
- The "Cable, all types" statistic keeps "incl. waste".
- The "Apply each item's waste %" option now reads "Add waste to material".

**Confirm at the start of the build:** that labour is paid on the net quantity and
the Qty column shows net. The alternative keeps today's Qty-with-waste and pays
labour on it too, which is simpler but overstates labour.

**Bill of quantities (`boq.js`)**
- Columns: Item code · Description · From · Qty · Unit · **Material rate** ·
  **Labour rate** · **Material** · **Labour** · **Amount** (material + labour).
- Each section subtotal and the grand total are split into material / labour /
  total. The summary stats add **Material** and **Labour** totals, and the labour
  share as a %.
- New BOQ option **"Price"**: *Supply & install* (default) / *Supply only* /
  *Install only*. It hides the unused columns and prices only that part. Use it
  when the client supplies the material, or when material is bought directly.
- Exports:
  - CSV/XLSX `_aoa`: both rates and both amounts as separate columns.
  - PDF: switch to **landscape A4** for the extra columns. The totals block is split
    into material / labour.
- `compute()` line shape gains `labour`, `matAmount`, `labAmount`. `amount`
  stays as their sum, so existing callers (badges, totals) keep working.

**Rate library UI**
- The **Rate** column becomes **Material** and a **Labour** column is added next to
  it. Both are Excel-style number cells with no spinner.

**CSV / XLSX round trip**
- `Rates.HEAD` becomes Key · Category · Description · Unit · **Material rate** ·
  **Labour rate** · Waste % · Supplier code · Quantity from · In this project.
- Import still accepts a sheet whose only price column is called **Rate** (older
  exports and hand-made sheets) and reads it as material, or as labour for
  `priceIn: 'labour'` items.
- The preview shows material and labour changes separately.

**Percentage lines (§4) interact:** each percentage item's "of" gains a choice of
**total / material / labour**. For example, P&G of the total, or a labour-escalation
% of labour only. A percentage line's own amount is reported in a single Amount
column; it is not split.

## 1. Model

A rule lives on the item key in the per-project rate library, next to rate, waste %
and supplier code:

```js
AppState.rateLibrary.items[key].rule =
    { basis: 'erven', factor: 1 }                 // quantity = factor × basis count
  | { basis: 'fixed', factor: 1 }                 // lump sum: quantity = factor
  | { basis: 'pct',   factor: 8, of: ['total'] }  // percentage line, see §4
  | null                                          // explicitly "measured only"
```

- **Effective rule** = `items[key].rule` if that property exists (including `null`),
  otherwise the catalogue's default `rule` for that key (starter items, §6). An
  improved starter default then reaches every project that hasn't overridden it.
- `Rates._prune` must keep an item that has a `rule` property, even when rate, waste
  and supplier are empty.
- Custom items (`L.custom[key] = {desc, unit, cat}`) take rules the same way.
- `saveDefault` / `loadDefault` already copy `items` and `custom` whole, so rules
  travel with "Save as my default". Confirm this, and say so in the toast.
- Add `Rates.getRule(key)` next to `Rates.get(key)`.

## 2. Bases (the "Quantity from" vocabulary)

Bases are counted **inside `BOQ.collect`**, in the same pass and with the same
source toggles and counted-once logic as the measured lines, so a basis can never
disagree with the bill. `collect` returns `{ lines, warnings, notes, bases }`.
`bases` holds the **measured quantity, before waste**.

Ids are fixed. Labels are only for display, so renaming a label never breaks a
rule. Define the list once, as `BOQ.BASES = [{ id, label, unit, group }]`.

| id | Label | Counted from |
|---|---|---|
| `erven` | Erven | Demand: every erf of every kiosk. With no Demand data: plan `erf` elements |
| `erven_1ph` | Erven, single-phase | Demand only. Not 3-phase (below) |
| `erven_3ph` | Erven, three-phase | Demand only. `erf.phase === '3 Phase'` **or** a kiosk class that is 3-phase (`Retic._classIs3ph(Retic._kioskClass(k))`), the same rule as `_erfCableMismatch` / backend `_erf_phases` |
| `kiosks` | Kiosks | The same count as the `EQ-KIOSK` line (Demand, else plan) |
| `minisubs` | Minisubs | The same count as the `EQ-MINISUB` line |
| `lv_feeders` | LV feeder runs | Demand kiosks with a feeder length and cable type |
| `services` | Service connections | Demand erven with a service length and cable type |
| `cable_lv_m` | LV cable, m | Sum of measured `cat:'cable'`, `unit:'m'` lines whose cable is LV (`CableLib`, `!isMV`). Includes plan, SLD and DB lines |
| `cable_mv_m` | MV cable, m | The same, for MV cables |
| `service_m` | Service cable, m | Demand service lengths |
| `trench_m` | Trench, m (all types) | Plan trenches |
| `trench_m:<type>` | Trench, m: *type name* | One basis per `PLAN_DEFS.trenchTypes` key |
| `crossings` | Road crossings | Plan crossings |
| `boards` | Distribution boards | The sum of the `EQ-DB*` + `EQ-SWITCHBOARD` quantities |
| `ways` | DB circuits (ways) | Every DB schedule way except spares |
| `lights` | Light points | Plan `bd_light` elements |
| `sockets` | Socket outlets | Plan `bd_socket` elements |
| `switches` | Light switches | Plan `bd_switch` elements |
| `floors` | Floors | `AppState.planFloors()` in the building domain |
| `fixed` | Fixed quantity (lump sum) | Always 1; the factor is the quantity |

In a project without Demand data, the phase split (`erven_1ph` / `erven_3ph`) is 0.
Add a note that it needs Demand. Don't guess.

## 3. Evaluation (in `BOQ.collect`, after all measured lines)

For every key in the catalogue ∪ `L.custom` with an effective non-pct rule:

1. **Counted once.** If the key already has a measured quantity > 0, **the measured
   quantity wins**. Skip the rule and warn: "‹desc›: has a rule and is also measured;
   the measured quantity is used."
2. Otherwise `qty = factor × bases[basis]` (`fixed` → `factor`).
   `add(item, qty, 'rule', 'Rule: ‹factor› × ‹basis label› (‹basis value›)')`.
   The source text is the working a QS checks.
3. **Zero basis.** If the basis is 0 and the item has a rate, add a note:
   "‹desc›: rule 1 × kiosks, but this project has no kiosks." No line is added,
   unless `opts.zero` is set.
4. Waste % applies to rule lines like any other line, and the existing rounding is
   used: `m` to 0.1, everything else up to a whole number. Use factors like
   `0.02 × LV cable m` for "one marker per 50 m"; the round-up gives whole markers.
5. Add a source id `'rule'` to `BOQ.SOURCES`: "Rules (not drawn)", ticked by default.
   Unticking it drops rule and percentage lines together.

## 4. Percentage lines (configurable)

- The rule is `{ basis: 'pct', factor: <percent>, of: ['total'] | [<cat ids>], part: 'all' | 'material' | 'labour' }`
  (`part` defaults to `'all'`; see §A).
- They go in a new last section, `cat: 'allow'`, label **"Preliminaries & allowances"**.
  Add it to `Rates.CATS` and `BOQ.SECTION`, and map `PCT-` keys to it in `guessCat`.
- They're computed in `BOQ.compute` **after** the priced sections. Amount =
  `percent × sum of subtotals of the chosen sections` (or of every non-allowance
  section for `'total'`). They never include other percentage lines, so no
  compounding. State this in the section footnote.
- Quantity column: `8 %`. Rate column: the base amount. Amount: the result. Unit `%`.
- Configurable per item, in the rate library:
  - percent (the factor cell);
  - "of" (a picker: *Total*, or tick sections);
  - **on/off** (a percentage item with no percent entered is off and raises no
    "no rate" flag).
- Export (CSV/XLSX/PDF): these lines are included, and the grand total includes them.
  Show the "Total before allowances" subtotal first.

## 5. UI

**Rate library (`rates.js`)**
- New columns after **Unit**: **Quantity from** (a `<select>` of `BOQ.BASES`
  grouped by `group`, first option "Measured") and **Factor** (an Excel-style number
  cell, no spinner). `GridTable` already handles selects and paste.
  - For pct items the Factor header reads "%", and an "of" picker appears in the row.
  - Measured catalogue items (cables, MCBs…) show "Measured" and stay editable. The
    counted-once rule handles clashes.
- **Add item** button → a dialog with: category, description, unit, key (suggested:
  category prefix + slug(desc), editable, uniqueness checked), Quantity from + factor.
  This is the one correct way to create an item. Writes `L.custom[key]` + `L.items[key].rule`.
- Status column / filter: **"Not counted"** means the item has a rate, no rule, and
  is not measured in this project. Add a filter chip.
- Put a /design canvas of the column and dialog before building, as was done for the
  Quantities menu.

**Bill of quantities (`boq.js`)**
- Rule lines show their working in the source column.
- The "Rules (not drawn)" source checkbox.
- The Preliminaries & allowances section.
- `refreshMenuBadges()`: the BOQ badge also counts rule lines with no rate.

**CSV / XLSX round trip (`Rates.HEAD`, `_exportRows`, `planImport`, `applyImport`)**
- New column **Quantity from**, as text: `1 x erven`, `1.05 x trench m`,
  `0.02 x LV cable m`, `fixed 1`, `8% of total`, `5% of cables, civils`, `measured`,
  or blank (no change).
- Parse against basis **ids and labels**, case-insensitive; accept `x`, `×` and `*`.
- Unknown basis or bad syntax → the preview row shows an error and that row's rule
  is not applied. Other fields on the row still apply.
- Writing the parser and formatter as one pair (`Rates.ruleText(rule)` ↔
  `Rates.parseRule(text)`) means an exported sheet always round-trips.

## 6. Starter items (catalogue defaults, **no rates**)

| Key | Description | Unit | Cat | Default rule |
|---|---|---|---|---|
| `EQ-METER-BOX` | Meter box / service connection box, per erf | ea | equip | 1 × erven |
| `CIV-WARNING-TAPE` | Cable warning tape | m | civil | 1 × trench m |
| `CIV-CABLE-MARKER` | Cable route marker (1 per 50 m) | ea | civil | 0.02 × trench m |
| `EQ-EARTH-ELECTRODE` | Earth electrode, per kiosk | ea | equip | 2 × kiosks |
| `EQ-EARTH-MINISUB` | Minisub earthing installation | ea | equip | 1 × minisubs |
| `LAB-TEST-COMMISSION` | Testing & commissioning | sum | civil | fixed 1 |
| `LAB-COC` | Certificate of compliance, per DB | ea | civil | 1 × boards |
| `PCT-PG` | Preliminaries & general | % | allow | pct, of total, no percent (off) |
| `PCT-CONTINGENCY` | Contingency | % | allow | pct, of total, no percent (off) |

A starter item with no rate appears in the bill only when its quantity > 0, and is
flagged "no rate" like any other line. Show the rules in the rate library so the
user can change a factor, not only the rate.

## 7. Build steps

1. **Material + labour (§A).** The `labour` field, `get`/`set`/`_prune`, the
   Material/Labour columns in the rate library, the split BOQ columns and totals,
   waste on material only, the Price option (supply/install), CSV/XLSX/PDF
   columns, and import of old single-Rate sheets. Verify: an old project's bill
   total is unchanged when no labour is entered (apart from the net-quantity
   display); a labour-only `LAB-` item is priced and not flagged.
2. **Bases engine.** `BOQ.BASES`, bases counted in `collect`, returned with the
   result. Verify: on a Demand project and a building project, the bases equal
   hand counts.
3. **Rules in the bill.** `Rates.getRule`, catalogue default rules + starter items,
   evaluation (§3), `'rule'` source, the `_prune` fix. Verify the counted-once
   warning, the zero-basis note and the working text.
4. **Percentage lines.** The `allow` category, compute after the subtotals, the
   `part` choice (total / material / labour), the exports, the total before allowances.
5. **Rate library UI.** /design first, then the Quantity from + Factor columns,
   the "of" picker, the Add item dialog, the "Not counted" status/filter.
6. **CSV/XLSX column.** `ruleText` / `parseRule`, import-preview validation, a
   round-trip test (export → import unchanged → no changes reported).
7. **Badges and docs.** The menu badge count, `HELP.md` section, a BACKLOG
   Completed entry, and the CLAUDE.md rates.js/boq.js lines.

## 8. Verification (each step)

- `node --check frontend/js/*.js`.
- Headless Playwright on the static server (`python3 -m http.server` from `frontend/`).
  Everything here is client-side. Globals are bare names in `page.evaluate`.
- Fixture: a Demand project with 2 kiosks / 24 erven (6 of them 3-phase), 1 minisub,
  plan trenches on a calibrated floor. Check each basis, each starter line, the
  counted-once warning, P&G 8 % of total, and a CSV round trip. Enter a material and
  a labour rate on a cable with 5 % waste: labour = net m × labour rate, and
  material = net m × 1.05 × material rate.
- Old projects (no `rule` anywhere) must produce exactly the same bill as before, apart
  from the starter lines. Check this against a saved project from before the change.
