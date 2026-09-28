# Data inputs and outputs — v25 (schema v6)

Every way data gets into and out of `CheckinPallets_25_mg.html` + `order-form-v6.js`, for use as
a checklist when importing a clean slate and verifying what comes out. Checked against the code;
the traps at the end were reproduced in a browser against a stubbed GitHub API.

Data lives in `publicappdata/CheckinPallets/v6/` (tables: [SCHEMA.md §3, §6](SCHEMA.md)). Every
browser that opens the app also keeps a full copy in its localStorage (`fb_v6:*`).

**Bulk** = a file import or export in the app · **In the app** = typed or tapped · **File only** =
no screen for it; change the JSON directly · — = none

## Inputs

| Data | File | Bulk in | Bulk out | In the app | File only |
|---|---|---|---|---|---|
| **Sites** — code, name | `sites.json` | Import Schedule adds any code it hasn't seen | — | Add Special Order adds one. No edit or delete — but a special order that reuses a code under another name **renames** the site | Edit, delete, `area`, `provisional`; replacing `SITE-LOCAL-NN` placeholder codes |
| **Distributions** — name, day, week pattern | `schedules.json` | — | — | Add (name only), rename, day, week pattern, delete. Settings → Delete asks first; the × in Manage Distributions doesn't. A distribution with closed weeks is retired, not removed | `siteCode` and `id`: set once, at creation, from the town in the name. Renaming changes neither |
| **Agencies & rosters** — agency #, name, group, distribution, hidden | `agencies.json` | — | — | Add one at a time, edit, move, hide, delete. Deleting a distribution deletes its roster with it | An agency in more than one distribution: the file allows it, but the app lists it only under the first, and moving it drops the others |
| **Items** — material #, description | `items.json` | — (also grows by itself from every Send to Pallets and hand-added pallet) | — | Item Library: add (name + unique material #), rename, delete | Changing a material #; `altDescriptions`; `provisional` (free-text codes kept by the migration) |
| **Planned orders** — AOR #, site code, site name, date | `orders.json` · `planned` | **Import Schedule** (.xlsx/.csv; replaces the whole list; columns *No.*, *Sell-to Agency No.*, *Sell-to Agency Name*, *Shipment Date*) | — | Add Special Order. No edit or delete except by re-importing | — |
| **Draft order** — order #, location, lines (item #, pallet #, description, qty, unit) | `orders.json` · `draft` | **Import from Excel** (the Full Order Detail layout). Also takes location, date and order # from the file | **Export to Excel** (ERP allocation file); **Export Full Order Detail** | Lines: add, edit, clear; Copy / Paste Items between distributions (this browser only). Order #: from the schedule, or typed. Location: read-only, from the planned order or the distribution's site | — |
| **Pull actuals** — qty pulled, returned, used | on order lines | Import from Excel only | Full Order Detail; Download All Orders | — (no on-screen field) | — |
| **Saved orders** | `orders.json` · `saved` | — | **Download All Orders** (resets the export reminder) | Save or Print adds or updates one, matched by order # — with no order #, every save adds another. Delete one. *Clear Saved Orders* says "from this browser" but clears them from the shared file, for every device | — |
| **Shipments** | `shipments.json` | — | — | Written only by Send to Pallets; never edited | Viewing, correcting, deleting |
| **This week** — date, notes | `events-open.json` | Import from Excel (date) | in the week report | Settings tab; the order form's date; Close Week advances it | — |
| **Check-in, order pickup, lottery** | `events-open.json` | — | in the week report | Tap to check in, Clear All Check-ins, the order-pickup badge, Run Lottery | — |
| **Pallets** — description, material #, unit, count, done | `events-open.json` | Send to Pallets, from the order | in the week report | Add by hand, count, mark done, remove. A re-send updates them; Overwrite starts them over | — |
| **Closed weeks** | `events-<year>.json` | — | HTML copy downloaded at every Close Week; Reports → View / Print | Close Week adds one; delete one; never edited | Corrections |
| **Meta** — schema version, archive-year index, export stamp, migration notice | `meta.json` | — | — | *Got it* clears the migration notice | Everything else; system-managed |
| **Everything at once** | all files | **Pull from older stream**: migrates `data-v5.json` (or `data.json`) and replaces all v6 data. Test build only; gone at cutover | — (no whole-dataset export; the files and their git history are the backup) | — | — |
| **Built into the code** | the two source files | — | — | — | `V6_SITE_SEED` (15 sites); `V6_TOWN_TO_SITE` (town → site code; no El Sobrante); `DEFAULT_LOCATIONS` (15); `DEFAULT_ORDER_SCHEDULE` (99 orders, Aug 1 – Sep 30 2026); `produceItems` (66, the order form's item suggestions, separate from the Item Library); repo, folder and token; Ceres API (off). v25 never reads `DIST_LOCATION_MAP` |

## Outputs

| Output | From | Contents |
|---|---|---|
| `Allocation_<location>_<date>.xlsx` | Order Form → Export to Excel | The ERP allocation upload: *Agency No.* (the site code), *Item No.*, *Qty. to Allocate*, *Shipment Date*. Lines without an item # are left out |
| `DistributionOrder_<location>_<date>.xlsx` | App Settings → Export Full Order Detail | Location, Date, Order Number and every line field, pull actuals included. Import from Excel reads it back |
| `AllDistributionOrders_<date>.xlsx` | Order Form → More actions → Download All Orders | Every saved order, same columns |
| Printed order | Order Form → Print hard copy → Portrait / Landscape; More actions → Print Saved Orders | Hard copy of the order |
| `<distribution>_<date>.html` | Close Week (downloads by itself); Reports → View / Print; Print Report | Roster with check-ins and order pickups, lottery order, pallets with counts, done marks, per-agency share and leftover, notes |
| The data files | every save | What everything above is built from |

Not an output: each closed week's per-agency allocation rows (the CERES upload shape) are computed
from its snapshot, but the Reports list only shows how many there are; nothing exports them.

## Traps

1. **Every browser that has used v25 holds a full copy of the data.** Opened against an emptied
   folder, it shows that copy, and its first save — one check-in tap is enough — writes it all
   back: 16 sites, 51 agencies, 80 items, 15 distribution records, 22 orders and the open week,
   plus the year's archive file, recreated empty.
2. **A file the import leaves out is filled from the cache.** With `events-open.json` missing, a
   cached browser showed last week's check-ins, then wrote that file back on its next edit.
3. **No planned orders means the built-in Aug–Sep schedule.** The order form falls back to it, and
   the first special order writes all 99 of those orders into `orders.json`, with a site for each
   of their 12 codes.
4. **No sites means the built-in location list.** The first time the order form adds a site — a
   special order with a new code, for one — it writes all 15 `DEFAULT_LOCATIONS` into `sites.json`
   along with it.
5. **A distribution's site is fixed when it is created**, from the town in its name. A town not in
   `V6_TOWN_TO_SITE` (El Sobrante, for one) gets a placeholder `SITE-LOCAL-NN`, and no screen can
   change it.
6. **A special order that reuses a site code under another name renames that site**, silently.
7. **Import from Excel can move a draft to another site.** A file whose Location is another site
   repoints the draft there and sets the distribution's date from the file — in the test,
   Wednesday Fairfield's draft became Concord's. The next export and shipment then carry the
   wrong site code. (The migration notice lists drafts already in that state.)

## Import checklist

- [ ] Clear this site's data in every browser that has opened v25 (1, 2), or change `LS_PREFIX`
- [ ] Write every file, empty ones included: `meta`, `sites`, `agencies`, `items`, `schedules`,
      `orders`, `shipments` (`[]`), `events-open` (`{}`), and one `events-<year>` per year listed in
      `meta.archiveYears` (2)
- [ ] `meta.version` is `6`
- [ ] Planned orders loaded — Import Schedule, or `planned` rows in `orders.json` (3)
- [ ] Every site the schedules and orders use is in `sites.json`, with its real code (4, 5)
- [ ] Every `schedules[].siteCode` is in `sites`
- [ ] Every `agencies[].scheduleIds[]` is in `schedules` — one each, while the app shows only one
- [ ] Every `orders[].siteCode` is in `sites`, and every draft's matches its distribution's (7);
      every draft's `scheduleId` is in `schedules`
- [ ] Every `events-open` key is a schedule id; every closed week's `scheduleId` is in `schedules`,
      retired ones included
- [ ] Then, in the app: open each distribution, check its roster and the order form's location,
      run one order through Export to Excel, and compare against the ERP
