# Data schema — v6 normalization

**Status:** phases 1 and 2 implemented in `CheckinPallets_25_mg.html` + `order-form-v6.js`.
**Applies to:** `CheckinPallets_25_mg.html` (v6) onward. v23/v4 and v24/v5 are unaffected.

---

## 1. Why

The app is two applications that were merged: an **Order** half (`order-form.js`, `OF.html`)
and a **Distribution** half (`CheckinPallets_*.html`). They were built independently, describe
the same real-world things, and disagree about what those things are called and how they are
identified.

| Entity | Order half | Distribution half | Real identity |
|---|---|---|---|
| **Site** | `{name, code:'PEDI-S2002'}` in `locationsList`, flattened to the string `"Perish Dist: Fairfield - PEDI-S2002"` | *half of a display name* — "**Fairfield** Tuesday" — under a random uid `1775239971741z7x6` | CERES code `PEDI-S2002` |
| **Item** | `{itemNum, description}` | `{materialNumber, desc}` and `itemLibrary{materialNumber, name}` | material number `APPL-D003` |
| **Schedule** | `orderSchedule[{code, date, orderNumber}]` | `dayOfWeek` + a rolling `date` | site × date |

The Distribution half never had a site concept — it baked the site into a display name. The
Order half never had a roster concept. The bridge is `DIST_LOCATION_MAP` (`order-form.js:8`):
six hardcoded name→site pairs.

### What is already broken in production data

Observed in a real `data.json` export (2026-09-15), not hypothetical:

- **`DIST_LOCATION_MAP` covers 3 of 14 distributions.** The v3 migration renamed
  "Day Location" → "Location Day"; new distributions were then created in the old
  "Day Location" style. `deriveLocationFromDist()` silently returns `''` for eleven of them —
  `"Wednesday Fairfield"` is not a key, `"Fairfield Wednesday"` is.
- **9 of 15 reports are orphaned.** `distId 1775239956014qjkz` no longer exists. They survive
  only because v5 denormalizes them.
- **Three duplicate distribution pairs** from that rename. Only 3 of 14 distributions have any
  roster; 11 are empty shells.
- **13 of 15 `orderLog` entries have a blank `orderNumber`.** The dedupe at `order-form.js:573`
  is guarded by `if (orderNumber)`, so blank-numbered orders never dedupe — hence 10 identical
  Concord rows for 2026-09-15.
- **11 item codes carry conflicting descriptions** across the halves. `APPL-D003` is "APPLES"
  in the order form and "APPLES - BULK - BIN/TOTE" in pallets.
- `itemLibrary` holds junk keys next to real material numbers: `'1 Pallet'`, `'2 pallet'`.

### What this refactor is and isn't

It is **not** primarily a size win — v5 already took the file from 472 KB to 78 KB. The wins are:

1. the Order↔Distribution join actually existing, instead of a hardcoded name map;
2. write amplification (see §6);
3. referential integrity, so reports stop being orphaned;
4. a real seam between the two halves, so they can be pulled apart later without surgery.

---

## 2. Two buildings

Order and Distribution are **two separate activities in two separate places**, and the schema
should treat them that way even while they ship as one page.

> Food is pulled and loaded onto a truck at the warehouse. The truck arrives at a site. The
> food is allocated among the agencies who showed up.

- **Order** is warehouse-side. What to pull, how much, in what units, what was actually pulled,
  what came back. Its output is *a truckload leaving for a site on a date*.
- **Distribution** is site-side. Who showed up, in what pick order, how the load gets split.
  Its input is *a truckload arriving*.

Today the seam between them is `mapOrderItemsToPallets()` — an in-memory function that copies
order rows into `d.pallets`, dropping `qtyPulled`, `returned` and `used` on the way. That is a
doorway cut through a shared wall, not an interface.

The target is that **each half owns its own tables and neither reads the other's.** They meet at
one narrow, stable contract (§5). Either half could become its own app against the same backend
without a schema change.

This constraint is why phase 1 (§8) builds table *ownership* into the storage layer from the
start, even though the tables that need separating don't split until phase 2.

---

## 3. Entity model

Natural keys throughout for master data. These entities already have stable external identities
in CERES; using them is what removes the need for a bridge map, and it makes the files diffable
in git — which matters when the backend *is* git.

### Master data — slow-changing, human-curated

```jsonc
// sites.json — PK: code
{ "code": "PEDI-S2002", "name": "Perish Dist: Fairfield", "area": "S2", "active": true }

// agencies.json — PK: code
{ "code": "CAMI-S1001", "name": "CAMINAR: GATEWAY", "group": "Caminar",
  "scheduleIds": ["PEDI-S2002-WED"], "active": true, "legacyId": "1775242009388snvd" }

// items.json — PK: materialNumber
{ "materialNumber": "APPL-D003",
  "description": "APPLES - BULK - BIN/TOTE",
  "altDescriptions": ["APPLES"],
  "defaultUnit": "BIN",
  "active": true }
```

`area` is the letter+digit of the code suffix (`S2` = Fairfield area, `C3` = East County) and is
a **hint only** — Fairfield's roster contains S1, S2 and S3 agencies. Membership is always
explicit, never derived from the code.

### Configuration

```jsonc
// schedules.json — PK: id
{ "id": "PEDI-S2002-WED",
  "siteCode": "PEDI-S2002",
  "dayOfWeek": 3,
  "cadence": "all",             // "all" | "1st3rd" | "2nd4th" — the contributor's vocabulary
  "label": "Fairfield Wednesday",
  "active": true }
```

**The roster is a schedule-level fact, not a site-level one.** Fairfield Tuesday (19 agencies)
and Fairfield Wednesday (17 agencies) share **zero** agencies — verified against the live
export. An agency attending two days at one site belongs to both schedules, which is correct
and impossible to express today.

**Revised during implementation:** the join is stored as `agencies[].scheduleIds`, not
`schedules[].agencyCodes`. Same normalization, better write locality — adding an agency or
changing its assignment then writes `agencies.json` alone, where the other direction would have
written two files and broken the one-action-one-file rule (§6) on a routine admin action. It is
also a direct generalization of the existing `masterAgencies[].distId`, so the migration is a
widening rather than a restructure.

This replaces `distributions` as the recurring definition.

### Transactional

```jsonc
// orders.json — PK: id — OWNED BY ORDER
{ "id": "ord-2026-09-15-PEDI-C2002-01",
  "orderNumber": "AOR218283",            // may be blank; never the PK
  "siteCode": "PEDI-C2002",
  "date": "2026-09-15",
  "status": "planned",                   // planned -> draft -> saved -> dispatched
  "lines": [ { "materialNumber": "BREA-D001", "palletNum": "",
               "needToPull": "6", "pullUnit": "CS",
               "qtyPulled": "", "returned": "", "used": "" } ],
  "savedAt": "2026-09-11T22:48:23.989Z" }

// events-*.json — PK: id — OWNED BY DISTRIBUTION
{ "id": "PEDI-S2002@2026-08-26",
  "scheduleId": "PEDI-S2002-WED",
  "siteCode": "PEDI-S2002",
  "date": "2026-08-26",
  "status": "open",                      // open -> closed
  "shipmentId": "shp-...",               // what arrived; null if none
  "checkedIn": ["CAMI-S1001", "..."],
  "pallets": [ { "materialNumber": "APPL-D003", "desc": "...",
                 "qty": 0,            // counted on site; 0 until the coordinator counts
                 "plannedQty": 20.73, // the manifest amount, carried as the head start
                 "unit": "units", "done": true, "shipmentId": "shp-..." } ],
  "lottery": [ { "num": "CAMI-S1001", "name": "...", "late": 1 } ],
  "notes": "",
  "closedAt": null,
  "snapshot": null }                     // frozen at close; the v5 report structure
```

Two consolidations:

**`orders` absorbs three current structures.** `orderSchedule` (the AOR calendar) becomes rows
with `status:'planned'`; `distributions[].orderForm` (the live draft) becomes `'draft'`;
`orderLog` becomes `'saved'`. One lifecycle, one table.

**`events` absorbs `distributions`' live state and `reports`.** A v5 report is just a closed
event. `status:'open'` holds the working state that Close Week currently wipes; `'closed'`
carries the frozen snapshot with all names denormalized. The orphaned-report problem disappears,
because a closed event is self-contained by construction.

`copiedItems` stops being synced — it is a UI clipboard, not domain data. localStorage only.
That removes 5.7 KB from every sync for free.

---

## 4. Identity rules

| Table | Key | Notes |
|---|---|---|
| `sites` | `code` | CERES code. Missing ones get a provisional `SITE-LOCAL-nn` (§7). |
| `agencies` | `code` | CERES code. Blank-num agencies get `AGCY-LOCAL-nn`. |
| `items` | `materialNumber` | Junk keys are flagged, not silently dropped. |
| `schedules` | `siteCode` + day mnemonic | Readable and stable: `PEDI-S2002-WED`. |
| `orders` | synthetic `id` | **Not `orderNumber`** — 13 of 15 real rows have it blank. |
| `events` | `siteCode@date` | Assumes one distribution per site per date. |

---

## 5. The Order → Distribution interface

The contract between the two buildings is a **shipment**: the manifest of what physically went
on the truck. Order writes it. Distribution reads it. Neither touches the other's tables.

```jsonc
// shipments.json — WRITTEN BY ORDER, READ BY DISTRIBUTION
{ "id": "shp-2026-09-15-PEDI-S2002",
  "siteCode": "PEDI-S2002",
  "date": "2026-09-15",
  "sourceOrderId": "ord-2026-09-15-PEDI-S2002-01",  // opaque to Distribution
  "dispatchedAt": "2026-09-15T14:02:11.000Z",
  "lines": [ { "materialNumber": "APPL-D003",
               "description": "APPLES - BULK - BIN/TOTE",
               "qty": 20.73, "unit": "units" } ] }
```

The contract is deliberately narrow. Distribution needs to know *what arrived*, not how it was
picked. `needToPull` / `pullUnit` / `qtyPulled` / `returned` / `used` are warehouse vocabulary
and stay on the Order side of the wall. `sourceOrderId` is a back-reference Distribution stores
and never interprets.

A shipment is **immutable once dispatched.** Re-dispatching creates a new shipment; the event
points at the newest. This is what lets the two halves diverge safely.

**A re-dispatch updates the pallets; it doesn't replace them** (`reconcilePallets()`). The
coordinator may already have counted, marked pallets done, or added pallets by hand, and a
corrected order must not undo that work:

- A manifest line that matches an existing pallet keeps that pallet's `id`, counted `qty` and
  done mark. Only the order-side fields are refreshed: `desc`, `materialNumber`, `plannedQty`,
  `shipmentId`, `sourcePalletNum`.
- *Match* means the same material number (case-insensitive) when either side has one, otherwise
  the same description, **and the same unit.** A count only means something in its unit, so 12
  cases of bread is not carried onto a bread bin.
- A manifest line with no match becomes a new pallet, uncounted.
- A pallet with no matching line is left exactly as it is, including pallets added by hand.

**Overwrite** is an explicit opt-out, unchecked by default. It starts the pallets over from the
current order: exactly its lines, uncounted, nothing done, hand-added pallets gone. The send
dialog previews either outcome with the same functions the send runs (`shipmentLinesFrom()`,
`palletsFromShipment()`, `reconcilePallets()`), recording nothing. So the counts it shows are
what the send will do.

The shipment is dated from the draft order, and the draft's `date` follows the distribution's
(`orderFormFor()`). The order form edits the distribution's date directly, so the draft's copy
used to go stale after the first Close Week and shipments carried the draft's creation date.

**Direction is one-way for now.** Distribution records its own actuals (`pallets[].qty`,
per-agency allocation, leftover) on the event. Reconciling those back to the warehouse would
join `events → shipments` on `shipmentId`; there is no return-channel table yet, and adding one
does not disturb this contract. Noting the attachment point now so it isn't surgery later.

This replaces `mapOrderItemsToPallets()`, which is lossy and couples the two halves directly.

**Manifest quantity is a head start, not a count.** `palletsFromShipment()` puts the manifest
line quantity in `plannedQty` and sets `qty` to 0. The coordinator at the site is the first
person positioned to know the real case count: the ERP's per-pallet case counts can't be
trusted, and substitutions happen at fulfillment. Allocation divides `qty`, so nothing allocates
until counted; the count dialog shows `plannedQty` as its placeholder, so the usual case is
confirming a number rather than typing one. (Contributed with the v2 order-component work.)

---

## 6. Files, ownership, and sync

```
CheckinPallets/v6/
  meta.json            schema version, migration notices     rare
  sites.json           ~1 KB                                 rare
  agencies.json        ~5 KB                                 rare
  items.json           ~6 KB                                 occasional, append-only
  schedules.json       ~4 KB                                 rare
  orders.json          ~25 KB                                per order edit
  shipments.json       ~10 KB                                per dispatch
  events-open.json     ~3 KB   ← live working state          every few seconds
  events-<year>.json   ~25 KB  ← closed history              once per Close Week
```

### Ownership

| File | Order | Distribution |
|---|---|---|
| `sites`, `schedules` | read | read (`schedules` write: add/rename/remove) |
| `agencies` | read | **read / write** (records, and roster via `scheduleIds`) |
| `items` | read / append | read / append |
| `orders` | **read / write** | — |
| `shipments` | **write** | read |
| `events-*` | — | **read / write** |

No file is written by both halves except `items`, where writes are append-only — a new material
number seen for the first time. Appends are commutative: on a 409, re-read and re-append.

### Hot / cold split

This is the single highest-value split. Today, toggling one check-in re-uploads the entire
78 KB db (~104 KB base64). After, it re-uploads `events-open.json` alone (~3 KB). That is
roughly a **35x cut on the hot path**, which is what will actually be felt on a phone in a
parking lot.

### Atomicity

There is no cross-file transaction on the GitHub contents API, so:

**Every user action must write exactly one file.** A well-normalized schema makes this natural —
check-in touches only `events-open.json`; roster editing touches only `schedules.json`.

The one action that inherently spans files is **Close Week**, which moves an event from open to
archive. It must write in this order:

1. append the closed event to `events-<year>.json`
2. only then remove it from `events-open.json`

A failure between the two leaves a duplicate, which is recoverable. The reverse order loses a
week of work. Migration and startup should both tolerate and de-duplicate that state.

Each file also carries its own `sha`, so conflicts become per-table instead of global, and the
1 MB contents-API ceiling stops being a shared budget.

---

## 7. Migration — reconciling both halves

Must run from **either half's data**, be idempotent, and be re-runnable. Order matters:

**1. `sites`** — union of `DEFAULT_LOCATIONS` (15 authoritative codes), any user-added
`locationsList`, codes parsed from the ` - CODE` suffix of `orderLog[].location`, and site names
inferred from distribution names. Sites with no known code (El Sobrante has none;
"Thursday VACAVILLE 2nd / 4th weeks" maps to `PEDI-S3003`) get a provisional
`SITE-LOCAL-nn` code and are flagged in `meta.migrationNotice` for a human to correct.
*Real codes to be supplied later; filler until then.*

**2. `agencies`** — from `masterAgencies`, keyed by `num`. `distId` moves to
`schedules.agencyCodes`; `hidden` becomes `active:false`.

**3. `items`** — union of `itemLibrary` ∪ `orderLog` line codes ∪ pallet `materialNumber`s ∪
`PRODUCE_ITEMS`. On a description conflict, **the longest description wins** and the others are
preserved in `altDescriptions[]`. Nothing is lost; a canonical list can be imported later. Junk
keys (`'1 Pallet'`) are migrated but flagged.

**4. `schedules`** — from `distributions`, matched to sites by name. Duplicate pairs from the v3
rename are **left as-is**; they are junk to be cleaned manually or truncated on a fresh start,
and merging them automatically risks picking the wrong survivor. Every live distribution
migrates `active: true`, including ones whose roster hasn't been entered yet — see §3 for what
`active` means.

**5. `orders`** — from `orderLog` + `orderSchedule` + every `distributions[].orderForm`. Parse
`location` → `siteCode` from the ` - CODE` suffix. Mint synthetic ids for the 13 blank order
numbers. **Collapse exact-duplicate empty orders** on `(siteCode, date, itemsHash)` — the 10
Concord rows are test residue.

**6. `events`** — from v5 report snapshots plus current live distribution state. Orphaned reports
resolve by normalizing `distName`: both "Fairfield Wednesday" and "Wednesday Fairfield" map to
site `PEDI-S2002` + Wednesday, matching a migrated schedule or creating one.

**7. `shipments`** — none exist historically. Back-fill is not attempted; shipments begin with
the first dispatch under v6.

Migration reuses the existing `migrationNotice` mechanism (`showMigrationNoticeIfAny`), which was
built for exactly this and already survives a round trip.

---

## 8. Phasing

**Phase 1 — storage layer + master data** — *shipped in `CheckinPallets_25_mg.html`*

- `Store`: per-table load, per-table `sha`, per-table dirty state, and table ownership declared
  per bounded context. Dirtiness is decided by **hashing each serialized table** rather than by
  asking every mutation site to declare itself — so `save()` stays one call, as in v5, while
  only the files that actually changed are uploaded.
- `sites`, `agencies`, `items`, `schedules` split out and migrated from either a v4 or v5 source.
- `orders` and `events` stay together in `legacy.json` (`{events, reports, orderLog,
  orderSchedule, copiedItems}`), so no phase-1 user action has to write two files.

**Phase 1 changes where data lives, not how the app reads it.** A view layer binds the app's
existing `db` shape to the split tables: `db.masterAgencies` *is* the agencies table, and each
row carries its v4/v5 field names (`num`, `distId`, `hidden`, `id`) as **non-enumerable**
accessors over the v6 fields. Non-enumerable is what matters — `JSON.stringify` skips them, so
the files on disk hold only the v6 shape while ~65 existing call sites keep working unchanged.
A distribution view is the event object with its schedule's fields layered on as write-through
accessors, so `d.checkedIn = []` lands in `legacy.json` and `d.name = 'x'` lands in
`schedules.json` — the one-action-one-file rule holds by construction rather than by discipline.
Phase 2 moves the in-memory model onto the tables and this layer goes away.

Two behaviours worth knowing:

- **`archivedOnly` schedules.** Reports whose distribution was deleted get a schedule of their
  own so the foreign key resolves, marked `archivedOnly` and excluded from the distribution
  list. Without that flag, migrating would resurrect deleted distributions in the sidebar.
- **`active` means one thing: live, as opposed to former.** A former distribution stays in
  `schedules.json` (`active: false`, `archivedOnly: true`) only so its closed weeks still have
  something to join to. It is not a feature flag and nothing in the UI reads it. Deleting a
  distribution in the app therefore *retires* it if any closed week refers to it, and removes it
  outright only if nothing does; records already retired are never touched. (Corrected after
  pass 1: phase 1 set `active` from "has a roster", which marked eleven live distributions
  inactive, and the delete path removed every archive-only record on any add or delete —
  orphaning their reports — as well as the history of whatever was deleted.)
- **The migration owns its input.** `migrateToV6` deep-copies the source before building
  tables. Without it the tables alias the source db, the app's first mutation reaches back into
  it, and a second run on the "same" source produces something different.

**Phase 2 — transactional split** — *shipped*

- `legacy.json` split into `orders.json`, `shipments.json`, `events-open.json` and
  `events-<year>.json`. Closed events are partitioned by year, indexed by `meta.archiveYears`
  so load needs no directory listing.
- `mapOrderItemsToPallets()` replaced by the shipment contract (§5): `dispatchShipment()` on
  the Order side, `palletsFromShipment()` on the Distribution side.
- Hot/cold separation: **a check-in rewrites `events-open.json` alone, 4.6 KB** — against
  59 KB in phase 1 and 78 KB for the v5 single file. 37.5 KB of frozen archive stopped moving.
- `copiedItems` left the schema entirely; the paste clipboard is per-browser localStorage.
- **v6 has its own copy of the order form**, `order-form-v6.js`. `order-form.js` is shared by
  v23 and v24, both in active use, so it is untouched — `DIST_LOCATION_MAP` still lives there
  and still serves them. v6 simply stops consulting it: `deriveLocationFromDist()` reads
  `dist.siteCode` from the schedule, falling back to the old map only when no siteCode exists.

Nothing was deleted to do this. `mapOrderItemsToPallets()` stays in place, marked superseded
and unreferenced; `order-form.js` and every earlier app file stay exactly as they were.

**Phase 3 — decoupling** *(optional, enabled by the above)*

- Either half can be served as its own page against the same backend.
- Retire the view layer: move the app's in-memory model onto the tables and drop the aliases.
- A return channel from Distribution actuals to warehouse reconciliation (§5).

### Parallel run

Same isolation pattern as v5, generalized from two literals to a base path and key prefix:

```js
const DATA_DIR   = 'CheckinPallets/v6/';   // <<< CUTOVER
const LS_PREFIX  = 'fb_v6:';               // <<< CUTOVER
const SCHEMA_VERSION = 6;
```

New app file `CheckinPallets_25_mg.html`, seeded read-only from v5's `data-v5.json` with a v4
`data.json` fallback so it works whichever PR has landed. Three streams — `_23`/`data.json`,
`_24`/`data-v5.json`, `_25`/`v6/` — none able to write to another's storage.

---

## 9. Decisions on record

| Question | Decision |
|---|---|
| Site codes not in `DEFAULT_LOCATIONS` | Provisional filler codes; real ones supplied later |
| Item description conflicts | Longest wins, others kept in `altDescriptions[]`; canonical list later |
| Duplicate distributions | Leave them; covered by a separate data-integrity pass sourced from the ERP |
| `active` / inactive | Live vs former only — former kept so archive data has something to join to |
| Duplicate empty orders | Collapse — test residue |
| Scope | Option B: incremental, master data first |
| Roster attaches to | **Schedule** (site × day), not site — rosters differ by day at the same site |
| Order/Distribution coupling | Two bounded contexts, one narrow shipment contract |
| Order → pallets timing | Explicit dispatch only — **no live sync** (ontologically wrong, and it would write the remote file on every order-form keystroke) |
| Pallet quantity | `qty` counted on site, starts at 0 — no pre-fill; manifest amount kept as `plannedQty` |
| Re-sending an order to pallets | Reconcile (§5): matched pallets keep id, count and done mark; new lines arrive uncounted; pallets not on the order are left as they are |
| Restarting the pallet flow | Explicit **Overwrite** in the send dialog, unchecked by default |
| Week patterns | Contributor's `all` / `1st3rd` / `2nd4th`, stored as `schedule.cadence` |
| One-off ("special") orders | Existing machinery — a site plus a planned order; no special type |
| App as system of record | **No.** The ERP is the source of truth; the app is a working clipboard |

## 10. Open items

- Real CERES codes for sites currently on filler codes.
- Canonical item description list, to replace the longest-wins heuristic.
- Whether `cadence` needs richer expression than `all` / `1st3rd` / `2nd4th`.
- Return channel from Distribution actuals back to warehouse reconciliation (§5) — attachment
  point identified, not designed.
- `events-<year>.json` will need splitting again if a year's history outgrows the ceiling; not a
  concern at current volume (~15 events/year/site).

---

## 11. Contributor merge — order-component v2

A contributor extended the order component from `CheckinPallets_23` + `order-form.js`. Their files
are kept verbatim in `incoming/` as the reviewable baseline. Merged into the v6 line
(`CheckinPallets_25_mg.html`, `order-form-v6.js`) by three-way merge — base `_23`, ours `_25`,
theirs `v2` — so that "only they touched it" (splice in) and "both sides touched it" (needs a
decision) were decided mechanically rather than by judgment. The order form merged with zero
conflicts; the app with nine, all in regions v6 had already replaced.

### Pass 1 — merged

**Surface UI, taken as-is:** mobile sidebar (hamburger, backdrop, show-all), sidebar schedule-date
filter, App Settings modal (the four admin actions moved out of the sidebar footer), print menu
with orientation, pallet-row redesign, clear-all check-ins, pick-order toggle, special-order modal,
order-number auto-match, full order-detail export.

**Rewired onto v6's joins:**
- `getScheduledDistsForDate` — their chain went date → AOR calendar → site code → reverse lookup
  through `DIST_LOCATION_MAP` → distribution *names*. The map covers 3 of 14 distributions, so it
  returned nothing for eleven. Now a filter on `schedule.siteCode`; same semantics otherwise.
- `d.weekPattern` → an alias onto `schedule.cadence`, so every call site works unchanged.
- `SEED_DOW` / `SEED_WEEK_PATTERN` → derived from the label (`dowFromLabel`, `cadenceFromLabel`).
  Their seed was keyed `'Thursday Vacaville'`; the real distribution is `'Thursday VACAVILLE
  2nd / 4th weeks'`, so an exact-name seed would have missed it.
- The qty-on-site affordance, which landed in `mapOrderItemsToPallets` — no longer v6's send
  path — ported to `palletsFromShipment` where the logic now lives.

**Not taken:** their local-file deployment scaffolding — `fb_db_v2`, disabled sync, JSON
export/import/reset, the debug panel and `traceV2`. v6 keeps its remote sync architecture.

**Bugs found and fixed along the way** — the first two were already on `main`:
1. *The order tables' projections broke under the order form's copy pattern* (phase 2). The order
   form loads with `.map(o => ({...o}))`; a spread drops non-enumerable aliases, so schedule
   entries lost `code`/`name`, saved orders lost `location`, and every save wrote `items` next to
   `lines`. Rebuilt as a translation layer: `toScheduleEntry` / `toLogEntry` hand out plain copies
   in the order form's shape, and `syncOrders` rebuilds clean rows field by field.
2. *The seed button reported failure after succeeding* (phase 2). Its summary read the `legacy`
   table phase 2 removed; it now counts `allClosedEvents()`.
3. *Close Week's date advance was silently undone* — also in production v23. Switching tabs
   flushes the order form, whose `saveData` writes its date input back onto the distribution; the
   input still held the pre-close date. Fixed in v25 by syncing the input first. v23 not touched.
4. *The first sidebar render threw on a fresh load.* Their init renders synchronously after
   `load()`; v6's load is async. `db` is now bound over empty tables immediately.
5. *The order form cached its tables once at `init()`*, before v6's async pull landed. Added
   `OrderForm.refresh()`, called whenever the host rebinds `db`.

### Pass 2 — merged

Decisions, in review: pallets not on a re-sent order are **left as they are**; counts **stay
blank** until counted on site; re-sending **reconciles**, with an **Overwrite** option, unchecked
by default, to restart the pallet flow from the current order.

- **Re-send reconciliation** — the rules are in §5. The contributor's idea was right: match on
  material number, fall back to description, keep the pallet's id so its done mark survives.
  But their `autoSyncOrderFormToPallets` took every field *except* the id from the fresh
  pallet, so it kept done marks and reset every count to 0. With counts now starting at 0, each
  re-save of the order would have wiped them. It also dropped every pallet not on the new order,
  including ones added by hand. Their live trigger stays out (decided); the reconciliation now
  runs on the explicit send. That replaces v6's *Replace all* / *Append instead* choice. *Replace
  all* discarded counts and done marks; *Append instead* added every order line again, so
  pallets already sent appeared twice.
- **One action, one question.** The send dialog is *Update pallets from order?* It shows how many
  pallets are kept, new, and left alone, plus an unchecked **Overwrite** box. Checking it turns
  the button red and relabels it *Start over*. A first send, with no pallets yet, is unchanged:
  *Send to Pallets?* / *Add to Pallets*.
- **Blank count kept.** `qty` starts at 0 with `plannedQty` as the placeholder, no pre-fill.
  Allocation divides `qty`, so nothing is allocated from an ERP number nobody on site confirmed.
- **Unit is part of the match** (new; not in the contributor's key). A count carried across a
  unit change would be a number in the wrong unit, so a line that changes unit arrives as a new,
  uncounted pallet, and the old one is left alone.
- **Preview can't disagree with the send.** The dialog used to count through the superseded
  `mapOrderItemsToPallets`. It now previews through the send's own functions. The pure half of
  `dispatchShipment` was split out as `shipmentLinesFrom()` so the preview records no shipment.
  `mapOrderItemsToPallets` is no longer called by v6; it stays in the file, unremoved.

**Bug found and fixed** — on `main` since phase 2:

6. *Shipments were dated from the draft order's creation date.* Close Week recycles the draft for
   the next week but never moved its date, and dispatch dates the shipment from the draft. So
   after a distribution's first Close Week, every shipment carried the stale date: Sep 15 for the
   Oct 13 week in the test. Nothing on screen showed it: reports join on `shipmentId`, and
   nothing reads shipments by date yet (`shipmentsFor()` is unused). But the stored manifest was
   wrong, and so was its id, which embeds the date. Pass 1's notes called the stale draft date
   harmless; that was wrong. `orderFormFor()` now keeps the draft's date in step with the
   distribution.

**Checks** (`tools/verify-v6-contrib.js` §L) go through the real dialog and the real count and
done controls: a first send; coordinator work (a count, a done mark, a hand-added pallet); a
changed order; the preview against the outcome; shipment immutability; a unit change; Overwrite;
dates. 23 checks. 14 of them fail against the pre-pass-2 app.

### Still open — parked, not pass 2

- **One-off distributions.** A special order creates the order half (site + planned order); the
  distribution half is still "add a distribution". One action for both, if wanted.
- **Data integrity — a separate pass, sourced from the ERP.** Covers the three duplicate v3
  pairs (Monday Vallejo, Tuesday Fairfield, Thursday Vallejo — all created in one sitting on
  Sep 14 next to populated "Location Day" originals, and now both visible on the sidebar date
  filter), Wednesday Fairfield's roster (lost when the original distribution was deleted; still
  recoverable from the Sep 2 report snapshot), the seven distributions still awaiting rosters,
  and the placeholder El Sobrante site code. Deleting a distribution also deletes its roster
  with no confirmation — relevant to anyone cleaning up the duplicates by hand.
- Deferred by the ontology discussion: whether per-agency allocations are ever reported
  (currently the movement is to the distribution), returns (weighed at the warehouse, not
  recorded here), and the ERP import shape of the order export.
