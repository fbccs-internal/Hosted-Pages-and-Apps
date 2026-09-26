#!/usr/bin/env node
/**
 * v4 -> v5 report parity harness.
 *
 * Loads CheckinPallets_24_mg.html in real Chromium with the GitHub contents API
 * stubbed to return a real data.json, lets the app's own load() + migrateDb() run,
 * and then checks that nothing was lost in the conversion:
 *
 *   1. every v4 report converted to a v5 snapshot (no html / allocations left)
 *   2. the re-rendered report carries exactly the same table content as the
 *      stored v4 html -- cell for cell, after normalising the two known display
 *      differences (see NOTE below)
 *   3. allocationsFrom(snapshot) reproduces the stored v4 allocations[] exactly
 *   4. the resulting file is materially smaller
 *
 * NOTE on "identical": v5 moves styling out of inline style= attributes and into
 * one stylesheet, so the raw HTML strings are intentionally different. What must
 * match is the DATA -- every cell's text, in order. Two v4 rendering artifacts are
 * normalised away rather than silently tolerated:
 *   - "! missing" was v4's display for an empty material number
 *   - allocations[] row ORDER followed live roster order in v4 and follows the
 *     frozen name-sorted order in v5, so rows are compared as multisets
 *
 * Usage: node tools/verify-v5-parity.js [path/to/data.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..', 'CheckinPallets_24_mg.html');
const DATA = process.argv[2] || path.join(__dirname, 'data.json');

(async () => {
  if (!fs.existsSync(DATA)) {
    console.error(`No data.json at ${DATA}\nPass one: node tools/verify-v5-parity.js /path/to/data.json`);
    process.exit(2);
  }
  const raw = fs.readFileSync(DATA, 'utf8');
  const original = JSON.parse(raw);
  const originalReports = JSON.parse(JSON.stringify(original.reports || []));

  // Use whichever Chromium this machine already has rather than downloading one;
  // the npm playwright build and the preinstalled browser build often differ.
  const PREINSTALLED = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome']
    .filter(p => fs.existsSync(p));
  const browser = await chromium.launch(
    PREINSTALLED.length ? { executablePath: PREINSTALLED[0] } : {}
  );
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // Stub the contents API. GET returns the real file; any PUT is failed loudly --
  // the harness must never write anywhere.
  await page.route('**://api.github.com/**', route => {
    if (route.request().method() !== 'GET') {
      return route.fulfill({ status: 500, body: 'harness: writes are not allowed' });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        sha: 'harness',
        content: Buffer.from(raw, 'utf8').toString('base64'),
        encoding: 'base64'
      })
    });
  });

  // Ignore resource-load failures: on file:// the page's Google Fonts link cannot
  // resolve, which says nothing about the app logic under test.
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push('console: ' + t);
  });

  await page.goto('file://' + APP);
  // `let db` at script top level is not a window property, so probe it by scope.
  await page.waitForFunction(
    () => typeof db !== 'undefined' && db && db.version >= 5,
    { timeout: 15000 }
  ).catch(async () => {
    const state = await page.evaluate(() => ({
      hasDb: typeof db !== 'undefined',
      version: typeof db !== 'undefined' ? db.version : null,
      reports: typeof db !== 'undefined' ? (db.reports || []).length : null,
      hasMigrate: typeof migrateReportV4toV5 === 'function',
      hasRender: typeof renderReport === 'function'
    })).catch(e => ({ probeFailed: String(e) }));
    console.error('App never reached schema v5. State:', JSON.stringify(state, null, 2));
    if (errors.length) console.error('Errors:\n  ' + errors.join('\n  '));
    process.exit(1);
  });

  const result = await page.evaluate(originalReports => {
    const out = { checks: [], fail: 0 };
    const ok = (name, pass, detail) => {
      out.checks.push({ name, pass, detail });
      if (!pass) out.fail++;
    };

    // --- 1. schema ---------------------------------------------------------
    ok('db.version === 5', db.version === 5, `got ${db.version}`);
    const stragglers = db.reports.filter(r => r.html || r.allocations);
    ok('no report still carries html/allocations', stragglers.length === 0, `${stragglers.length} straggler(s)`);
    ok('every report has a snapshot', db.reports.every(r => r.snapshot),
      `${db.reports.filter(r => !r.snapshot).length} missing`);
    ok('report count preserved', db.reports.length === originalReports.length,
      `${originalReports.length} -> ${db.reports.length}`);

    // --- 2. table content parity -------------------------------------------
    // Pull [tableIndex][row][cell] text out of any report html, v4 or v5.
    const grid = html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      return [...doc.querySelectorAll('table')].map(t =>
        [...t.querySelectorAll('tr')].map(tr =>
          [...tr.querySelectorAll('th,td')].map(c => c.textContent.replace(/\s+/g, ' ').trim())));
    };
    // v4 printed the missing-material placeholder where the stored value was empty.
    const PLACEHOLDER = '⚠ missing';
    const norm = g => g.map(t => t.map(r => r.map(c => (c === PLACEHOLDER ? '' : c))));
    const headerOf = html => {
      const doc = new DOMParser().parseFromString(html, 'text/html');
      const h = doc.querySelector('.pr-header');
      return h ? h.textContent.replace(/\s+/g, ' ').trim() : '';
    };

    let gridMismatch = 0, headerMismatch = 0;
    const diffs = [];
    db.reports.forEach((r, i) => {
      const before = originalReports[i];
      const after = renderReport(r.snapshot, r);
      const gb = JSON.stringify(norm(grid(before.html)));
      const ga = JSON.stringify(norm(grid(after)));
      if (gb !== ga) {
        gridMismatch++;
        if (diffs.length < 3) {
          const b = JSON.parse(gb).flat(), a = JSON.parse(ga).flat();
          const row = b.findIndex((x, j) => JSON.stringify(x) !== JSON.stringify(a[j]));
          diffs.push(`${before.date} ${before.distName} row ${row}: v4=${JSON.stringify(b[row])} v5=${JSON.stringify(a[row])}`);
        }
      }
      if (headerOf(before.html) !== headerOf(after)) {
        headerMismatch++;
        if (diffs.length < 6) diffs.push(`${before.date} header: v4="${headerOf(before.html)}" v5="${headerOf(after)}"`);
      }
    });
    ok('every report re-renders the same table content', gridMismatch === 0,
      `${gridMismatch}/${db.reports.length} differ` + (diffs.length ? ' -- ' + diffs.join(' | ') : ''));
    ok('every report re-renders the same header line', headerMismatch === 0,
      `${headerMismatch}/${db.reports.length} differ` + (diffs.length ? ' -- ' + diffs.join(' | ') : ''));

    // --- 3. allocations parity ---------------------------------------------
    const SEP = '|~|';   // any separator that cannot occur inside a field
    const key = a => [a.agencyNum, a.materialNumber, a.description, a.qty, a.date].join(SEP);
    let allocMismatch = 0, allocRows = 0;
    const allocDiffs = [];
    db.reports.forEach((r, i) => {
      const derived = allocationsFrom(r.snapshot, r.date).map(key).sort();
      const stored = (originalReports[i].allocations || []).map(key).sort();
      allocRows += stored.length;
      if (JSON.stringify(derived) !== JSON.stringify(stored)) {
        allocMismatch++;
        if (allocDiffs.length < 3) {
          const only = (x, y) => x.filter(v => !y.includes(v)).slice(0, 2);
          allocDiffs.push(`${originalReports[i].date}: +${JSON.stringify(only(derived, stored))} -${JSON.stringify(only(stored, derived))}`);
        }
      }
    });
    ok(`allocations re-derive exactly (${allocRows} rows across all reports)`, allocMismatch === 0,
      `${allocMismatch}/${db.reports.length} differ` + (allocDiffs.length ? ' -- ' + allocDiffs.join(' | ') : ''));

    // --- 4. size -----------------------------------------------------------
    out.size = {
      before: JSON.stringify({ ...db, reports: originalReports }).length,
      after: JSON.stringify(db).length
    };
    return out;
  }, originalReports);

  await browser.close();

  const pad = s => (s.length > 62 ? s.slice(0, 59) + '...' : s.padEnd(62));
  console.log('\nv4 -> v5 PARITY\n' + '='.repeat(78));
  for (const c of result.checks) {
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${pad(c.name)}  ${c.pass ? '' : c.detail}`);
  }
  const { before, after } = result.size;
  console.log('-'.repeat(78));
  console.log(`  data.json   ${(before / 1024).toFixed(1)} KB  ->  ${(after / 1024).toFixed(1)} KB`
    + `   (${Math.round(100 - 100 * after / before)}% smaller, ${(before / after).toFixed(1)}x)`);
  const b64 = Math.ceil(after / 3) * 4;
  console.log(`  sync payload (base64)  ${(b64 / 1024).toFixed(1)} KB  =  ${(100 * b64 / 1048576).toFixed(1)}% of the 1 MB contents-API ceiling`);
  console.log('='.repeat(78));

  if (errors.length) {
    console.log('\nPage errors:');
    errors.forEach(e => console.log('  ' + e));
  }
  const failed = result.fail > 0 || errors.length > 0;
  console.log(failed ? '\nPARITY FAILED\n' : '\nPARITY OK -- v5 preserves every report exactly.\n');
  process.exit(failed ? 1 : 0);
})();
