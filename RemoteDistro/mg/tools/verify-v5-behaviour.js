#!/usr/bin/env node
/**
 * v5 behaviour + parallel-run isolation checks.
 *
 * Complements verify-v5-parity.js (which proves the historical reports survive the
 * conversion). This one drives the live paths in a real browser and proves the
 * things that would actually hurt if they were wrong:
 *
 *   A. isolation  - every write goes to data-v5.json and the v5 localStorage key;
 *                   data.json and 'fb_db' are never written, ever
 *   B. close week - produces a v5 report carrying a snapshot and a frozen lottery,
 *                   and no stored html
 *   C. render     - the report renders, and the standalone download carries its own
 *                   styling so it stands up outside the app
 *   D. guard      - a file from a newer schema is refused rather than overwritten
 *                   (this is the v4 bug that made the whole migration necessary)
 *
 * Usage: node tools/verify-v5-behaviour.js [path/to/data.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..', 'CheckinPallets_24_mg.html');
const DATA = process.argv[2] || path.join(__dirname, 'data.json');

const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

function ghBody(raw) {
  return JSON.stringify({
    sha: 'harness',
    content: Buffer.from(raw, 'utf8').toString('base64'),
    encoding: 'base64'
  });
}

async function newPage(browser, raw, writes) {
  const page = await browser.newPage();
  page.on('pageerror', e => writes.errors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) writes.errors.push('console: ' + t);
  });
  await page.route('**://api.github.com/**', route => {
    const req = route.request();
    if (req.method() === 'GET') {
      return route.fulfill({ status: 200, contentType: 'application/json', body: ghBody(raw) });
    }
    writes.puts.push(req.url());
    return route.fulfill({
      status: 200, contentType: 'application/json',
      body: JSON.stringify({ content: { sha: 'harness2' } })
    });
  });
  return page;
}

(async () => {
  if (!fs.existsSync(DATA)) {
    console.error(`No data.json at ${DATA}`);
    process.exit(2);
  }
  const raw = fs.readFileSync(DATA, 'utf8');

  const PREINSTALLED = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(p => fs.existsSync(p));
  const browser = await chromium.launch(PREINSTALLED.length ? { executablePath: PREINSTALLED[0] } : {});

  // ===================== A/B/C: live paths ==================================
  {
    const writes = { puts: [], errors: [] };
    const page = await newPage(browser, raw, writes);
    // Pre-seed the LIVE v4 key so we can prove the v5 app never touches it.
    await page.addInitScript(() => {
      try { localStorage.setItem('fb_db', JSON.stringify({ version: 4, sentinel: 'LIVE-V4-DATA' })); } catch (e) {}
    });
    await page.goto('file://' + APP);
    await page.waitForFunction(() => typeof db !== 'undefined' && db && db.version >= 5, { timeout: 15000 });

    const r = await page.evaluate(async () => {
      const res = {};
      // --- B. drive a real week: check in, add a pallet, run the lottery -----
      const d = db.distributions.find(x => (db.masterAgencies || []).some(a => a.distId === x.id));
      cur = d.id;
      const ags = getDistAgencies(d);
      d.checkedIn = ags.slice(0, 4).map(a => a.id);
      d.pallets = [{ id: uid(), materialNumber: 'TEST-D001', desc: 'Test Bread', qty: 10, type: 'cases' }];
      d.palletsDone = {};
      d.orderStatus = { [ags[0].id]: true };
      d.notes = 'smoke test note';
      // lottery over the checked-in agencies
      const slots = buildLotterySlots(d);
      d.pickOrder = slots.map(s => (s.type === 'group' ? `group:${s.name}` : `solo:${s.agency.id}`));
      d.lateSlots = d.pickOrder.length ? [d.pickOrder[0]] : [];

      const before = db.reports.length;
      const rep = saveReportSnapshot(d);
      res.reportAdded = db.reports.length === before + 1;
      res.hasSnapshot = !!rep.snapshot;
      res.noStoredHtml = !('html' in rep) && !('allocations' in rep);
      res.lotteryFrozen = Array.isArray(rep.snapshot.lottery) && rep.snapshot.lottery.length > 0;
      res.lotteryHasNames = rep.snapshot.lottery.every(s => s.group ? Array.isArray(s.members) : typeof s.name === 'string');
      res.lotteryHasNoIds = !JSON.stringify(rep.snapshot.lottery).includes('solo:');
      res.lateCaptured = rep.snapshot.lottery.some(s => s.late === 1);
      res.notesCaptured = rep.snapshot.notes === 'smoke test note';
      res.checkedInCount = rep.snapshot.agencies.filter(a => a.in).length;
      res.orderCaptured = rep.snapshot.agencies.filter(a => a.ord).length === 1;

      // frozen against later roster edits?
      const firstName = rep.snapshot.agencies[0].name;
      const liveAgency = db.masterAgencies.find(a => a.name === firstName);
      if (liveAgency) liveAgency.name = 'RENAMED AFTER THE FACT';
      res.frozenAgainstRename = rep.snapshot.agencies[0].name === firstName;

      // allocations derive
      const alloc = allocationsFrom(rep.snapshot, rep.date);
      res.allocDerived = alloc.length === res.checkedInCount && alloc[0].materialNumber === 'TEST-D001';

      // --- C. render ---------------------------------------------------------
      const html = renderReport(rep.snapshot, rep);
      const doc = new DOMParser().parseFromString(html, 'text/html');
      res.rendersTables = doc.querySelectorAll('table').length === 2;
      res.rendersRows = doc.querySelectorAll('tbody tr').length > 0;
      res.noInlineStyles = !/style=/.test(html);
      res.usesClasses = /class="pr-table"/.test(html);
      res.notesRendered = /smoke test note/.test(html);

      // standalone download must carry its own styling
      const full = `<!DOCTYPE html><html><head><meta charset="UTF-8"><title>x</title><style>${REPORT_CSS}</style></head><body>${reportHTML(rep)}</body></html>`;
      res.downloadSelfContained = full.includes('.pr-table th{') && full.includes('<table class="pr-table">');

      // size of the new report vs the v4 average (~30KB)
      res.reportBytes = JSON.stringify(rep).length;

      save();
      return res;
    });

    await page.waitForTimeout(2200);   // let the debounced ghPut fire

    const liveKey = await page.evaluate(() => {
      try { return localStorage.getItem('fb_db'); } catch (e) { return 'ERR'; }
    });
    const v5Key = await page.evaluate(() => {
      try { return localStorage.getItem('fb_db_v5'); } catch (e) { return 'ERR'; }
    });

    // --- A. isolation -------------------------------------------------------
    ok('writes go to data-v5.json', writes.puts.length > 0 && writes.puts.every(u => u.endsWith('data-v5.json')),
      writes.puts.length ? writes.puts.join(', ') : 'no PUT observed');
    ok('data.json is never written', !writes.puts.some(u => u.endsWith('/data.json')));
    ok("live localStorage key 'fb_db' untouched",
      liveKey === JSON.stringify({ version: 4, sentinel: 'LIVE-V4-DATA' }),
      `got ${String(liveKey).slice(0, 60)}`);
    ok("v5 writes to its own key 'fb_db_v5'", !!v5Key && JSON.parse(v5Key).version === 5);

    // --- B. close week ------------------------------------------------------
    ok('close week adds a report', r.reportAdded);
    ok('report carries a snapshot', r.hasSnapshot);
    ok('report stores no html / allocations', r.noStoredHtml);
    ok('lottery pick order is captured', r.lotteryFrozen);
    ok('lottery stores resolved names, not agency ids', r.lotteryHasNames && r.lotteryHasNoIds);
    ok('late flag survives into the snapshot', r.lateCaptured);
    ok('notes captured', r.notesCaptured);
    ok('order-pickup flag captured', r.orderCaptured);
    ok('snapshot is frozen against a later roster rename', r.frozenAgainstRename);
    ok('allocations derive from the snapshot', r.allocDerived);

    // --- C. render ----------------------------------------------------------
    ok('renders both report tables', r.rendersTables);
    ok('renders data rows', r.rendersRows);
    ok('emits zero inline style attributes', r.noInlineStyles);
    ok('uses the shared stylesheet classes', r.usesClasses);
    ok('notes render', r.notesRendered);
    ok('standalone download is self-contained', r.downloadSelfContained);
    ok(`new report is small (${r.reportBytes} bytes vs ~30,000 in v4)`, r.reportBytes < 10000, `${r.reportBytes} bytes`);

    if (writes.errors.length) ok('no page errors', false, writes.errors.join(' | '));
    else ok('no page errors', true);

    await page.close();
  }

  // ===================== D: forward guard ===================================
  {
    const writes = { puts: [], errors: [] };
    const future = JSON.stringify({ ...JSON.parse(raw), version: 99 });
    const page = await newPage(browser, future, writes);
    let alerted = '';
    page.on('dialog', async d => { alerted = d.message(); await d.dismiss(); });
    await page.goto('file://' + APP);
    await page.waitForFunction(() => typeof db !== 'undefined' && db && db.version === 99, { timeout: 15000 });
    await page.evaluate(() => { save(); });      // must be refused
    await page.waitForTimeout(2200);

    ok('a newer-schema file is not overwritten', writes.puts.length === 0,
      `${writes.puts.length} PUT(s) escaped`);
    ok('the user is told why it went read-only', /newer version/i.test(alerted),
      alerted ? alerted.slice(0, 70) : 'no dialog');
    await page.close();
  }

  await browser.close();

  const pad = s => (s.length > 62 ? s.slice(0, 59) + '...' : s.padEnd(62));
  console.log('\nv5 BEHAVIOUR + ISOLATION\n' + '='.repeat(78));
  let fail = 0;
  for (const c of checks) {
    if (!c.pass) fail++;
    console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${pad(c.name)}  ${c.pass ? '' : c.detail}`);
  }
  console.log('='.repeat(78));
  console.log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nALL BEHAVIOUR CHECKS OK\n');
  process.exit(fail ? 1 : 0);
})();
