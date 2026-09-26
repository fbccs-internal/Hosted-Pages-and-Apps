# CheckinPallets v2 — Hosting Request

## What this is
An updated, tested version of the Food Bank distribution/check-in/pallets app
(the "v2" copy). It's been built and tested extensively, but has only been
run locally as a double-clicked file so far — which has confirmed a real
limitation: browsers block local (`file://`) pages from triggering their own
file downloads. That's why Export to Excel / Export Data currently do
nothing when tested this way. This is a browser security restriction, not a
bug in the app.

## What's needed
Host these two files together, at any URL — a subfolder alongside the
existing production app on GitHub Pages would be the simplest option
(e.g. `RemoteDistro/mg/v2/`):

- `CheckinPallets_23_v2.html`
- `order-form_v2.js`

Both files must sit in the **same folder** as each other. No build step, no
server-side code, no database — it's a static two-file app, same as the
production one this is based on.

## Why this fixes the download issue
Once the app is reachable at a real `https://` address instead of opened as
a local file, the browser no longer applies the local-file download
restriction, and the Export to Excel / Export Data / Import Data buttons
should all work immediately — no code changes needed on our end.

## Isolation from production — confirmed safe
This is a completely separate, self-contained copy:
- Uses its own browser storage key (`fb_db_v2`, vs production's `fb_db`) —
  cannot read or overwrite production's saved data.
- Remote sync (the GitHub-based cross-device backup feature) is fully
  disabled in this version — it only saves to the browser it's opened in.
- No credentials or tokens of any kind are embedded in either file.

## After hosting
Once it's live at a URL, we'll test the Export/Download features there to
confirm they work as expected, and go from there.
