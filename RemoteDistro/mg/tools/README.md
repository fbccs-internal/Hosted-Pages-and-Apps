# v5 verification harness

Two checks that run the real app in real Chromium against a real `data.json`.
Neither writes anywhere: the GitHub contents API is stubbed, and PUTs are recorded
rather than performed.

```bash
npm install playwright --no-save          # once
cp /path/to/data.json tools/data.json     # a real export; gitignored

node tools/verify-v5-parity.js            # nothing was lost in the v4 -> v5 conversion
node tools/verify-v5-behaviour.js         # v5 behaves, and cannot touch the live app's data
```

Both exit non-zero on failure, so they can gate a cutover.

## verify-v5-parity.js

Loads a v4 `data.json`, lets the app's own `load()` + `migrateDb()` convert it, then
checks every historical report survived:

- every report converted to a snapshot, with no `html` / `allocations` left behind
- the re-rendered report has the same table content as the stored v4 HTML, cell for cell
- `allocationsFrom(snapshot)` reproduces the stored v4 `allocations[]` exactly
- reports the size change

Two v4 rendering artifacts are normalised rather than silently tolerated, and both are
named in the script: the `⚠ missing` placeholder v4 printed for an empty material
number, and allocation row *order* (v4 followed live roster order; v5 follows the
frozen name-sorted order, so rows compare as multisets).

Styling moved out of inline `style=` attributes into one stylesheet, so the raw HTML
strings differ on purpose. What must match is the data.

## verify-v5-behaviour.js

Drives the live paths and the isolation guarantees:

- every write goes to `data-v5.json` and `fb_db_v5`; `data.json` and `fb_db` are never
  written (the run pre-seeds a sentinel into `fb_db` and asserts it survives)
- Close Week produces a snapshot with the lottery frozen to resolved names, and the
  snapshot does not change when an agency is renamed afterwards
- the report renders with zero inline styles, and the standalone download carries its
  own CSS
- a file from a newer schema is refused rather than overwritten

## verify-v6-migration.js

Checks the v5→v6 split, against the v6 app (`CheckinPallets_25_mg.html`).

```bash
node tools/verify-v6-migration.js
```

Runs two scenarios in one pass:

1. **v4 source** — serves the fixture at `data.json` so the v4 fallback in `SEED_SOURCES` is
   exercised for real, including the v4→v5 report conversion chained ahead of the v6 split.
2. **v5 source** — first runs the fixture through the v5 app to produce a genuine v5 file, then
   seeds v6 from that, and asserts both scenarios agree on schedules, agencies and counts.

Covers migration (every entity migrated, joins resolve, nothing orphaned, deterministic and
re-runnable), the view layer (the app's `db` façade still reads like v5 over split tables, and
writes land in the right table), file shape (no v4/v5 field names reach disk), isolation (v6
writes only under its own directory; `data.json`, `data-v5.json`, `fb_db` and `fb_db_v5` are
untouched), and write cost (a check-in dirties one table, not all of them).

Phase 2 additions to the same run: the `legacy.json` split (orders lifecycle, year-partitioned
archive, events-open holding no order draft on disk), the clipboard leaving the schema, the
shipment contract (warehouse vocabulary must not cross the wall; BIN→bin, CS→cases; pallets
carry the shipment id; Distribution can find its shipment without reading the order), and Close
Week's ordered write (archive appended and persisted before the open state is cleared).

## verify-v6-contrib.js

Pass-1 checks for the contributor's order-component work merged into v6 (45 checks):

```bash
node tools/verify-v6-contrib.js
```

Drives real entry points wherever possible — the seed button's handler, the order form's own
save path, Close Week the way a user reaches it (pick the date in the sidebar, open the
distribution, go to Settings, press Close Week) — because calling helpers directly is how the
phase-2 seed-button bug got past the migration suite. Covers the order-table translation layer,
special orders, week patterns, the siteCode join (and that `DIST_LOCATION_MAP` is never
consulted), Close Week's pattern-aware advance, qty-on-site, live sync being off, the surface UI,
that no local-deployment scaffolding survived, and write isolation.
