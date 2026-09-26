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
