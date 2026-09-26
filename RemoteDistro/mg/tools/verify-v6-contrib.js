#!/usr/bin/env node
/**
 * Pass-1 checks for the contributor's order-component work, merged into v6.
 *
 * verify-v6-migration.js proves the schema; this proves the merged features run
 * on it. Wherever possible each check drives the real entry point — the button's
 * handler, the order form's own save path — rather than calling a helper, because
 * calling helpers directly is exactly how the phase-2 seed-button bug got past
 * the migration suite.
 *
 *   A. seed button     - the real handler completes and reports success
 *   B. projections     - order-form copies keep code/name/location; nothing leaks
 *   C. special order   - round-trips through the real order form into sites+orders
 *   D. week patterns   - cadence vocabulary, alias, advance, missing weekday filled
 *   E. schedule join   - siteCode, not DIST_LOCATION_MAP; never consults the map
 *   F. close week      - advances by week pattern and moves the sidebar date
 *   G. qty on site     - pallets arrive uncounted; the ordered amount is the hint
 *   H. live sync off   - saving an order does not touch pallets
 *   I. surface UI      - hamburger, app settings, print menu, show-all, clear-all
 *   J. dropped         - no local-deployment scaffolding survived the merge
 *   K. isolation       - v6 still writes only under its own directory
 *
 * Usage: node tools/verify-v6-contrib.js [path/to/data.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..', 'CheckinPallets_25_mg.html');
const DATA = process.argv[2] || path.join(__dirname, 'data.json');
const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass: !!pass, detail });

(async () => {
  if (!fs.existsSync(DATA)) { console.error(`No data.json at ${DATA}`); process.exit(2); }
  const raw = fs.readFileSync(DATA, 'utf8');
  const PRE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(p => fs.existsSync(p));
  const browser = await chromium.launch(PRE.length ? { executablePath: PRE[0] } : {});
  const page = await browser.newPage({ acceptDownloads: true });
  const errors = [], puts = [], dialogs = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push('console: ' + t);
  });
  page.on('dialog', async d => { dialogs.push(d.message()); await d.dismiss(); });
  await page.route('**://api.github.com/**', route => {
    const req = route.request(), url = req.url();
    if (req.method() !== 'GET') {
      puts.push(url);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ content: { sha: 'sha-' + puts.length } }) });
    }
    if (url.endsWith('/data.json') && !url.includes('/v6/'))
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ sha: 'src', content: Buffer.from(raw, 'utf8').toString('base64'), encoding: 'base64' }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });

  await page.goto('file://' + APP);
  await page.waitForFunction(() => typeof Store !== 'undefined' && Store.t && Store.t.meta, { timeout: 15000 });
  await page.waitForTimeout(300);
  const bootErrors = errors.length;

  // ---- A. the seed button, through its real handler ----------------------------
  await page.evaluate(() => { confirmSeedFromLive(); });
  await page.evaluate(() => document.getElementById('conf-ok').onclick());
  await page.waitForTimeout(600);
  const seedDialogs = dialogs.slice();
  ok('seed button completes without "Could not pull"', !seedDialogs.some(m => /Could not pull/.test(m)),
    seedDialogs.join(' | ').slice(0, 160));
  ok('seed summary reports all 15 reports preserved', seedDialogs.some(m => /15 reports preserved/.test(m)),
    seedDialogs.join(' | ').slice(0, 160));

  const r = await page.evaluate(async () => {
    const out = {};
    // ---- B. projections survive the order form's copy-mutate-save pattern ------
    db.orderSchedule = [{ orderNumber: 'AOR910001', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-10-07' }];
    const sched = db.orderSchedule.map(o => ({ ...o }));
    out.schedCopy = { code: sched[0].code, name: sched[0].name };
    const log = db.orderLog.map(o => ({ ...o, items: (o.items || []).map(it => ({ ...it })) }));
    out.logCopyLocation = log[0] && log[0].location;
    db.orderLog = log.map(o => ({ ...o, items: (o.items || []).map(it => ({ ...it })) }));
    const disk = JSON.parse(JSON.stringify(Store.get('orders')));
    out.leak = {
      itemsAndLines: disk.filter(o => 'items' in o && 'lines' in o).length,
      orderFormFields: disk.filter(o => ['location', 'code', 'name', 'items'].some(k => k in o)).length
    };
    out.savedIdsStable = db.orderLog.every(e => !!e.id);

    // ---- C. special order through the real order form code ----------------------
    const fair = db.distributions.find(d => d.siteCode === 'PEDI-S2002');
    openDist(fair.id);
    document.getElementById('so-name').value = 'Perish Dist: Pop-Up Test';
    document.getElementById('so-code').value = 'PEDI-S9901';
    document.getElementById('so-date').value = '2026-11-03';
    document.getElementById('so-orderNumber').value = 'AOR919999';
    OrderForm.confirmAddSpecialOrder();
    const site = Store.get('sites').find(s => s.code === 'PEDI-S9901');
    // Selecting the new entry also loads it into the open draft (the contributor's
    // intended UX), so two rows carry this AOR; the special order is the planned one.
    const planned = Store.get('orders').find(o => o.orderNumber === 'AOR919999' && o.status === 'planned');
    out.special = {
      siteAdded: !!site && site.name === 'Perish Dist: Pop-Up Test',
      plannedOrder: !!planned && planned.status === 'planned' && planned.siteCode === 'PEDI-S9901' && planned.date === '2026-11-03',
      cleanOnDisk: !!planned && !['code', 'name', 'location', 'items'].some(k => k in JSON.parse(JSON.stringify(planned))),
      readBack: (OrderForm.getScheduleForDate('2026-11-03')[0] || {}).code
    };

    // ---- D. week patterns ------------------------------------------------------
    const scs = Store.get('schedules');
    out.cadences = [...new Set(scs.map(s => s.cadence))].sort();
    const vaca = db.distributions.find(d => /vacaville/i.test(d.name));
    out.vacaPattern = vaca && vaca.weekPattern;
    out.noDowMissing = scs.filter(s => !s.archivedOnly && s.dayOfWeek === null).map(s => s.label);
    vaca.weekPattern = '1st3rd';
    out.aliasWritesSchedule = vaca._sched.cadence === '1st3rd';
    vaca.weekPattern = '2nd4th';
    out.weekPatternOnDisk = JSON.parse(JSON.stringify(scs)).some(s => 'weekPattern' in s);
    out.advance2nd4th = advanceToNextOccurrence('2026-10-08', 4, '2nd4th');
    out.advance1st3rd = advanceToNextOccurrence('2026-10-01', 4, '1st3rd');
    out.advanceAll = advanceToNextOccurrence('2026-10-08', 4, 'all');

    // ---- E. schedule join on siteCode --------------------------------------------
    let mapCalls = 0;
    const realMap = OrderForm.getDistNamesForCode;
    OrderForm.getDistNamesForCode = function () { mapCalls++; return realMap.apply(this, arguments); };
    db.orderSchedule = [
      { orderNumber: 'AOR920001', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-10-06' },
      { orderNumber: 'AOR920002', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-10-07' }
    ];
    OrderForm.refresh();
    out.joinConcordTue = getScheduledDistsForDate('2026-10-06').map(d => d.name);
    out.joinFairfieldWed = getScheduledDistsForDate('2026-10-07').map(d => d.name);
    sidebarScheduleDate = '2026-10-06'; renderSidebar();
    out.sidebarShowsConcord = document.getElementById('sidebar-dist-list').textContent.includes('Tuesday Concord');
    out.mapCalls = mapCalls;
    OrderForm.getDistNamesForCode = realMap;

    // ---- G. qty on site ----------------------------------------------------------
    const cw = db.distributions.find(d => getDistAgencies(d).length > 0);
    openDist(cw.id);
    const ord = orderFormFor(cw);
    ord.lines = [{ itemNum: 'APPL-D003', description: 'APPLES', needToPull: '3', pullUnit: 'BIN' },
                 { itemNum: 'BREA-D001', description: 'BREAD', needToPull: '12', pullUnit: 'CS' }];
    const shp = dispatchShipment(ord, cw.id);
    cw.pallets = palletsFromShipment(shp);
    cw.checkedIn = getDistAgencies(cw).slice(0, 4).map(a => a.id);
    out.qty = {
      uncounted: cw.pallets.every(p => p.qty === 0),
      planned: cw.pallets.map(p => p.plannedQty),
      allocBeforeCount: calcAlloc(cw, cw.pallets[1].qty).perAgency
    };
    openEditPalletQty(cw.pallets[1].id);
    const qtyInput = document.querySelector('#m-edit-pallet-qty input[type="number"], #ep-qty, #m-edit-qty input');
    out.qty.placeholder = qtyInput ? qtyInput.placeholder : '(no input found)';
    closeModal && document.querySelectorAll('.overlay.open').forEach(m => m.classList.remove('open'));
    cw.pallets[1].qty = 12;
    out.qty.allocAfterCount = calcAlloc(cw, cw.pallets[1].qty).perAgency;

    // ---- H. live sync is off --------------------------------------------------------
    out.autoSyncDefined = typeof autoSyncOrderFormToPallets === 'function';
    const before = JSON.stringify(cw.pallets);
    switchTab('orderform', document.getElementById('nav-orderform'));
    try { OrderForm.saveCurrentOrder(); } catch (e) { out.saveErr = String(e); }
    out.palletsUntouchedBySave = JSON.stringify(cw.pallets) === before;

    // ---- I. surface UI ----------------------------------------------------------------
    const ui = {};
    toggleSidebarMobile();
    ui.hamburgerOpens = document.getElementById('sidebar-backdrop').classList.contains('open');
    closeSidebarMobile();
    ui.backdropCloses = !document.getElementById('sidebar-backdrop').classList.contains('open');
    openModal('m-app-settings');
    ui.appSettingsOpens = document.getElementById('m-app-settings').classList.contains('open');
    ui.appSettingsHasAdmin = ['Manage Distributions', 'Manage Agencies', 'Item Library', 'Reports']
      .every(t => document.getElementById('m-app-settings').textContent.includes(t));
    ui.seedButtonVisible = getComputedStyle(document.getElementById('btn-seed')).display !== 'none';
    closeModal('m-app-settings');
    ui.badgeVisible = getComputedStyle(document.getElementById('parallel-badge')).display !== 'none';
    OrderForm.togglePrintMenu();
    const pm = document.getElementById('of-printMenu');
    ui.printMenuToggles = !!pm && getComputedStyle(pm).display !== 'none';
    OrderForm.togglePrintMenu();
    const beforeShowAll = sidebarShowAll; toggleSidebarShowAll(); ui.showAllToggles = sidebarShowAll !== beforeShowAll; toggleSidebarShowAll();
    cw.checkedIn = getDistAgencies(cw).slice(0, 2).map(a => a.id);
    ui.clearAllDefined = typeof clearAllCheckins === 'function' && typeof togglePickOrder === 'function';
    out.ui = ui;

    // ---- J. dropped scaffolding ----------------------------------------------------------
    out.dropped = ['exportV2Data', 'importV2Data', 'resetV2TestData', 'traceV2', 'updateV2DebugInfo']
      .filter(n => typeof window[n] === 'function');
    out.v2Key = (() => { try { return localStorage.getItem('fb_db_v2'); } catch (e) { return null; } })();
    return out;
  });

  // ---- F. close week, through its real handler ---------------------------------
  const f = await page.evaluate(async () => {
    const vaca = db.distributions.find(d => /vacaville/i.test(d.name));
    vaca.weekPattern = '2nd4th';
    setSidebarScheduleDate('2026-10-08');      // the sidebar is the date source of truth
    openDist(vaca.id);                         // lands on the order form, which loads the date
    switchTab('settings', document.getElementById('nav-settings'));
    confirmCloseWeek();
    await document.getElementById('conf-ok').onclick();
    return { date: vaca.date, sidebarDate: sidebarScheduleDate };
  });
  await page.waitForTimeout(1800);
  await browser.close();

  // ---- report --------------------------------------------------------------------------
  ok('page boots with no errors (db bound before the first sidebar render)', bootErrors === 0, errors.slice(0, 2).join(' | '));

  ok('schedule copies keep code and name', r.schedCopy.code === 'PEDI-S2002' && r.schedCopy.name === 'Perish Dist: Fairfield',
    JSON.stringify(r.schedCopy));
  ok('saved-order copies keep location', /PEDI-/.test(r.logCopyLocation || ''), String(r.logCopyLocation));
  ok('no items/lines duplication on disk after a save round-trip', r.leak.itemsAndLines === 0, `${r.leak.itemsAndLines} rows`);
  ok('no order-form field names reach orders.json', r.leak.orderFormFields === 0, `${r.leak.orderFormFields} rows`);
  ok('saved orders keep their ids through the order form', r.savedIdsStable);

  ok('special order adds the site', r.special.siteAdded);
  ok('special order lands as a planned order', r.special.plannedOrder);
  ok('special order is stored in the orders shape', r.special.cleanOnDisk);
  ok('special order reads back through the order form', r.special.readBack === 'PEDI-S9901', String(r.special.readBack));

  ok(`cadence uses the contributor vocabulary (${r.cadences.join(', ')})`,
    r.cadences.every(c => ['all', '1st3rd', '2nd4th'].includes(c)), r.cadences.join(','));
  ok('Vacaville migrates as 2nd4th (their exact-name seed would have missed it)', r.vacaPattern === '2nd4th', String(r.vacaPattern));
  ok('no live schedule is missing a weekday', r.noDowMissing.length === 0, r.noDowMissing.join(', '));
  ok('d.weekPattern writes schedule.cadence', r.aliasWritesSchedule);
  ok('weekPattern never reaches schedules.json', !r.weekPatternOnDisk);
  ok('2nd4th advance skips to the 4th Thursday (Oct 8 -> Oct 22)', r.advance2nd4th === '2026-10-22', r.advance2nd4th);
  ok('1st3rd advance skips to the 3rd Thursday (Oct 1 -> Oct 15)', r.advance1st3rd === '2026-10-15', r.advance1st3rd);
  ok('weekly advance is one week (Oct 8 -> Oct 15)', r.advanceAll === '2026-10-15', r.advanceAll);

  ok('join finds Tuesday Concord — absent from DIST_LOCATION_MAP entirely', r.joinConcordTue.includes('Tuesday Concord'),
    JSON.stringify(r.joinConcordTue));
  ok('join prefers the weekday match (Fairfield on a Wednesday)', r.joinFairfieldWed.length === 1 && r.joinFairfieldWed[0] === 'Wednesday Fairfield',
    JSON.stringify(r.joinFairfieldWed));
  ok('sidebar date filter shows the joined distribution', r.sidebarShowsConcord);
  ok('v6 never consults DIST_LOCATION_MAP for the join', r.mapCalls === 0, `${r.mapCalls} calls`);

  ok('close week advances a 2nd4th distribution two weeks (Oct 8 -> Oct 22)', f.date === '2026-10-22', f.date);
  ok('close week moves the sidebar date filter with it', f.sidebarDate === '2026-10-22', f.sidebarDate);

  ok('pallets arrive uncounted (qty 0)', r.qty.uncounted);
  ok('the ordered amount rides along as plannedQty', JSON.stringify(r.qty.planned) === '[3,12]', JSON.stringify(r.qty.planned));
  ok('nothing allocates until counted', r.qty.allocBeforeCount === 0, String(r.qty.allocBeforeCount));
  ok('the count dialog offers the ordered amount as its hint', /12/.test(r.qty.placeholder), r.qty.placeholder);
  ok('allocation runs off the counted number (12 cases / 4 agencies = 3)', r.qty.allocAfterCount === 3, String(r.qty.allocAfterCount));

  ok('live-sync hook is not defined, so the order form cannot fire it', !r.autoSyncDefined);
  ok('saving an order does not touch pallets', r.palletsUntouchedBySave, r.saveErr || '');

  ok('hamburger opens the mobile sidebar', r.ui.hamburgerOpens);
  ok('backdrop closes it', r.ui.backdropCloses);
  ok('App Settings opens with the four admin actions', r.ui.appSettingsOpens && r.ui.appSettingsHasAdmin);
  ok('test-build seed action lives in App Settings', r.ui.seedButtonVisible);
  ok('test-build badge stays visible in the sidebar', r.ui.badgeVisible);
  ok('print menu toggles', r.ui.printMenuToggles);
  ok('sidebar show-all toggles', r.ui.showAllToggles);
  ok('clear-all check-ins and pick-order toggle are present', r.ui.clearAllDefined);

  ok('local-deployment scaffolding did not survive the merge', r.dropped.length === 0, r.dropped.join(','));
  ok("nothing written to the contributor's fb_db_v2 key", r.v2Key === null);

  const outside = puts.filter(u => !u.includes('/CheckinPallets/v6/'));
  ok('every write stays inside CheckinPallets/v6/', puts.length > 0 && outside.length === 0, outside.join(', ') || 'no PUT seen');
  ok('no page errors across the whole run', errors.length === 0, errors.slice(0, 3).join(' | '));

  const pad = s => (s.length > 70 ? s.slice(0, 67) + '...' : s.padEnd(70));
  console.log('\nPASS 1 — CONTRIBUTOR FEATURES ON v6\n' + '='.repeat(88));
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${pad(c.name)}  ${c.pass ? '' : c.detail}`); }
  console.log('='.repeat(88));
  console.log(fail ? `\n${fail} CHECK(S) FAILED\n` : `\nALL ${checks.length} PASS-1 CHECKS OK\n`);
  process.exit(fail ? 1 : 0);
})();
