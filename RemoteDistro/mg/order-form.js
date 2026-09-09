/* Order Form module for CheckinPallets CP23 */
const OrderForm = (function() {
let _getDb = () => ({});
let _getDist = () => null;
let _persist = () => {};
let _xlsxLoading = null;

const DIST_LOCATION_MAP = {
    'Vallejo Monday': { name: 'Perish Dist: Vallejo', code: 'PEDI-S1001' },
    'Vallejo Thursday': { name: 'Perish Dist: Vallejo', code: 'PEDI-S1001' },
    'Fairfield Tuesday': { name: 'Perish Dist: Fairfield', code: 'PEDI-S2002' },
    'Fairfield Wednesday': { name: 'Perish Dist: Fairfield', code: 'PEDI-S2002' },
    'East County Thursday': { name: 'Perish Dist: Concord', code: 'PEDI-C2002' },
    'East County Friday': { name: 'Perish Dist: Antioch', code: 'PEDI-C3003' },
};

function ensureXlsxLoaded() {
    if (typeof XLSX !== 'undefined') return Promise.resolve();
    if (_xlsxLoading) return _xlsxLoading;
    _xlsxLoading = new Promise((resolve, reject) => {
        const script = document.createElement('script');
        script.src = 'xlsx.min.js';
        script.onload = () => resolve();
        script.onerror = () => reject(new Error('Could not load xlsx.min.js'));
        document.head.appendChild(script);
    });
    return _xlsxLoading;
}

function bindDateListener() {
    const dateEl = document.getElementById('of-date');
    if (!dateEl || dateEl._ofBound) return;
    dateEl._ofBound = true;
    dateEl.addEventListener('change', (e) => {
        formData.date = e.target.value;
        const dist = _getDist();
        if (dist) dist.date = e.target.value;
        saveData();
        fetchOrderNumber();
        renderScheduleOptions(e.target.value || '');
    });
}

function init(config) {
    _getDb = config.getDb;
    _getDist = config.getDist;
    _persist = config.persist;
    loadLocationsList();
    loadOrderSchedule();
    loadOrderLog();
    populateProduceDatalists();
    applyPageOrientationStyle();
    bindDateListener();
    if (!window._ofPrintBound) {
        window._ofPrintBound = true;
        window.addEventListener('afterprint', () => {
            document.body.classList.remove('of-printing');
            const pv = document.getElementById('of-printView');
            if (pv) pv.classList.remove('open');
        });
    }
}

function activate() {
    loadData();
    renderScheduleOptions(document.getElementById('of-date')?.value || '');
    updateExportReminder();
    const helper = document.getElementById('of-orderNumberHelperText');
    if (helper) {
        helper.textContent = CERES_API_ENABLED
            ? 'Auto-populated from Ceres API, or type your own'
            : 'Auto-generated placeholder for now, or type your own';
    }
}

function getItems() {
    return items.map(it => ({ ...it }));
}

function flush() {
    saveData();
}
const DEFAULT_LOCATIONS = [
    { name: 'Perish Dist: Oroville', code: 'PEDI-B1001' },
    { name: 'Perish Dist: Chico', code: 'PEDI-B1002' },
    { name: 'Perish Dist: Williams', code: 'PEDI-B2001' },
    { name: 'Perish Dist: Red Bluff', code: 'PEDI-B3001' },
    { name: 'Perish Dist: Willows', code: 'PEDI-B4001' },
    { name: 'Perish Dist: Glenn County', code: 'PEDI-B4002' },
    { name: 'Perish Dist: Richmond', code: 'PEDI-C1001' },
    { name: 'Perish Dist: Bay Area Rescue M.', code: 'PEDI-C1004' },
    { name: 'Perish Dist Loaves & Fishes Pittburg', code: 'PEDI-C1005' },
    { name: 'Perish Dist: Concord', code: 'PEDI-C2002' },
    { name: 'Perish Dist: Antioch', code: 'PEDI-C3003' },
    { name: 'Perish Dist: Redding', code: 'PEDI-N1001' },
    { name: 'Perish Dist: Vallejo', code: 'PEDI-S1001' },
    { name: 'Perish Dist: Fairfield', code: 'PEDI-S2002' },
    { name: 'Perish Dist: Vacaville', code: 'PEDI-S3003' }
];

let locationsList = [];

function locationValue(loc) {
    return `${loc.name} - ${loc.code}`;
}

function loadLocationsList() {
    const db = _getDb();
    locationsList = (db.locationsList && db.locationsList.length)
        ? db.locationsList.map(l => ({ ...l }))
        : DEFAULT_LOCATIONS.map(l => ({ ...l }));
}

function saveLocationsList() {
    _getDb().locationsList = locationsList.map(l => ({ ...l }));
    _persist();
}

function showAddLocationPanel() {
    document.getElementById('of-newLocationName').value = '';
    document.getElementById('of-newLocationCode').value = '';
    document.getElementById('of-addLocationPanel').style.display = 'block';
    document.getElementById('of-newLocationName').focus();
}

function hideAddLocationPanel() {
    document.getElementById('of-addLocationPanel').style.display = 'none';
}

function cancelAddLocation() {
    hideAddLocationPanel();
}

// Adds a new location to the saved list (for future schedule
// matching/imports) and also fills it into the Location field
// directly, for the case where the coordinator is at a
// distribution that isn't in the schedule yet.
function confirmAddLocation() {
    const name = document.getElementById('of-newLocationName').value.trim();
    const code = document.getElementById('of-newLocationCode').value.trim();
    if (!name || !code) {
        alert('Please enter both a name and a code.');
        return;
    }
    const newLoc = { name, code };
    const value = locationValue(newLoc);
    if (locationsList.some(l => locationValue(l) === value)) {
        alert('That location already exists.');
        return;
    }
    locationsList.push(newLoc);
    saveLocationsList();
    hideAddLocationPanel();
    document.getElementById('of-location').value = value;
    fetchOrderNumber();
}

// ============================================================
// ORDER SCHEDULE - seeded from the Aug-Sep agency order sheet.
// Re-importable at any time via the "Import Schedule" button,
// which fully replaces this list with revised information.
// ============================================================
const DEFAULT_ORDER_SCHEDULE = [
    { orderNumber: 'AOR216687', code: 'PEDI-B1002', name: 'Perish Dist: Chico', date: '2026-08-01' },
    { orderNumber: 'AOR216688', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-03' },
    { orderNumber: 'AOR216689', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-03' },
    { orderNumber: 'AOR216690', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-04' },
    { orderNumber: 'AOR216691', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-04' },
    { orderNumber: 'AOR216692', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-05' },
    { orderNumber: 'AOR216693', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-05' },
    { orderNumber: 'AOR216694', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-06' },
    { orderNumber: 'AOR216695', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-06' },
    { orderNumber: 'AOR216696', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-06' },
    { orderNumber: 'AOR216698', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-07' },
    { orderNumber: 'AOR216699', code: 'PEDI-B1001', name: 'Perish Dist: Oroville', date: '2026-08-08' },
    { orderNumber: 'AOR216700', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-10' },
    { orderNumber: 'AOR216701', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-10' },
    { orderNumber: 'AOR216702', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-11' },
    { orderNumber: 'AOR216703', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-11' },
    { orderNumber: 'AOR216704', code: 'PEDI-B2001', name: 'Perish Dist: Williams', date: '2026-08-11' },
    { orderNumber: 'AOR216705', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-12' },
    { orderNumber: 'AOR216706', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-12' },
    { orderNumber: 'AOR216707', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-13' },
    { orderNumber: 'AOR216708', code: 'PEDI-S3003', name: 'Perish Dist: Vacaville', date: '2026-08-13' },
    { orderNumber: 'AOR216709', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-13' },
    { orderNumber: 'AOR216710', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-13' },
    { orderNumber: 'AOR216711', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-14' },
    { orderNumber: 'AOR216712', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-17' },
    { orderNumber: 'AOR216713', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-17' },
    { orderNumber: 'AOR216714', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-18' },
    { orderNumber: 'AOR216715', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-18' },
    { orderNumber: 'AOR216716', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-19' },
    { orderNumber: 'AOR216717', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-19' },
    { orderNumber: 'AOR216718', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-20' },
    { orderNumber: 'AOR216719', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-20' },
    { orderNumber: 'AOR216720', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-20' },
    { orderNumber: 'AOR216721', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-21' },
    { orderNumber: 'AOR216722', code: 'PEDI-B3001', name: 'Perish Dist: Red Bluff', date: '2026-08-22' },
    { orderNumber: 'AOR216723', code: 'PEDI-N1001', name: 'Perish Dist: Redding', date: '2026-08-22' },
    { orderNumber: 'AOR216724', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-24' },
    { orderNumber: 'AOR216725', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-24' },
    { orderNumber: 'AOR216726', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-25' },
    { orderNumber: 'AOR216728', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-08-26' },
    { orderNumber: 'AOR216729', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-26' },
    { orderNumber: 'AOR216730', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-27' },
    { orderNumber: 'AOR216732', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-27' },
    { orderNumber: 'AOR216738', code: 'PEDI-S3003', name: 'Perish Dist: Vacaville', date: '2026-08-27' },
    { orderNumber: 'AOR216739', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-08-27' },
    { orderNumber: 'AOR216740', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-08-28' },
    { orderNumber: 'AOR216741', code: 'PEDI-B4002', name: 'Perish Dist: Glenn County', date: '2026-08-28' },
    { orderNumber: 'AOR216742', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-08-31' },
    { orderNumber: 'AOR216743', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-08-31' },
    { orderNumber: 'AOR218274', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-03' },
    { orderNumber: 'AOR218275', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-10' },
    { orderNumber: 'AOR218276', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-14' },
    { orderNumber: 'AOR218277', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-17' },
    { orderNumber: 'AOR218278', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-21' },
    { orderNumber: 'AOR218279', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-24' },
    { orderNumber: 'AOR218280', code: 'PEDI-S1001', name: 'Perish Dist: Vallejo', date: '2026-09-28' },
    { orderNumber: 'AOR218281', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-02' },
    { orderNumber: 'AOR218282', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-09' },
    { orderNumber: 'AOR218283', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-14' },
    { orderNumber: 'AOR218284', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-16' },
    { orderNumber: 'AOR218285', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-21' },
    { orderNumber: 'AOR218286', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-23' },
    { orderNumber: 'AOR218287', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-28' },
    { orderNumber: 'AOR218288', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-30' },
    { orderNumber: 'AOR218289', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-02' },
    { orderNumber: 'AOR218291', code: 'PEDI-C1001', name: 'Perish Dist: Richmond', date: '2026-09-01' },
    { orderNumber: 'AOR218292', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-08' },
    { orderNumber: 'AOR218293', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-09' },
    { orderNumber: 'AOR218294', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-15' },
    { orderNumber: 'AOR218295', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-16' },
    { orderNumber: 'AOR218296', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-22' },
    { orderNumber: 'AOR218297', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-23' },
    { orderNumber: 'AOR218298', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-29' },
    { orderNumber: 'AOR218299', code: 'PEDI-S2002', name: 'Perish Dist: Fairfield', date: '2026-09-30' },
    { orderNumber: 'AOR218300', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-01' },
    { orderNumber: 'AOR218301', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-03' },
    { orderNumber: 'AOR218302', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-08' },
    { orderNumber: 'AOR218303', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-10' },
    { orderNumber: 'AOR218304', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-15' },
    { orderNumber: 'AOR218305', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-17' },
    { orderNumber: 'AOR218306', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-22' },
    { orderNumber: 'AOR218307', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-24' },
    { orderNumber: 'AOR218308', code: 'PEDI-C2002', name: 'Perish Dist: Concord', date: '2026-09-29' },
    { orderNumber: 'AOR218309', code: 'PEDI-S3003', name: 'Perish Dist: Vacaville', date: '2026-09-10' },
    { orderNumber: 'AOR218310', code: 'PEDI-S3003', name: 'Perish Dist: Vacaville', date: '2026-09-24' },
    { orderNumber: 'AOR218311', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-03' },
    { orderNumber: 'AOR218312', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-04' },
    { orderNumber: 'AOR218313', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-10' },
    { orderNumber: 'AOR218314', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-11' },
    { orderNumber: 'AOR218315', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-17' },
    { orderNumber: 'AOR218316', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-18' },
    { orderNumber: 'AOR218317', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-24' },
    { orderNumber: 'AOR218318', code: 'PEDI-C3003', name: 'Perish Dist: Antioch', date: '2026-09-25' },
    { orderNumber: 'AOR218319', code: 'PEDI-B2001', name: 'Perish Dist: Williams', date: '2026-09-08' },
    { orderNumber: 'AOR218320', code: 'PEDI-B4002', name: 'Perish Dist: Glenn County', date: '2026-09-25' },
    { orderNumber: 'AOR218321', code: 'PEDI-B1002', name: 'Perish Dist: Chico', date: '2026-09-05' },
    { orderNumber: 'AOR218322', code: 'PEDI-B1001', name: 'Perish Dist: Oroville', date: '2026-09-12' },
    { orderNumber: 'AOR218323', code: 'PEDI-B3001', name: 'Perish Dist: Red Bluff', date: '2026-09-26' },
    { orderNumber: 'AOR218324', code: 'PEDI-N1001', name: 'Perish Dist: Redding', date: '2026-09-26' }
];

let orderSchedule = [];
let scheduleSorted = [];

function loadOrderSchedule() {
    const db = _getDb();
    orderSchedule = (db.orderSchedule && db.orderSchedule.length) ? db.orderSchedule.map(o => ({ ...o })) : DEFAULT_ORDER_SCHEDULE.map(o => ({ ...o }));
}

function saveOrderSchedule() {
    _getDb().orderSchedule = orderSchedule.map(o => ({ ...o }));
    _persist();
}

// Renders the schedule dropdown. If filterDate is given, only shows
// orders scheduled for that date (flat list, since it's a single
// day); otherwise shows everything grouped into <optgroup>s by date.
function renderScheduleOptions(filterDate) {
    const select = document.getElementById('of-scheduleSelect');
    let sorted = [...orderSchedule].sort((a, b) =>
        (a.date || '').localeCompare(b.date || '') || (a.name || '').localeCompare(b.name || '')
    );
    if (filterDate) {
        sorted = sorted.filter(o => o.date === filterDate);
    }
    scheduleSorted = sorted;

    if (filterDate && sorted.length === 0) {
        select.innerHTML = '<option value="">No scheduled orders for this date</option>';
        select.value = '';
        return;
    }

    let html = '<option value="">Select a scheduled order...</option>';
    let lastDate = null;
    sorted.forEach((o, i) => {
        if (!filterDate) {
            if (o.date !== lastDate) {
                if (lastDate !== null) html += '</optgroup>';
                html += `<optgroup label="${Shared.escapeHtml(o.date || 'No date')}">`;
                lastDate = o.date;
            }
        }
        html += `<option value="${i}">${Shared.escapeHtml(o.name)} (${Shared.escapeHtml(o.code)}) — ${Shared.escapeHtml(o.orderNumber)}</option>`;
    });
    if (!filterDate && lastDate !== null) html += '</optgroup>';
    select.innerHTML = html;
    select.value = '';
}

// Finds a location already in the editable locations list by agency
// code, or adds it automatically if the schedule references a code
// that isn't there yet.
function findOrCreateLocationByCode(code, name) {
    let loc = locationsList.find(l => l.code === code);
    if (!loc) {
        loc = { name: name || code, code: code };
        locationsList.push(loc);
        saveLocationsList();
    }
    return locationValue(loc);
}

// Called when a scheduled order is picked. Fills Location, Date, and
// Order Number, saves the current form (including its items) to
// the saved-orders log first, then loads that order's own items:
// if this order was already filled out earlier (e.g. going back to
// Antioch after doing Concord), its saved items are restored so it
// can be reviewed/printed; if it's brand new, it starts blank.
function handleScheduleSelect(value) {
    if (value === '') return;
    const order = scheduleSorted[parseInt(value, 10)];
    if (!order) return;

    const currentOrderNumber = document.getElementById('of-orderNumber').value;

    // Re-selecting the SAME order that's already on screen should
    // never touch the current items — previously this always
    // re-fetched items from the saved-orders log, which meant any
    // in-progress/unsaved edits (or all of it, if the log had just
    // been cleared) got wiped out just by picking the same order
    // again.
    if (order.orderNumber && order.orderNumber === currentOrderNumber) {
        return;
    }

    // Save whatever is currently on screen before switching, so the
    // completed order for the previous location isn't lost even if
    // "Print" was never clicked for it.
    const currentLocation = document.getElementById('of-location').value;
    const hasData = currentOrderNumber || currentLocation || hasAnyItemData(items);
    if (hasData) {
        logCurrentOrder();
    }

    document.getElementById('of-date').value = order.date || '';
    formData.date = order.date || '';

    const locValue = findOrCreateLocationByCode(order.code, order.name);
    document.getElementById('of-location').value = locValue;
    hideAddLocationPanel();

    formData.orderNumber = order.orderNumber || '';
    document.getElementById('of-orderNumber').value = order.orderNumber || '';

    // Restore this order's own saved items if it was already
    // filled out before; otherwise start fresh.
    const savedOrder = order.orderNumber
        ? orderLog.find(o => o.orderNumber === order.orderNumber)
        : null;
    items = savedOrder ? savedOrder.items.map(it => ({ ...it })) : [];
    renderItems();
    saveData();

    renderScheduleOptions(order.date || '');
}

// Maps flexible schedule column headers to our internal field names
const SCHEDULE_HEADER_MAP = {
    'no.': 'orderNumber', 'no': 'orderNumber', 'order number': 'orderNumber', 'order #': 'orderNumber', 'order#': 'orderNumber',
    'sell-to agency no.': 'code', 'sell-to agency no': 'code', 'agency no.': 'code', 'agency no': 'code',
    'agency code': 'code', 'sell-to agency number': 'code',
    'sell-to agency name': 'name', 'agency name': 'name', 'location': 'name',
    'shipment date': 'date', 'date': 'date'
};

function toISODateString(v) {
    if (v == null || v === '') return '';
    if (v instanceof Date) {
        const y = v.getFullYear(), m = String(v.getMonth() + 1).padStart(2, '0'), d = String(v.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    const s = String(v).trim();
    const isoMatch = s.match(/^(\d{4}-\d{2}-\d{2})/);
    if (isoMatch) return isoMatch[1];
    const parsed = new Date(s);
    if (!isNaN(parsed.getTime())) {
        const y = parsed.getFullYear(), m = String(parsed.getMonth() + 1).padStart(2, '0'), d = String(parsed.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }
    return s;
}

// Imports a revised schedule file (.xlsx/.xls/.csv) and fully
// replaces the current schedule list with its contents.
function importSchedule(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array', cellDates: true });

            const sheetName = wb.SheetNames.find(n => {
                const lower = n.trim().toLowerCase();
                return lower.includes('agency') || lower.includes('order');
            }) || wb.SheetNames[0];
            const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

            if (!json.length) {
                showScheduleImportStatus('No rows found in that file.', 'error');
                return;
            }

            const parsed = json.map(row => {
                const entry = { orderNumber: '', code: '', name: '', date: '' };
                Object.keys(row).forEach(col => {
                    const field = SCHEDULE_HEADER_MAP[normalizeHeader(col)];
                    if (!field) return;
                    const raw = row[col];
                    entry[field] = field === 'date' ? toISODateString(raw) : String(raw).trim();
                });
                return entry;
            }).filter(e => e.orderNumber || e.code || e.name);

            if (!parsed.length) {
                showScheduleImportStatus('Could not find recognizable schedule columns in that file.', 'error');
                return;
            }

            orderSchedule = parsed;
            saveOrderSchedule();
            renderScheduleOptions(document.getElementById('of-date').value || '');
            showScheduleImportStatus(`Loaded ${parsed.length} scheduled order(s) from ${file.name}.`, 'success');
        } catch (err) {
            console.error('Schedule import error:', err);
            showScheduleImportStatus('Could not read that file. Please check it is a valid Excel/CSV file.', 'error');
        }
        event.target.value = '';
    };
    reader.readAsArrayBuffer(file);
}

// Shared by showImportStatus() and showScheduleImportStatus() below,
// which were previously identical copy-pasted functions differing
// only in which status element they targeted.
function showStatusMessage(elementId, message, type) {
    const el = document.getElementById(elementId.startsWith('of-') ? elementId : 'of-' + elementId);
    el.textContent = message;
    el.className = 'import-status' + (type ? ' ' + type : '');
    if (type === 'success') {
        setTimeout(() => { if (el.textContent === message) el.textContent = ''; }, 5000);
    }
}

function showScheduleImportStatus(message, type) {
    showStatusMessage('scheduleImportStatus', message, type);
}

// ============================================================
// SAVED ORDERS LOG - every printed form is captured here so all
// completed orders can be downloaded together as one spreadsheet.
// ============================================================
let orderLog = [];

// Tracks when saved orders were last exported, so we can remind
// the person if unexported orders start piling up.
const EXPORT_REMINDER_THRESHOLD = 3;
let lastExportAt = null;

function loadOrderLog() {
    orderLog = (_getDb().orderLog || []).map(o => ({ ...o, items: (o.items || []).map(it => ({ ...it })) }));
    lastExportAt = _getDb().lastExportAt || null;
}

function saveOrderLog() {
    _getDb().orderLog = orderLog.map(o => ({ ...o, items: (o.items || []).map(it => ({ ...it })) }));
    _persist();
}

// Shows/hides the "you have unexported orders" banner based on how
// many saved orders have been added since the last export.
function updateExportReminder() {
    const banner = document.getElementById('of-exportReminderBanner');
    if (!banner) return;
    const unexportedCount = orderLog.filter(o => !lastExportAt || o.savedAt > lastExportAt).length;
    if (unexportedCount >= EXPORT_REMINDER_THRESHOLD) {
        document.getElementById('of-exportReminderText').textContent =
            `${unexportedCount} saved order(s) haven't been downloaded yet.`;
        banner.style.display = 'flex';
    } else {
        banner.style.display = 'none';
    }
}

// Shared by handleScheduleSelect(), logCurrentOrder(), and
// saveCurrentOrder() — all three needed to check whether an items
// array has any real data, and previously each defined the same
// field list separately (a future new field would've needed
// updating in three places).
function hasAnyItemData(itemsArr) {
    return itemsArr.some(it =>
        it.itemNum || it.description || it.needToPull || it.pullUnit || it.qtyPulled || it.returned || it.used
    );
}

// Saves (or updates) the current on-screen order into the running
// log, but only if it actually has item data — switching through
// scheduled orders without entering anything won't create blank
// log entries. Called automatically by "Print hard copy" and when
// switching to a different scheduled order. Reprinting/re-editing
// the same order number updates that entry instead of duplicating it.
function logCurrentOrder() {
    if (!hasAnyItemData(items)) return;

    const location = document.getElementById('of-location').value;
    const date = document.getElementById('of-date').value;
    const orderNumber = document.getElementById('of-orderNumber').value;

    const entry = {
        location, date, orderNumber,
        items: items.map(it => ({ ...it })),
        savedAt: new Date().toISOString()
    };

    if (orderNumber) {
        orderLog = orderLog.filter(o => o.orderNumber !== orderNumber);
    }
    orderLog.push(entry);
    saveOrderLog();
    updateExportReminder();
}

// The "💾 Save" button. Saves the current order into the log
// (available afterward in "Print Saved Orders") without printing
// or downloading anything — separate from Export/Download, which
// are purely for generating an Excel file.
function saveCurrentOrder() {
    if (!hasAnyItemData(items)) {
        showImportStatus('Nothing to save yet — add at least one item first.', 'error');
        return;
    }
    logCurrentOrder();
    if (savedOrdersPanelOpen) renderSavedOrdersPanel();
    showImportStatus('Order saved.', 'success');
}

// Shared by exportToExcel() and exportLogToExcel() below. Both used
// to define this same column shape independently, which is
// how the "Qty Pulled" column previously went missing from one
// export but not the other — now there's only one place to edit.
function buildItemExportRow(baseFields, item) {
    return {
        ...baseFields,
        'Item #': item ? (item.itemNum || '') : '',
        'Pallet #': item ? (item.palletNum || '') : '',
        'Description': item ? (item.description || '') : '',
        'Need to Pull Qty': item ? (item.needToPull || '') : '',
        'Need to Pull Unit': item ? (item.pullUnit || '') : '',
        'Qty Pulled': item ? (item.qtyPulled || '') : '',
        'Qty Returned': item ? (item.returned || '') : '',
        'Qty Used': item ? (item.used || '') : ''
    };
}

function exportLogToExcel() {
    if (!orderLog.length) {
        showImportStatus('No saved orders yet — click Save or print a form first.', 'error');
        return;
    }

    const rows = [];
    orderLog.forEach(order => {
        const base = { 'Location': order.location || '', 'Date': order.date || '', 'Order Number': order.orderNumber || '' };
        if (order.items && order.items.length) {
            order.items.forEach(item => rows.push(buildItemExportRow(base, item)));
        } else {
            rows.push(buildItemExportRow(base, null));
        }
    });

    const sheet = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'All Orders');

    const today = new Date().toISOString().split('T')[0];
    XLSX.writeFile(wb, `AllDistributionOrders_${today}.xlsx`);

    lastExportAt = new Date().toISOString();
    _getDb().lastExportAt = lastExportAt; _persist();
    updateExportReminder();
    if (savedOrdersPanelOpen) renderSavedOrdersPanel();

    showImportStatus(`Downloaded ${orderLog.length} saved order(s).`, 'success');
}

// Dispatches the "More actions" dropdown to the relevant existing
// function, then resets the select back to its placeholder so it
// behaves like a one-shot action menu rather than a persistent
// choice.
function handleMoreActionsMenu(value) {
    if (value === 'downloadAll') exportLogToExcel();
    else if (value === 'printSaved') toggleSavedOrdersPanel();
    else if (value === 'clearSaved') clearOrderLog();
    document.getElementById('of-moreActionsMenu').value = '';
}

// Shared undo toast. Call with a message and a function that
// restores whatever was just cleared; the toast auto-dismisses
// (and discards the undo option) after a while so it doesn't
// linger indefinitely.
let undoToastTimeout = null;
let pendingUndoAction = null;

function showUndoToast(message, undoFn) {
    if (undoToastTimeout) clearTimeout(undoToastTimeout);
    pendingUndoAction = undoFn;
    document.getElementById('of-undoToastMessage').textContent = message;
    document.getElementById('of-undoToast').style.display = 'flex';
    undoToastTimeout = setTimeout(hideUndoToast, 10000);
}

function hideUndoToast() {
    document.getElementById('of-undoToast').style.display = 'none';
    pendingUndoAction = null;
    if (undoToastTimeout) {
        clearTimeout(undoToastTimeout);
        undoToastTimeout = null;
    }
}

function handleUndoToastClick() {
    if (pendingUndoAction) pendingUndoAction();
    hideUndoToast();
}

function clearOrderLog() {
    if (!orderLog.length) {
        showImportStatus('No saved orders to clear.', 'error');
        return;
    }
    const count = orderLog.length;
    const proceed = confirm(`Clear all ${count} saved order(s) from this browser? You'll have a few seconds to undo right after.`);
    if (!proceed) return;
    const backup = orderLog;
    orderLog = [];
    saveOrderLog();
    updateExportReminder();
    if (savedOrdersPanelOpen) renderSavedOrdersPanel();
    showUndoToast(`Cleared ${count} saved order(s).`, () => {
        orderLog = backup;
        saveOrderLog();
        updateExportReminder();
        if (savedOrdersPanelOpen) renderSavedOrdersPanel();
        showImportStatus('Saved orders restored.', 'success');
    });
}

// ============================================================
// PRINT SAVED ORDERS PANEL - lets the person fill out several
// orders (e.g. Concord and Fairfield, both scheduled for the same
// date), then print any combination of the saved ones together in
// a single print job, each on its own separate sheet of paper.
// ============================================================
let savedOrdersSorted = [];
let savedOrdersPanelOpen = false;

function toggleSavedOrdersPanel() {
    savedOrdersPanelOpen = !savedOrdersPanelOpen;
    document.getElementById('of-savedOrdersPanel').style.display = savedOrdersPanelOpen ? 'block' : 'none';
    if (savedOrdersPanelOpen) renderSavedOrdersPanel();
}

function renderSavedOrdersPanel() {
    const container = document.getElementById('of-savedOrdersList');
    savedOrdersSorted = [...orderLog].sort((a, b) =>
        (a.date || '').localeCompare(b.date || '') || (a.location || '').localeCompare(b.location || '')
    );

    if (!savedOrdersSorted.length) {
        container.innerHTML = '<div class="helper-text">No saved orders yet. Click "💾 Save" to save the current order, or orders save automatically when you print or switch to a different scheduled order.</div>';
        return;
    }

    let html = '';
    savedOrdersSorted.forEach((o, i) => {
        const label = `${o.date || 'No date'} — ${o.location || 'No location'} — ${o.orderNumber || 'No order #'}`;
        const isExported = !!(lastExportAt && o.savedAt && o.savedAt <= lastExportAt);
        const badge = isExported
            ? '<span style="background: #e8f5e9; color: #2e7d32; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap;">✓ Exported</span>'
            : '<span style="background: #fff3e0; color: #b26a00; font-size: 11px; font-weight: 600; padding: 2px 8px; border-radius: 10px; white-space: nowrap;">○ Not exported</span>';
        html += `
            <div style="display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 4px 0; font-size: 13px;">
                <label style="display: flex; align-items: center; gap: 8px; flex: 1; min-width: 0;">
                    <input type="checkbox" class="saved-order-checkbox" value="${i}">
                    <span>${Shared.escapeHtml(label)}</span>
                </label>
                ${badge}
                <button type="button" onclick="OrderForm.previewSavedOrder(${i})" title="Preview this order's items without printing" style="background: none; border: 1px solid #0066cc; color: #0066cc; border-radius: 4px; cursor: pointer; font-size: 11px; padding: 2px 8px; white-space: nowrap;">👁 View</button>
                <button type="button" onclick="OrderForm.deleteSavedOrder(${i})" title="Remove this saved order" style="background: none; border: none; color: #c0392b; cursor: pointer; font-size: 12px; white-space: nowrap;">✕ Remove</button>
            </div>`;
    });
    container.innerHTML = html;
}

// Removes a single saved order from the log (identified by its
// position in the currently rendered, sorted list).
function deleteSavedOrder(idx) {
    const order = savedOrdersSorted[idx];
    if (!order) return;
    const label = `${order.location || 'No location'} — ${order.orderNumber || 'No order #'} (${order.date || 'no date'})`;
    const proceed = confirm(`Remove saved order "${label}"? This cannot be undone.`);
    if (!proceed) return;
    orderLog = orderLog.filter(o => o !== order);
    saveOrderLog();
    updateExportReminder();
    renderSavedOrdersPanel();
}

function selectSavedOrdersForCurrentDate() {
    const date = document.getElementById('of-date').value;
    document.querySelectorAll('.saved-order-checkbox').forEach(cb => {
        const o = savedOrdersSorted[parseInt(cb.value, 10)];
        cb.checked = !!o && o.date === date;
    });
}

function selectAllSavedOrders(checked) {
    document.querySelectorAll('.saved-order-checkbox').forEach(cb => { cb.checked = checked; });
}

function printSelectedSavedOrders() {
    const selected = Array.from(document.querySelectorAll('.saved-order-checkbox:checked'))
        .map(cb => savedOrdersSorted[parseInt(cb.value, 10)])
        .filter(Boolean);

    if (!selected.length) {
        alert('Select at least one saved order to print.');
        return;
    }

    showBatchPrintPreview(selected);
}

const produceItems = [
    { itemNum: 'APPL-D003', description: 'APPLES' },
    { itemNum: 'ASPA-D001', description: 'ASPARAGUS' },
    { itemNum: 'AVOC-D001', description: 'AVOCADOS' },
    { itemNum: 'BANA-D001', description: 'BANANAS' },
    { itemNum: 'BLPE-D001', description: 'BELLPEPPERS' },
    { itemNum: 'BOKC-D001', description: 'BOK CHOY' },
    { itemNum: 'BROC-D002', description: 'BROCCOLI' },
    { itemNum: 'BRUS-D001', description: 'BRUSSEL SPROUTS' },
    { itemNum: 'CABB-D001', description: 'CABBAGE' },
    { itemNum: 'CANT-D001', description: 'CANTALOUPE' },
    { itemNum: 'CANT-D002', description: 'CANTALOUPES' },
    { itemNum: 'CARR-D002', description: 'CARROTS' },
    { itemNum: 'CARR-D004', description: 'CARROTS' },
    { itemNum: 'CAUL-D001', description: 'CAULIFLOWER' },
    { itemNum: 'CAUL-D002', description: 'CAULIFLOWER' },
    { itemNum: 'CELE-D001', description: 'CELERY' },
    { itemNum: 'CELE-D002', description: 'CELERY' },
    { itemNum: 'CHER-D001', description: 'CHERRIES' },
    { itemNum: 'CORN-D001', description: 'CORN' },
    { itemNum: 'CORN-D002', description: 'CORN' },
    { itemNum: 'CUKE-D001', description: 'CUCUMBERS' },
    { itemNum: 'GARL-D001', description: 'GARLIC' },
    { itemNum: 'GARL-D002', description: 'GARLIC' },
    { itemNum: 'GREE-D001', description: 'GREEN BEANS' },
    { itemNum: 'GRFR-D001', description: 'GRAPEFRUIT' },
    { itemNum: 'HNDW-D001', description: 'HONEYDEW' },
    { itemNum: 'HNDW-D002', description: 'HONEYDEW' },
    { itemNum: 'KIWI-D001', description: 'KIWI' },
    { itemNum: 'LETT-D001', description: 'LETTUCE' },
    { itemNum: 'LETT-D002', description: 'LETTUCE' },
    { itemNum: 'LEMN-D001', description: 'LEMONS' },
    { itemNum: 'MAND-D004', description: 'MANDARINS' },
    { itemNum: 'MANG-D001', description: 'MANGOES' },
    { itemNum: 'MANG-D002', description: 'MANGOES' },
    { itemNum: 'MXML-D001', description: 'MIXED MELONS' },
    { itemNum: 'ONIO-D001', description: 'ONIONS BAGGED' },
    { itemNum: 'ONIO-D002', description: 'ONIONS' },
    { itemNum: 'ORAN-D001', description: 'ORANGES' },
    { itemNum: 'PEAC-D002', description: 'PEACHES' },
    { itemNum: 'PEAR-D009', description: 'PEARS' },
    { itemNum: 'PINE-D001', description: 'PINEAPPLE' },
    { itemNum: 'POME-D001', description: 'POMEGRANATES' },
    { itemNum: 'POTA-D001', description: 'POTATOES BAGGED' },
    { itemNum: 'POTA-D002', description: 'POTATOES' },
    { itemNum: 'PROD-D001', description: 'PRODUCE ASST' },
    { itemNum: 'RADI-D001', description: 'RADISHES' },
    { itemNum: 'SPOT-D001', description: 'SWEET POTATOES' },
    { itemNum: 'SPOT-D002', description: 'SWEET POTATOES' },
    { itemNum: 'SQUA-D001', description: 'SQUASH' },
    { itemNum: 'STFR-D001', description: 'STONEFRUIT' },
    { itemNum: 'STRW-D001', description: 'STRAWBERRIES' },
    { itemNum: 'STRW-D002', description: 'STRAWBERRIES' },
    { itemNum: 'TOMA-D001', description: 'TOMATOES' },
    { itemNum: 'TURN-D002', description: 'TURNIPS' },
    { itemNum: 'WTMN-D002', description: 'WATERMELONS' },
    { itemNum: 'WTMN-D003', description: 'WATERMELON' },
    { itemNum: 'ZUCH-D001', description: 'ZUCCHINI' },
    { itemNum: 'BREA-D001', description: 'BREAD BIN/TRAY' },
    { itemNum: 'FROZ-D001', description: 'ASST FROZEN' },
    { itemNum: 'MEAT-D001', description: 'ASST MEAT' },
    { itemNum: 'ASST-D001', description: 'ASST BULK FOOD' },
    { itemNum: 'ASST-D009', description: 'ASST BULK NON-FOOD' },
    { itemNum: 'BABY-D001', description: 'ASST BABY PRODUCTS' },
    { itemNum: 'PETF-D001', description: 'ASST PET FOOD' }

];

let items = [];
let printOrientation = 'portrait';

function toggleOrientationSelect() {
    const select = document.getElementById('of-printOrientationSelect');
    select.style.display = select.style.display === 'none' ? 'inline-block' : 'none';
}

function setPrintOrientation(orientation) {
    printOrientation = orientation;
    document.body.classList.toggle('print-landscape', orientation === 'landscape');
    applyPageOrientationStyle();
    document.getElementById('of-printOrientationSelect').style.display = 'none';
}

function applyPageOrientationStyle() {
    let styleTag = document.getElementById('of-dynamicPageStyle');
    if (!styleTag) {
        styleTag = document.createElement('style');
        styleTag.id = 'dynamicPageStyle';
        document.head.appendChild(styleTag);
    }
    styleTag.textContent = `@page { size: letter ${printOrientation}; margin: 0; }`;
}

let formData = {
    location: '',
    date: new Date().toISOString().split('T')[0],
    orderNumber: '',
    items: []
};

function ensureOrderForm(dist) {
    if (!dist.orderForm) {
        dist.orderForm = { orderNumber: '', location: '', items: [], lastSentAt: null };
    } else {
        dist.orderForm.items = dist.orderForm.items || [];
        if (dist.orderForm.lastSentAt === undefined) dist.orderForm.lastSentAt = null;
    }
    return dist.orderForm;
}

function deriveLocationFromDist(dist) {
    const mapped = DIST_LOCATION_MAP[dist.name];
    if (mapped) return locationValue(mapped);
    const of = dist.orderForm || {};
    return of.location || '';
}

function loadData() {
    const dist = _getDist();
    if (!dist) return;
    const of = ensureOrderForm(dist);
    formData.location = of.location || deriveLocationFromDist(dist);
    formData.date = dist.date || Shared.todayStr();
    formData.orderNumber = of.orderNumber || '';
    formData.items = (of.items || []).map(item => ({ ...item, id: item.id || Shared.uid() }));
    const locEl = document.getElementById('of-location');
    const dateEl = document.getElementById('of-date');
    const numEl = document.getElementById('of-orderNumber');
    if (locEl) locEl.value = formData.location;
    if (dateEl) dateEl.value = formData.date;
    if (numEl) numEl.value = formData.orderNumber;
    items = formData.items.map(item => ({ ...item }));
    renderItems();
}

function saveData() {
    const dist = _getDist();
    if (!dist) return;
    const of = ensureOrderForm(dist);
    of.location = document.getElementById('of-location').value;
    of.orderNumber = document.getElementById('of-orderNumber').value;
    of.items = items.map(it => ({ ...it }));
    dist.date = document.getElementById('of-date').value || dist.date;
    formData.location = of.location;
    formData.date = dist.date;
    formData.orderNumber = of.orderNumber;
    formData.items = of.items;
    _persist();
}

// ============================================================
// CERES API CONFIGURATION - IT: fill these in, then set
// CERES_API_ENABLED to true. Leave it false and the form will
// keep generating mock order numbers (useful for testing before
// the integration is wired up).
// ============================================================
const CERES_API_ENABLED = false; // TODO(IT): set to true once the values below are filled in
const CERES_API_BASE_URL = 'https://yourcompany.dynamics365.com'; // TODO(IT): replace with your real Ceres/Business Central base URL
const CERES_API_KEY = 'YOUR_API_KEY_HERE'; // TODO(IT): replace with a real API key or bearer token

function handleOrderNumberChange(value) {
    formData.orderNumber = value.trim();
    saveData();
}

function fetchOrderNumber() {
    const location = document.getElementById('of-location').value;
    const date = document.getElementById('of-date').value;

    // Both date AND location are required
    if (!location || !date) {
        document.getElementById('of-orderNumber').value = '';
        formData.orderNumber = '';
        return;
    }

    // Only auto-generate an order number if this date/location
    // combination is actually assigned to a scheduled distribution
    // (PEDI). For a date that hasn't been scheduled, leave the
    // order number blank instead of fabricating one — the person
    // can still type one in by hand if they need to.
    const isScheduled = orderSchedule.some(o =>
        o.date === date && locationValue({ name: o.name, code: o.code }) === location
    );
    if (!isScheduled) {
        document.getElementById('of-orderNumber').value = '';
        formData.orderNumber = '';
        saveData();
        return;
    }

    document.getElementById('of-orderNumber').value = CERES_API_ENABLED
        ? '⟳ Fetching from Ceres...'
        : '⟳ Generating order number...';

    if (CERES_API_ENABLED) {
        // Real Ceres API call
        const url = `${CERES_API_BASE_URL}/api/v2.0/orders?date=${encodeURIComponent(date)}&location=${encodeURIComponent(location)}`;
        fetch(url, {
            headers: {
                // TODO(IT): confirm the correct auth header format for your Ceres/Business Central setup.
                // Common options: 'Authorization': `Bearer ${CERES_API_KEY}` or 'Ocp-Apim-Subscription-Key': CERES_API_KEY
                'Authorization': `Bearer ${CERES_API_KEY}`,
                'Accept': 'application/json'
            }
        })
            .then(response => {
                if (!response.ok) {
                    throw new Error(`Ceres API returned ${response.status}`);
                }
                return response.json();
            })
            .then(data => {
                // TODO(IT): confirm the actual field name Ceres returns for the order number
                // (this assumes `data.orderNumber`; adjust if it's e.g. `data.number` or `data.value[0].number`)
                const orderNumber = data.orderNumber || data.number || '';
                if (!orderNumber) {
                    throw new Error('No order number found in Ceres response');
                }
                formData.orderNumber = orderNumber;
                document.getElementById('of-orderNumber').value = orderNumber;
                saveData();
            })
            .catch(error => {
                document.getElementById('of-orderNumber').value = 'Error fetching order';
                console.error('Ceres API error:', error);
            });
    } else {
        // Mock call - simulates API delay. Remove this block once CERES_API_ENABLED is true.
        setTimeout(() => {
            const mockOrderId = Math.floor(Math.random() * 1000000).toString().padStart(6, '0');
            formData.orderNumber = `AOR${mockOrderId}`;
            document.getElementById('of-orderNumber').value = formData.orderNumber;
            saveData();
        }, 800);
    }
}

// Export current order (location/date/order number + items) to a single-sheet .xlsx file.
// Download-only — does not save to the saved-orders log. Use the
// "💾 Save" button to save without downloading anything.
function exportToExcel() {
    const location = document.getElementById('of-location').value;
    const date = document.getElementById('of-date').value;
    const orderNumber = formData.orderNumber || '';

    const baseRow = {
        'Location': location,
        'Date': date,
        'Order Number': orderNumber
    };

    const rows = items.length
        ? items.map(item => buildItemExportRow(baseRow, item))
        : [buildItemExportRow(baseRow, null)];

    const sheet = XLSX.utils.json_to_sheet(rows);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Order');

    const safeLocation = (location || 'order').replace(/[^a-z0-9]+/gi, '_');
    const safeDate = date || new Date().toISOString().split('T')[0];
    const filename = `DistributionOrder_${safeLocation}_${safeDate}.xlsx`;

    XLSX.writeFile(wb, filename);
    showImportStatus(`Exported to ${filename}`, 'success');
}

// Map flexible/variant column headers to our internal field names
const IMPORT_HEADER_MAP = {
    'location': 'location',
    'date': 'date',
    'order number': 'orderNumber', 'order #': 'orderNumber', 'order#': 'orderNumber',
    'item #': 'itemNum', 'item#': 'itemNum', 'itemnum': 'itemNum', 'item number': 'itemNum', 'item': 'itemNum',
    'description': 'description', 'item description': 'description',
    'pallet #': 'palletNum', 'pallet#': 'palletNum', 'pallet number': 'palletNum', 'pallet': 'palletNum',
    'need to pull qty': 'needToPull', 'need to pull': 'needToPull', 'qty': 'needToPull', 'quantity': 'needToPull', 'needtopull': 'needToPull',
    'need to pull unit': 'pullUnit', 'unit': 'pullUnit',
    'qty pulled': 'qtyPulled', 'quantity pulled': 'qtyPulled',
    'qty returned': 'returned', 'returned': 'returned', 'quantity returned': 'returned',
    'qty used': 'used', 'used': 'used', 'quantity used': 'used'
};

function normalizeHeader(h) {
    return String(h || '').trim().toLowerCase();
}

// Import items + order info from a single-sheet (or first-sheet) .xlsx/.xls/.csv file
function importFromExcel(event) {
    const file = event.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function(e) {
        try {
            const data = new Uint8Array(e.target.result);
            const wb = XLSX.read(data, { type: 'array' });

            const sheetName = wb.SheetNames.find(n => n.trim().toLowerCase() === 'order') || wb.SheetNames[0];
            const json = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { defval: '' });

            if (!json.length) {
                showImportStatus('No rows found in that file.', 'error');
                return;
            }

            // Location / Date / Order Number are read from the first row that has them
            for (const row of json) {
                let locationVal = '', dateVal = '', orderNumVal = '';
                Object.keys(row).forEach(col => {
                    const field = IMPORT_HEADER_MAP[normalizeHeader(col)];
                    const value = String(row[col]).trim();
                    if (field === 'location' && value) locationVal = value;
                    if (field === 'date' && value) dateVal = value;
                    if (field === 'orderNumber' && value) orderNumVal = value;
                });
                if (locationVal) document.getElementById('of-location').value = locationVal;
                if (dateVal) document.getElementById('of-date').value = dateVal;
                if (orderNumVal) {
                    formData.orderNumber = orderNumVal;
                    document.getElementById('of-orderNumber').value = orderNumVal;
                }
                if (locationVal || dateVal || orderNumVal) break;
            }

            const importedItems = json.map((row, idx) => {
                const item = {
                    id: Date.now() + idx,
                    itemNum: '', palletNum: '', description: '',
                    needToPull: '', pullUnit: '', qtyPulled: '', returned: '', used: ''
                };
                Object.keys(row).forEach(col => {
                    const field = IMPORT_HEADER_MAP[normalizeHeader(col)];
                    if (field && field !== 'location' && field !== 'date' && field !== 'orderNumber') {
                        item[field] = String(row[col]).trim();
                    }
                });
                return item;
            }).filter(item => item.itemNum || item.description);

            if (!importedItems.length) {
                showImportStatus('Could not find recognizable item columns in that file.', 'error');
                return;
            }

            items = importedItems;
            renderItems();
            saveData();
            showImportStatus(`Imported ${importedItems.length} item(s) from ${file.name}.`, 'success');
        } catch (err) {
            console.error('Import error:', err);
            showImportStatus('Could not read that file. Please check it is a valid Excel/CSV file.', 'error');
        }
        event.target.value = ''; // allow re-importing the same file if needed
    };
    reader.readAsArrayBuffer(file);
}

function showImportStatus(message, type) {
    showStatusMessage('importStatus', message, type);
}

function addItem() {
    items.unshift({
        id: Shared.uid(),
        itemNum: '',
        palletNum: '',
        description: '',
        needToPull: '',
        pullUnit: '',
        qtyPulled: '',
        returned: '',
        used: ''
    });
    renderItems();
    saveData();
}

function removeItem(id) {
    const item = items.find(i => i.id === id);
    const hasData = item && (item.itemNum || item.description || item.palletNum || item.needToPull || item.pullUnit || item.qtyPulled || item.returned || item.used);
    if (hasData) {
        const label = [item.itemNum, item.description].filter(Boolean).join(' — ') || 'this item';
        if (!confirm(`Remove ${label} from this order?`)) return;
    }
    items = items.filter(item => item.id !== id);
    renderItems();
    saveData();
}

// In-app clipboard for copying an item list from one order to the
// next. Persisted to localStorage (not just kept in memory) so it
// still works after switching to a different scheduled order,
// which reloads the items table.
function copyItemsToClipboard() {
    if (!items.length) {
        showImportStatus('No items to copy yet.', 'error');
        return;
    }
    // Strip ids — paste always assigns fresh ones, so old ids
    // don't matter and aren't worth carrying along.
    const copyable = items.map(({ id, ...rest }) => rest);
    _getDb().copiedItems = copyable; _persist();
    showImportStatus(`Copied ${items.length} item(s). Switch to another order and click "Paste Items".`, 'success');
}

function pasteItemsFromClipboard() {
    const stored = JSON.stringify(_getDb().copiedItems || []);
    const copied = stored ? JSON.parse(stored) : [];
    if (!copied.length) {
        showImportStatus('Nothing copied yet — use "Copy Items" on an order first.', 'error');
        return;
    }
    const pasted = copied.map((it, idx) => ({ ...it, id: Date.now() + idx }));
    items = [...pasted, ...items];
    renderItems();
    saveData();
    showImportStatus(`Pasted ${pasted.length} item(s).`, 'success');
}

// Manually wipes the Items table. This is the only thing that
// clears it — switching scheduled orders no longer does this
// automatically, so the table stays as-is until the person is
// ready to start entering the next order's items.
function clearItemsManually() {
    if (!items.length) return;
    const count = items.length;
    const proceed = confirm(`Clear all ${count} item(s) from the table? Make sure the current order has already been saved or printed first.`);
    if (!proceed) return;
    const backup = items;
    items = [];
    renderItems();
    saveData();
    showUndoToast(`Cleared ${count} item(s).`, () => {
        items = backup;
        renderItems();
        saveData();
    });
}

// Strips anything that isn't a digit as the person types. Plain
// type="number" inputs still technically allow characters like
// "e", "+", "-", and "." (valid per the number-input spec, since
// it's built for things like exponents), which is how letters
// were slipping into the Need to Pull quantity field.
function sanitizeQtyInput(el) {
    const cleaned = el.value.replace(/[^0-9]/g, '');
    if (cleaned !== el.value) el.value = cleaned;
}

// Uppercases text as it's typed (used for Item #, since produce
// codes are always uppercase). Preserves cursor position so typing
// lowercase still feels natural instead of jumping the caret.
function uppercaseInput(el) {
    const upper = el.value.toUpperCase();
    if (upper !== el.value) {
        const pos = el.selectionStart;
        el.value = upper;
        try { el.setSelectionRange(pos, pos); } catch (e) { /* ignore for input types that don't support it */ }
    }
}

// Column order for Left/Right navigation across a row.
const ITEM_COLUMN_ORDER = ['col-itemNum', 'col-palletNum', 'col-description', 'col-needToPull', 'col-pullUnit'];

// True if moving left/right from here would just be normal text-cursor
// movement (i.e. NOT at the edge of the field's text, or there's an
// active selection) — in which case we should leave it alone rather
// than hijacking it for field-to-field navigation.
function isAtFieldEdge(el, direction) {
    if (el.tagName !== 'INPUT') return true; // <select> has no text cursor
    if (el.type === 'number') return true; // number inputs don't reliably support selectionStart in all browsers
    try {
        if (el.selectionStart !== el.selectionEnd) return false;
        return direction === 'left' ? el.selectionStart === 0 : el.selectionStart === el.value.length;
    } catch (e) {
        return true;
    }
}

// Lets arrow keys move focus between fields (like a spreadsheet):
// Up/Down moves between rows in the same column, Left/Right moves
// between columns in the same row (only once the cursor is at the
// edge of the field's text, so normal editing still works). This
// overrides the browser's native per-field behavior that was
// silently "eating" arrow keys before: number inputs (Need to
// Pull, Qty Returned, Qty Used) treat Up/Down as increment/
// decrement, and datalist-backed fields (Item #, Description)
// treat them as browsing the autocomplete suggestion list.
function handleArrowNav(event, id, colClass) {
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
        const rows = Array.from(document.querySelectorAll('#of-itemsContainer tr[data-row-id]'));
        const currentIndex = rows.findIndex(row => Number(row.dataset.rowId) === id);
        if (currentIndex === -1) return;
        const targetIndex = event.key === 'ArrowUp' ? currentIndex - 1 : currentIndex + 1;
        if (targetIndex < 0 || targetIndex >= rows.length) return;
        const targetInput = rows[targetIndex].querySelector('.' + colClass);
        if (!targetInput) return;
        event.preventDefault();
        targetInput.focus();
        if (targetInput.tagName === 'INPUT') targetInput.select();
        return;
    }

    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        const direction = event.key === 'ArrowLeft' ? 'left' : 'right';
        if (!isAtFieldEdge(event.target, direction)) return;
        const colIndex = ITEM_COLUMN_ORDER.indexOf(colClass);
        if (colIndex === -1) return;
        const targetColIndex = direction === 'left' ? colIndex - 1 : colIndex + 1;
        if (targetColIndex < 0 || targetColIndex >= ITEM_COLUMN_ORDER.length) return;
        const row = document.querySelector(`tr[data-row-id="${id}"]`);
        const targetInput = row && row.querySelector('.' + ITEM_COLUMN_ORDER[targetColIndex]);
        if (!targetInput) return;
        event.preventDefault();
        targetInput.focus();
        if (targetInput.tagName === 'INPUT') targetInput.select();
    }
}

// Tabbing forward out of the last field (Qty Used) of the bottom-most row
// automatically adds a new row and moves focus into it, for quick continuous entry.
function handleLastFieldKeydown(event, id) {
    if (event.key !== 'Tab' || event.shiftKey) return;
    const isLastRow = items.length > 0 && items[items.length - 1].id === id;
    if (!isLastRow) return;
    event.preventDefault();
    addItem();
    requestAnimationFrame(() => {
        const newRow = document.querySelector(`tr[data-row-id="${items[0].id}"]`);
        const input = newRow && newRow.querySelector('.item-num-input');
        if (input) input.focus();
    });
}

function updateItem(id, field, value) {
    const item = items.find(i => i.id === id);
    if (item) {
        item[field] = value;
        saveData();
        refreshItemsSummary();
    }
}

// Populate the produce autocomplete lists once at startup
function populateProduceDatalists() {
    const numList = document.getElementById('of-produceNumList');
    const descList = document.getElementById('of-produceDescList');
    let numHtml = '';
    let descHtml = '';
    produceItems.forEach(p => {
        numHtml += `<option value="${p.itemNum}">${p.description}</option>`;
        descHtml += `<option value="${p.description}">${p.itemNum}</option>`;
    });
    numList.innerHTML = numHtml;
    descList.innerHTML = descHtml;
}

// When Item # is picked/typed, auto-fill Description if it's a known produce code
function handleItemNumChange(id, value) {
    updateItem(id, 'itemNum', value);
    const match = produceItems.find(p => p.itemNum.toLowerCase() === value.trim().toLowerCase());
    if (match) {
        updateItem(id, 'description', match.description);
        const row = document.querySelector(`tr[data-row-id="${id}"]`);
        const descInput = row && row.querySelector('.description-input');
        if (descInput) descInput.value = match.description;
    }
    updateDuplicateWarnings();
}

// When Description is picked/typed, auto-fill Item # if it's a known produce item
function handleDescriptionChange(id, value) {
    updateItem(id, 'description', value);
    const match = produceItems.find(p => p.description.trim().toLowerCase() === value.trim().toLowerCase());
    if (match) {
        updateItem(id, 'itemNum', match.itemNum);
        const row = document.querySelector(`tr[data-row-id="${id}"]`);
        const numInput = row && row.querySelector('.item-num-input');
        if (numInput) numInput.value = match.itemNum;
    }
}

function renderItems() {
    const container = document.getElementById('of-itemsContainer');
    
    if (items.length === 0) {
        container.innerHTML = '<div class="empty-state">No items added yet. Click "Add item" to get started.</div>';
        return;
    }

    let html = `<table>
        <colgroup>
            <col style="width: 15%;">
            <col style="width: 9%;">
            <col style="width: 24%;">
            <col style="width: 15%;">
            <col style="width: 7%;">
            <col style="width: 7%;">
            <col style="width: 7%;">
            <col style="width: 16%;">
        </colgroup>
        <thead><tr><th>Item #</th><th>Pallet #</th><th>Description</th><th>Need to Pull</th><th>Qty Pulled</th><th>Qty Ret.</th><th>Qty Used</th><th class="action-col">Action</th></tr></thead><tbody>`;

    items.forEach(item => {
        html += `
            <tr data-row-id="${item.id}">
                <td><input type="text" class="table-input col-itemNum item-num-input" list="of-produceNumList" value="${Shared.escapeHtml(item.itemNum)}" onchange="OrderForm.handleItemNumChange(${item.id}, this.value)" oninput="OrderForm.uppercaseInput(this)" onkeydown="OrderForm.handleArrowNav(event, ${item.id}, 'col-itemNum')" placeholder="e.g. APPL-D003"></td>
                <td><input type="text" class="table-input col-palletNum" value="${Shared.escapeHtml(item.palletNum)}" onchange="OrderForm.updateItem(${item.id}, 'palletNum', this.value)" onkeydown="OrderForm.handleArrowNav(event, ${item.id}, 'col-palletNum')" placeholder="e.g. P1234"></td>
                <td><input type="text" class="table-input col-description description-input" list="of-produceDescList" value="${Shared.escapeHtml(item.description)}" onchange="OrderForm.handleDescriptionChange(${item.id}, this.value)" onkeydown="OrderForm.handleArrowNav(event, ${item.id}, 'col-description')" placeholder="Start typing produce name..."></td>
                <td style="display: flex; gap: 4px; padding: 6px; overflow: hidden;">
                    <input type="number" min="0" step="1" inputmode="numeric" pattern="[0-9]*" class="table-input col-needToPull" value="${Shared.escapeHtml(item.needToPull)}" onchange="OrderForm.updateItem(${item.id}, 'needToPull', this.value)" oninput="OrderForm.sanitizeQtyInput(this)" onkeydown="OrderForm.handleArrowNav(event, ${item.id}, 'col-needToPull')" placeholder="Qty" style="flex: 1 1 0; min-width: 0;">
                    <select class="table-input col-pullUnit" onchange="OrderForm.updateItem(${item.id}, 'pullUnit', this.value)" onkeydown="OrderForm.handleArrowNav(event, ${item.id}, 'col-pullUnit'); handleLastFieldKeydown(event, ${item.id})" style="flex: 0 0 52px; padding-left: 2px; padding-right: 2px;"><option value="">Unit</option><option value="PLT" ${item.pullUnit === 'PLT' ? 'selected' : ''}>PLT</option><option value="BIN" ${item.pullUnit === 'BIN' ? 'selected' : ''}>BIN</option><option value="CS" ${item.pullUnit === 'CS' ? 'selected' : ''}>CS</option><option value="LBS" ${item.pullUnit === 'LBS' ? 'selected' : ''}>LBS</option></select>
                </td>
                <td style="background-color: #f9f9f9;" title="Filled in by hand on the printed sheet"></td>
                <td style="background-color: #f9f9f9;" title="Filled in by hand on the printed sheet"></td>
                <td style="background-color: #f9f9f9;" title="Filled in by hand on the printed sheet"></td>
                <td class="action-col"><button class="btn-danger" onclick="OrderForm.removeItem(${item.id})">Remove</button></td>
            </tr>
        `;
    });

    html += '</tbody></table>';
    container.innerHTML = '<div class="table-scroll">' + html + '</div>' + buildItemsSummary();
    updateDuplicateWarnings();
}

// Highlights any rows whose Item # is duplicated elsewhere in the
// current order, so the coordinator can catch accidental repeats
// before printing. Runs after render and after any Item # edit.
function updateDuplicateWarnings() {
    const counts = {};
    items.forEach(it => {
        const key = (it.itemNum || '').trim().toLowerCase();
        if (!key) return;
        counts[key] = (counts[key] || 0) + 1;
    });
    document.querySelectorAll('#of-itemsContainer tr[data-row-id]').forEach(row => {
        const id = Number(row.dataset.rowId);
        const item = items.find(it => it.id === id);
        const key = item ? (item.itemNum || '').trim().toLowerCase() : '';
        const isDup = !!(key && counts[key] > 1);
        row.classList.toggle('duplicate-item-row', isDup);
        const input = row.querySelector('.item-num-input');
        if (input) input.title = isDup ? 'This Item # appears more than once in this order' : '';
    });
}

// Small on-screen summary (item count + Need to Pull totals by
// unit) so the coordinator can sanity-check the order before
// printing, without having to add everything up by hand.
function buildItemsSummary() {
    if (!items.length) return '';
    let itemCount = 0;
    const unitTotals = {};
    items.forEach(it => {
        if (it.itemNum || it.description) itemCount++;
        const qty = parseFloat(it.needToPull);
        if (!isNaN(qty) && qty > 0) {
            const unit = it.pullUnit || 'unit(s)';
            unitTotals[unit] = (unitTotals[unit] || 0) + qty;
        }
    });
    const unitParts = Object.keys(unitTotals).map(u => `${unitTotals[u]} ${Shared.escapeHtml(u)}`);
    const qtyText = unitParts.length ? unitParts.join(', ') : 'no quantities entered yet';
    return `<div class="items-summary" id="itemsSummary">${itemCount} item${itemCount !== 1 ? 's' : ''} on this order &nbsp;•&nbsp; Need to Pull: ${qtyText}</div>`;
}

// Refreshes just the summary line (item count / Need to Pull totals)
// without re-rendering the whole table, so it stays live as
// quantities/units change without disturbing focus mid-edit.
function refreshItemsSummary() {
    const el = document.getElementById('itemsSummary');
    if (el) el.outerHTML = buildItemsSummary();
}

// Builds the print HTML for a single order (used for both the
// regular single-order print and the batch "print saved orders"
// Formats a YYYY-MM-DD date string as "Month Day, Year" for print
// (e.g. "August 31, 2026"). Deliberately does this with plain
// string splitting rather than `new Date(isoString)`, since that
// parses as UTC midnight and can display as the WRONG day in
// timezones behind UTC (a classic JS date gotcha).
function formatDateForPrint(isoDate) {
    if (!isoDate) return '';
    const parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    const [year, month, day] = parts.map(Number);
    const monthNames = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
    if (!year || !month || !day || month < 1 || month > 12) return isoDate;
    return `${monthNames[month - 1]} ${day}, ${year}`;
}

// flow). `order` is { location, date, orderNumber, items }.
function buildOrderPrintHtml(order) {
    const location = order.location || '';
    const date = order.date || '';
    const displayDate = formatDateForPrint(date);
    const orderNumber = order.orderNumber || '';
    const orderItems = order.items || [];

    // These same constants are used again below for blank-row
    // sizing; computed early here too so we can decide whether the
    // repeating Location/Date/Order # line (which only matters if
    // this order spans multiple pages) should be included at all.
    // NOTE: this is a heuristic based on our own estimated
    // single-page row budget, not an exact measurement of what the
    // browser will actually do when printed — it can't be, since
    // JS has no way to know real page breaks in advance. If an
    // order that clearly needs 2 pages doesn't get this line (or
    // vice versa), singlePageBudgetPx below is the number to tune.
    const singlePageBudgetPx = 400; // ~25 items' worth (25 * 16px), based on real print testing
    const dataRowHeightPx = 16;
    const blankRowHeightPx = 30;
    const preferredHandwrittenRows = 5; // soft target for shorter orders — never forced if it wouldn't fit
    const likelyMultiPage = (orderItems.length * dataRowHeightPx) > singlePageBudgetPx;

    let printHtml = `
        <div class="print-header">
            <h1>PERISHABLE DISTRIBUTION PULL SHEET</h1>
            <p>Distribution Inventory Pull Form</p>
        </div>

        <div class="print-info">
            <span class="print-info-field"><span class="print-info-label">Location:</span> ${location || '___________________'}</span>
            <span class="print-info-field"><span class="print-info-label">Date:</span> ${displayDate || '___________________'}</span>
            <span class="print-info-field"><span class="print-info-label">Order Number:</span> ${orderNumber || '___________________'}</span>
        </div>

        <div class="print-table-wrap">
        <table class="print-table">
            <colgroup>
                <col style="width: 14%;">
                <col style="width: 11%;">
                <col style="width: 27%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
                <col style="width: 12%;">
            </colgroup>
            <thead>
                ${likelyMultiPage ? `
                <tr class="print-repeat-info">
                    <th colspan="7">${Shared.escapeHtml(location) || '___________'} &nbsp;•&nbsp; ${Shared.escapeHtml(displayDate) || '___________'} &nbsp;•&nbsp; Order #: ${Shared.escapeHtml(orderNumber) || '___________'}</th>
                </tr>` : ''}
                <tr>
                    <th>ITEM #</th>
                    <th>Pallet #</th>
                    <th>Item Description</th>
                    <th>Need to Pull</th>
                    <th>Qty Pulled</th>
                    <th>Qty Returned</th>
                    <th>Qty Used</th>
                </tr>
            </thead>
            <tbody>
    `;

    // Add items
    orderItems.forEach(item => {
        let needToPullDisplay = '';
        if (item.needToPull && item.pullUnit) {
            needToPullDisplay = `${item.needToPull} ${item.pullUnit}`;
        } else if (item.pullUnit) {
            needToPullDisplay = item.pullUnit;
        } else if (item.needToPull) {
            needToPullDisplay = item.needToPull;
        }
        printHtml += `
            <tr>
                <td>${Shared.escapeHtml(item.itemNum)}</td>
                <td>${Shared.escapeHtml(item.palletNum)}</td>
                <td>${Shared.escapeHtml(item.description)}</td>
                <td>${Shared.escapeHtml(needToPullDisplay)}</td>
                <td></td>
                <td>${Shared.escapeHtml(item.returned)}</td>
                <td>${Shared.escapeHtml(item.used)}</td>
            </tr>
        `;
    });

    // Add blank rows for the warehouse/driver to fill in by hand
    // Blank rows are sized based on remaining page space (in px),
    // not a flat row count — a flat count doesn't work well since
    // blank rows (30px, sized for handwriting) and real item rows
    // (16px) take up very different amounts of space. This
    // estimates how much vertical room is left on page 1 after
    // the header/info/thead/footer overhead, and fills it with
    // AT MOST a handful of blank rows — but only ever as many as
    // actually fit. Blank rows are never forced past what fits,
    // because the signature line getting pushed to an orphan
    // page-2-with-no-items is a worse outcome than having fewer
    // (or zero) blank handwriting rows on a nearly-full order.
    const remainingForBlanksPx = singlePageBudgetPx - (orderItems.length * dataRowHeightPx);
    const blanksThatFit = Math.max(0, Math.floor(remainingForBlanksPx / blankRowHeightPx));
    const blankRows = Math.min(preferredHandwrittenRows, blanksThatFit);
    for (let i = 0; i < blankRows; i++) {
        printHtml += `
            <tr style="height: 30px;">
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
                <td></td>
            </tr>
        `;
    }

    printHtml += `
            </tbody>
        </table>
        </div>

        <div class="print-signatures" style="display: grid; grid-template-columns: 1fr 1fr; gap: 1rem; margin-top: 0.4in;">
            <div style="font-size: 11px; color: #666;">
                <p style="margin: 0 0 2px 0;">Pulled By: ________________________ Date: ______</p>
            </div>
            <div style="font-size: 11px; color: #666;">
                <p style="margin: 0;">Checked By: ________________________ Date: ______</p>
            </div>
        </div>
        <div style="font-size: 7px; color: #ccc; margin-top: 4px;">Build: 2026-08-31 — v.print-font-20px</div>
    `;

    return printHtml;
}

// Shared by showPrintPreview() and showBatchPrintPreview() below —
// both switch from the editing view to the print view and trigger
// the browser print dialog the same way.
function switchToPrintViewAndPrint() {
    document.body.classList.add('of-printing');
    const pv = document.getElementById('of-printView');
    if (pv) pv.classList.add('open');
    setTimeout(() => window.print(), 100);
}

function showPrintPreview() {
    const location = document.getElementById('of-location').value;
    const date = document.getElementById('of-date').value;
    const missing = [];
    if (!location) missing.push('Location');
    if (!date) missing.push('Date');
    if (missing.length) {
        const proceed = confirm(`${missing.join(' and ')} ${missing.length > 1 ? 'are' : 'is'} still blank. Print this form anyway?`);
        if (!proceed) return;
    }

    logCurrentOrder();
    const order = {
        location: location,
        date: date,
        orderNumber: document.getElementById('of-orderNumber').value,
        items: items
    };

    const printContent = document.getElementById('of-printContent');
    printContent.className = 'print-preview';
    printContent.innerHTML = buildOrderPrintHtml(order);

    switchToPrintViewAndPrint();
}

// Prints multiple saved orders together in one print job, each on
// its own separate sheet of paper.
function showBatchPrintPreview(orders) {
    const printContent = document.getElementById('of-printContent');
    // Each order gets its own full-page ".print-preview" box, so
    // remove that class from the outer wrapper to avoid nesting it
    // inside another page-sized flex box.
    printContent.className = '';
    printContent.innerHTML = orders.map((order, i) => {
        const breakStyle = i < orders.length - 1 ? 'page-break-after: always;' : '';
        return `<div class="print-preview" style="${breakStyle}">${buildOrderPrintHtml(order)}</div>`;
    }).join('');

    switchToPrintViewAndPrint();
}

function hidePrintPreview() {
    document.body.classList.remove('of-printing');
    const pv = document.getElementById('of-printView');
    if (pv) pv.classList.remove('open');
}

// Shows a saved order's content (read-only, print-styled) without
// triggering the browser's print dialog — for the "👁 View" button
// in the Print Saved Orders panel, so an order can be checked
// before deciding to actually print it.
function previewSavedOrder(index) {
    const order = savedOrdersSorted[index];
    if (!order) return;
    const printContent = document.getElementById('of-printContent');
    printContent.className = 'print-preview';
    printContent.innerHTML = buildOrderPrintHtml(order);
    document.body.classList.add('of-printing');
    const pv = document.getElementById('of-printView');
    if (pv) pv.classList.add('open');
}

const api = {
    init,
    activate,
    getItems,
    flush,
    addItem,
    removeItem,
    updateItem,
    handleItemNumChange,
    handleDescriptionChange,
    handleArrowNav,
    handleLastFieldKeydown,
    uppercaseInput,
    sanitizeQtyInput,
    copyItemsToClipboard,
    pasteItemsFromClipboard,
    clearItemsManually,
    saveCurrentOrder,
    showPrintPreview,
    hidePrintPreview,
    exportToExcel,
    importFromExcel,
    exportLogToExcel,
    importSchedule,
    handleScheduleSelect,
    handleMoreActionsMenu,
    handleOrderNumberChange,
    showAddLocationPanel,
    cancelAddLocation,
    confirmAddLocation,
    toggleOrientationSelect,
    setPrintOrientation,
    handleUndoToastClick,
    toggleSavedOrdersPanel,
    printSelectedSavedOrders,
    previewSavedOrder,
    deleteSavedOrder,
    selectSavedOrdersForCurrentDate,
    selectAllSavedOrders
};

// Wrap XLSX-dependent exports
const _exportToExcel = exportToExcel;
api.exportToExcel = function() { return ensureXlsxLoaded().then(() => _exportToExcel()); };
const _importFromExcel = importFromExcel;
api.importFromExcel = function(ev) { ensureXlsxLoaded().then(() => _importFromExcel(ev)).catch(err => showImportStatus(err.message, 'error')); };
const _exportLogToExcel = exportLogToExcel;
api.exportLogToExcel = function() { return ensureXlsxLoaded().then(() => _exportLogToExcel()); };
const _importSchedule = importSchedule;
api.importSchedule = function(ev) { ensureXlsxLoaded().then(() => _importSchedule(ev)).catch(err => showScheduleImportStatus(err.message, 'error')); };

return api;
})();
