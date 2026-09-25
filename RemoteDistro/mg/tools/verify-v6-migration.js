#!/usr/bin/env node
/**
 * v5 -> v6 migration + multi-table storage checks.
 *
 * Loads CheckinPallets_25_mg.html in real Chromium with the v6 table files
 * absent (404) and the v5 source present, runs the app's own seed path, and
 * checks that the split preserved everything and that the storage layer behaves.
 *
 *   A. migration  - every entity migrated, joins resolve, nothing orphaned
 *   B. view       - the app's db façade still reads like v5 over split tables
 *   C. files      - tables serialize in the v6 shape, with no v4/v5 field leakage
 *   D. isolation  - v6 writes only under its own directory; older streams untouched
 *   E. write cost - a check-in dirties one table, not all of them
 *
 * Usage: node tools/verify-v6-migration.js [path/to/data.json]
 */
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const APP = path.join(__dirname, '..', 'CheckinPallets_25_mg.html');
const DATA = process.argv[2] || path.join(__dirname, 'data.json');

const checks = [];
const ok = (name, pass, detail = '') => checks.push({ name, pass, detail });

(async () => {
  if (!fs.existsSync(DATA)) { console.error(`No data.json at ${DATA}`); process.exit(2); }
  const raw = fs.readFileSync(DATA, 'utf8');
  const sourceVersion = JSON.parse(raw).version;
  // The checked-in fixture is a v4 export. Scenario 1 serves it at data.json so
  // the v4 fallback in SEED_SOURCES is exercised for real; scenario 2 first runs
  // it through the v5 app to produce a genuine v5 file, so the whole
  // v4 -> v5 -> v6 chain is covered rather than assumed.
  let SOURCE_FILE = sourceVersion >= 5 ? 'data-v5.json' : 'data.json';
  let SOURCE_RAW = raw;

  const PRE = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome'].filter(p => fs.existsSync(p));
  const browser = await chromium.launch(PRE.length ? { executablePath: PRE[0] } : {});
  const page = await browser.newPage();
  const errors = [], puts = [], gets = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource/.test(t)) errors.push('console: ' + t);
  });

  // v6 tables do not exist yet (404). The v5 source does. Any PUT is recorded.
  await page.route('**://api.github.com/**', route => {
    const req = route.request(), url = req.url();
    if (req.method() !== 'GET') {
      puts.push(url);
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ content: { sha: 'sha-' + puts.length } }) });
    }
    gets.push(url);
    if (url.endsWith(SOURCE_FILE)) {
      return route.fulfill({ status: 200, contentType: 'application/json',
        body: JSON.stringify({ sha: 'srcsha', content: Buffer.from(SOURCE_RAW, 'utf8').toString('base64'), encoding: 'base64' }) });
    }
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });

  await page.addInitScript(() => {
    try {
      localStorage.setItem('fb_db', JSON.stringify({ version: 4, sentinel: 'V4-LIVE' }));
      localStorage.setItem('fb_db_v5', JSON.stringify({ version: 5, sentinel: 'V5-LIVE' }));
    } catch (e) {}
  });

  await page.goto('file://' + APP);
  await page.waitForFunction(() => typeof Store !== 'undefined' && Store.t && Store.t.meta, { timeout: 15000 });

  // Run the app's own migration path against the v5 source.
  const r = await page.evaluate(async () => {
    const out = {};
    // Closed events now live in one file per year rather than a single reports array.
    const migratedReports = t => Object.keys(t).filter(k => /^events-\d{4}$/.test(k)).reduce((a, k) => a.concat(t[k]), []);
    const src = await fetchSeedSource();
    out.srcLabel = src.label;
    out.srcVersion = src.db.version;
    const before = src.db;
    out.beforeCounts = {
      dists: (before.distributions || []).length,
      agencies: (before.masterAgencies || []).length,
      reports: (before.reports || []).length,
      orders: (before.orderLog || []).length,
      items: (before.itemLibrary || []).length
    };

    // Determinism must be judged on two untouched outputs: bindDbView() below
    // materializes empty events for schedules that lack one, so comparing a
    // bound set against a fresh one measures the binding, not the migration.
    const stripTime = x => { const c = JSON.parse(JSON.stringify(x)); c.meta.migratedAt = null; return JSON.stringify(c); };
    out.deterministic = stripTime(migrateToV6(before)) === stripTime(migrateToV6(before));

    const tables = migrateToV6(before);
    Store.reset(tables);
    Store.tooNew = false;
    bindDbView();
    normalizeTables();

    // --- A. migration ----------------------------------------------------
    out.counts = {
      sites: tables.sites.length, agencies: tables.agencies.length,
      items: tables.items.length, schedules: tables.schedules.length,
      reports: migratedReports(tables).length, orders: tables.orders.filter(o => o.status === 'saved').length
    };
    out.everyScheduleHasSite = tables.schedules.every(s => tables.sites.some(x => x.code === s.siteCode));
    out.everyAgencyHasSchedule = tables.agencies.every(a =>
      a.scheduleIds.length === 0 || a.scheduleIds.every(id => tables.schedules.some(s => s.id === id)));
    out.everyReportHasSchedule = migratedReports(tables).every(rep =>
      !rep.distId || tables.schedules.some(s => s.id === rep.scheduleId));
    out.agencyCodesUnique = new Set(tables.agencies.map(a => a.code)).size === tables.agencies.length;
    out.scheduleIdsUnique = new Set(tables.schedules.map(s => s.id)).size === tables.schedules.length;
    out.itemCodesUnique = new Set(tables.items.map(i => i.materialNumber)).size === tables.items.length;
    out.reportsPreserved = migratedReports(tables).length === out.beforeCounts.reports;
    out.snapshotsIntact = migratedReports(tables).every(rep => rep.snapshot && Array.isArray(rep.snapshot.agencies));
    out.ordersCollapsed = out.beforeCounts.orders - tables.orders.filter(o => o.status === 'saved').length;
    out.notice = tables.meta.migrationNotice;
    out.scheduleIdsJoined = tables.schedules.map(x => x.id).sort().join(',');
    out.agencyCodesJoined = tables.agencies.map(a => a.code).sort().join(',');

    // the DIST_LOCATION_MAP failure this replaces: every schedule now resolves
    out.schedulesWithRealSite = tables.schedules.filter(s => !/^SITE-LOCAL-/.test(s.siteCode)).length;
    out.provisionalSites = tables.sites.filter(s => s.provisional).map(s => s.code + ' ' + s.name);

    // item description merge
    const appl = tables.items.find(i => i.materialNumber === 'APPL-D003');
    out.applDescription = appl ? appl.description : null;
    out.applAliases = appl ? appl.altDescriptions : null;

    // --- B. view ---------------------------------------------------------
    out.view = {
      dists: db.distributions.length,
      agencies: db.masterAgencies.length,
      firstDistName: db.distributions[0] ? db.distributions[0].name : null,
      firstAgencyNum: db.masterAgencies[0] ? db.masterAgencies[0].num : null,
      firstAgencyDistId: db.masterAgencies[0] ? db.masterAgencies[0].distId : null,
      itemName: db.itemLibrary[0] ? db.itemLibrary[0].name : null,
      reports: db.reports.length,
      version: db.version
    };
    // the join the hardcoded map used to do
    const d0 = db.distributions.find(x => getDistAgencies(x).length > 0);
    out.view.joinWorks = !!d0 && getDistAgencies(d0).length > 0;
    out.view.joinCount = d0 ? getDistAgencies(d0).length : 0;
    out.view.joinDist = d0 ? d0.name : null;

    // write-through: setting a schedule field vs an event field
    const d = db.distributions[0];
    const origName = d.name, origDate = d.date;
    d.name = 'RENAMED VIA VIEW';
    d.date = '2030-01-01';
    out.view.nameWroteToSchedule = Store.get('schedules')[0].label === 'RENAMED VIA VIEW';
    out.view.dateWroteToEvent = Store.get('eventsOpen')[Store.get('schedules')[0].id].date === '2030-01-01';
    d.name = origName; d.date = origDate;

    // --- C. file shape ---------------------------------------------------
    const ser = n => JSON.parse(JSON.stringify(Store.get(n)));
    const aSer = ser('agencies')[0], iSer = ser('items')[0];
    out.file = {
      agencyKeys: Object.keys(aSer),
      itemKeys: Object.keys(iSer),
      // v4/v5 field names must NOT reach disk
      agencyLeak: ['num', 'distId', 'hidden', 'id'].filter(k => k in aSer),
      itemLeak: ['name'].filter(k => k in iSer),
      scheduleKeys: Object.keys(ser('schedules')[0]),
      sampleScheduleId: ser('schedules')[0].id,
      sampleAgencyCode: aSer.code
    };

    // --- E. write cost ---------------------------------------------------
    Store.markAllClean();
    out.dirtyAfterClean = Store.dirtyNames();
    const anyDist = db.distributions.find(x => getDistAgencies(x).length > 0);
    const ag = getDistAgencies(anyDist)[0];
    anyDist.checkedIn = [ag.id];              // a check-in, the hot path
    normalizeTables();
    out.dirtyAfterCheckin = Store.dirtyNames();

    // --- phase 2: the split ------------------------------------------------
    out.tables = TABLES.map(t => t.name);
    out.tableCount = TABLES.length;
    out.orderStatuses = {};
    Store.get('orders').forEach(o => { out.orderStatuses[o.status] = (out.orderStatuses[o.status] || 0) + 1; });
    out.archiveYears = archiveYears();
    out.closedEvents = allClosedEvents().length;
    out.openEvents = Object.keys(Store.get('eventsOpen')).length;
    // `orderForm` exists on the in-memory view as a non-enumerable alias onto the
    // orders table, so `in` finds it. What must be true is that it never reaches
    // disk — the draft belongs to the order half's table.
    out.eventsHaveNoOrderForm = Object.values(JSON.parse(JSON.stringify(Store.get('eventsOpen'))))
      .every(e => !('orderForm' in e));
    out.eventKeysOnDisk = Object.keys(JSON.parse(JSON.stringify(Store.get('eventsOpen')))[Object.keys(Store.get('eventsOpen'))[0]] || {});
    out.reportsViaArchive = db.reports.length;
    out.orderLogProjection = db.orderLog.length;
    out.orderLogHasLocation = db.orderLog.length ? /- [A-Z]{4}-/.test(db.orderLog[0].location || '') : false;
    out.orderLogHasItems = db.orderLog.length ? Array.isArray(db.orderLog[0].items) : false;

    // clipboard is per-browser now, not a synced table
    out.clipboardNotATable = !TABLES.some(t => t.name === 'copiedItems');
    db.copiedItems = [{ itemNum: 'TEST-D001' }];
    out.clipboardRoundTrips = db.copiedItems.length === 1 && db.copiedItems[0].itemNum === 'TEST-D001';
    Store.markAllClean();
    db.copiedItems = [{ itemNum: 'TEST-D002' }];
    out.clipboardDirtiesNothing = Store.dirtyNames().length === 0;

    // --- the shipment contract ---------------------------------------------
    Store.markAllClean();
    const shipDist = db.distributions[0];
    const ord = orderFormFor(shipDist);
    ord.lines = [
      { itemNum: 'APPL-D003', description: 'APPLES', needToPull: '2', pullUnit: 'BIN', qtyPulled: '9', returned: '1', used: '8' },
      { itemNum: 'BREA-D001', description: 'BREAD', needToPull: '6', pullUnit: 'CS', qtyPulled: '', returned: '', used: '' }
    ];
    const shp = dispatchShipment(ord, shipDist.id);
    out.shipment = {
      lines: shp.lines.length,
      keys: Object.keys(shp.lines[0]).sort(),
      // warehouse vocabulary must NOT cross the wall
      leak: ['needToPull', 'pullUnit', 'qtyPulled', 'returned', 'used'].filter(k => k in shp.lines[0]),
      hasSourceOrder: shp.sourceOrderId === ord.id,
      orderNowDispatched: ord.status === 'dispatched'
    };
    const pal = palletsFromShipment(shp);
    out.shipmentPallets = {
      n: pal.length,
      binBecomesBin: pal[0].type === 'bin' && pal[0].qty === 2,
      csBecomesCases: pal[1].type === 'cases' && pal[1].qty === 6,
      carriesShipmentId: pal.every(x => x.shipmentId === shp.id)
    };
    // Distribution reading the contract must never need the order
    out.distReadsOnlyShipment = shipmentsFor(shp.siteCode, shp.date).length > 0;

    // --- Close Week ordered write ------------------------------------------
    Store.markAllClean();
    const cw = db.distributions.find(x => getDistAgencies(x).length > 0);
    cw.checkedIn = getDistAgencies(cw).slice(0, 3).map(a => a.id);
    cw.pallets = [{ id: uid(), materialNumber: 'APPL-D003', desc: 'APPLES', qty: 9, type: 'cases' }];
    const beforeClosed = allClosedEvents().length;
    const rep = saveReportSnapshot(cw);
    out.close = {
      archivedFirst: allClosedEvents().length === beforeClosed + 1,
      // after step 1 the archive is dirty and the open state is NOT yet cleared
      dirtyAfterArchive: Store.dirtyNames(),
      stillHasCheckins: cw.checkedIn.length === 3
    };
    clearEventAfterClose(cw, '2026-12-31');
    out.close.clearedAfter = cw.checkedIn.length === 0 && cw.pallets.length === 0;
    out.close.archiveKeptIt = allClosedEvents().some(e => e.id === rep.id);
    out.close.archiveYear = Number(String(rep.date).slice(0, 4));

    Store.markAllClean();
    db.masterAgencies.push({ id: uid(), num: 'TEST-S9001', name: 'Harness Agency', group: '', distId: anyDist.id, hidden: false });
    normalizeTables();
    out.dirtyAfterAddAgency = Store.dirtyNames();
    // the pushed v5-shaped row must have been folded into v6 shape
    const added = JSON.parse(JSON.stringify(Store.get('agencies'))).find(a => a.code === 'TEST-S9001');
    out.addedAgencyKeys = added ? Object.keys(added) : null;
    out.addedAgencyScheduleIds = added ? added.scheduleIds : null;

    // byte comparison
    out.bytes = {
      v5: JSON.stringify(before).length,
      v6total: TABLES.reduce((n, t) => n + JSON.stringify(Store.get(t.name)).length, 0),
      hot: JSON.stringify(Store.get('eventsOpen')).length,
      archive: archiveYears().reduce((n, y) => n + JSON.stringify(Store.get(archiveName(y))).length, 0),
      orders: JSON.stringify(Store.get('orders')).length,
      master: ['sites', 'agencies', 'items', 'schedules'].reduce((n, t) => n + JSON.stringify(Store.get(t)).length, 0)
    };
    return out;
  });

  // Let the debounced flush fire so we can see what it PUTs.
  await page.evaluate(() => save());
  await page.waitForTimeout(2200);

  const ls = await page.evaluate(() => {
    const out = {};
    try {
      out.v4 = localStorage.getItem('fb_db');
      out.v5 = localStorage.getItem('fb_db_v5');
      out.v6keys = Object.keys(localStorage).filter(k => k.startsWith('fb_v6:')).sort();
    } catch (e) { out.err = String(e); }
    return out;
  });
  // ---- scenario 2: seed from a genuine v5 file -------------------------------
  // Produce one by running the fixture through the v5 app, then check that v6
  // lands in the same place whichever source it was given.
  const v5page = await browser.newPage();
  await v5page.route('**://api.github.com/**', route =>
    route.request().method() === 'GET'
      ? route.fulfill({ status: 200, contentType: 'application/json',
          body: JSON.stringify({ sha: 'x', content: Buffer.from(raw, 'utf8').toString('base64'), encoding: 'base64' }) })
      : route.fulfill({ status: 200, contentType: 'application/json', body: '{"content":{"sha":"y"}}' }));
  await v5page.goto('file://' + path.join(__dirname, '..', 'CheckinPallets_24_mg.html'));
  await v5page.waitForFunction(() => typeof db !== 'undefined' && db && db.version >= 5, { timeout: 15000 });
  const v5db = await v5page.evaluate(() => JSON.parse(JSON.stringify(db)));
  await v5page.close();

  SOURCE_FILE = 'data-v5.json';
  SOURCE_RAW = JSON.stringify(v5db);
  const page2 = await browser.newPage();
  const puts2 = [];
  page2.on('pageerror', e => errors.push('scenario2: ' + String(e)));
  await page2.route('**://api.github.com/**', route => {
    const req = route.request(), url = req.url();
    if (req.method() !== 'GET') { puts2.push(url); return route.fulfill({ status: 200, contentType: 'application/json', body: '{"content":{"sha":"z"}}' }); }
    if (url.endsWith(SOURCE_FILE)) return route.fulfill({ status: 200, contentType: 'application/json',
      body: JSON.stringify({ sha: 's', content: Buffer.from(SOURCE_RAW, 'utf8').toString('base64'), encoding: 'base64' }) });
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{"message":"Not Found"}' });
  });
  await page2.goto('file://' + APP);
  await page2.waitForFunction(() => typeof Store !== 'undefined' && Store.t && Store.t.meta, { timeout: 15000 });
  const r2 = await page2.evaluate(async () => {
    const reps = t => Object.keys(t).filter(k => /^events-\d{4}$/.test(k)).reduce((a, k) => a.concat(t[k]), []);
    const src = await fetchSeedSource();
    const t = migrateToV6(src.db);
    return {
      label: src.label, version: src.db.version,
      counts: { sites: t.sites.length, agencies: t.agencies.length, items: t.items.length,
                schedules: t.schedules.length, reports: reps(t).length },
      snapshotsIntact: reps(t).every(x => x.snapshot && Array.isArray(x.snapshot.agencies)),
      scheduleIds: t.schedules.map(s => s.id).sort().join(','),
      agencyCodes: t.agencies.map(a => a.code).sort().join(',')
    };
  });
  await page2.close();

  ok(`scenario 2 seeded from a real v5 file (v${r2.version})`, r2.version === 5, `got v${r2.version}`);
  ok('v5 source yields intact snapshots', r2.snapshotsIntact);
  ok('v4-sourced and v5-sourced migrations agree on schedules',
    r2.scheduleIds === r.scheduleIdsJoined, `${r2.scheduleIds.slice(0,60)} vs ${(r.scheduleIdsJoined||'').slice(0,60)}`);
  ok('v4-sourced and v5-sourced migrations agree on agencies',
    r2.agencyCodes === r.agencyCodesJoined);
  ok('v4-sourced and v5-sourced migrations agree on counts',
    JSON.stringify(r2.counts) === JSON.stringify({ sites: r.counts.sites, agencies: r.counts.agencies,
      items: r.counts.items, schedules: r.counts.schedules, reports: r.counts.reports }),
    `${JSON.stringify(r2.counts)} vs ${JSON.stringify(r.counts)}`);

  await browser.close();

  const TABLE_COUNT = r.tableCount;

  // ---- A ----
  ok(`seeded from ${r.srcLabel} (schema v${r.srcVersion})`, r.srcVersion === sourceVersion, `got v${r.srcVersion}`);
  ok(`sites built (${r.counts.sites})`, r.counts.sites > 0);
  ok(`agencies migrated (${r.beforeCounts.agencies} -> ${r.counts.agencies})`, r.counts.agencies === r.beforeCounts.agencies);
  ok(`schedules built (${r.beforeCounts.dists} dists -> ${r.counts.schedules})`, r.counts.schedules >= r.beforeCounts.dists);
  ok(`items unioned (${r.beforeCounts.items} lib -> ${r.counts.items})`, r.counts.items >= r.beforeCounts.items);
  ok(`all ${r.counts.reports} reports preserved`, r.reportsPreserved);
  ok('report snapshots intact', r.snapshotsIntact);
  ok('every schedule resolves to a site', r.everyScheduleHasSite);
  ok('every agency resolves to a schedule', r.everyAgencyHasSchedule);
  ok('every report resolves to a schedule (no orphans)', r.everyReportHasSchedule);
  ok('agency codes unique', r.agencyCodesUnique);
  ok('schedule ids unique', r.scheduleIdsUnique);
  ok('item codes unique', r.itemCodesUnique);
  ok(`duplicate empty orders collapsed (${r.ordersCollapsed})`, r.ordersCollapsed > 0, 'expected some');
  ok('migration is deterministic / re-runnable', r.deterministic);
  ok('longest item description wins, others kept as aliases',
    r.applDescription === 'APPLES - BULK - BIN/TOTE' && (r.applAliases || []).includes('APPLES'),
    `${r.applDescription} / ${JSON.stringify(r.applAliases)}`);

  // ---- B ----
  // Schedules >= distributions: archive-only schedules exist as foreign-key
  // targets for reports whose distribution was deleted, and must NOT come back
  // as live distributions.
  ok(`db.distributions reads through the view (${r.view.dists} live of ${r.counts.schedules} schedules)`,
    r.view.dists === r.beforeCounts.dists, `${r.view.dists} vs ${r.beforeCounts.dists} originally`);
  ok(`deleted distributions stay deleted (${r.counts.schedules - r.view.dists} archive-only)`,
    r.counts.schedules - r.view.dists === (r.notice.orphanSchedules || []).length);
  ok('db.masterAgencies reads through the view', r.view.agencies === r.counts.agencies);
  ok('agency .num alias resolves to code', /^[A-Z]{4}-/.test(r.view.firstAgencyNum || ''), r.view.firstAgencyNum);
  ok('agency .distId alias resolves to a schedule id', /-[A-Z]{3}/.test(r.view.firstAgencyDistId || ''), r.view.firstAgencyDistId);
  ok('item .name alias resolves to description', !!r.view.itemName);
  ok(`site<->agency join works without a hardcoded map (${r.view.joinDist}: ${r.view.joinCount})`, r.view.joinWorks);
  ok('setting d.name writes to schedules', r.view.nameWroteToSchedule);
  ok('setting d.date writes to the event', r.view.dateWroteToEvent);
  ok('db.version reads 6', r.view.version === 6, `got ${r.view.version}`);

  // ---- C ----
  ok('agency file rows carry no v4/v5 field names', r.file.agencyLeak.length === 0, r.file.agencyLeak.join(','));
  ok('item file rows carry no v4/v5 field names', r.file.itemLeak.length === 0, r.file.itemLeak.join(','));
  ok(`schedule ids are readable (${r.file.sampleScheduleId})`, /^[A-Z]{4}-|^SITE-LOCAL-/.test(r.file.sampleScheduleId));
  ok('a v5-shaped pushed agency is folded into v6 shape',
    r.addedAgencyKeys && !r.addedAgencyKeys.includes('num') && r.addedAgencyKeys.includes('code'),
    JSON.stringify(r.addedAgencyKeys));
  ok('pushed agency kept its schedule assignment', (r.addedAgencyScheduleIds || []).length === 1,
    JSON.stringify(r.addedAgencyScheduleIds));

  // ---- D ----
  const outside = puts.filter(u => !u.includes('/CheckinPallets/v6/'));
  ok(`writes stay inside ${'CheckinPallets/v6/'}`, puts.length > 0 && outside.length === 0,
    outside.join(', ') || 'no PUT observed');
  ok('data.json never written', !puts.some(u => /\/data\.json$/.test(u)));
  ok('data-v5.json never written', !puts.some(u => /\/data-v5\.json$/.test(u)));
  ok("v4 localStorage key untouched", ls.v4 === JSON.stringify({ version: 4, sentinel: 'V4-LIVE' }));
  ok("v5 localStorage key untouched", ls.v5 === JSON.stringify({ version: 5, sentinel: 'V5-LIVE' }));
  ok(`v6 uses its own localStorage keys (${(ls.v6keys || []).length})`,
    (ls.v6keys || []).length === TABLE_COUNT + 1 &&      // +1 for the un-synced clipboard
    (ls.v6keys || []).every(k => k.startsWith('fb_v6:')),
    (ls.v6keys || []).join(' '));

  // ---- E ----
  ok('nothing dirty right after a clean mark', r.dirtyAfterClean.length === 0, r.dirtyAfterClean.join(','));
  ok(`a check-in dirties only events-open (${r.dirtyAfterCheckin.join(',')})`,
    r.dirtyAfterCheckin.length === 1 && r.dirtyAfterCheckin[0] === 'eventsOpen', r.dirtyAfterCheckin.join(','));
  ok(`adding an agency dirties only agencies (${r.dirtyAfterAddAgency.join(',')})`,
    r.dirtyAfterAddAgency.length === 1 && r.dirtyAfterAddAgency[0] === 'agencies', r.dirtyAfterAddAgency.join(','));

  // ---- phase 2: split ----
  ok(`legacy.json is gone; tables are ${r.tables.filter(t => !/^events-\d/.test(t)).join(', ')}`,
    !r.tables.includes('legacy') && ['orders', 'shipments', 'eventsOpen'].every(t => r.tables.includes(t)),
    r.tables.join(','));
  ok(`orders carry a lifecycle (${JSON.stringify(r.orderStatuses)})`,
    r.orderStatuses.saved > 0 && r.orderStatuses.draft > 0);
  ok(`closed events partitioned by year (${r.archiveYears.join(', ')})`, r.archiveYears.length > 0);
  ok(`all ${r.closedEvents} reports live in the archive, not the hot file`,
    r.closedEvents === r.counts.reports && r.reportsViaArchive === r.counts.reports,
    `${r.closedEvents}/${r.reportsViaArchive} vs ${r.counts.reports}`);
  ok(`${r.openEvents} open events hold no order draft on disk (${(r.eventKeysOnDisk || []).join(', ')})`,
    r.eventsHaveNoOrderForm, (r.eventKeysOnDisk || []).join(','));
  ok(`db.orderLog still reads as the order half expects (${r.orderLogProjection} entries)`,
    r.orderLogProjection > 0 && r.orderLogHasLocation && r.orderLogHasItems,
    `location=${r.orderLogHasLocation} items=${r.orderLogHasItems}`);
  ok('paste clipboard is no longer a synced table', r.clipboardNotATable);
  ok('clipboard round-trips through localStorage', r.clipboardRoundTrips);
  ok('using the clipboard dirties no table', r.clipboardDirtiesNothing);

  // ---- the contract ----
  ok(`shipment carries ${r.shipment.lines} lines in contract vocabulary (${r.shipment.keys.join(', ')})`,
    r.shipment.lines === 2);
  ok('warehouse vocabulary does not cross the wall', r.shipment.leak.length === 0, r.shipment.leak.join(','));
  ok('shipment back-references its order', r.shipment.hasSourceOrder);
  ok('dispatch moves the order to dispatched', r.shipment.orderNowDispatched);
  ok('BIN becomes a bin pallet, CS becomes cases',
    r.shipmentPallets.binBecomesBin && r.shipmentPallets.csBecomesCases);
  ok('pallets carry the shipment id', r.shipmentPallets.carriesShipmentId);
  ok('distribution can find its shipment without the order', r.distReadsOnlyShipment);

  // ---- close week ordering ----
  ok('close week archives before clearing', r.close.archivedFirst && r.close.stillHasCheckins);
  ok(`the archive write is what gets persisted first (${r.close.dirtyAfterArchive.join(',')})`,
    r.close.dirtyAfterArchive.some(n => /^events-\d{4}$/.test(n)), r.close.dirtyAfterArchive.join(','));
  ok('open state cleared only after', r.close.clearedAfter);
  ok(`closed event kept in events-${r.close.archiveYear}.json`, r.close.archiveKeptIt);

  ok('no page errors', errors.length === 0, errors.join(' | '));

  const pad = s => (s.length > 64 ? s.slice(0, 61) + '...' : s.padEnd(64));
  console.log('\nv5 -> v6 MIGRATION + MULTI-TABLE STORAGE\n' + '='.repeat(84));
  let fail = 0;
  for (const c of checks) { if (!c.pass) fail++; console.log(`  ${c.pass ? 'PASS' : 'FAIL'}  ${pad(c.name)}  ${c.pass ? '' : c.detail}`); }
  console.log('-'.repeat(84));
  console.log(`  tables:  sites ${r.counts.sites} · agencies ${r.counts.agencies} · items ${r.counts.items} · schedules ${r.counts.schedules} · reports ${r.counts.reports}`);
  console.log(`  bytes:   v5 one file ${(r.bytes.v5 / 1024).toFixed(1)} KB  ->  v6 ${(r.bytes.v6total / 1024).toFixed(1)} KB across ${6} tables`);
  console.log(`           master ${(r.bytes.master / 1024).toFixed(1)} KB · orders ${(r.bytes.orders / 1024).toFixed(1)} KB`
    + ` · archive ${(r.bytes.archive / 1024).toFixed(1)} KB (once per Close Week) · open ${(r.bytes.hot / 1024).toFixed(1)} KB`);
  console.log(`  hot path: a check-in rewrites events-open.json only — ${(r.bytes.hot / 1024).toFixed(1)} KB`);
  if (r.provisionalSites.length) console.log(`  filler site codes: ${r.provisionalSites.join(' | ')}`);
  console.log('='.repeat(84));
  console.log(fail ? `\n${fail} CHECK(S) FAILED\n` : '\nALL v6 CHECKS OK\n');
  process.exit(fail ? 1 : 0);
})();
