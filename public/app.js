'use strict';

const app = document.getElementById('app');
let socket = null;

// Presentation only: retain the same permission-gated modules and cart state.
const mobileLayout = globalThis.matchMedia?.('(max-width: 900px)') || { matches: false };
const mobileFilterExpanded = new Map();
let mobileCartButton = null;
mobileLayout.addEventListener?.('change', () => {
  document.querySelectorAll('.bo-nav').forEach(nav => { nav.open = !mobileLayout.matches; });
  document.querySelectorAll('.filter-more').forEach(panel => {
    if(panel.classList.contains('bi-advanced'))return;
    panel.open = !mobileLayout.matches || mobileFilterExpanded.get(panel.dataset.filterKey) === true;
  });
});

// Table nodes stay actual tables; contain horizontal scrolling after insertion.
// This also covers tables added asynchronously inside existing dialogs.
let responsiveUiPending = false;
const dialogOrigins = new Map();
function enhanceResponsiveUi() {
  responsiveUiPending = false;
  document.querySelectorAll('table.report-table').forEach(table => {
    if (table.closest('.filter-table, .perm-table-wrap, .responsive-table')) return;
    const region = h('div', { class: 'responsive-table', tabindex: '0', role: 'region',
      'aria-label': 'Scrollable data table' });
    table.before(region); region.append(table);
  });
  document.querySelectorAll('.filter-table, .perm-table-wrap').forEach(region => {
    region.setAttribute('tabindex', '0');
    region.setAttribute('role', 'region');
    if (!region.hasAttribute('aria-label')) region.setAttribute('aria-label', 'Scrollable data table');
  });
  document.querySelectorAll('.overlay .modal').forEach(dialog => {
    if (dialogOrigins.has(dialog)) return;
    dialogOrigins.set(dialog, document.activeElement);
    dialog.setAttribute('role', 'dialog'); dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('tabindex', '-1');
    const title = dialog.querySelector('h2');
    if (title) {
      title.id ||= 'pos-dialog-' + (++enhanceResponsiveUi.dialogId);
      dialog.setAttribute('aria-labelledby', title.id);
    }
    dialog.addEventListener('keydown', event => {
      if (event.key !== 'Tab') return;
      const controls = [...dialog.querySelectorAll('button,input,select,textarea,[tabindex]')]
        .filter(node => !node.disabled && node.tabIndex >= 0 && node.getClientRects().length);
      if (!controls.length) { event.preventDefault(); dialog.focus(); return; }
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        event.preventDefault(); last.focus();
      } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialog)) {
        event.preventDefault(); first.focus();
      }
    });
    // Focus the dialog itself, not an input that would unexpectedly open a keyboard.
    dialog.focus({ preventScroll: true });
  });
  for (const [dialog, previous] of dialogOrigins) {
    if (!dialog.isConnected) {
      dialogOrigins.delete(dialog);
      if (previous?.isConnected && !document.querySelector('.overlay')) previous.focus({ preventScroll: true });
    }
  }
}
enhanceResponsiveUi.dialogId = 0;
const responsiveUiObserver = typeof MutationObserver === 'undefined' ? null : new MutationObserver(records => {
  if (!records.some(record => record.type === 'childList')) return;
  if (!responsiveUiPending) { responsiveUiPending = true; requestAnimationFrame(enhanceResponsiveUi); }
});
responsiveUiObserver?.observe(document.body, { childList: true, subtree: true });

function initialState() { return {
  filterDrafts: {}, filterErrors: {}, filters: {}, filterPages: {}, filterOptions: null, filterOptionsLoading: false, ledger: {},
  token: null, // local request-generation marker, never a credential
  csrfToken: null, sessionContext: null,
  user: null,
  permissions: [],
  tab: 'new',
  products: [],
  categories: [],
  activeCategory: null,
  cart: new Map(),
  orderShiftId: undefined,
  orderShiftChoice: '',
  orders: [],
  orderFilter: 'ALL',
  waiters: [],
  addTo: null,
  waiterId: '',
  sending: false,
  mergeMode: false,
  selected: new Set(),
  timer: null,
  // Back office
  boTab: 'reports',
  dashboardData:null, dashboardLoading:false, inventoryReportData:null, globalPeriod:null,
  reportTab: 'daily',
  reportDate: '',
  reportData: null,
  reportLoading: false,
  pnlStart: '',
  pnlEnd: '',
  pnlData: null,
  commissionsData: null,
  stockData: null,
  stockLoading: false,
  stockCountMode: false,
  stockCountData: null,
  stockCountSession: null,
  stockCountClockOffset: 0,
  stockCountBusy: false,
  pendingCounts: null,
  staffData: null,
  staffAdministration: null,
  expensesData: null,
  shiftData: null,
  shiftsList: null,
  permissionsMatrix: null,
}; }
const state = initialState();
let sessionGeneration = 0;
let sessionId = null;
let permissionTimer = null;
let logoutPending = null;
const sessionRequests = new Set();
// Fence asynchronous consumers, including their error/finally paths. Aborting
// transport is only an optimization; a server operation may already commit.
const staleSession = () => Object.assign(new Error('Session changed'), { staleSession: true });
const isCurrentSession = generation => generation === sessionGeneration;

let cartBox = null;
let ordersBox = null;

// ---------- tiny helpers ----------

function h(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === null || value === undefined || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) {
      const generation = sessionGeneration;
      node.addEventListener(key.slice(2), (...args) => {
        if (!isCurrentSession(generation)) return;
        return value(...args);
      });
    }
    else node.setAttribute(key, value);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child.nodeType ? child : document.createTextNode(String(child)));
  }
  return node;
}

const ksh = (n) =>
  'KSh ' + Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 2 });

// Stock numbers: 12.000000 -> 12, 0.975000 -> 0.975
const fmtQty = (n) =>
  Number(n).toLocaleString('en-KE', { minimumFractionDigits: 0, maximumFractionDigits: 3 });

const can = (perm) => state.permissions.includes(perm);
const canBrowseOrders = () => ['sales.split','sales.make', 'sales.view_all', 'pay.cash', 'pay.mpesa', 'sales.merge', 'sales.void', 'sales.remove_item', 'sales.return', 'pay.void', 'sales.discount', 'sales.change_price'].some(can);
const canInventory = () => ['stock.view', 'stock.receive', 'stock.adjust', 'stock.count', 'stock.count_approve', 'purchases.manage'].some(can);
const canReadStock = () => can('stock.view') || can('stock.count');
const canChooseStock = () => can('stock.receive') || can('stock.adjust') || can('purchases.manage');
const canShiftAction = () => can('shifts.manage') || can('pay.cash') || can('pay.mpesa');
let permissionGeneration = 0;
function accessGuard() {
  const generation = sessionGeneration, permissions = permissionGeneration;
  return () => isCurrentSession(generation) && permissions === permissionGeneration;
}

function boAllowed() {
  return {
    accounting: typeof accountingAllowed==='function'&&accountingAllowed(),
    employeeFinance: typeof employeeFinanceAllowed==='function'&&employeeFinanceAllowed(),
    reports: can('reports.sales') || can('reports.financial') || can('commissions.manage') || can('payments.view_collected') || canFinancialAction(),
    inventory: canInventory(),
    staff: can('users.manage'),
    expenses: can('expenses.manage'),
    shifts: can('shifts.manage'),
    permissions: state.user?.role === 'MANAGER' && can('permissions.manage'),
    salesInvoices: can('reports.sales'),
    purchaseInvoices: can('purchases.manage') || can('purchases.view'),
    movements: can('stock.view'),
    settings:can('settings.manage')||can('printers.manage')||can('accounting.settings'),
    dashboard:can('dashboard.view'),
    inventoryReport:can('reports.inventory')&&(can('stock.view')||can('stock.count')),
    countHistory:can('stock.count')||can('stock.count_approve'),
  };
}
const canSeeBackOffice = () => Object.values(boAllowed()).some(Boolean);

function toast(message, bad) {
  const box = h('div', { class: 'toast' + (bad ? ' bad' : '') }, message);
  document.body.append(box);
  setTimeout(() => box.remove(), 3500);
}

function newSessionId() {
  // getRandomValues also works on the existing plain-HTTP LAN deployment.
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('');
}
function discardLegacyToken() {
  for(const storage of ['localStorage','sessionStorage'])try{window[storage].removeItem('habibi_token');window[storage].removeItem('habibi_session_id');}catch(e){}
}
function saveToken() { discardLegacyToken(); sessionId = newSessionId(); }
function loadToken() { discardLegacyToken(); return null; }
function clearToken() { discardLegacyToken(); }
function announceSession(kind,context) { try { localStorage.setItem('habibi_auth_changed',JSON.stringify({kind,context,eventId:newSessionId()})); } catch(e) {} }
async function ensureCsrf() {
  if(state.csrfToken)return state.csrfToken;
  const generation=sessionGeneration;
  const response=await fetch('/api/auth/csrf',{credentials:'same-origin',cache:'no-store'});
  const data=await response.json();if(!isCurrentSession(generation))throw staleSession();
  if(!response.ok||typeof data.csrfToken!=='string')throw Error('Unable to establish a secure session');
  state.csrfToken=data.csrfToken;return state.csrfToken;
}

function clearSession(message = 'Please log in again.', { broadcast = true } = {}) {
  if(typeof acctForgetPendingBody==='function')acctForgetPendingBody();
  if(typeof resetEmployeeFinance==='function')resetEmployeeFinance();
  const token = state.token, previousId = sessionId, context = state.sessionContext;
  ++sessionGeneration;
  stopTimer();
  if (permissionTimer) clearInterval(permissionTimer);
  permissionTimer = null;
  for (const controller of sessionRequests) controller.abort();
  sessionRequests.clear();
  if (socket) { socket.removeAllListeners(); socket.disconnect(); socket = null; }
  redactMutationDraft();
  clearToken(token, previousId);
  sessionId = null;
  Object.assign(state, initialState());
  cartBox = null; ordersBox = null;
  adminWrites.clear(); workflowWrites.clear(); ++staffReadVersion;
  // Dialogs may contain credentials or data outside #app. Erase before removal.
  document.querySelectorAll?.('.overlay, .toast').forEach(node => {
    node.querySelectorAll?.('input').forEach(input => { input.value = ''; });
    node.remove();
  });
  if (broadcast && previousId) {
    announceSession('logout',context);
  }
  showLogin(message);
}

function onSessionStorage(event) {
  if(event.key!=='habibi_auth_changed'||!event.newValue||!state.token)return;
  try {const notice=JSON.parse(event.newValue);if((notice.kind==='login'&&notice.context!==state.sessionContext)||(notice.kind==='logout'&&notice.context===state.sessionContext))clearSession('Browser session changed in another tab. Review your session before continuing.',{broadcast:false});}catch(e){}
}



// A tab-scoped unresolved intent is never silently replayed. Only narrow business
// fields are retained; no PIN, JWT, response models or authorization context.
const mutationInFlight = new Map();
function mutationBody(path, body) {
  const keys = path.endsWith('/payments') ? ['method','amount','reference','shiftId'] : path.endsWith('/items') ? ['items'] : ['items','notes','waiterId','shiftId'];
  if (!body || Object.keys(body).some(k => !keys.includes(k))) throw Error('Invalid operation fields');
  if (body.items && body.items.some(i => Object.keys(i).some(k => !['productId','quantity'].includes(k)))) throw Error('Invalid item fields');
  return JSON.parse(JSON.stringify(body));
}
function readMutationIntent() {
  const value = sessionStorage.getItem('habibi_mutation_' + state.user.id);
  if (!value) return null;
  const intent = JSON.parse(value);
  if (!/^[0-9a-f-]{36}$/i.test(intent.id || '') || !/^\/sales(?:\/[^/]+\/(?:items|payments))?$/.test(intent.path || '') || !/^[0-9a-f]{64}$/.test(intent.fingerprint || '')) throw Error('Unresolved operation record is invalid. Request manual review.');
  if (intent.body) mutationBody(intent.path, intent.body);
  return intent;
}
function redactMutationDraft() {
  if (!state.user?.id) return;
  try { const intent = readMutationIntent(); if (intent) storeMutationIntent({id:intent.id,path:intent.path,fingerprint:intent.fingerprint}); }
  catch { try { sessionStorage.removeItem('habibi_mutation_' + state.user.id); } catch {} }
}
function storeMutationIntent(intent) {
  const key = 'habibi_mutation_' + state.user.id;
  if (intent) sessionStorage.setItem(key, JSON.stringify(intent)); else sessionStorage.removeItem(key);
}
async function reconcileMutation(intent) {
  return apiTransport('/sales/operations/' + intent.id);
}
async function api(path, options = {}) {
  const mutation = (options.method || 'GET') === 'POST' && /^\/sales(?:\/[^/]+\/(?:items|payments))?$/.test(path);
  if (!mutation) return apiTransport(path, options);
  const generation = sessionGeneration, actor = state.user?.id;
  if (!actor || !crypto.subtle || !crypto.randomUUID) throw Error('Secure operation storage is unavailable. No transaction was sent.');
  const body = mutationBody(path, options.body);
  const canonical = v => Array.isArray(v) ? v.map(canonical) : v && typeof v === 'object' ? Object.fromEntries(Object.keys(v).sort().map(k => [k, canonical(v[k])])) : v;
  const bytes = new TextEncoder().encode(JSON.stringify(canonical({ path, body })));
  const fingerprint = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), b => b.toString(16).padStart(2,'0')).join('');
  if (!isCurrentSession(generation) || state.user?.id !== actor) throw staleSession();
  let intent = readMutationIntent();
  if (intent && intent.fingerprint !== fingerprint) throw Error('Resolve the previous uncertain operation using Check pending operation before submitting a new one.');
  if (intent && mutationInFlight.has(intent.id)) return mutationInFlight.get(intent.id);
  if (intent) {
    if (intent.fingerprint !== fingerprint) throw Error('Resolve the previous uncertain operation using Check pending operation before submitting a new one.');
    try {
      const result = await reconcileMutation(intent);
      storeMutationIntent(null); return { ...result, replayed: true, message: 'Previously committed operation reconciled' };
    } catch (error) {
      if (error.status !== 404) throw error;
      if (typeof window.confirm !== 'function' || !window.confirm('No committed result is visible yet. After reviewing current records, retry this SAME operation identifier? No new order or payment will be created for an already committed request.')) throw Error('Operation remains uncertain. Nothing was replayed.');
    }
  } else { intent = { id: crypto.randomUUID(), fingerprint, path, body }; storeMutationIntent(intent); }
  const run = (async () => {
    try {
      const result = await apiTransport(path, { ...options, mutationKey: intent.id });
      if (!result.sale?.id) throw Error('Operation response is incomplete. Reconcile before retrying.');
      if (isCurrentSession(generation) && state.user?.id === actor) storeMutationIntent(null);
      return result;
    } catch (error) {
      if ((error.status === 400 || error.status === 422) && isCurrentSession(generation) && state.user?.id === actor) storeMutationIntent(null);
      throw error;
    } finally { mutationInFlight.delete(intent.id); }
  })();
  mutationInFlight.set(intent.id, run); return run;
}
function mutationNotice() {
  let intent; try { intent = readMutationIntent(); } catch { return h('p',{role:'alert'},'Operation storage needs manual review.'); }
  if (!intent) return null;
  return h('div',{role:'status'}, 'An operation is unresolved. Do not submit a replacement. ',
    h('button',{class:'ghost',onclick:async()=>{
      try { const result = await reconcileMutation(intent); storeMutationIntent(null); toast('Committed operation verified: ' + result.sale.saleNumber); render(); }
      catch(error) {
        if (error.status === 404 && !mutationInFlight.has(intent.id) && intent.body) {
          try { await api(intent.path,{method:'POST',body:intent.body}); toast('Operation reconciled'); render(); } catch(e) { toast(e.message,true); }
        } else toast(error.message,true);
      }
    }},'Check pending operation'));
}

function invalidateBusinessReads(path,method){
 if(['GET','HEAD','OPTIONS'].includes(method||'GET')||path.startsWith('/auth/')||/\/(?:preview|bill-preview)(?:\?|$)/.test(path))return;
 state.readRevision=(state.readRevision||0)+1;
 if(/^\/(?:products|stock)(?:\/|$)/.test(path))state.catalogueDirty=true;
 for(const key of ['reportData','pnlData','commissionsData','dashboardData','inventoryReportData','stockData','expensesData','shiftsList','filterOptions'])state[key]=null;
 for(const key of ['reportLoading','pnlLoading','commissionsLoading','dashboardLoading','stockLoading','filterOptionsLoading'])state[key]=false;
 state.ledger={};
 if(typeof acctUi!=='undefined'){acctUi.readVersion++;acctUi.data=null;acctUi.options=null;acctUi.error=null;acctUi.loading=false;}
 if(typeof efUi!=='undefined'){efUi.readVersion=(efUi.readVersion||0)+1;efUi.data=null;efUi.options=null;efUi.error='';efUi.loading=false;}
 if(typeof coreCatalogue!=='undefined'){coreCatalogue.readVersion=(coreCatalogue.readVersion||0)+1;coreCatalogue.data=null;coreCatalogue.error='';coreCatalogue.loading=false;}
 // Preserve cart, selections, applied/draft filters, pagination and entered forms.
}
async function apiTransport(path, options = {}) {
  const generation = sessionGeneration, token = state.token;
  // Capture before CSRF setup yields; forms clear secret fields immediately after submission.
  const requestBody = options.body ? JSON.stringify(options.body) : undefined;
  if (!token && path !== '/auth/login') { clearSession('Your session has expired or is no longer valid. Please log in again.'); throw staleSession(); }
  const permissionSnapshot = permissionGeneration;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  if (controller) sessionRequests.add(controller);
  const headers = { 'Content-Type': 'application/json' };
  try {
    if (!['GET','HEAD','OPTIONS'].includes(options.method || 'GET')) headers['X-CSRF-Token'] = await ensureCsrf();
    if (!isCurrentSession(generation)) throw staleSession();
    if (options.mutationKey) headers['Idempotency-Key'] = options.mutationKey;
    const res = await fetch('/api' + path, {
      method: options.method || 'GET',
      credentials: 'same-origin',
      headers,
      body: requestBody,
      signal: controller?.signal,
    });
    let data = {};
    try { data = await res.json(); } catch (e) {}
    if (!isCurrentSession(generation)) throw staleSession();
    if (res.status === 401 && path !== '/auth/login') {
      clearSession('Your session has expired or is no longer valid. Please log in again.');
      throw staleSession();
    }

    if (res.ok && permissionSnapshot !== permissionGeneration) {
      throw Object.assign(new Error('Permissions changed. Refresh and review current records; an operation already submitted may have completed.'), { stalePermissions: true });
    }

    if (res.status === 403 && /Refresh your session/.test(data.message||'') && token) { clearSession('Your browser session changed. Review pending operations before signing in again.'); throw staleSession(); }
    if (res.status === 403 && token && state.user && path !== '/permissions/mine') {
      refreshPermissions().catch(() => {});
    }

    if (!res.ok) throw Object.assign(new Error(data.message || 'Something went wrong'), { status: res.status });
    invalidateBusinessReads(path,options.method);
    return data;
  } catch (error) {
    if (!isCurrentSession(generation)) throw staleSession();
    throw error;
  } finally { if (controller) sessionRequests.delete(controller); }
}

function startTimer() {
  stopTimer();
  const generation = sessionGeneration;
  state.timer = setInterval(() => { if (isCurrentSession(generation) && state.user && state.tab === 'orders') loadOrders(); }, 10000);
  if (permissionTimer) clearInterval(permissionTimer);
  permissionTimer = setInterval(() => { if (isCurrentSession(generation) && state.user) refreshPermissions().catch(() => {}); }, 30000);
}
function stopTimer() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

// ---------- Dynamic Permissions ----------

async function refreshPermissions({ silent = true } = {}) {
  const generation = sessionGeneration;
  if (!state.token || !state.user) return;
  let permData;
  try { permData = await api('/permissions/mine'); if (!isCurrentSession(generation)) return; } catch { if (!isCurrentSession(generation)) return; return; }
  if (permData.role) state.user.role = permData.role;

  const newKey = [...permData.permissions].sort().join(',');
  const oldKey = [...state.permissions].sort().join(',');
  if (newKey === oldKey) return;

  redactMutationDraft();
  state.coreCatalogueEnabled = permData.features?.coreCatalogue === true;
  state.corePayrollCorrectionsEnabled = permData.features?.payrollCorrections === true;
  state.permissions = permData.permissions;
  ++permissionGeneration;
  if(typeof resetEmployeeFinance==='function')resetEmployeeFinance();
  state.filterOptions=null; state.filterOptionsLoading=false; state.ledger={}; state.filterPages={}; state.filterErrors={}; state.filterDrafts={};
  // Drop old-authority data and dialogs before any replacement reads. Keep the
  // login/session generation intact; in-flight writes are never retried here.
  for (const key of ['orders', 'products', 'categories', 'waiters']) state[key] = [];
  for (const key of ['staffData', 'staffAdministration', 'expensesData', 'shiftsList', 'permissionsMatrix', 'pendingCounts', 'stockCountSession', 'stockCountData']) state[key] = null;
  state.stockCountMode = false; state.stockCountBusy = false; state.stockLoading = false; state.reportLoading = false;
  state.cart = new Map(); state.addTo = null;
  document.querySelectorAll?.('.overlay').forEach(node => { node.querySelectorAll?.('input').forEach(input => { input.value = ''; }); node.remove(); });
  state.reportData = null;
  state.dashboardData=null;state.dashboardLoading=false;state.inventoryReportData=null;
  state.pnlData = null;
  state.settingsData=null;state.settingsError=null;state.settingsLoading=false;state.settingsAudit=null;state.settingsAuditLoading=false;state.permissionAudit=null;
  state.commissionsData = null;
  state.stockData = null;
  const hasBackOffice = canSeeBackOffice();
  const canSales = canBrowseOrders();

  if (state.tab === 'new' && !can('sales.make')) state.tab = hasBackOffice ? 'backoffice' : 'orders';
  if (state.tab === 'orders' && !canSales) state.tab = hasBackOffice ? 'backoffice' : (can('sales.make') ? 'new' : 'backoffice');
  if (state.tab === 'backoffice' && !hasBackOffice) state.tab = can('sales.make') ? 'new' : 'orders';

  if (state.mergeMode && !can('sales.merge')) { state.mergeMode = false; state.selected = new Set(); }
  if (state.stockCountMode && !can('stock.count') && !can('stock.count_approve')) state.stockCountMode = false;

  if (!silent) toast('Your permissions were updated');
  render();
  // Remove revoked screens immediately, before waiting for replacement data.
  try { await loadCatalogue(); if (!isCurrentSession(generation)) return; } catch (e) { if (!isCurrentSession(generation)) return; }
  if (state.tab === 'new') render();
}

function connectPermissionSocket() {
  if (socket || !state.token || !state.user) return;
  const generation = sessionGeneration;
  const token = state.token;
  const connection = io({ auth: callback => {
    if (!isCurrentSession(generation) || state.token !== token) { connection.disconnect(); return; }
    callback({ csrfToken: state.csrfToken });
  } });
  socket = connection;
  const invalid = () => {
    if (isCurrentSession(generation) && socket === connection) clearSession('Your session has expired or is no longer valid. Please log in again.');
  };
  connection.on('connect_error', error => { if (error?.data?.code === 'SESSION_INVALID') invalid(); });
  connection.on('session:invalid', invalid);
  connection.on('disconnect', reason => { if (reason === 'io server disconnect') invalid(); });
  socket.on('permissions:changed', () => {
    if (isCurrentSession(generation) && state.user) refreshPermissions();
  });
}

// ---------- login ----------

function showLogin(message = '') {
  stopTimer();
  let pin = '';
  const dots = h('div', { class: 'dots' });
  const error = h('div', { class: 'error', role: 'status', 'aria-live': 'polite', id: 'session-message' }, message);
  let submitting = false;

  function refresh() { dots.textContent = pin ? '●'.repeat(pin.length) : 'Enter PIN'; }

  async function submit() {
    let generation = sessionGeneration;
    if (pin.length < 4 || submitting) return;
    submitting = true;
    try {
      const request = api('/auth/login', { method: 'POST', body: { pin } });
      pin = ''; refresh();
      const data = await request;
      if (!isCurrentSession(generation)) return;
      pin = ''; generation = ++sessionGeneration;
      state.token = newSessionId();
      state.csrfToken = data.csrfToken;
      state.sessionContext = data.sessionContext;
      announceSession('login',state.sessionContext);
      state.user = data.user;
      saveToken();
      await startApp();
      if (!isCurrentSession(generation)) return;
      await loadMyShift();
    } catch (err) { if (!isCurrentSession(generation)) return;
      if (err.stalePermissions && state.user && state.token) {
        render(); startTimer(); connectPermissionSocket(); void loadMyShift(); return;
      }
      if (state.token) { clearSession('Unable to open your session. Please log in again.'); return; }
      error.textContent = err.status === 401 ? 'Invalid PIN.' : 'Unable to log in. Please try again.';
      pin = '';
      refresh();
    } finally { if (!isCurrentSession(generation)) return; submitting = false; }
  }

  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', 'C', '0', 'OK'];
  const pad = h('div', { class: 'pad' }, keys.map((k) =>
    h('button', {
      class: 'key',
      onclick: () => {
        error.textContent = '';
        if (k === 'C') pin = '';
        else if (k === 'OK') { submit(); return; }
        else if (pin.length < 6) pin += k;
        refresh();
      },
    }, k)
  ));

  app.replaceChildren(h('div', { class: 'login' }, h('h1', {class:'login-brand'}, brandMark('full')), dots, error, pad));
  refresh();
}

function logout() {
  if (!state.token) return logoutPending || Promise.resolve();
  const token = state.token, csrf = state.csrfToken;
  clearSession('Signing out…');
  const generation = sessionGeneration;
  // Separate from api(): local cleanup aborts old API requests immediately.
  // One attempt only. A local deadline never implies server revocation failed.
  const controller = new AbortController();
  const deadline = setTimeout(() => controller.abort(), 10000);
  const request = (async () => {
    let confirmed = false;
    try {
      const response = await fetch('/api/auth/logout', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type':'application/json','X-CSRF-Token':csrf }, body:'{}', signal: controller.signal });
      confirmed = response.status === 204;
    } catch (e) {} finally { clearTimeout(deadline); }
    if (isCurrentSession(generation) && !state.token) showLogin(confirmed ? 'Signed out on all devices.' : 'Signed out on this device. Server logout could not be confirmed.');
  })();
  logoutPending = request;
  request.finally(() => { if (logoutPending === request) logoutPending = null; });
  return request;
}

// ---------- main screen ----------

async function loadCatalogue() {
  const currentAccess = filterGuard('products');
  let data = { products: [], categories: [] };
  if (can('sales.make') || can('sales.view_all') || can('products.manage')) {
    data = await api('/products'); if (!currentAccess()) return;
  }

  state.waiters = [];
  if (can('sales.view_all')) {
    try {
      const w = await api('/staff/waiters'); if (!currentAccess()) return;
      state.waiters = w.waiters;
    } catch (e) { if (!currentAccess()) return;
      state.waiters = [];
    }
  }

  state.products = data.products.map((p) => ({ ...p, categoryId: p.categoryId || 'none' }));
  state.categories = data.categories.filter((c) => state.products.some((p) => p.categoryId === c.id));
  if (state.products.some((p) => p.categoryId === 'none')) {
    state.categories.push({ id: 'none', name: 'Other' });
  }
  if (!state.categories.some((c) => c.id === state.activeCategory)) {
    state.activeCategory = state.categories.length ? state.categories[0].id : null;
  }
}

async function startApp() {
  const generation = sessionGeneration;
  if (!state.user) {
    const me = await api('/auth/me'); if (!isCurrentSession(generation)) return;
    state.user = me.user;
  }

  const permData = await api('/permissions/mine'); if (!isCurrentSession(generation)) return;
  state.coreCatalogueEnabled = permData.features?.coreCatalogue === true;
  state.corePayrollCorrectionsEnabled = permData.features?.payrollCorrections === true;
  state.permissions = permData.permissions;

  await loadCatalogue(); if (!isCurrentSession(generation)) return;
  state.tab = can('sales.make') ? 'new' : canBrowseOrders() ? 'orders' : canSeeBackOffice() ? 'backoffice' : 'new';
  state.addTo = null;

  render();
  startTimer();
  connectPermissionSocket();
  refreshPermissions({ silent: true });
}

function tabButton(tab, label) {
  return h('button', {
    class: 'tab' + (state.tab === tab ? ' on' : ''),
    onclick: async () => {
      const generation=sessionGeneration;
      if(tab==='new'&&state.catalogueDirty){try{await loadCatalogue();if(!isCurrentSession(generation))return;state.catalogueDirty=false;}catch(e){if(isCurrentSession(generation))toast(e.message,true);return;}}
      if(!isCurrentSession(generation))return;
      state.tab = tab;
      state.mergeMode = false;
      state.selected = new Set();
      if (tab === 'backoffice') {
        state.dashboardData=null;state.inventoryReportData=null;
        state.reportData = null; state.pnlData = null; state.commissionsData = null;
        state.stockData = null; state.stockCountMode = false; state.pendingCounts = null;
        state.staffData = null; state.staffAdministration = null; state.expensesData = null; state.shiftsList = null;
        state.permissionsMatrix = null;
      }
      render();
    },
  }, label);
}

function render() {
  if (state.permissions.length === 0) {
    app.replaceChildren(h('header', {}, h('div', { class: 'who who-branded' }, brandMark('compact'), h('span',{class:'brand-user'},state.user.name + ' · ' + state.user.role)), h('button', { class: 'ghost', onclick: logout }, 'Log out')),
      h('main', { class: 'backoffice' }, h('h2', {}, 'No permissions assigned'), h('p', {}, 'Please contact the manager to grant you permissions.'))
    );
    return;
  }

  const hasBackOfficePerms = canSeeBackOffice();

  const header = h(
    'header', {},
    h('div', { class: 'who who-branded' }, brandMark('compact'), h('span',{class:'brand-user'},state.user.name + ' · ' + state.user.role)),
    h('nav', {},
      can('sales.make') ? tabButton('new', 'New order') : null,
      canBrowseOrders() ? tabButton('orders', 'Orders') : null,
      hasBackOfficePerms ? tabButton('backoffice', 'Back office') : null
    ),
    h('div', { style: 'display:flex; gap: 10px; align-items:center;' },
      can('stock.count') ? h('button', { class: 'ghost', disabled: state.stockLoading, onclick: startStockCount }, 'Stock Count') : null,
      state.shiftData && canShiftAction()
        ? h('button', { class: 'ghost', onclick: () => closeShiftDialog(state.shiftData), style: 'color: #d97706; border-color: #d97706;' }, 'Close Shift')
        : ((can('shifts.manage') || can('pay.cash') || can('pay.mpesa')) ? h('button', { class: 'primary', onclick: openShiftDialog }, 'Open Shift') : null),
      h('button', { class: 'ghost', onclick: logout }, 'Log out')
    )
  );

  const unresolved = mutationNotice(); if (unresolved) header.append(unresolved);

  if (state.stockCountMode && (can('stock.count') || can('stock.count_approve'))) {
    app.replaceChildren(header, h('main', { class: 'backoffice' }, stockCountView()));
    return;
  }

  let body;
  if (state.tab === 'new' && can('sales.make')) body = newOrderView();
  else if (state.tab === 'backoffice' && hasBackOfficePerms) body = backOfficeView();
  else if (state.tab === 'orders' && canBrowseOrders()) body = ordersView();
  else body = h('main', { class: 'backoffice' }, h('p', {}, 'No available workflow for these permissions. Ask a manager to review access.'));

  app.replaceChildren(header, body);

  if (state.tab === 'orders' && canBrowseOrders()) loadOrders();
  if (state.tab === 'backoffice' && hasBackOfficePerms) {
    if(state.boTab==='dashboard'&&!state.dashboardData&&!state.dashboardLoading)void loadDashboard();
    if (state.boTab === 'reports') {
      if (state.reportTab === 'daily' && !state.reportData && !state.reportLoading) loadDailyReport();
      if (state.reportTab === 'pnl' && !state.pnlData) loadPnlReport();
      if (state.reportTab === 'commissions' && !state.commissionsData) loadCommissionsReport();
    }
    if (state.boTab === 'inventory' && !state.stockData && !state.stockLoading) {
      loadStock();
      if (can('stock.count_approve') || can('stock.count')) loadPendingCounts();
    }
    if (state.boTab === 'staff' && !state.staffData) loadStaff();
    if (state.boTab === 'expenses' && !state.expensesData) loadExpenses();
    if (state.boTab === 'shifts' && !state.shiftsList) loadShifts();
    if (state.boTab === 'permissions' && !state.permissionsMatrix) loadPermissions();
  }
}

// ---------- new order ----------

function newOrderView() {
  const cats = h('div', { class: 'cats' }, state.categories.map((c) =>
    h('button', {
      class: 'cat' + (c.id === state.activeCategory ? ' on' : ''),
      onclick: () => { state.activeCategory = c.id; render(); },
    }, c.name)
  ));

  const items = state.products.filter((p) => filterValues('products').q || p.categoryId === state.activeCategory);
  const grid = h('div', { class: 'grid' }, items.map((p) =>
    h('button', { class: 'item', onclick: () => addToCart(p) },
      h('span', { class: 'n' }, p.name),
      h('span', { class: 'p' }, ksh(p.price)))
  ));

  cartBox = h('aside', { class: 'cart', id: 'order-cart', 'aria-label': 'Current order cart' });
  mobileCartButton = h('button', { class: 'primary mobile-only mobile-cart-button',
    'aria-controls': 'order-cart', onclick: () => cartBox.scrollIntoView({ block: 'start' }) });
  renderCart();
  return h('main', { class: 'order-layout' }, h('section', { class: 'menu', id: 'product-menu' },
    cats, grid), cartBox, mobileCartButton);
}

function addToCart(product) {
  if (state.cart.size === 0) { state.orderShiftId = state.shiftData?.id || null; state.orderShiftChoice = state.orderShiftId || ''; }
  const line = state.cart.get(product.id);
  if (line) line.qty = Math.min(99, line.qty + 1);
  else state.cart.set(product.id, { product, qty: 1 });
  renderCart();
}

function changeQty(productId, delta) {
  const line = state.cart.get(productId);
  if (!line) return;
  line.qty = Math.min(99, line.qty + delta);
  if (line.qty <= 0) state.cart.delete(productId);
  renderCart();
}

function renderCart() {
  const lines = [...state.cart.values()];
  const total = lines.reduce((sum, l) => sum + l.qty * Number(l.product.price), 0);
  if (mobileCartButton) {
    const count = lines.reduce((sum, line) => sum + line.qty, 0);
    mobileCartButton.textContent = 'View cart · ' + count + (count === 1 ? ' item · ' : ' items · ') + ksh(total);
  }

  cartBox.replaceChildren(
    ...[
      h('h2', {}, state.addTo ? 'Adding to ' + state.addTo.saleNumber : 'Order'),
      h('button', { class: 'ghost mobile-only', onclick: () => document.getElementById('product-menu')?.scrollIntoView({ block: 'start' }) }, 'Back to products'),
      state.addTo ? h('button', { class: 'ghost', onclick: () => { state.addTo = null; state.cart = new Map(); render(); } }, 'Stop adding') : null,
      can('sales.view_all') && !state.addTo
        ? h('label', { class: 'pick' }, 'Waitress ',
            h('select', { onchange: (e) => { state.waiterId = e.target.value; } },
              h('option', { value: '' }, 'No waitress (counter)'),
              state.waiters.map((w) => h('option', { value: w.id, selected: w.id === state.waiterId ? 'selected' : false }, w.name))))
        : null,
      lines.length === 0 ? h('p', { class: 'muted' }, 'Tap items to add them') : null,
      h('ul', { class: 'lines' }, lines.map((l) =>
        h('li', {},
          h('span', { class: 'ln' }, l.product.name),
          h('span', { class: 'qty' },
            h('button', { 'aria-label': 'Decrease ' + l.product.name, onclick: () => changeQty(l.product.id, -1) }, '−'),
            h('b', {}, l.qty),
            h('button', { 'aria-label': 'Increase ' + l.product.name, onclick: () => changeQty(l.product.id, 1) }, '+')),
          h('span', { class: 'lt' }, ksh(l.qty * Number(l.product.price))))
      )),
      h('div', { class: 'total' }, h('span', {}, 'Total'), h('b', {}, ksh(total))),
      !state.addTo ? h('label', {}, 'Originating shift ', h('select', {
        onchange: e => { state.orderShiftChoice = e.target.value; } },
        h('option', { value: '', selected: !state.orderShiftChoice }, 'Choose originating shift'),
        state.orderShiftId ? h('option', { value: state.orderShiftId, selected: state.orderShiftChoice === state.orderShiftId }, 'Captured shift (' + state.orderShiftId.slice(-6) + ')') : null,
        h('option', { value: '__unassigned__', selected: state.orderShiftChoice === '__unassigned__' }, 'Unassigned order (cannot merge bills)'))) : null,
      h('button', {
        class: 'primary big',
        disabled: lines.length === 0 || state.sending ? 'disabled' : false,
        onclick: sendOrder,
      }, state.sending ? 'Sending...' : state.addTo ? 'Add to order' : 'Send order'),
    ].filter(Boolean)
  );
}

async function sendOrder() {
  const generation = sessionGeneration;
  if (state.sending || state.cart.size === 0) return;
  const items = [...state.cart.values()].map((l) => ({ productId: l.product.id, quantity: l.qty }));

  state.sending = true;
  renderCart();
  try {
    const choice = state.orderShiftChoice;
    if (!state.addTo && !choice) throw new Error('Choose the originating shift or deliberately choose an unassigned order.');
    const body = { items, shiftId: choice === '__unassigned__' ? null : choice };
    if (can('sales.view_all') && state.waiterId) body.waiterId = state.waiterId;
    let data;
    if (state.addTo) {
      data = await api('/sales/' + state.addTo.id + '/items', { method: 'POST', body: { items } }); if (!isCurrentSession(generation)) return;
      toast('Items added to ' + data.sale.saleNumber);
      state.addTo = null;
    } else {
      data = await api('/sales', { method: 'POST', body }); if (!isCurrentSession(generation)) return;
      toast('Order ' + data.sale.saleNumber + ' sent');
    }
    state.cart = new Map();
    state.tab = 'orders';
    state.sending = false;
    render();
  } catch (err) { if (!isCurrentSession(generation)) return;
    state.sending = false;
    toast(err.message, true);
    renderCart();
  }
}

// ---------- orders ----------

function ordersView() {
  ordersBox = h('main', { class: 'orders' }, h('p', { class: 'muted' }, 'Loading...'));
  return ordersBox;
}

async function loadOrders() {
  const currentAccess = filterGuard('orders');
  if (!canBrowseOrders()) return;
  if(state.tab==='orders'&&ordersBox)ordersBox.replaceChildren(filterControls('orders',loadOrders,{search:'Order number, bill or waitress',statuses:['UNPAID','PARTIAL','PAID','CANCELLED','MERGED']}),h('p',{role:'status'},'Loading orders…'));
  try {
    const q = state.orderFilter === 'ALL' || Object.hasOwn(filterValues('orders'),'status') ? '' : '?status=' + state.orderFilter;
    const data = await api('/sales' + filterQuery('orders',q.slice(1)));
    if (currentAccess()) state.filterPages.orders=data.pagination; if (!currentAccess()) return;
    state.orders = data.sales;
    for (const id of [...state.selected]) {
      const o = state.orders.find((x) => x.id === id);
      if (!o || o.status !== 'UNPAID') state.selected.delete(id);
    }
    if (state.tab === 'orders') renderOrders();
  } catch (err) { if (!currentAccess()) return; toast(err.message, true); if(state.tab==='orders'&&ordersBox)ordersBox.replaceChildren(filterControls('orders',loadOrders,{search:'Order number, bill or waitress',statuses:['UNPAID','PARTIAL','PAID','CANCELLED','MERGED']}),h('p',{class:'error',role:'alert'},err.message),h('button',{class:'ghost',onclick:loadOrders},'Retry')); }
}

function isOpen(o) { return o.status === 'UNPAID' || o.status === 'PARTIAL'; }
const waiterKey = (o) => (o.waiter ? o.waiter.id : 'none');

function canPick(o) {
  if (o.status !== 'UNPAID' || !o.shiftId || !o.accountingDate || o.accountingDate.slice(0,10) !== businessToday() || o.payments?.length) return false;
  if (state.selected.size === 0) return true;
  const first = state.orders.find((x) => state.selected.has(x.id));
  return !first || (waiterKey(first) === waiterKey(o) && first.shiftId === o.shiftId && first.accountingDate === o.accountingDate && String(first.commissionRateSnapshot) === String(o.commissionRateSnapshot));
}

function togglePick(o) {
  if (state.selected.has(o.id)) state.selected.delete(o.id);
  else if (canPick(o)) state.selected.add(o.id);
  else if (o.status !== 'UNPAID') toast('Only unpaid orders can be merged', true);
  else toast('Only orders of the same waiter can be merged', true);
  renderOrders();
}

function startMerge() { state.mergeMode = true; state.selected = new Set(); renderOrders(); }
function stopMerge() { state.mergeMode = false; state.selected = new Set(); renderOrders(); }

async function doMerge() {
  const generation = sessionGeneration;
  if (state.selected.size < 2) { toast('Pick at least 2 orders', true); return; }
  try {
    const data = await api('/sales/merge', { method: 'POST', body: { saleIds: [...state.selected] } }); if (!isCurrentSession(generation)) return;
    toast('Merged into ' + data.sale.saleNumber);
    state.mergeMode = false;
    state.selected = new Set();
    loadOrders();
  } catch (err) { if (!isCurrentSession(generation)) return; toast(err.message, true); }
}

function renderOrders() {
  const cutoff = Date.now() - 18 * 3600 * 1000;
  const shown = state.orders; // Backend filtering/pagination includes older closed bills.

  const open = shown.filter(isOpen);
  const done = shown.filter((o) => !isOpen(o));
  const unpaidCount = open.filter((o) => o.status === 'UNPAID').length;

  const filterBar = h('div', { style: 'display:flex; gap:10px; margin-bottom: 20px;' },
    h('button', { class: 'tab' + (state.orderFilter === 'ALL' ? ' on' : ''), onclick: () => { state.orderFilter = 'ALL'; state.filters.orders={...filterValues('orders'),status:'',page:1}; loadOrders(); } }, 'All orders'),
    h('button', { class: 'tab' + (state.orderFilter === 'UNPAID' ? ' on' : ''), onclick: () => { state.orderFilter = 'UNPAID'; state.filters.orders={...filterValues('orders'),status:'UNPAID',page:1}; loadOrders(); } }, 'Unpaid Only'),
    h('button', { class: 'tab' + (state.orderFilter === 'PAID' ? ' on' : ''), onclick: () => { state.orderFilter = 'PAID'; state.filters.orders={...filterValues('orders'),status:'PAID',page:1}; loadOrders(); } }, 'Paid Only')
  );

  ordersBox.replaceChildren(
    h('div', {},
      filterControls('orders',loadOrders,{search:'Order number, bill or waitress',statuses:['UNPAID','PARTIAL','PAID','CANCELLED','MERGED']}),
      filterBar,
      h('div', { class: 'row' },
        h('h2', {}, 'Open orders (' + open.length + ')'),
        state.mergeMode ? h('button', { class: 'ghost', onclick: stopMerge }, 'Cancel Merge / Back') : null,
        unpaidCount >= 2 && !state.mergeMode && can('sales.merge') ? h('button', { class: 'ghost', onclick: startMerge }, 'Merge bills') : null),
      state.mergeMode ? h('p', { class: 'muted' }, 'Select verified unpaid bills from the same open originating shift and current Nairobi date. The server rechecks eligibility.') : null,
      open.length ? open.map(orderCard) : h('p', { class: 'muted' }, 'No open orders'),

      state.orderFilter !== 'UNPAID' ? h('h2', {}, 'Recent') : null,
      state.orderFilter !== 'UNPAID' && done.length ? done.map(orderCard) : (state.orderFilter !== 'UNPAID' ? h('p', { class: 'muted' }, 'Nothing yet') : null),

      state.mergeMode
        ? h('div', { class: 'mergebar' },
            h('span', {}, state.selected.size + ' selected'),
            h('button', { class: 'ghost', onclick: stopMerge }, 'Cancel Merge / Back'),
            h('button', { class: 'primary', disabled: state.selected.size < 2 ? 'disabled' : false, onclick: doMerge }, 'Merge bills'))
        : null)
  );
}

function orderCard(o) {
  const open = isOpen(o);
  const picking = state.mergeMode;
  const picked = state.selected.has(o.id);

  const classes = ['card', o.status.toLowerCase()];
  if (picking) classes.push('pick');
  if (picked) classes.push('picked');
  if (picking && !picked && !canPick(o)) classes.push('dim');

  const info = [o.waiter ? 'Waiter: ' + o.waiter.name : null, new Date(o.createdAt).toLocaleTimeString('en-KE', { timeZone:'Africa/Nairobi', hour: '2-digit', minute: '2-digit' })].filter(Boolean).join(' · ');

  return h('div', { class: classes.join(' '), onclick: picking ? () => togglePick(o) : null },
    h('div', { class: 'top' }, h('b', {}, (picked ? '✓ ' : '') + o.saleNumber), h('span', { class: 'badge' }, o.status)),
    h('div', { class: 'muted' }, info),
    h('ul', { class: 'items' }, o.items.map((i) => h('li', {}, h('span', {}, i.quantity + ' × ' + i.product.name), h('span', {}, ksh(i.subtotal)),
      removableBill(o) ? h('button', { class: 'danger', style: 'padding:4px 8px;font-size:12px;', disabled: workflowWrites.has(workflowKey('item', i.id)), onclick: () => removeLineDialog(o, i), 'aria-label': 'Remove ' + i.product.name }, 'Remove item') : null))),
    h('div', {}, 'Total ', h('b', {}, ksh(o.netTotal??o.total)), Number(o.amountPaid) > 0 ? ' · Paid ' + ksh(o.amountPaid) : '', open ? ' · Balance ' + ksh(o.balance) : ''),
    open && !picking
      ? h('div', { class: 'actions' },
          o.status === 'UNPAID' && can('sales.make') ? h('button', { onclick: () => { state.addTo = o; state.cart = new Map(); state.tab = 'new'; render(); } }, 'Add items') : null,
          can('receivables.manage')&&can('receivables.view')&&typeof efReceiptDialog==='function'?h('button',{class:'ghost',onclick:()=>efReceiptDialog(null,o)},'Full payment / tips'):null,
          can('pay.mpesa') ? h('button', { class: 'primary', onclick: () => payDialog(o, 'MPESA') }, 'M-Pesa') : null,
          can('pay.cash') ? h('button', { class: 'primary', onclick: () => payDialog(o, 'CASH') }, 'Cash') : null,
          o.status==='UNPAID' && can('sales.void') ? h('button', { class: 'danger', onclick: () => cancelOrder(o) }, 'Cancel') : null)
      : null
  );
}

// Hints from public bill fields only; the server rechecks history, shift, date,
// ownership and payment events under its existing locks. Never guess a reversal.
const workflowWrites = new Set();
const workflowKey = (kind, id) => sessionGeneration + ':' + kind + ':' + id;
function removableBill(order) {
  const origin = state.shiftsList?.find(s => s.id === order.shiftId);
  return can('sales.remove_item') && !state.mergeMode && order.status === 'UNPAID' && Number(order.amountPaid) === 0 &&
    order.items?.length > 1 && order.accountingDate?.slice(0, 10) === businessToday() &&
    (can('sales.view_all') || order.waiterId === state.user?.id || order.createdById === state.user?.id) &&
    (!origin || origin.status === 'OPEN');
}
function removeLineDialog(order,item){if(removableBill(order)&&order.items.some(i=>i.id===item.id))unpaidCorrectionDialog(order,'REMOVE_ITEM',item);}

// Capture available shift once. A form never follows a newly opened shift.
function shiftContextControl(methodControl) {
  const capturedId = state.shiftData?.id || null;
  const method = () => typeof methodControl === 'string' ? methodControl : methodControl.value;
  const unassigned = h('option', { value: '__unassigned__', disabled: method() !== 'MPESA' }, 'Unassigned M-Pesa — excluded from shift reconciliation');
  const select = h('select', {},
    h('option', { value: '' }, 'Choose transaction shift'),
    capturedId ? h('option', { value: capturedId }, 'Current shift (' + capturedId.slice(-6) + ')') : null,
    unassigned
  );
  select.value = capturedId || '';
  if (typeof methodControl !== 'string') methodControl.addEventListener('change', () => {
    unassigned.disabled = method() !== 'MPESA';
    if (unassigned.disabled && select.value === '__unassigned__') select.value = '';
  });
  return {
    view: h('div', {}, h('label', {}, 'Transaction shift'), select,
      h('p', { class: 'muted', style: 'font-size:12px; margin-top:6px;' }, 'Reopen this form if your shift changes. Unassigned M-Pesa must be chosen explicitly.')),
    read() {
      if (select.value === '__unassigned__' && method() === 'MPESA') return null;
      if (capturedId && select.value === capturedId) return capturedId;
      throw new Error('Choose an open shift, or explicitly choose unassigned M-Pesa.');
    },
  };
}

function payDialog(order, method) {
  if (!can(method === 'CASH' ? 'pay.cash' : 'pay.mpesa')) return;
  const shift = shiftContextControl(method);
  const amount = h('input', { type: 'number', inputmode: 'decimal', min: '0', step: '0.01', value: String(Number(order.balance)), style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const code = h('input', { placeholder: 'e.g. SJK4L9M2QP', maxlength: '10', autocapitalize: 'characters', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;

  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    let shiftId;
    try { shiftId = shift.read(); } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; return; }
    const body = { method, amount: Number(amount.value), shiftId };
    if (method === 'MPESA') body.reference = code.value.trim().toUpperCase();
    busy = true;
    try {
      await api('/sales/' + order.id + '/payments', { method: 'POST', body }); if (!isCurrentSession(generation)) return;
      close(); toast('Payment recorded'); loadOrders();
    } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }

  overlay.append(
    h('div', { class: 'modal' },
      h('h2', {}, (method === 'MPESA' ? 'M-Pesa' : 'Cash') + ' payment'),
      h('p', { class: 'muted' }, order.saleNumber + ' · Balance ' + ksh(order.balance)),
      shift.view,
      h('label', {}, 'Amount (KSh)'), amount,
      method === 'MPESA' ? [h('label', {}, 'Full M-Pesa code (10 characters)'), code,mpesaMatchControl()] : null,
      error,
      h('div', { class: 'actions' },
        h('button', { class: 'ghost', onclick: close }, 'Back'),
        h('button', { class: 'primary', onclick: submit }, 'Confirm')))
  );
  document.body.append(overlay);
}

async function cancelOrder(order){if(can('sales.void')&&order.status==='UNPAID')unpaidCorrectionDialog(order,'CANCEL');}

// ---------- BACK OFFICE MENU ----------

function backOfficeView() {
  const allowed = boAllowed();
  if (!allowed[state.boTab]) {
    const first = Object.keys(allowed).find((k) => allowed[k]);
    if (first) state.boTab = first;
    else return h('p', {}, 'Back office access is not permitted.');
  }

  const menu = h('div', { class: 'bo-menu' },
    allowed.employeeFinance?h('button',{class:'tab'+(state.boTab==='employeeFinance'?' on':''),onclick:()=>{state.boTab='employeeFinance';render();}},'Employee finance'):null,
    allowed.accounting?h('button',{class:'tab'+(state.boTab==='accounting'?' on':''),onclick:()=>{state.boTab='accounting';render();}},'Accounting & suppliers'):null,
    h('h3', {}, 'Menu'),
    allowed.dashboard?h('button',{class:'tab'+(state.boTab==='dashboard'?' on':''),onclick:()=>{state.dashboardData=null;state.boTab='dashboard';render();}},'Dashboard'):null,
    allowed.inventoryReport?h('button',{class:'tab',onclick:()=>{state.boTab='inventoryReport';render();}},'Inventory report'):null,
    allowed.countHistory?h('button',{class:'tab',onclick:()=>{state.boTab='countHistory';render();}},'Stock-count history'):null,
    allowed.settings?h('button',{class:'tab'+(state.boTab==='settings'?' on':''),onclick:()=>{state.boTab='settings';render();}},'Settings'):null,
    allowed.salesInvoices ? h('button',{class:'tab'+(state.boTab==='salesInvoices'?' on':''),onclick:()=>{state.boTab='salesInvoices';render();}},'Sales Invoices') : null,
    allowed.purchaseInvoices ? h('button',{class:'tab'+(state.boTab==='purchaseInvoices'?' on':''),onclick:()=>{state.boTab='purchaseInvoices';render();}},'Purchase Invoices') : null,
    can('payments.view_collected') ? h('button',{class:'tab',onclick:()=>{state.boTab='reports';state.reportTab='payments';render();}},'Payments & collections') : null,
    canFinancialAction() ? h('button',{class:'tab',onclick:()=>{state.boTab='reports';state.reportTab='approvals';render();}},'Approval requests & audit') : null,
    allowed.movements ? h('button',{class:'tab'+(state.boTab==='movements'?' on':''),onclick:()=>{state.boTab='movements';render();}},'Stock movements') : null,
    allowed.reports ? h('button', { class: 'tab' + (state.boTab === 'reports' ? ' on' : ''), onclick: () => { state.boTab = 'reports'; render(); } }, '📊 Reports') : null,
    allowed.inventory ? h('button', { class: 'tab' + (state.boTab === 'inventory' ? ' on' : ''), onclick: () => { state.boTab = 'inventory'; render(); } }, '📦 Inventory') : null,
    can('users.manage') ? h('button', { class: 'tab' + (state.boTab === 'staff' ? ' on' : ''), onclick: () => { state.boTab = 'staff'; render(); } }, '👥 Staff') : null,
    can('expenses.manage') ? h('button', { class: 'tab' + (state.boTab === 'expenses' ? ' on' : ''), onclick: () => { state.boTab = 'expenses'; render(); } }, '💸 Expenses') : null,
    can('shifts.manage') ? h('button', { class: 'tab' + (state.boTab === 'shifts' ? ' on' : ''), onclick: () => { state.boTab = 'shifts'; render(); } }, '⏱️ Shifts') : null,
    allowed.permissions ? h('button', { class: 'tab' + (state.boTab === 'permissions' ? ' on' : ''), onclick: () => { state.boTab = 'permissions'; render(); } }, '🔐 Permissions') : null
  );

  let content;
  if(state.boTab==='employeeFinance')content=employeeFinanceView();
  else if(state.boTab==='accounting')content=accountingView();
  else if(state.boTab==='dashboard')content=dashboardView();
  else if(state.boTab==='inventoryReport')content=inventoryReportView();
  else if(state.boTab==='countHistory')content=countHistoryView();
  else if(state.boTab==='settings')content=settingsView();
  else if (state.boTab === 'salesInvoices') content = invoicesView('sales');
  else if (state.boTab === 'purchaseInvoices') content = invoicesView('purchases');
  else if (state.boTab === 'movements') content = h('div',{},h('h2',{},'Stock movements'),ledgerView('movements','/stock/movements','movements',[['Date',r=>invoiceDateText(r.createdAt)],['Product',r=>r.product.name],['Type',r=>r.type],['Change',r=>r.quantityChange],['Before',r=>r.previousQty],['After',r=>r.quantityAfter],['Origin shift',r=>r.shiftId||'Unassigned']],{search:'Product or movement reason'}));
  else if (state.boTab === 'reports') content = reportsView();
  else if (state.boTab === 'inventory') content = stockView();
  else if (state.boTab === 'staff') content = staffView();
  else if (state.boTab === 'expenses') content = expensesView();
  else if (state.boTab === 'shifts') content = shiftsView();
  else if (state.boTab === 'permissions') content = permissionsView();

  return h('main', { class: 'backoffice' },
    h('div', { class: 'bo-layout' },
      h('details', { class: 'bo-nav', open: !mobileLayout.matches },
        h('summary', {}, 'Back office menu'), menu), h('div', { class: 'bo-content' }, content))
  );
}

// ---------- PERMISSIONS ----------

const adminWrites = new Set();
const canManagePermissions = () => state.user?.role === 'MANAGER' && can('permissions.manage');
function administrationError(err) {
  if (err.status === 403) return 'This action is not permitted. Review your access before submitting again.';
  if (err.status === 409) return 'The change could not be saved because of a conflict. Review refreshed data, then submit again deliberately.';
  if (err.status === 400) return 'Review the entered fields and PIN requirements before submitting again.';
  return 'The administration request could not be completed. Refresh and review before submitting again.';
}

async function loadPermissions() {
  const currentAccess = accessGuard();
  if (!canManagePermissions()) { state.permissionsMatrix = null; return false; }
  try {
    const data = await api('/permissions'); if (!currentAccess()) return; state.permissionsMatrix = data;
    if (state.boTab === 'permissions') render(); return true;
  } catch (err) { if (!currentAccess()) return; state.permissionsMatrix = null; toast(administrationError(err), true); return false; }
}

async function togglePermission(role, permission, currentStatus) {
  const generation = sessionGeneration;
  if (!canManagePermissions()) { toast(administrationError({ status: 403 }), true); return; }
  const entry = state.permissionsMatrix?.permissions.find(p => p.key === permission);
  const mandatory = role === 'MANAGER' && ['users.manage', 'permissions.manage'].includes(permission);
  const forbiddenEnable = role !== 'MANAGER' && permission === 'permissions.manage';
  if (!entry || !state.permissionsMatrix.roles.includes(role) || mandatory ||
      (forbiddenEnable && !(currentStatus === true && entry.storedRoles?.[role] === true))) return;
  const key = role + ':' + permission;
  if (adminWrites.has(key)) return;
  adminWrites.add(key);
  try {
    await api('/permissions', { method: 'PUT', body: { role, permissions: [{ permission, enabled: !currentStatus }] } }); if (!isCurrentSession(generation)) return;
    toast('Saved. The server checks fresh grants on every request; open screens receive refresh notifications.');
    await loadPermissions();
  } catch (err) { if (!isCurrentSession(generation)) return;
    toast(administrationError(err), true);
    if (err.status === 409 || err.status === 403) await loadPermissions();
  } finally { if (!isCurrentSession(generation)) return; adminWrites.delete(key); if (state.boTab === 'permissions') render(); }
}

function permissionsView() {
  if (!canManagePermissions()) return h('p', { class: 'error' }, 'Only authorized managers may view role permissions.');
  if (!state.permissionsMatrix) return h('div', {}, h('h2', {}, 'Role Permissions'),h('button',{class:'ghost',onclick:async()=>{const current=accessGuard();try{const result=await api('/permissions/audit?pageSize=25');if(current()){state.permissionAudit=result;render();}}catch(e){if(current())toast(e.message,true);}}},'Load permission audit'), state.permissionAudit?h('div',{},...(state.permissionAudit.events.length?state.permissionAudit.events.map(e=>h('article',{class:'settings-card'},h('p',{},e.actor.name+' ? '+invoiceDateText(e.createdAt)),h('pre',{},JSON.stringify({before:e.before,after:e.after},null,2)))):[h('p',{class:'muted'},'No recorded permission changes.')])):null, h('p', { class: 'muted' }, 'Permission data is not available.'), h('button', { class: 'ghost', onclick: loadPermissions }, 'Refresh permissions'));
  const { roles, permissions } = state.permissionsMatrix;
  return h('div', {}, h('h2', {}, 'Role Permissions'),h('button',{class:'ghost',onclick:async()=>{const current=accessGuard();try{const result=await api('/permissions/audit?pageSize=25');if(current()){state.permissionAudit=result;render();}}catch(e){if(current())toast(e.message,true);}}},'Load permission audit'), state.permissionAudit?h('div',{},...(state.permissionAudit.events.length?state.permissionAudit.events.map(e=>h('article',{class:'settings-card'},h('p',{},e.actor.name+' ? '+invoiceDateText(e.createdAt)),h('pre',{},JSON.stringify({before:e.before,after:e.after},null,2)))):[h('p',{class:'muted'},'No recorded permission changes.')])):null,
    h('p', { class: 'muted' }, 'Availability describes the current software: Available, Partially available, or Planned / unavailable. A stored grant does not create a missing workflow. Assignments are retained and can still be reviewed below.'),
    h('p', { class: 'muted' }, 'Changing MANAGER permissions affects every manager. Mandatory administration permissions remain enabled.'),
    h('p', { class: 'muted' }, 'Historical non-manager permission-administration grants may remain stored but are ineffective. Remove a stored grant explicitly below. Other instances may take time to refresh.'),
    h('div', { class: 'perm-table-wrap', style: 'max-width: 100%;' },
      h('table', { class: 'report-table perm-table' },
        h('thead', {}, h('tr', {}, h('th', {}, 'Permission'), roles.map(r => h('th', { style: 'text-align:center;' }, r)))),
        [...new Set(permissions.map(p=>p.category))].map(category=>h('tbody', {},h('tr',{class:'permission-category'},h('th',{colspan:roles.length+1,scope:'rowgroup'},category)), permissions.filter(p=>p.category===category).map(p =>
          h('tr', { class: 'permission-card' },
            h('td', { class: 'permission-info', 'data-permission-key': p.key }, h('strong', { class: 'permission-name' }, p.label), h('span', { class: 'muted', style: 'font-size:10px; display:block;' }, p.category),
              h('strong', { style: 'display:block;', 'data-capability-status': p.capability?.status || 'unverified' },
                ({ available: 'Available', partial: 'Partially available', planned: 'Planned / unavailable' })[p.capability?.status] || 'Availability unverified'),
              h('span', { class: 'muted', style: 'display:block;' }, p.capability?.description || 'Refresh the permission catalog to verify availability.')),
            roles.map(role => {
              const mandatory = role === 'MANAGER' && ['permissions.manage', 'users.manage'].includes(p.key);
              const obsolete = role !== 'MANAGER' && p.key === 'permissions.manage';
              const isEnabled = mandatory || (!obsolete && p.roles[role] === true);
              const isLocked = mandatory || obsolete || adminWrites.has(role + ':' + p.key);
              return h('td', { class: 'permission-assignment', 'data-role': role, style: 'text-align:center;' },
                h('label', { class: 'permission-role' }, h('span', { class: 'mobile-only' }, role),
                  h('input', { type: 'checkbox', 'aria-label': role + ' ' + p.label, checked: isEnabled ? 'checked' : false, disabled: isLocked ? 'disabled' : false, onchange: e => { e.target.disabled = true; togglePermission(role, p.key, isEnabled); } })),
                mandatory ? h('span', { class: 'muted' }, ' Required') : null,
                obsolete && p.storedRoles?.[role] === true ? h('div', {}, h('span', { class: 'muted' }, 'Stored; ineffective '), h('button', { class: 'ghost', disabled: adminWrites.has(role + ':' + p.key), onclick: () => togglePermission(role, p.key, true) }, 'Remove stored grant')) : null
              );
            })
          )
        )))
      )
    )
  );
}

// ---------- REPORTS ----------

function businessToday(){return state.businessDayDate||nairobiToday();}
function nairobiToday() { const now = new Date(); const nairobi = new Date(now.getTime() + 3 * 60 * 60 * 1000); return nairobi.toISOString().slice(0, 10); }

async function loadDailyReport() {
  if (!can('reports.sales')) return;
  ensureReportPeriod('daily');
  const currentAccess = filterGuard('daily');
  // Explicit filter changes may replace an older in-flight read.
  state.reportLoading = true;
  if (state.tab === 'backoffice' && state.boTab === 'reports') render();
  try {
    const data = await api('/reports/daily' + filterQuery('daily')); if (!currentAccess()) return;
    state.reportData = data;
  } catch (err) { if (!currentAccess()) return; toast(err.message, true); state.reportData = { error: err.message }; }
  finally { if (!currentAccess()) return; state.reportLoading = false; if (state.tab === 'backoffice' && state.boTab === 'reports') render(); }
}

async function loadPnlReport() {
  if (!can('reports.financial')) return;
  ensureReportPeriod('pnl');
  const currentAccess = filterGuard('pnl');
  try { const data = await api('/reports/pnl'+filterQuery('pnl')); if (!currentAccess()) return; state.pnlData = data; render(); } catch (err) { if (!currentAccess()) return; state.pnlData={error:err.message};toast(err.message, true);render(); }
}

async function loadCommissionsReport() {
  if (!can('commissions.manage')) return;
  ensureReportPeriod('commissions');
  const currentAccess = filterGuard('commissions');
  try { const data = await api('/reports/commissions'+filterQuery('commissions')); if (!currentAccess()) return; state.commissionsData = data; render(); } catch (err) { if (!currentAccess()) return; state.commissionsData={error:err.message};toast(err.message, true);render(); }
}

function reportsView() {
  const rt = {
    payments: can('payments.view_collected'),
    daily: can('reports.sales'),
    pnl: can('reports.financial'),
    commissions: can('commissions.manage'),
  };
  if (!rt[state.reportTab]) {
    const f = Object.keys(rt).find((k) => rt[k]);
    if (f) state.reportTab = f;
  }

  const tabToggle = h('div', { class: 'report-tabs', style: 'display:flex; gap:10px; margin-bottom: 20px;' },
    can('payments.view_collected') ? h('button',{class:'tab'+(state.reportTab==='payments'?' on':''),onclick:()=>{state.reportTab='payments';render();}},'Collections') : null,
    can('reports.sales') ? h('button', { class: 'tab' + (state.reportTab === 'daily' ? ' on' : ''), onclick: () => { state.reportTab = 'daily'; render(); } }, 'Daily Sales') : null,
    can('reports.financial') ? h('button', { class: 'tab' + (state.reportTab === 'pnl' ? ' on' : ''), onclick: () => { state.reportTab = 'pnl'; render(); } }, 'Profit & Loss') : null,
    can('commissions.manage') ? h('button', { class: 'tab' + (state.reportTab === 'commissions' ? ' on' : ''), onclick: () => { state.reportTab = 'commissions'; render(); } }, 'Commissions') : null
  );

  if (state.reportTab === 'payments') return h('div',{},tabToggle,ledgerView('payments','/reports/payments','payments', [['Collected',r=>new Date(r.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})],['Bill',r=>r.saleNumber],['Method',r=>r.method],['Reference',r=>r.reference],['Amount',r=>ksh(r.amount)],['Receiving shift',r=>r.receivedShiftId]],{methods:true,search:'Payment reference or bill number'}));
  if (state.reportTab === 'pnl') return h('div', {}, tabToggle, ...pnlContent());
  if (state.reportTab === 'commissions') return h('div', {}, tabToggle, ...commissionsContent());

  const r = state.reportData; const loading = state.reportLoading;
  const heading=h('h2',{},'Daily Sales');const controls=reportPeriodNote(r);

  if (loading) return h('div', {}, tabToggle, heading, controls, h('p', { class: 'muted' }, 'Loading report...'));
  if (!r) return h('div', {}, tabToggle, heading, controls, h('p', { class: 'muted' }, 'No data yet.'));
  if (r.error) return h('div', {}, tabToggle, heading, controls, h('p', { class: 'muted' }, 'Error: ' + r.error));

  const t = r.totals; const o = r.orders;
  const financial = can('reports.financial') && Object.hasOwn(t, 'cost') && Object.hasOwn(t, 'profit');
  const collections = can('payments.view_collected') && Object.hasOwn(r, 'payments');
  const waiterTable = r.waiters.length === 0
      ? h('p', { class: 'muted' }, 'No orders on this day.')
      : h('table', { class: 'report-table' },
          h('thead', {}, h('tr', {}, h('th', {}, 'Waitress'), h('th', {}, 'Orders'), h('th', {}, 'Sales'), h('th', {}, 'Paid'), financial ? h('th', {}, 'Cost') : null, financial ? h('th', {}, 'Profit') : null)),
          h('tbody', {}, r.waiters.map((w) => h('tr', {}, h('td', {}, w.name), h('td', {}, String(w.orders)), h('td', {}, ksh(w.total)), h('td', {}, ksh(w.paid)), financial ? h('td', {}, ksh(w.cost)) : null, financial ? h('td', { class: w.profit >= 0 ? 'profit' : 'loss' }, ksh(w.profit)) : null))));

  return h('div', {}, tabToggle, heading, controls,
    h('div', { class: 'stat-grid' }, statCard('Sales', ksh(t.sales)), statCard(r.balanceView==='current'?'Origin-period bills paid ? current':'Origin-period bills paid by cutoff', ksh(t.paid)), statCard(r.balanceView==='current'?'Current outstanding (all bills)':'Outstanding at cutoff (all bills)', ksh(r.outstanding)), financial ? statCard('Cost', ksh(t.cost)) : null, financial ? statCard('Gross profit', ksh(t.profit)) : null),
    h('div', { class: 'row' }, h('span', {}, 'Orders: ', h('b', {}, String(o.total))), h('span', { class: 'muted' }, 'Paid ' + o.paid + ' · Partial ' + o.partial + ' · Unpaid ' + o.unpaid)),
    h('p', { class: 'muted' }, (r.balanceView==='current'?'Current paid status and balances include later events. Unverified legacy sales: ':'Paid status and balances use the selected Nairobi period cutoff. Unverified legacy sales: ') + r.provenance.unverifiedSales + (collections ? '. Unassigned M-Pesa: ' + ksh(r.unassignedMpesa) + '. Inconsistent legacy receipts: ' + r.provenance.inconsistentReceiptCount : '')),
    collections ? [h('h3', {}, 'Collections recorded on this day (all order dates)'), h('ul', { class: 'payments' }, h('li', {}, 'Cash ', h('b', {}, ksh(r.payments.CASH))), h('li', {}, 'M-Pesa ', h('b', {}, ksh(r.payments.MPESA))))] : null,
    h('h3', {}, 'By waitress'), waiterTable
  );
}

function pnlContent() {
  const heading=h('h2',{},'Profit & Loss Statement');
  const controls=reportPeriodNote(state.pnlData);
  if (!state.pnlData) { loadPnlReport(); return [heading, controls, h('p', { class: 'muted' }, 'Calculating P&L...')]; }

  const p = state.pnlData;
  if(p.error)return[heading,controls,h('p',{class:'error',role:'alert'},p.error)];
  const row = (label, value, isTotal = false, isNegative = false) => {
    return h('tr', { style: isTotal ? 'background: #292929; color:#f5f5f5; font-weight: bold; border-top: 2px solid #777;' : '' },
      h('td', {}, label), h('td', { style: `text-align:right; ${isNegative ? 'color: #fca5a5;' : ''}` }, value==null?'Unavailable — review unclassified expenses':ksh(value))
    );
  };
  const table = h('table', { class: 'report-table' }, h('tbody', {}, row('Revenue (Total Sales)', p.revenue), row('Cost of Goods Sold (COGS)', p.cogs, false, true), row('Gross Profit', p.grossProfit, true), row('Operating Expenses', p.totalExpenses, false, true), row('Net Profit', p.netProfit, true, p.netProfit < 0)));
  const note = p.stockPurchases > 0
    ? h('p', { class: 'muted', style: 'font-size:12px; margin-top:8px;' }, 'Stock bought in this period: ' + ksh(p.stockPurchases) + ' (not subtracted again: it is counted in cost of goods when sold).')
    : null;
  return [heading,controls,p.expenseVerification?.unclassifiedCount?h('p',{class:'error',role:'status'},'Unclassified purchase expenses: '+p.expenseVerification.unclassifiedCount+' · '+ksh(p.expenseVerification.unclassifiedAmount)+'. Net profit remains unverified.'):null,h('div',{style:'max-width:600px;'},table,note)];
}

function commissionsContent() {
  const heading=h('h2',{},'Waitress Commissions');
  const controls=reportPeriodNote(state.commissionsData);
  if (!state.commissionsData) { loadCommissionsReport(); return [heading, controls, h('p', { class: 'muted' }, 'Loading...')]; }

  const d = state.commissionsData;
  if(d.error)return[heading,controls,h('p',{class:'error',role:'alert'},d.error)];
  const rows = d.waitresses.map(w => h('tr', {}, h('td', {}, w.name), h('td', {}, w.commissionRate === null ? 'Mixed / unverified' : String(w.commissionRate) + '%'), h('td', {}, String(w.orders)), h('td', {}, ksh(w.totalSales)), h('td', { style: 'font-weight:bold; text-align:right;' }, ksh(w.commissionAmount))));
  const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Waitress'), h('th', {}, 'Rate'), h('th', {}, 'Paid Orders'), h('th', {}, 'Sales'), h('th', { style: 'text-align:right;' }, 'Commission'))), h('tbody', {}, rows), h('tfoot', {}, h('tr', { style: 'background:#292929; color:#f5f5f5; font-weight:bold;' }, h('td', { colspan: '4' }, 'Total Payout'), h('td', { style: 'text-align:right;' }, ksh(d.grandTotalCommission)))));
  return [heading, controls, h('p', { class: 'muted' }, 'Commission is earned on final settlement at the frozen order rate. Legacy paid bills needing review: ' + d.unverifiedOrders + '. Their commission amounts are unknown and excluded from verified totals.'), table];
}

function statCard(label, value) {
  return h('div', { class: 'stat' }, h('div', { class: 'label' }, label), h('div', { class: 'value' }, value));
}

// ---------- INVENTORY ----------

async function loadStock() {
  const currentAccess = filterGuard('stock');
  if (!canInventory()) return;
  // Filter guards fence obsolete responses; never strand loading on a change.
  state.stockLoading = true;
  if (state.boTab === 'inventory') render();
  try { const data = canReadStock() ? await api('/stock'+filterQuery('stock','page=1')) : canChooseStock() ? await api('/stock/options'+filterQuery('stock','page=1')) : { products: [] }; if (!currentAccess()) return; state.stockData = data.products;state.filterPages.stock=data.pagination; } catch (err) { if (!currentAccess()) return; if (!err.stalePermissions) { state.stockData = []; toast(err.message, true); } }
  finally { if (!currentAccess()) return; state.stockLoading = false; if (state.boTab === 'inventory') render(); }
}

async function loadPendingCounts() {
  const currentAccess = accessGuard();
  if (!can('stock.count') && !can('stock.count_approve')) return;
  try { const data = await api('/stock/counts'); if (!currentAccess()) return; state.pendingCounts = data.counts; if (state.boTab === 'inventory') render(); } catch (err) { if (!currentAccess()) return; toast(err.message, true); }
}

function stockView() {
  if (!canInventory()) return h('p', {}, 'Inventory access is not permitted.');
  if (state.stockCountMode) return stockCountView();
  const heading = h('div', { class: 'row' },
    h('h2', { style: 'margin:0;' }, 'Stock Management'),
    h('div', { style: 'display:flex; gap:10px;' },
      can('purchases.manage') ? h('button', { class: 'primary', disabled: state.stockLoading || !state.stockData || !state.stockData.length, onclick: () => purchaseDialog() }, 'Record Purchase (Invoice)') : null,
      can('stock.count') ? h('button', { class: 'ghost', disabled: state.stockLoading, onclick: startStockCount }, 'Start Physical Count') : null
    )
  );

  if (state.stockLoading || !state.stockData) return h('div', {}, heading, h('p', { class: 'muted' }, 'Loading stock...'));

  const financial = canReadStock() && can('reports.financial') && state.stockData.every(p => Object.hasOwn(p, 'cost'));
  const pendingList = state.pendingCounts && state.pendingCounts.length > 0
    ? h('div', { style: 'background: #2a2a2a; padding: 15px; border-radius: 8px; margin-bottom: 20px; border: 1px solid #d97706;' },
        h('h3', { style: 'color: #d97706; margin-top: 0;' }, 'Pending Stock Counts (Drafts)'),
        state.pendingCounts.map(c => {
          const diffCount = c.items.filter(i => Number(i.difference) !== 0).length;
          return h('div', { style: 'display:flex; justify-content:space-between; align-items:center; margin-bottom: 8px; border-bottom: 1px solid #444; padding-bottom: 8px;' },
            h('span', {}, `${c.countedBy?.name || 'Historical count'} - ${c.phase} (${c.submittedAt || c.phase === 'LEGACY' ? diffCount + ' variances' : 'physical count not submitted'})`),
            h('div', {}, c.phase === 'SUBMITTED' || c.phase === 'LEGACY' ? (can('stock.count_approve') ? h('button', { class: 'primary', onclick: () => approveStockDialog(c) }, 'Review & Approve') : h('span', { class: 'muted' }, 'Pending Approval')) : null,
              c.phase !== 'LEGACY' ? h('button', { class: 'ghost', onclick: () => openStockCount(c.id) }, 'Open Session') : null)
          );
        })
      )
    : null;

  const smallBtn = 'padding: 4px 8px; font-size: 12px;';
  const productRows = state.stockData.map(p => {
    const isRecipe = p.type === 'composite';
    // Recipe items (like a tot of vodka) have no stock of their own
    const actions = isRecipe
      ? h('span', { class: 'muted', style: 'font-size:11px;' }, 'Recipe: uses its ingredients')
      : h('div', { style: 'display:flex; gap:6px; justify-content:flex-end;' },
          can('stock.receive') ? h('button', { class: 'primary', style: smallBtn, onclick: () => receiveStockDialog(p) }, 'Receive') : null,
          can('stock.adjust') ? h('button', { class: 'ghost', style: smallBtn, onclick: () => adjustStockDialog(p) }, 'Adjust') : null
        );
    return h('tr', {},
      h('td', {}, p.name, h('span', { class: 'muted', style: 'font-size:10px; display:block;' }, p.category?.name || 'No category')),
      canReadStock() ? h('td', {}, isRecipe ? '-' : fmtQty(p.quantity) + ' ' + p.unitOfMeasure) : null,
      financial ? h('td', {}, ksh(p.cost)) : null,
      h('td', { style: 'text-align:right;' }, actions));
  });
  const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Product'), canReadStock() ? h('th', {}, 'Current Stock') : null, financial ? h('th', {}, 'Unit Cost') : null, h('th', {}, 'Action'))), h('tbody', {}, productRows));
  return h('div', {}, heading, pendingList, table);
}


// Preserve typed digits until the server Decimal validator sees them. Do not
// convert stock quantities through Number before validating or transmitting.
function stockQuantityText(value, { positive = false, nonzero = false, signed = false, max = '999999.999999' } = {}) {
  const raw = String(value ?? '').trim();
  const match = /^([+-]?)(\d+)(?:\.(\d+))?$/.exec(raw);
  if (!match) throw new Error('Enter a quantity using at most six decimal places.');
  const sign = match[1], whole = match[2].replace(/^0+(?=\d)/, ''), fraction = (match[3] || '').replace(/0+$/, '');
  if (fraction.length > 6) throw new Error('Use at most six decimal places; quantities are never rounded.');
  const zero = /^0+$/.test(whole) && fraction === '';
  if ((sign === '-' && !signed) || (positive && (sign === '-' || zero)) || (nonzero && zero)) throw new Error('Enter a permitted nonzero stock quantity.');
  const [maxWhole, maxFraction = ''] = max.split('.');
  if (whole.length > maxWhole.length || (whole.length === maxWhole.length && (whole > maxWhole || (whole === maxWhole && fraction.padEnd(6, '0') > maxFraction.padEnd(6, '0'))))) throw new Error('Quantity exceeds supported stock capacity.');
  return raw;
}

function receiveStockDialog(product) {
  if (!can('stock.receive')) return;
  const qty = h('input', { 'aria-label':'Purchase quantity', type: 'number', min: '0.000001', step: '0.000001', value: '1', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const reason = h('input', { type: 'text', placeholder: 'e.g. Delivery from supplier', value: 'Stock received', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;
  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    busy = true;
    try { await api('/stock/receive', { method: 'POST', body: { productId: product.id, quantity: stockQuantityText(qty.value, { positive: true }), reason: reason.value } }); if (!isCurrentSession(generation)) return; close(); toast('Stock updated'); state.stockData = null; loadStock(); } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }
  overlay.append(h('div', { class: 'modal' }, h('h2', {}, 'Receive Stock'), h('p', { class: 'muted' }, product.name + (canReadStock() && Object.hasOwn(product, 'quantity') ? ' (Current: ' + fmtQty(product.quantity) + ')' : '')), h('label', {}, 'Quantity to add'), qty, h('label', {}, 'Reason (optional)'), reason, error, h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, 'Add Stock'))));
  document.body.append(overlay);
}

// Fix stock by hand (broken, spilled, found...). A reason is required.
function adjustStockDialog(product) {
  if (!can('stock.adjust')) return;
  const change = h('input', { type: 'number', step: '0.000001', placeholder: 'e.g. -2 (broken) or 3 (found)', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const reason = h('input', { type: 'text', placeholder: 'e.g. 2 bottles broken', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;
  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    let n;
    try { n = stockQuantityText(change.value, { signed: true, nonzero: true, max: '100000' }); }
    catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; return; }
    if (reason.value.trim().length < 3) { error.textContent = 'Please give a reason'; return; }
    busy = true;
    try {
      await api('/stock/adjust', { method: 'POST', body: { productId: product.id, change: n, reason: reason.value.trim() } }); if (!isCurrentSession(generation)) return;
      close(); toast('Stock adjusted'); state.stockData = null; loadStock();
    } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }
  overlay.append(h('div', { class: 'modal' },
    h('h2', {}, 'Adjust Stock'),
    h('p', { class: 'muted' }, product.name + (canReadStock() && Object.hasOwn(product, 'quantity') ? ' (Current: ' + fmtQty(product.quantity) + ' ' + product.unitOfMeasure + ')' : '')),
    h('label', {}, 'Change (+ adds, - removes)'), change,
    h('label', {}, 'Reason (required)'), reason,
    error,
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, 'Save Adjustment'))));
  document.body.append(overlay);
}

function approveStockDialog(count) {
  if (!can('stock.count_approve')) return;
  const diffCount = count.items.filter(i => Number(i.difference) !== 0).length;
  const checkbox = h('input', { type: 'checkbox', checked: true, style: 'margin-right: 8px; width: 18px; height: 18px;' });
  if (!count.baselineAt || !count.submittedAt) { checkbox.checked = false; checkbox.disabled = true; }

  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;

  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    busy = true;
    try {
      const updateStock = checkbox.checked;
      await api('/stock/counts/' + count.id + '/approve', { method: 'POST', body: { updateStock } }); if (!isCurrentSession(generation)) return;
      toast(updateStock ? 'Stock levels updated' : 'Count approved without updating stock');
      close();
      state.pendingCounts = null; state.stockData = null;
      loadStock(); loadPendingCounts();
    } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }

  overlay.append(
    h('div', { class: 'modal', style: 'min-width: 350px;' },
      h('h2', {}, 'Approve Stock Count'),
      h('p', { class: 'muted' }, `${count.countedBy?.name || 'Historical count'} - ${new Date(count.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})}`),
      h('div', { style: 'background: #2a2a2a; padding: 10px; border-radius: 6px; margin-bottom: 15px;' },
        h('div', { style: 'color: #d97706; font-weight: bold; margin-bottom: 5px;' }, `${diffCount} variances found`),
        count.items.filter(i => Number(i.difference) !== 0).map(i =>
          h('div', { style: 'font-size: 12px; display:flex; justify-content:space-between;' },
            h('span', {}, i.product.name),
            h('span', { style: Number(i.difference) > 0 ? 'color: #1a7f37;' : 'color: #b91c1c;' }, `${fmtQty(i.systemQty)} -> ${fmtQty(i.countedQty)} (${Number(i.difference) > 0 ? '+' : ''}${fmtQty(i.difference)})`)
          )
        )
      ),
      h('label', { style: 'display:flex; align-items:center; cursor:pointer; font-weight: bold; color: #fff;' },
        checkbox, 'Update actual stock levels'
      ),
      h('p', { class: 'muted', style: 'font-size: 11px; margin-top: 4px; margin-left: 26px;' },
        count.baselineAt ? 'Apply the fixed verified variance once; movements since submission are preserved. Untick to archive without changing stock.' : 'Historical baseline is unverified. Records-only archival is available; start a new physical count to correct stock.'
      ),
      error,
      h('div', { class: 'actions', style: 'margin-top: 20px;' },
        h('button', { class: 'ghost', onclick: close }, 'Cancel'),
        h('button', { class: 'primary', onclick: submit }, 'Confirm Approval')
      )
    )
  );
  document.body.append(overlay);
}

// Stock Count: server baseline, explicit physical input, no cached quantities.
function adoptStockCount(data, keepInputs = false) {
  const old = new Map((state.stockCountData || []).map(i => [i.productId, i.countedQty]));
  state.stockCountSession = data.count;
  state.stockCountClockOffset = new Date(data.serverNow).getTime() - Date.now();
  state.stockCountData = data.count.items.map(i => ({ productId: i.productId, name: i.product.name, unit: i.product.unitOfMeasure,
    systemQty: i.systemQty, countedQty: keepInputs && old.has(i.productId) ? old.get(i.productId) : i.countedQty === null ? '' : String(i.countedQty) }));
  state.stockCountMode = true;
}
async function openStockCount(id) {
  const currentAccess = accessGuard();
  if (!can('stock.count') && !can('stock.count_approve')) return;
  try { const data = await api('/stock/counts/' + id); if (!currentAccess()) return; adoptStockCount(data); render(); } catch (err) { if (!currentAccess()) return; toast(err.message, true); }
}
async function startStockCount() {
  const generation = sessionGeneration;
  if (!can('stock.count')) return;
  if (!state.stockData) await loadStock();
  if (!isCurrentSession(generation)) return;
  if (!state.stockData) return;
  const overlay = h('div', { class: 'overlay' });
  const choices = state.stockData.filter(p => p.type === 'simple').map(p => ({ p, input: h('input', { type: 'checkbox' }) }));
  const error = h('div', { class: 'error' });let busy = false;
  const begin = async () => {
    const generation = sessionGeneration;
    if (busy) return;
    const productIds = choices.filter(c => c.input.checked).map(c => c.p.id);
    if (!productIds.length || productIds.length > 20) { error.textContent = 'Choose 1 to 20 products; keep the group small.'; return; }
    busy = true;
    try { const data = await api('/stock/counts/start', { method: 'POST', body: { productIds } }); if (!isCurrentSession(generation)) return; adoptStockCount(data);overlay.remove();render(); }
    catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    finally { if (!isCurrentSession(generation)) return; busy = false; }
  };
  const sessions = await api('/stock/counts').catch(() => ({ counts: [] })); if (!isCurrentSession(generation)) return;
  overlay.append(h('div', { class: 'modal', style: 'max-height:85vh;overflow:auto;' }, h('h2', {}, 'Choose stock to count'),
    h('p', {}, 'Selected ingredients pause stock-changing orders, receipts, purchases and cancellations. Payments and unaffected orders continue. The default pause is five minutes.'),
    sessions.counts.filter(c => c.phase !== 'LEGACY').map(c => h('button', { class: 'ghost', onclick: () => { overlay.remove();openStockCount(c.id); } }, 'Open ' + c.phase + ' session ' + c.id.slice(-6))),
    choices.map(({ p, input }) => h('label', { style: 'display:block;' }, input, ' ', p.name)), error,
    h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: () => overlay.remove() }, 'Cancel'), h('button', { class: 'primary', onclick: begin }, 'Pause Selected Products'))));
  document.body.append(overlay);
}
async function stockCountAction(action) {
  const generation = sessionGeneration;
  if (state.stockCountBusy) return;
  state.stockCountBusy = true;
  try {
    const data = await api('/stock/counts/' + state.stockCountSession.id + '/' + action, { method: 'POST', body: action === 'ready' ? { physicalReady: true } : {} }); if (!isCurrentSession(generation)) return;
    if (action === 'discard') { state.stockCountMode = false;state.stockCountSession = null;state.stockCountData = null;state.stockData = null;loadStock();loadPendingCounts(); }
    else adoptStockCount(data, true);
  } catch (err) { if (!isCurrentSession(generation)) return; toast(err.message, true); }
  finally { if (!isCurrentSession(generation)) return; state.stockCountBusy = false;render(); }
}
function stockCountView() {
  const count = state.stockCountSession;
  if (!count) return h('p', {}, 'Open a server-owned count session to begin.');
  const expired = !count.submittedAt && new Date(count.expiresAt).getTime() <= Date.now() + state.stockCountClockOffset;
  const editable = count.status === 'DRAFT' && count.readyAt && !count.submittedAt && !expired;
  const heading = h('div', { class: 'row' }, h('h2', {}, 'Physical Stock Count'), h('div', {},
    h('button', { class: 'ghost', onclick: () => { state.stockCountMode = false;render(); } }, 'Leave View'),
    h('button', { class: 'ghost', onclick: () => openStockCount(count.id) }, 'Refresh Status'),
    count.status === 'DRAFT' ? h('button', { class: 'ghost', onclick: () => stockCountAction('discard') }, 'Discard Session') : null,
    !count.submittedAt && !expired && count.status === 'DRAFT' ? h('button', { class: 'ghost', onclick: () => stockCountAction('extend') }, 'Extend Pause') : null,
    editable ? h('button', { class: 'primary', onclick: submitStockCount }, 'Submit for Approval') : null));
  const instructions = h('p', {}, expired ? 'Session expired. Its baseline cannot be reused. Discard it and start a new physical count.' : count.submittedAt ? 'Submitted. Stock movements have resumed; this product group awaits approval or discard.' :
    'Stock changes for these products are paused until ' + new Date(count.expiresAt).toLocaleTimeString('en-KE',{timeZone:'Africa/Nairobi'}) + '. Finish or segregate pending pours and reserved units, hold deliveries and physical returns separately, then count available stock. Leaving this view does not discard the session.');
  const ready = !count.readyAt && !expired && count.status === 'DRAFT' ? h('button', { class: 'primary', onclick: () => stockCountAction('ready') }, 'Physical Stock Aligned ? Start Counting') : null;
  const rows = (state.stockCountData || []).map(p => h('tr', {}, h('td', {}, p.name), h('td', {}, fmtQty(p.systemQty) + ' ' + p.unit),
    h('td', {}, h('input', { type: 'number', min: '0', step: '0.000001', value: p.countedQty, disabled: !editable, placeholder: 'Enter physical quantity',
      oninput: e => { p.countedQty = e.target.value;renderCountDifference(); } }), ' ', p.unit), h('td', { id: 'diff-' + p.productId }, '')));
  const generation = sessionGeneration;
  setTimeout(() => { if (isCurrentSession(generation)) renderCountDifference(); }, 0);
  return h('div', {}, heading, instructions, ready, h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, ['Product', 'Captured Baseline', 'Physical Quantity', 'Variance'].map(s => h('th', {}, s)))), h('tbody', {}, rows)));
}
function physicalCountPayload(items) {
  return items.map(p => {
    let raw;
    try { raw = stockQuantityText(p.countedQty); } catch { throw new Error('Enter a physical quantity for every product, using at most six decimal places.'); }
    return { productId: p.productId, countedQty: raw };
  });
}
function renderCountDifference() {
  for (const p of state.stockCountData || []) {
    const cell = document.getElementById('diff-' + p.productId);
    if (!cell) continue;
    const raw = String(p.countedQty ?? '').trim();
    cell.textContent = raw === '' || !Number.isFinite(Number(raw)) ? 'Not counted' : (Number(raw) - Number(p.systemQty)).toFixed(6);
  }
}
async function submitStockCount() {
  const generation = sessionGeneration;
  if (state.stockCountBusy) return;
  state.stockCountBusy = true;
  try {
    const count = state.stockCountSession;
    await api('/stock/count', { method: 'POST', body: { sessionId: count.id, items: physicalCountPayload(state.stockCountData) } }); if (!isCurrentSession(generation)) return;
    state.stockCountMode = false;state.stockCountSession = null;state.stockCountData = null;state.stockData = null;
    toast('Count submitted. Normal stock movements have resumed.');loadStock();loadPendingCounts();
  } catch (err) { if (!isCurrentSession(generation)) return; toast(err.message, true); }
  finally { if (!isCurrentSession(generation)) return; state.stockCountBusy = false;render(); }
}

// ---------- Purchases ----------

function purchaseDialog() {
  if(!can('purchases.manage')||state.stockLoading||!Array.isArray(state.stockData)||!state.stockData.length)return;
  return acctDocument('PURCHASE');
}
function legacyPurchaseLayoutReference() {
  if (!can('purchases.manage') || !Array.isArray(state.stockData) || !state.stockData.length) return;
  const supplier = h('input', { 'aria-label':'Supplier name', type: 'text', placeholder: 'e.g. KBL or General Supplier', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const invoiceRef=h('input',{'aria-label':'Supplier invoice reference',placeholder:'Supplier invoice reference (optional)'}),invoiceDate=h('input',{type:'date','aria-label':'Supplier invoice date',value:new Date(Date.now()+10800000).toISOString().slice(0,10)}),clientRequestId=financialClientKey();
  const method = h('select', { style: 'width: 100%; padding: 8px; margin-top: 8px;' }, h('option', { value: 'CASH' }, 'Cash'), h('option', { value: 'MPESA' }, 'M-Pesa'));
  const shift = shiftContextControl(method);
  // Recipe items cannot be bought, only their ingredients
  const buyable = state.stockData.filter(p => p.type !== 'composite');
  const productSelect = h('select', { 'aria-label':'Purchase product', style: 'width: 100%; padding: 8px; margin-top: 8px;' }, buyable.map(p => h('option', { value: p.id }, p.name)));
  const productSearch=h('input',{'aria-label':'Purchase product search',placeholder:'Product name or code'});
  let productSearchVersion=0;
  const findProducts=h('button',{class:'ghost',onclick:async()=>{const version=++productSearchVersion,current=accessGuard();findProducts.disabled=true;error.textContent='';try{const data=await api('/stock/options?q='+encodeURIComponent(productSearch.value.trim())+'&pageSize=200');if(!current()||!overlay.isConnected||version!==productSearchVersion)return;const options=data.products.filter(p=>p.type!=='composite');for(const p of options)if(!state.stockData.some(x=>x.id===p.id))state.stockData.push(p);productSelect.replaceChildren(...options.map(p=>h('option',{value:p.id},p.name)));if(!options.length)error.textContent='No matching products.';}catch(e){if(current()&&overlay.isConnected)error.textContent=e.message;}finally{if(current()&&overlay.isConnected)findProducts.disabled=false;}}},'Find purchase products');
  const qty = h('input', { 'aria-label':'Purchase quantity', type: 'number', min: '0.000001', step: '0.000001', placeholder: 'Quantity', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const cost = h('input', { 'aria-label':'Purchase unit cost', type: 'number', min: '0', step: '0.01', placeholder: 'Unit Cost (KSh)', style: 'width: 100%; padding: 8px; margin-top: 8px;' });

  const cart = [];
  const cartList = h('ul', { class: 'lines', style: 'margin-top: 10px; margin-bottom: 10px;' });
  const totalText = h('div', { style: 'font-weight:bold; margin-bottom: 10px;' }, 'Total: KSh 0');

  const addBtn = h('button', { class: 'ghost', style: 'margin-top: 10px; width: 100%;', onclick: () => {
    const prodId = productSelect.value; const c = Number(cost.value);
    let q;
    try { q = stockQuantityText(qty.value, { positive: true }); } catch (err) { error.textContent = err.message; return; }
    if (!prodId || !q || !c) return;
    const pName = state.stockData.find(p => p.id === prodId).name;
    cart.push({ productId: prodId, name: pName, quantity: q, unitCost: c, totalCost: q * c });
    cartList.append(h('li', {}, h('span', {}, q + ' x ' + pName), h('span', {}, ksh(q * c))));
    totalText.textContent = 'Total: ' + ksh(cart.reduce((sum, i) => sum + i.totalCost, 0));
    qty.value = ''; cost.value = '';
  }}, '+ Add Item to Invoice');

  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;

  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    if (!supplier.value || cart.length === 0) { error.textContent = 'Supplier Name and at least 1 item required (Click "+ Add Item")'; return; }
    busy = true;
    try {
      await api('/purchases', { method: 'POST', body: { supplierName: supplier.value, ...(invoiceRef.value.trim()?{invoiceNumber:invoiceRef.value.trim()}:{}), invoiceDate:invoiceDate.value,clientRequestId,method: method.value, items: cart, shiftId: shift.read() } }); if (!isCurrentSession(generation)) return;
      close(); toast('Purchase recorded successfully'); state.stockData = null; if(state.boTab==='purchaseInvoices')void loadInvoicePage('purchases');else loadStock();
    } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }

  overlay.append(
    h('div', { class: 'modal', style: 'min-width: 400px; max-height: 85vh; overflow-y: auto;' },
      h('h2', {}, 'Record Supplier Purchase'),
      h('label', {}, 'Supplier Name'), supplier, h('label',{},'Supplier invoice reference'),invoiceRef,h('label',{},'Supplier invoice date'),invoiceDate,h('label', {}, 'Payment Method'), method,
      shift.view,
      h('hr', { style: 'margin: 15px 0;' }), h('h3', {}, 'Add Items'),
      h('label', {}, 'Find product'),productSearch,findProducts,h('label', {}, 'Product'), productSelect, h('label', {}, 'Quantity'), qty, h('label', {}, 'Unit Cost (KSh)'), cost, addBtn,
      cartList, totalText, error,
      h('div', { class: 'actions', style: 'margin-top: 20px;' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, 'Save Invoice'))
    )
  );
  document.body.append(overlay);
}

// ---------- STAFF ----------

async function loadStaff() {
  const currentAccess = filterGuard('staff');
  if (!can('users.manage')) { state.staffData = null; state.staffAdministration = null; return false; }
  // Invalidate hints before refreshing; failed or overlapping reads cannot
  // authorize UI controls with another actor's or an older response's hints.
  const actorId = state.user?.id, requestId = ++staffReadVersion;
  state.staffAdministration = null;
  try {
    const data = await api('/users'+filterQuery('staff','page=1')); if(currentAccess())state.filterPages.staff=data.pagination; if (!currentAccess()) return;
    if (requestId !== staffReadVersion || actorId !== state.user?.id || !can('users.manage')) return false;
    state.staffData = data.users; state.staffAdministration = data.administration;
    if (state.boTab === 'staff') render(); return !!staffMetadata();
  } catch (err) { if (!currentAccess()) return;
    if (requestId === staffReadVersion) { state.staffData = null; state.staffAdministration = null; }
    toast(administrationError(err), true); return false;
  }
}

let staffReadVersion = 0;
const staffMetadataNotice = 'Staff authorization details are unavailable or outdated. Refresh staff before making changes.';
function staffMetadata() {
  const metadata = state.staffAdministration;
  if (!state.user || !can('users.manage') || !Array.isArray(state.staffData) || metadata?.actorId !== state.user.id ||
      typeof metadata.canCreate !== 'boolean' || !Array.isArray(metadata.createRoles) ||
      metadata.createRoles.some(role => !['WAITER', 'CASHIER', 'MANAGER'].includes(role)) ||
      metadata.canCreate !== (metadata.createRoles.length > 0) || !metadata.targets || typeof metadata.targets !== 'object') return null;
  return metadata;
}
function staffRules(target) {
  const rule = staffMetadata()?.targets[target?.id];
  if (!rule || rule.canEdit !== true || !Array.isArray(rule.editableFields) || !rule.editableFields.includes('name') ||
      rule.editableFields.some(field => !['name', 'role', 'pin', 'isActive', 'commissionRate'].includes(field)) ||
      ['canChangeRole', 'canResetPin', 'requiresCurrentPin'].some(key => typeof rule[key] !== 'boolean')) return null;
  return rule;
}
function staffAccess(target) {
  const metadata = staffMetadata();
  if (!metadata) return false;
  if (!target) return metadata.canCreate ? JSON.stringify(metadata.createRoles) : false;
  const rule = staffRules(target);
  return rule ? JSON.stringify(rule) : false;
}
function staffView() {
  if (!can('users.manage')) return h('p', { class: 'error' }, 'Staff administration is not permitted.');
  const heading = h('div', { class: 'row' }, h('h2', { style: 'margin:0;' }, 'Staff Management'), staffAccess() ? h('button', { class: 'primary', onclick: () => staffDialog() }, '+ Add Staff') : null);
  if (!state.staffData) return h('div', {}, heading, h('p', { class: 'muted' }, 'Staff data is not available.'), h('button', { class: 'ghost', onclick: loadStaff }, 'Refresh staff'));
  const rows = state.staffData.map(u => h('tr', { style: !u.isActive ? 'opacity: 0.5;' : '' }, h('td', {}, u.name), h('td', {}, u.role), h('td', {}, u.commissionRate != null ? u.commissionRate + '%' : 'Unverified'), h('td', {}, u.isActive ? h('span', { style: 'color: #1a7f37;' }, 'Active') : h('span', { style: 'color: #b91c1c;' }, 'Inactive')), h('td', { style: 'text-align:right;' }, staffAccess(u) ? h('button', { class: 'ghost', style: 'padding: 4px 8px; font-size: 12px;', onclick: () => staffDialog(u) }, 'Edit') : h('span', { class: 'muted' }, 'Editing unavailable'))));
  const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Role'), h('th', {}, 'Commission'), h('th', {}, 'Status'), h('th', {}, 'Action'))), h('tbody', {}, rows));
  return h('div', {}, heading, !staffMetadata() ? h('p', { class: 'muted' }, staffMetadataNotice) : null, table,
    h('button', { class: 'ghost', onclick: loadStaff }, 'Refresh staff'));
}

function staffDialog(existingUser) {
  const access = staffAccess(existingUser);
  if (!access) { toast(can('users.manage') ? 'This account or creation action is unavailable. ' + staffMetadataNotice : administrationError({ status: 403 }), true); return; }
  const isEdit = !!existingUser;
  const self = isEdit && existingUser.id === state.user.id;
  const rules = isEdit ? staffRules(existingUser) : null;
  const fields = isEdit ? rules.editableFields : ['name', 'role', 'pin', 'commissionRate'];
  const allowedRoles = staffMetadata().createRoles;
  let baseline = existingUser ? { ...existingUser } : null;
  const name = h('input', { type: 'text', value: isEdit ? existingUser.name : '', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const role = fields.includes('role') && (!isEdit || rules.canChangeRole) ? h('select', { 'aria-label': 'Role' }, allowedRoles.map(r => h('option', { value: r, selected: isEdit && existingUser.role === r ? 'selected' : false }, r))) : null;
  const pin = fields.includes('pin') && (!isEdit || self || rules.canResetPin) ? h('input', { type: 'password', 'aria-label': 'New PIN', autocomplete: 'new-password', inputmode: 'numeric', maxlength: '6', placeholder: isEdit ? 'Leave blank to keep current PIN' : '4-6 digits' }) : null;
  const payrollOnly = !isEdit && state.user.role==='MANAGER' ? h('input',{type:'checkbox','aria-label':'Payroll-only employee (no POS login)',onchange:()=>{if(pin){pin.value='';pin.disabled=payrollOnly.checked;}}}) : null;
  const currentPin = rules?.requiresCurrentPin ? h('input', { type: 'password', 'aria-label': 'Current PIN', autocomplete: 'off', inputmode: 'numeric', maxlength: '6' }) : null;
  const rate = fields.includes('commissionRate') ? h('input', { type: 'number', 'aria-label': 'Commission rate', min: '0', max: '100', step: '0.01', value: isEdit ? (existingUser.commissionRate ?? '') : 2 }) : null;
  const isActive = isEdit && fields.includes('isActive') ? h('input', { type: 'checkbox', 'aria-label': 'Active', checked: existingUser.isActive, style: 'margin-right: 8px;' }) : null;
  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const clearPins = () => { if (pin) pin.value = ''; if (currentPin) currentPin.value = ''; };
  let busy = false, closed = false, needsReview = false;
  const close = () => { closed = true; clearPins(); overlay.remove(); };
  const save = h('button', { class: 'primary', onclick: submit }, isEdit ? 'Save Changes' : 'Create Staff');
  const review = h('button', { class: 'ghost', hidden: true, onclick: refreshForReview }, 'Review refreshed data');

  async function refreshForReview() {
    const generation = sessionGeneration;
    if (busy || closed) return;
    busy = true; save.disabled = true; clearPins();
    try {
      const loaded = await loadStaff();
      if (!isCurrentSession(generation)) return;
      if (!loaded) { error.textContent = 'Staff refresh failed. Refresh successfully before submitting again.'; return; }
      if (isEdit) {
        const fresh = state.staffData.find(u => u.id === baseline.id);
        if (!fresh || staffAccess(fresh) !== access) { error.textContent = 'Access or account changed. Close this dialog and review staff.'; return; }
        const changes = ['name', 'role', 'isActive', 'commissionRate'].filter(key => String(fresh[key]) !== String(baseline[key]));
        // Rebase untouched controls, retaining only deliberate local edits.
        if (name.value.trim() === baseline.name) name.value = fresh.name;
        if (role && role.value === baseline.role) role.value = fresh.role;
        if (rate && Number(rate.value) === Number(baseline.commissionRate)) rate.value = fresh.commissionRate ?? '';
        if (isActive && isActive.checked === baseline.isActive) isActive.checked = fresh.isActive;
        error.textContent = changes.length ? 'Server fields changed: ' + changes.join(', ') + '. Your entries are retained; compare with the refreshed Staff list before saving.' : 'Staff data refreshed. Review your entries and enter PINs again if needed.';
        baseline = { ...fresh };
      } else {
        if (staffAccess() !== access) { error.textContent = 'Creation permissions changed. Close this dialog and review staff.'; return; }
        error.textContent = 'Staff data refreshed. Review your entries and enter the new PIN again.';
      }
      needsReview = false; review.hidden = true;
    } finally { if (!isCurrentSession(generation)) return; busy = false; save.disabled = needsReview || closed; }
  }

  async function submit() {
    const generation = sessionGeneration;
    if (busy || closed || needsReview) return;
    error.textContent = '';
    if (staffAccess(existingUser) !== access) { clearPins(); error.textContent = administrationError({ status: 403 }); return; }
    if (name.value.trim().length < 2) { clearPins(); error.textContent = 'Name must contain at least two characters.'; return; }
    if (pin && !payrollOnly?.checked && (!isEdit || pin.value) && !/^\d{4,6}$/.test(pin.value)) { clearPins(); error.textContent = 'Enter a PIN containing 4 to 6 digits.'; return; }
    if (currentPin && pin?.value && !/^\d{4,6}$/.test(currentPin.value)) { clearPins(); error.textContent = 'Confirm the current PIN to change your PIN.'; return; }
    if (currentPin?.value && !pin?.value) { clearPins(); error.textContent = 'Enter a new PIN with its current-PIN confirmation.'; return; }
    if (rate && (rate.value === '' || !Number.isFinite(Number(rate.value)) || Number(rate.value) < 0 || Number(rate.value) > 100)) { clearPins(); error.textContent = 'Commission rate must be between 0 and 100.'; return; }
    const body = {};
    if(payrollOnly?.checked)body.payrollOnly=true;
    if (!isEdit || name.value.trim() !== baseline.name) body.name = name.value.trim();
    if (role && (!isEdit || role.value !== baseline.role)) body.role = role.value;
    if (rate && (!isEdit || Number(rate.value) !== Number(baseline.commissionRate))) body.commissionRate = Number(rate.value);
    if (isActive && isActive.checked !== baseline.isActive) body.isActive = isActive.checked;
    if (pin?.value) { body.pin = pin.value; if (currentPin) body.currentPin = currentPin.value; }
    if (!Object.keys(body).length) { clearPins(); error.textContent = 'No changes to save.'; return; }
    busy = true; save.disabled = true;
    try {
      // api serializes synchronously. Drop local credential references before
      // waiting for the network, and never retain them for a retry.
      const request = api(isEdit ? '/users/' + baseline.id : '/users', { method: isEdit ? 'PATCH' : 'POST', body });
      delete body.pin; delete body.currentPin; clearPins();
      const data = await request;
      if (!isCurrentSession(generation)) return;
      if (closed) return;
      if (self) state.user.name = data.user.name;
      toast(isEdit ? 'Staff updated' : 'Staff added'); close(); state.staffData = null; await loadStaff();
    } catch (err) { if (!isCurrentSession(generation)) return;
      clearPins();
      if (closed) return;
      error.textContent = administrationError(err);
      if (err.status === 409 || err.status === 403) { needsReview = true; review.hidden = false; await loadStaff(); }
    } finally { if (!isCurrentSession(generation)) return; clearPins(); busy = false; save.disabled = closed || needsReview; }
  }

  overlay.append(h('div', { class: 'modal', style: 'min-width: 320px;' }, h('h2', {}, isEdit ? 'Edit Staff' : 'Add New Staff'), h('label', {}, 'Name'), name,
    role ? h('label', {}, 'Role') : null, role, rate ? h('label', {}, 'Commission Rate (%)') : null, rate,
    currentPin ? h('label', {}, 'Current PIN (required when changing PIN)') : null, currentPin,
    payrollOnly ? h('label',{},payrollOnly,'Payroll-only employee — no POS PIN or login; salary/attendance remain available.') : null,
    pin ? h('label', {}, isEdit ? 'New PIN (optional)' : 'PIN (4-6 digits)') : null, pin,
    isActive ? h('label', {}, isActive, 'Active (can log in)') : null,
    error, h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), review, save)));
  document.body.append(overlay);
}

// ---------- EXPENSES ----------

async function loadExpenses() {
  if (!can('expenses.manage')) return;
  const currentAccess = filterGuard('expenses');
  state.filterErrors.expenses=null;
  try { const data = await api('/expenses'+filterQuery('expenses')); if(currentAccess())state.filterPages.expenses=data.pagination; if (!currentAccess()) return; state.expensesData = data.expenses; if (state.boTab === 'expenses') render(); } catch (err) { if (!currentAccess()) return; state.expensesData=[];state.filterErrors.expenses=err.message;toast(err.message, true);render(); }
}

function expensesView() {
  const heading = h('div', { class: 'row' }, h('h2', { style: 'margin:0;' }, 'Expenses'), h('button', { class: 'primary', onclick: () => addExpenseDialog() }, '+ Record Expense'));
  if (!state.expensesData) return h('div', {}, heading, h('p', { class: 'muted' }, 'Loading expenses...'));
  const rows = state.expensesData.map(e => h('tr', {}, h('td', {}, e.expenseNumber || '-'), h('td', {}, new Date(e.createdAt).toLocaleDateString('en-KE',{timeZone:'Africa/Nairobi'})), h('td', {}, e.category), h('td', {}, e.description), h('td', {}, e.method), h('td', {}, e.recordedBy?.name || 'Unknown'), h('td', { style: 'text-align:right; font-weight: bold;' }, ksh(e.amount))));
  const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Exp #'), h('th', {}, 'Date'), h('th', {}, 'Category'), h('th', {}, 'Description'), h('th', {}, 'Method'), h('th', {}, 'Recorded By'), h('th', { style: 'text-align:right;' }, 'Amount'))), h('tbody', {}, rows));
  return h('div', {}, heading, table);
}

function addExpenseDialog() {
  if (!can('expenses.manage')) return;
  acctDocument('EXPENSE');return;
}
function legacyExpenseLayoutReference() {
  if (!can('expenses.manage')) return;
  const amount = h('input', { type: 'number', min: '1', step: '0.01', placeholder: 'e.g. 1500', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const category = h('select', { style: 'width: 100%; padding: 8px; margin-top: 8px;' }, ['Utilities', 'Rent', 'Salaries', 'Stock Purchase', 'Maintenance', 'Miscellaneous'].map(c => h('option', { value: c }, c)));
  const description = h('input', { type: 'text', placeholder: 'e.g. KPLC Token', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const method = h('select', { style: 'width: 100%; padding: 8px; margin-top: 8px;' }, h('option', { value: 'CASH' }, 'Cash'), h('option', { value: 'MPESA' }, 'M-Pesa'));
  const shift = shiftContextControl(method);

  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  let busy = false;

  async function submit() {
    const generation = sessionGeneration;
    if (busy) return;
    if (!amount.value || !description.value) { error.textContent = 'Amount and description required'; return; }
    busy = true;
    try {
      await api('/expenses', { method: 'POST', body: { amount: Number(amount.value), category: category.value, description: description.value, method: method.value, shiftId: shift.read() } }); if (!isCurrentSession(generation)) return;
      close(); toast('Expense recorded'); state.expensesData = null; loadExpenses();
    } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
    busy = false;
  }

  overlay.append(h('div', { class: 'modal', style: 'min-width: 320px;' }, h('h2', {}, 'Record Expense'), h('label', {}, 'Amount (KSh)'), amount, h('label', {}, 'Category'), category, h('label', {}, 'Description'), description, h('label', {}, 'Payment Method'), method, shift.view, error, h('div', { class: 'actions', style: 'margin-top: 20px;' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, 'Save Expense'))));
  document.body.append(overlay);
}

// ---------- SHIFTS ----------

async function loadMyShift() {
  const generation = sessionGeneration;
  try { const data = await api('/shifts/mine/open'); if (!isCurrentSession(generation)) return; state.shiftData = data.shift; state.businessDayDate=data.businessDayDate||null; if (state.user) render(); } catch (err) { if (!isCurrentSession(generation)) return; state.shiftData = null; if (state.user) render(); }
}

function openShiftDialog() {
  if (!canShiftAction()) return;
  const cash = h('input', { type: 'number', value: '0', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const error = h('div', { class: 'error' });
  const overlay = h('div', { class: 'overlay' });
  const close = () => overlay.remove();
  async function submit() {
    const generation = sessionGeneration;
    try { await api('/shifts/open', { method: 'POST', body: { openingCash: Number(cash.value) } }); if (!isCurrentSession(generation)) return; close(); toast('Shift opened'); await loadMyShift(); } catch (err) { if (!isCurrentSession(generation)) return; error.textContent = err.message; }
  }
  overlay.append(h('div', { class: 'modal' }, h('h2', {}, 'Open Shift'), h('label', {}, 'Opening Cash Float (KSh)'), cash, error, h('div', { class: 'actions' }, h('button', { class: 'ghost', onclick: close }, 'Cancel'), h('button', { class: 'primary', onclick: submit }, 'Open Shift'))));
  document.body.append(overlay);
}

function canCloseShift(shift) {
  return shift?.status === 'OPEN' && (can('shifts.manage') || (shift.openedById === state.user?.id && canShiftAction()));
}
function closeShiftDialog(shift = state.shiftData) {
  if (!canCloseShift(shift)) return;
  const shiftId = shift.id, key = workflowKey('shift', shiftId), current = accessGuard();
  if (workflowWrites.has(key)) return;
  const cash = h('input', { type: 'number', min: '0', step: '0.01', value: '', placeholder: 'Enter actual cash in drawer', style: 'width: 100%; padding: 8px; margin-top: 8px;' });
  const acknowledged = h('input', { type: 'checkbox', style: 'width:18px;height:18px;margin-right:8px;' });
  const error = h('div', { class: 'error', role: 'status' });
  const overlay = h('div', { class: 'overlay' });
  let closed = false, review = false;
  const close = () => { if (workflowWrites.has(key)) return; closed = true; overlay.remove(); };
  const confirm = h('button', { class: 'primary', onclick: submit }, 'Confirm closure');
  const cancel = h('button', { class: 'ghost', onclick: close }, 'Cancel');
  async function submit() {
    if (closed || review || !current() || !canCloseShift(shift) || workflowWrites.has(key)) return;
    if (!acknowledged.checked || cash.value.trim() === '' || !Number.isFinite(Number(cash.value)) || Number(cash.value) < 0) { error.textContent = 'Enter a nonnegative cash count and confirm closure.'; return; }
    workflowWrites.add(key); confirm.disabled = cancel.disabled = true;
    try {
      const res = await api('/shifts/' + encodeURIComponent(shiftId) + '/close', { method: 'POST', body: { closingCash: Number(cash.value) } }); if (!current() || closed) return;
      closed = true; overlay.remove(); const variance = res.cashVariance;
      if (variance === 0) toast('Shift closed perfectly balanced!');
      else if (variance > 0) toast('Shift closed. Over by KSh ' + variance);
      else toast('Shift closed. Short by KSh ' + Math.abs(variance), true);
      if (state.shiftData?.id === shiftId) state.shiftData = null;
      await loadMyShift(); if (current() && can('shifts.manage')) await loadShifts();
    } catch (err) {
      if (!current() || closed) return; error.textContent = err.message;
      if (err.status === 403 || err.status === 409 || err.status === 404) {
        review = true; error.textContent += ' Refresh and review the shift before opening a new confirmation.';
        await loadMyShift(); if (current() && can('shifts.manage')) await loadShifts();
      }
    } finally {
      workflowWrites.delete(key);
      if (current()) {
        if (!closed) { confirm.disabled = review; cancel.disabled = false; }
        if (state.shiftsList && state.tab === 'backoffice' && state.boTab === 'shifts') render();
      }
    }
  }
  overlay.append(h('div', { class: 'modal' }, h('h2', {}, 'Close Shift'), h('p', {}, 'Shift ' + (shift.name || shiftId) + ' — ' + (shift.openedBy?.name || 'shift owner')),
    h('p', {}, 'Count this shift drawer. Closing fixes its reconciliation and rejects later transactions against it.'),
    h('label', {}, 'Actual Cash Count (KSh)'), cash, h('label', {}, acknowledged, ' I confirm this shift and counted cash are correct.'), error,
    h('div', { class: 'actions' }, cancel, confirm)));
  document.body.append(overlay);
}

async function loadShifts() {
  if (!can('shifts.manage')) return;
  const currentAccess = filterGuard('shifts');
  state.filterErrors.shifts=null;
  try { const data = await api('/shifts'+filterQuery('shifts')); if(currentAccess())state.filterPages.shifts=data.pagination; if (!currentAccess()) return; state.shiftsList = data.shifts; if (state.boTab === 'shifts') render(); } catch (err) { if (!currentAccess()) return; state.shiftsList=[];state.filterErrors.shifts=err.message;toast(err.message, true);render(); }
}

function shiftsView() {
  if (!can('shifts.manage')) return h('p', {}, 'Shift history access is not permitted.');
  const heading = h('h2', {}, 'Shift History');
  if (!state.shiftsList) return h('div', {}, heading, h('p', { class: 'muted' }, 'Loading...'));
  const rows = state.shiftsList.map(s => {
    const variance = s.closingCash !== null && s.expectedCash !== null ? Number(s.closingCash) - Number(s.expectedCash) : null;
    return h('tr', {}, h('td', {}, s.name || '-'), h('td', {}, new Date(s.openedAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})), h('td', {}, s.openedBy.name), h('td', {}, s.status), h('td', {}, ksh(s.openingCash)), h('td', {}, s.closingCash ? ksh(s.closingCash) : '-'), h('td', {}, s.expectedCash !== null ? ksh(s.expectedCash) : 'Unverified'), h('td', { style: variance === null ? '' : variance < 0 ? 'color:red; font-weight:bold;' : variance > 0 ? 'color:orange;' : 'color:green;' }, variance === null ? '-' : ksh(variance)),
      h('td', {}, canCloseShift(s) ? h('button', { class: 'ghost', disabled: workflowWrites.has(workflowKey('shift', s.id)), onclick: () => closeShiftDialog(s) }, 'Close shift') : null));
  });
  const table = h('table', { class: 'report-table' }, h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Opened'), h('th', {}, 'User'), h('th', {}, 'Status'), h('th', {}, 'Float'), h('th', {}, 'Counted'), h('th', {}, 'Expected'), h('th', {}, 'Variance'), h('th', {}, 'Action'))), h('tbody', {}, rows));
  return h('div', {}, heading, table);
}

// ---------- start ----------

async function boot() {
  discardLegacyToken();
  window.addEventListener('storage',onSessionStorage);
  window.addEventListener('focus',()=>refreshPermissions().catch(()=>{}));
  const generation=sessionGeneration;
  try {
    const response=await fetch('/api/auth/me',{credentials:'same-origin',cache:'no-store'});
    if(!isCurrentSession(generation))return;
    if(response.ok){const data=await response.json();if(!isCurrentSession(generation))return;state.token=newSessionId();state.user=data.user;state.csrfToken=data.csrfToken;state.sessionContext=data.sessionContext;saveToken();await startApp();if(isCurrentSession(generation))await loadMyShift();return;}
    if(response.status!==401)throw Error('Unable to verify session');
    await ensureCsrf();showLogin();
  } catch(error){if(!isCurrentSession(generation))return;if(error.stalePermissions&&state.user&&state.token){render();startTimer();connectPermissionSocket();void loadMyShift();return;}clearSession('Unable to restore your session. Please log in again.');}
}

// Shared filter controls. Values are session-scoped and survive navigation;
// identity/permission changes discard result caches and asynchronous readers.
function filterValues(key) { return state.filters[key] ||= {}; }
function filterQuery(key, initial='') {
  const query={};for(const pair of initial.split('&').filter(Boolean)){const [k,...v]=pair.split('=');query[decodeURIComponent(k)]=decodeURIComponent(v.join('='));}
  if(['date','start','end'].some(k=>filterValues(key)[k]))for(const k of ['date','start','end'])delete query[k];
  for(const [k,v] of Object.entries(filterValues(key)))if(v!==''&&v!=null)query[k]=String(v);
  const encoded=Object.entries(query).map(([k,v])=>encodeURIComponent(k)+'='+encodeURIComponent(v)).join('&');return encoded?'?'+encoded:'';
}
function filterGuard(key) { const current=accessGuard(),revision=state.readRevision||0,stamp=JSON.stringify(filterValues(key));return()=>current()&&revision===(state.readRevision||0)&&stamp===JSON.stringify(filterValues(key)); }
async function filterOptions(search='') {
  if(!state.user||!state.token)return;
  if(state.filterOptions||state.filterOptionsLoading)return;
  const access=accessGuard(),revision=state.readRevision||0,current=()=>access()&&revision===(state.readRevision||0);state.filterOptionsLoading=true;
  try{const data=await api('/shifts/options?pageSize=200'+(search?'&q='+encodeURIComponent(search):''));if(current())state.filterOptions=data;}
  catch(e){if(current())state.filterOptions={shifts:[],staff:[],error:e.message};}
  finally{if(current()){state.filterOptionsLoading=false;render();}}
}
function filterControls(key,apply,{dates=true,shift=true,staff=true,statuses=[],methods=false,search='Search',paginate=true}={}) {
  ensureReportPeriod(key);
  const f=filterValues(key), draft=state.filterDrafts[key]||={}, fields=[],inputs={};
  const input=(name,label,type='text')=>{const n=h('input',{type,value:draft[name]??f[name]??'',placeholder:label,'aria-label':label,oninput:e=>{draft[name]=e.target.value;if(name==='date'&&e.target.value){for(const other of ['start','end']){draft[other]='';if(inputs[other])inputs[other].value='';}}else if(['start','end'].includes(name)&&e.target.value){draft.date='';if(inputs.date)inputs.date.value='';}} });inputs[name]=n;fields.push(h('label',{},h('span',{class:'field-label'},label),n));};
  if(dates){input('date','Business date (Nairobi)','date');input('start','From (Nairobi)','date');input('end','To (Nairobi)','date');}
  input('q',search);
  if(shift||staff)void filterOptions();
  const select=(name,label,choices)=>{const selected=draft[name]??f[name]??(name==='balances'?'cutoff':undefined);if(selected&&!choices.some(c=>c.id===selected))choices.push({id:selected,name:selected});const n=h('select',{'aria-label':label,onchange:e=>{draft[name]=e.target.value;}},name==='balances'?null:h('option',{value:''},'All'),...choices.map(c=>h('option',{value:c.id,selected:selected===c.id},c.name)));inputs[name]=n;fields.push(h('label',{},label,n));};
  if(shift)select('shiftId','Shift',[{id:'unassigned',name:'Unassigned / unverifiable'},...(state.filterOptions?.shifts||[]).map(s=>({id:s.id,name:(s.name||s.id)+' · '+s.status+' · '+new Date(s.openedAt).toLocaleDateString('en-KE',{timeZone:'Africa/Nairobi'})}))]);
  if(staff)select('staffId','Staff member',state.filterOptions?.staff||[]);
  if(shift||staff){const find=h('input',{'aria-label':'Find shift or staff choices',placeholder:'Find older shift / staff name'});fields.push(h('label',{},'Find shift/staff choices',find),h('button',{class:'ghost',onclick:()=>{state.filterOptions=null;void filterOptions(find.value.trim());}},'Find choices'));}
  if(statuses.length)select('status','Status',statuses.map(s=>({id:s,name:s})));
  if(methods)select('method','Payment method',[{id:'CASH',name:'Cash'},{id:'MPESA',name:'M-Pesa'}]);
  if(['daily','dashboard'].includes(key))select('balances','Balance view',[{id:'cutoff',name:'At selected cutoff'},{id:'current',name:'Current balances (includes later events)'}]);
  const submit=()=>{for(const [name,node]of Object.entries(inputs))f[name]=node.value.trim();state.filterDrafts[key]={...f};f.page=1;if(key==='inventoryReport')f.movementPage=1;apply();};
  const reset=()=>{state.filters[key]={};state.filterDrafts[key]={};if(key==='orders')state.orderFilter='ALL';if(key==='daily')state.reportDate='';if(key==='pnl'||key==='commissions'){state.pnlStart='';state.pnlEnd='';}apply();};
  const contextActions=dates?periodActions(key,inputs,apply):null;
  const active=Object.entries(f).filter(([k,v])=>v&&k!=='page'&&k!=='pageSize').map(([k,v])=>k+': '+v).join(' · ');
  if(['orders','products','dashboard','daily','pnl','commissions','inventoryReport','countHistory'].includes(key)) {
    const query=fields[dates?3:0];
    const extra=fields.filter(node=>node!==query);
    const panel=extra.length?h('details',{class:'filter-more','data-filter-key':key,
      open:!mobileLayout.matches||mobileFilterExpanded.get(key)===true,
      ontoggle:e=>{if(mobileLayout.matches)mobileFilterExpanded.set(key,e.target.open);}},
      h('summary',{},'More filters'+(Object.entries(f).some(([name,value])=>value&&!['q','page','pageSize'].includes(name))?' · active':'')),
      h('div',{class:'filter-fields'},...extra)):null;
    if(panel&&contextActions)panel.append(contextActions);
    inputs.q.addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();submit();}});
    return h('section',{class:'filter-panel compact-filters '+(key==='products'?'product-search':''),'aria-label':key+' filters'},
      h('div',{class:'filter-search-row'},query,h('button',{class:'primary',onclick:submit},'Apply filters'),h('button',{class:'ghost',onclick:reset},'Clear filters')),
      panel,active?h('p',{class:'muted',role:'status'},'Active filters — '+active):null,
      state.filterOptions?.error?h('p',{class:'error'},'Filter choices unavailable: '+state.filterOptions.error):null,
      paginate?filterPager(key,apply):null);
  }
  return h('section',{class:'filter-panel','aria-label':key+' filters'},h('div',{class:'filter-fields'},...fields,h('button',{class:'primary',onclick:submit},'Apply filters'),h('button',{class:'ghost',onclick:reset},'Clear filters')),
    contextActions,h('p',{class:'muted',role:'status'},active?'Active filters — '+active:'No additional filters'),state.filterOptions?.error?h('p',{class:'error'},'Filter choices unavailable: '+state.filterOptions.error):null,
    paginate?filterPager(key,apply):null);
}
function filterPager(key,apply) {
  const p=state.filterPages[key];if(!p)return null;
  const go=delta=>{filterValues(key).page=p.page+delta;apply();};
  return h('div',{class:'row'},h('button',{class:'ghost',disabled:p.page<=1,onclick:()=>go(-1)},'Previous page'),h('span',{},'Page '+p.page+' of '+Math.max(1,p.pages)+' · '+p.total+' records'),h('button',{class:'ghost',disabled:p.page>=p.pages,onclick:()=>go(1)},'Next page'));
}
async function loadLedger(key,path,field) {
  const current=filterGuard(key);state.ledger[key]={loading:true};render();
  try{const data=await api(path+filterQuery(key));if(!current())return;state.ledger[key]={rows:data[field],note:data.attribution,totals:data.totals};state.filterPages[key]=data.pagination;}
  catch(e){if(!current())return;state.ledger[key]={error:e.message};}
  finally{if(current())render();}
}
function ledgerView(key,path,field,columns,options={}) {
  const data=state.ledger[key],load=()=>loadLedger(key,path,field);
  return h('section',{},filterControls(key,load,options),h('button',{class:'ghost',onclick:load},'Load / refresh '+key),
    data?.loading?h('p',{role:'status'},'Loading…'):data?.error?h('p',{class:'error',role:'alert'},data.error):data?.rows?.length?h('div',{class:'filter-table'},h('table',{class:'report-table'},h('thead',{},h('tr',{},...columns.map(c=>h('th',{},c[0])))),h('tbody',{},...data.rows.map(row=>h('tr',{},...columns.map(c=>h('td',{},String(c[1](row)??'Unassigned / unknown')))))))):h('p',{class:'muted'},data?'No matching records.':'Apply filters or load records.'),data?.note?h('p',{class:'muted'},data.note):null);
}


const baseNewOrderView=newOrderView;
newOrderView=function(){return h('div',{},filterControls('products',async()=>{const current=filterGuard('products');try{if(!filterValues('products').q){await loadCatalogue();if(current()){delete state.filterPages.products;render();}return;}const data=await api('/products'+filterQuery('products','page=1'));if(current()){state.products=data.products;state.filterPages.products=data.pagination;render();}}catch(e){if(current())toast(e.message,true);}},{dates:false,shift:false,staff:false,search:'Search products by name or code'}),baseNewOrderView());};
const baseStockView=stockView;
stockView=function(){if(!canInventory()||state.stockCountMode)return baseStockView();return h('div',{},filterControls('stock',()=>{state.stockData=null;loadStock();},{dates:false,shift:false,staff:false,search:'Search inventory product or code'}),baseStockView(),canReadStock()?h('details',{},h('summary',{},'Inventory movements'),ledgerView('movements','/stock/movements','movements',[['Date',r=>new Date(r.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})],['Product',r=>r.product.name],['Type',r=>r.type],['Change',r=>r.quantityChange],['Before',r=>r.previousQty],['After',r=>r.quantityAfter],['Origin shift',r=>r.shiftId]],{search:'Product or movement reason'})):null);};
for(const [key,view,load,options]of [['expenses',expensesView,loadExpenses,{methods:true,search:'Expense number, category or description'}],['shifts',shiftsView,loadShifts,{search:'Shift or owner',statuses:['OPEN','CLOSED']}],['staff',staffView,loadStaff,{dates:false,shift:false,staff:false,search:'Search staff by name',statuses:['ACTIVE','INACTIVE']}]]){
 const wrapped=()=>h('div',{},filterControls(key,load,options),state.filterErrors[key]?h('p',{class:'error',role:'alert'},state.filterErrors[key]):view());if(key==='expenses')expensesView=wrapped;else if(key==='shifts')shiftsView=wrapped;else staffView=wrapped;
}
const baseReportsView=reportsView;
reportsView=function(){const view=baseReportsView(),key=state.reportTab;if(key==='payments')return view;if(key==='daily'&&can('reports.sales'))view.prepend(h('button',{class:'ghost',onclick:exportDailyCsv},'Export sales CSV'));const apply=()=>{if(key==='daily'){state.reportData=null;loadDailyReport();}else if(key==='pnl'){state.pnlData=null;loadPnlReport();}else{state.commissionsData=null;loadCommissionsReport();}};return h('div',{},filterControls(key,apply,{search:'Bill or waitress (collections: reference or bill)',paginate:false}),view);};

// Phase 5: public UI projections only; no financial decisions are trusted here.
const canFinancialAction=()=>['pay.void','sales.return','sales.void','sales.remove_item','sales.discount','sales.change_price'].some(can);
function financialClientKey(){if(crypto.randomUUID)return crypto.randomUUID();return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,c=>{const n=crypto.getRandomValues(new Uint8Array(1))[0]&15;return(c==='x'?n:(n&3)|8).toString(16);});}
function financialShiftSelect(order,shifts){const rows=shifts||[...(state.shiftData?[state.shiftData]:[]),...(state.shiftsList||[]),...(order.shiftId?[{id:order.shiftId,name:'Originating shift — server verifies it is open'}]:[])];const seen=new Set();return h('select',{'aria-label':'Correction recording shift'},h('option',{value:''},'Choose an open recording shift'),...rows.filter(s=>s.status!=='CLOSED'&&!seen.has(s.id)&&seen.add(s.id)).map(s=>h('option',{value:s.id},s.name||s.id)));}
function financialModal(title){const overlay=h('div',{class:'overlay'}),content=h('div',{class:'modal',style:'max-height:90vh;overflow:auto;'}),error=h('div',{class:'error',role:'alert'});let busy=false,review=false;const current=accessGuard();const cancel=h('button',{class:'ghost',onclick:()=>{if(!busy)overlay.remove();}},'Close');const setBusy=v=>{busy=v;cancel.disabled=v;};overlay.append(content);content.append(h('h2',{},title));document.body.append(overlay);return{overlay,content,error,cancel,current,setBusy,get busy(){return busy;},get review(){return review;},stopReview(){review=true;},close(){overlay.remove();}};}
function financialFailure(dialog,error){dialog.error.textContent=error.message;if([403,404,409].includes(error.status)){dialog.stopReview();dialog.error.textContent+=' Close this dialog, review refreshed information and submit deliberately. Nothing is retried automatically.';}}
function moneyUnits(value){const [whole,fraction='']=String(value).split('.');return BigInt(whole)*100n+BigInt((fraction+'00').slice(0,2));}
function moneyText(units){return String(units/100n)+'.'+String(units%100n).padStart(2,'0');}
async function financialActionDialog(order,kind,paymentId){
 if(!can(kind==='RETURN'?'sales.return':'pay.void'))return;
 const d=financialModal(kind==='RETURN'?'Return paid items':'Void recorded payment'),loading=h('p',{},'Loading verified bill history…');d.content.append(loading,d.error,d.cancel);
 try{
  const info=await api('/financial-operations/sales/'+encodeURIComponent(order.id)+'/options');if(!d.current()){d.close();return;}loading.remove();
  const idempotency=financialClientKey(),reason=h('input',{'aria-label':'Financial correction reason',placeholder:'Mandatory reason (at least 3 characters)'}),shift=financialShiftSelect(order,info.recordingShifts),fields=h('div',{}),preview=h('p',{role:'status'});
  const submit=h('button',{class:'danger',disabled:kind==='RETURN',onclick:send},info.requiresApproval?'Submit for manager approval':'Confirm financial correction');
  let quote=null,selected,quantityInput,cash,mpesa,externalNote,externalHandled;
  if(kind==='RETURN'){
   selected=h('select',{'aria-label':'Original item to return',onchange:invalidate},h('option',{value:''},'Choose original item'),...info.items.map(i=>h('option',{value:i.id,disabled:i.returnEligible!==true},i.name+' · original '+i.quantity+' · returned '+i.returnedQuantity+(i.returnEligible===true?'':' · non-returnable / manual review'))));
   quantityInput=h('input',{type:'text',inputmode:'decimal','aria-label':'Return quantity',placeholder:'Explicit quantity',oninput:invalidate});cash=h('input',{type:'text',inputmode:'decimal','aria-label':'Cash refund amount'});mpesa=h('input',{type:'text',inputmode:'decimal','aria-label':'M-Pesa refund amount'});externalNote=h('input',{'aria-label':'External refund note',placeholder:'Optional external reference; not provider proof'});externalHandled=h('input',{type:'checkbox','aria-label':'M-Pesa handled externally'});
   const calculate=h('button',{class:'ghost',onclick:async()=>{if(d.busy||!selected.value||!quantityInput.value.trim())return;d.setBusy(true);try{const data=await api('/financial-operations/sales/'+encodeURIComponent(order.id)+'/quote?saleItemId='+encodeURIComponent(selected.value)+'&quantity='+encodeURIComponent(quantityInput.value.trim()));if(!d.current())return;quote={...data,itemId:selected.value,input:quantityInput.value.trim()};const amount=moneyUnits(data.amount),availableCash=moneyUnits(data.availableRefunds.CASH),c=amount<availableCash?amount:availableCash;cash.value=moneyText(c);mpesa.value=moneyText(amount-c);preview.textContent='Original discounted refund: '+ksh(data.amount)+'. No transfer has been sent.';submit.disabled=false;}catch(e){if(d.current())financialFailure(d,e);}finally{if(d.current())d.setBusy(false);}}},'Calculate original refund');
   fields.append(h('label',{},'Original item',selected),h('label',{},'Quantity to return',quantityInput),calculate,preview,h('label',{},'Cash refund',cash),h('label',{},'M-Pesa refund',mpesa),h('label',{},externalHandled,' I handled any M-Pesa refund externally. This only records a manual outflow.'),externalNote);
  }else{
   const choices=(info.payments||[]).filter(p=>!p.voided);selected=h('select',{'aria-label':'Payment to void'},h('option',{value:''},'Choose recorded payment'),...choices.map(p=>h('option',{value:p.id,selected:p.id===paymentId},p.method+' · '+ksh(p.amount)+' · '+new Date(p.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}))));fields.append(selected,h('p',{},'The original payment and reference remain in the audit ledger. An internal void does not send a refund. Cash voids require the original receiving drawer to remain open.'));
  }
  function invalidate(){quote=null;if(submit)submit.disabled=true;if(preview)preview.textContent='Recalculate after changing item or quantity.';}
  async function send(){if(d.busy||d.review||!d.current())return;if(reason.value.trim().length<3){d.error.textContent='A reason of at least 3 characters is required.';return;}if(!info.requiresApproval&&!shift.value){d.error.textContent='Choose the explicit open recording shift.';return;}
   const body={kind,saleId:order.id,reason:reason.value.trim(),clientRequestId:idempotency,expectedUpdatedAt:info.updatedAt,...(shift.value?{shiftId:shift.value}:{})};
   if(kind==='RETURN'){if(!quote||quote.itemId!==selected.value||quote.input!==quantityInput.value.trim()){d.error.textContent='Calculate the original refund first.';return;}body.saleItemId=selected.value;body.quantity=quantityInput.value.trim();body.refunds=[];for(const [method,input]of [['CASH',cash],['MPESA',mpesa]]){if(input.value.trim()&&Number(input.value)>0)body.refunds.push({method,amount:input.value.trim(),...(method==='MPESA'?{externallyHandled:externalHandled.checked,externalReference:externalNote.value.trim()}:{} )});}}
   else{if(!selected.value){d.error.textContent='Choose a recorded payment.';return;}body.paymentId=selected.value;}
   d.setBusy(true);submit.disabled=true;try{const result=await api('/financial-operations',{method:'POST',body});if(!d.current())return;d.close();toast(result.request?'Submitted for independent manager approval. No stock or financial change yet.':'Financial correction recorded; original history retained.');state.ledger={};state.reportData=state.pnlData=state.commissionsData=null;state.stockData=null;await loadOrders();render();}catch(e){if(d.current())financialFailure(d,e);}finally{if(d.current()){d.setBusy(false);submit.disabled=d.review||kind==='RETURN'&&!quote;}}
  }
  d.content.append(h('p',{},info.saleNumber+' · original '+ksh(info.originalTotal)+' · net '+ksh(info.netTotal)+' · balance '+ksh(info.balance)),h('p',{class:'muted'},info.requiresApproval?'This creates a request. An independent manager chooses the actual open shift when approving.':'This creates a dated correction; original dates, amounts and stock provenance remain unchanged.'),fields,h('label',{},'Reason',reason),h('label',{},'Recording shift',shift),d.error,h('div',{class:'actions'},d.cancel,submit));
 }catch(e){if(d.current())financialFailure(d,e);}
}
async function financialHistoryDialog(order){if(!canFinancialAction())return;const d=financialModal('Financial audit history');d.content.append(d.error,d.cancel);try{const info=await api('/financial-operations/sales/'+encodeURIComponent(order.id)+'/options');if(!d.current())return;d.content.append(h('p',{},info.saleNumber+' · original '+ksh(info.originalTotal)+' · net change '+ksh(Number(info.netTotal)-Number(info.originalTotal))+' · net '+ksh(info.netTotal)),...(info.history.length?info.history.map(a=>h('div',{class:'card'},h('b',{},a.kind),h('p',{},new Date(a.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})+' · shift '+(a.shiftId||'explicitly unassigned')),h('p',{},a.reason),h('p',{},'Sales correction '+ksh(a.salesDelta)),Object.hasOwn(a,'collectionDelta')?h('p',{},'Collection correction '+ksh(a.collectionDelta)):null,Object.hasOwn(a,'commissionDelta')?h('p',{},'Commission correction '+ksh(a.commissionDelta)):null)): [h('p',{},'No financial corrections recorded.')]));}catch(e){if(d.current())financialFailure(d,e);}}
function paymentDetailsDialog(payment){if(!can('payments.view_collected'))return;const d=financialModal('Recorded payment details');d.content.append(h('div',{},h('p',{},payment.saleNumber+' · '+payment.method+' · '+ksh(payment.amount)),h('p',{},'Reference: '+(payment.reference||'None recorded')),h('p',{},'Review: '+(payment.reviewStatus==='PENDING'?'Awaiting external M-Pesa verification':payment.reviewStatus)+' · ledger: '+payment.ledgerStatus),h('p',{},'Provider confirmation: '+payment.providerConfirmation+' — no external refund is automatic.'),payment.void?h('p',{},'Voided '+new Date(payment.void.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})+' · '+payment.void.reason):null,can('pay.void')&&!payment.void?h('button',{class:'danger',onclick:()=>{d.close();financialActionDialog({id:payment.saleId},'PAYMENT_VOID',payment.id);}},'Void recorded payment'):null,d.cancel));}
function financialReportTabs(){const choices=[['payments','Collections','payments.view_collected'],['daily','Daily Sales','reports.sales'],['pnl','Profit & Loss','reports.financial'],['commissions','Commissions','commissions.manage']];return h('div',{class:'row'},...choices.filter(c=>can(c[2])).map(([key,label])=>h('button',{class:'tab',onclick:()=>{state.reportTab=key;render();}},label)),canFinancialAction()?h('button',{class:'tab',onclick:()=>{state.reportTab='approvals';render();}},'Approvals / audit requests'):null);}
function paymentsManagementView(){const key='payments',data=state.ledger[key],load=()=>loadLedger(key,'/reports/payments','payments');return h('div',{},financialReportTabs(),h('h2',{},'Payments management'),h('details',{},h('summary',{},'Why recorded payments differ from net collections'),h('p',{},'Payment rows below are the original bill payment records. Net collections also include full incoming receipts and separately dated physical refunds/corrections. Allocating an existing receipt or confirming a payroll deduction is not a new cash collection. Review-status filters affect the rows; net collections cover the matching collection period independently of review status.'),data?.note?h('p',{},data.note):null),can('receivables.view')?h('button',{class:'ghost',onclick:()=>{const page=uiGroupDefinitions().flatMap(g=>g.pages).find(p=>p.employee==='receipts');if(page)uiGo(page);}},'View incoming receipts & tips'):null,h('p',{class:'muted'},'Cleared = recorded cash with a receiving shift. Pending = recorded M-Pesa awaiting external verification. Unresolved = incomplete reference/shift evidence. These are not provider confirmations. A suffix only locates possible matches: review every full reference and bill; ambiguous matches are never auto-selected. No manager action can provider-verify a payment. Unpaid bills remain in Orders.'),filterControls(key,load,{methods:true,statuses:['CLEARED','PENDING','UNRESOLVED','VOIDED'],search:'Full M-Pesa reference or identifying suffix, bill or collector'}),h('button',{class:'ghost',onclick:load},'Load payments'),data?.loading?h('p',{},'Loading payments…'):data?.error?h('p',{class:'error',role:'alert'},data.error):data?.rows?h('div',{class:'filter-table'},data.totals?h('p',{},'Payment rows '+ksh(data.totals.recorded)+' · active payment rows '+ksh(data.totals.activeRecords)+' · refunds / cash corrections '+ksh(data.totals.correctionFlows)+' · other incoming receipts '+ksh(data.totals.receiptCollections)+' · net collections '+ksh(data.totals.netCollections)):null,data.rows.length?h('table',{class:'report-table'},h('thead',{},h('tr',{},...['Collected','Bill','Collector','Shift','Method/reference','Amount','Status','Action'].map(x=>h('th',{},x)))),h('tbody',{},...data.rows.map(p=>h('tr',{},h('td',{},new Date(p.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})),h('td',{},p.saleNumber),h('td',{},p.receivedBy?.name||'Unassigned'),h('td',{},p.receivedShiftId||'Explicitly unassigned'),h('td',{},p.method+' · '+(p.reference||'No reference')),h('td',{},ksh(p.amount)),h('td',{},p.reviewStatus==='PENDING'?'Awaiting external M-Pesa verification':p.reviewStatus),h('td',{},h('button',{class:'ghost',onclick:()=>paymentDetailsDialog(p)},'Payment details')))))):h('p',{},'No matching payments.')):h('p',{},'Apply filters or load payments.'));}
async function loadFinancialRequests(){const current=filterGuard('approvals');state.ledger.approvals={loading:true};render();try{const data=await api('/financial-operations'+filterQuery('approvals'));if(!current())return;state.ledger.approvals={rows:data.requests,mode:data.approvalMode};state.filterPages.approvals=data.pagination;}catch(e){if(current())state.ledger.approvals={error:e.message};}finally{if(current())render();}}
async function financialDecisionDialog(request,approve){if(state.user?.role!=='MANAGER'||request.requestedById===state.user.id)return;const d=financialModal(approve?'Approve financial request':'Reject financial request'),reason=h('input',{'aria-label':'Approval decision reason',placeholder:'Mandatory decision reason'});d.content.append(h('p',{},request.kind+' · '+request.saleNumber+' · '+request.reason),d.error,d.cancel);let shift;
 try{if(approve){const info=await api('/financial-operations/sales/'+encodeURIComponent(request.saleId)+'/options');if(!d.current())return;const available=['CANCEL','REMOVE_ITEM'].includes(request.kind)&&info.originShiftId?info.recordingShifts.filter(s=>s.id===info.originShiftId):info.recordingShifts;shift=financialShiftSelect({},available);d.content.append(h('label',{},'Explicit recording shift',shift));}const submit=h('button',{class:approve?'primary':'danger',onclick:async()=>{if(d.busy||d.review||!d.current())return;if(reason.value.trim().length<3||approve&&!shift.value){d.error.textContent='A reason and explicit open recording shift (for approval) are required.';return;}d.setBusy(true);submit.disabled=true;try{await api('/financial-operations/'+encodeURIComponent(request.id)+'/decision',{method:'POST',body:{decision:approve?'APPROVE':'REJECT',reason:reason.value.trim(),...(approve?{shiftId:shift.value}:{})}});if(!d.current())return;d.close();toast(approve?'Approved and recorded atomically.':'Rejected without financial or stock changes.');state.orders=[];state.stockData=null;state.reportData=state.pnlData=state.commissionsData=null;loadFinancialRequests();}catch(e){if(d.current())financialFailure(d,e);}finally{if(d.current()){d.setBusy(false);submit.disabled=d.review;}}}},approve?'Confirm approval':'Confirm rejection');d.content.append(h('label',{},'Decision reason',reason),submit);}catch(e){if(d.current())financialFailure(d,e);}}
function financialRequestsView(){const data=state.ledger.approvals,permission={SALE_DISCOUNT:'sales.discount',SALE_PRICE_CHANGE:'sales.change_price',RETURN:'sales.return',PAYMENT_VOID:'pay.void',CANCEL:'sales.void',REMOVE_ITEM:'sales.remove_item'};return h('div',{},financialReportTabs(),h('h2',{},'Financial approvals and request audit'),filterControls('approvals',loadFinancialRequests,{shift:false,staff:false,statuses:['PENDING','APPROVED','REJECTED'],search:'Bill or request reason'}),h('button',{class:'ghost',onclick:loadFinancialRequests},'Load requests'),data?.loading?h('p',{},'Loading requests…'):data?.error?h('p',{class:'error',role:'alert'},data.error):data?.rows?.length?data.rows.map(r=>h('div',{class:'card'},h('b',{},r.saleNumber+' · '+r.kind+' · '+r.status),h('p',{},r.reason),h('p',{},'Requested '+new Date(r.createdAt).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'})),r.decisionReason?h('p',{},'Decision: '+r.decisionReason):null,r.status==='PENDING'&&state.user?.role==='MANAGER'&&r.requestedById!==state.user.id&&can(permission[r.kind])?h('div',{class:'actions'},h('button',{class:'primary',onclick:()=>financialDecisionDialog(r,true)},'Approve request'),h('button',{class:'danger',onclick:()=>financialDecisionDialog(r,false)},'Reject request')):null)):h('p',{},data?'No matching requests.':'Load the queue to review requests.'));}
const financialBaseReports=reportsView;
reportsView=function(){if(!['reports.sales','reports.financial','commissions.manage','payments.view_collected'].some(can)&&canFinancialAction())state.reportTab='approvals';if(state.reportTab==='approvals')return financialRequestsView();if(state.reportTab==='payments'&&can('payments.view_collected'))return paymentsManagementView();return h('div',{},canFinancialAction()?h('button',{class:'ghost',onclick:()=>{state.reportTab='approvals';render();}},'Approvals / audit requests'):null,financialBaseReports());};

function unpaidCorrectionDialog(order,kind,item){
 const removal=kind==='REMOVE_ITEM',current=accessGuard(),key=workflowKey(removal?'item':'sale',removal?item.id:order.id);
 if(workflowWrites.has(key))return;
 const overlay=h('div',{class:'overlay'}),error=h('div',{class:'error',role:'status'}),reason=h('input',{'aria-label':'Unpaid correction reason',placeholder:'Mandatory reason'}),shift=financialShiftSelect(order),clientRequestId=financialClientKey();let closed=false,review=false;
 const cancel=h('button',{class:'ghost',onclick:()=>{if(!workflowWrites.has(key)){closed=true;overlay.remove();}}},'Cancel');
 const confirm=h('button',{class:'danger',onclick:submit},removal?'Confirm removal':'Confirm cancellation');
 async function submit(){if(closed||review||!current()||!can(removal?'sales.remove_item':'sales.void')||workflowWrites.has(key))return;
  if(reason.value.trim().length<3||!shift.value){error.textContent='A reason and explicitly selected open correction shift are required.';return;}
  workflowWrites.add(key);confirm.disabled=cancel.disabled=true;
  try{const url='/sales/'+encodeURIComponent(order.id)+(removal?'/items/'+encodeURIComponent(item.id):'/cancel');const data=await api(url,{method:removal?'DELETE':'PATCH',body:{reason:reason.value.trim(),shiftId:shift.value,clientRequestId}});if(!current()||closed)return;
   if(data.sale)state.orders=state.orders.map(o=>o.id===order.id?data.sale:o);if(state.addTo?.id===order.id)state.addTo=null;closed=true;overlay.remove();toast(data.request?'Submitted for manager approval; bill and stock unchanged.':removal?'Item removed':'Order cancelled');await loadOrders();
  }catch(e){if(!current()||closed)return;error.textContent=e.message;if([403,404,409].includes(e.status)){review=true;error.textContent+=' Review the refreshed bill and open a new confirmation before trying again.';await loadOrders();}}
  finally{workflowWrites.delete(key);if(current()){if(!closed){confirm.disabled=review;cancel.disabled=false;}if(state.tab==='orders'&&ordersBox)renderOrders();}}
 }
 overlay.append(h('div',{class:'modal'},h('h2',{},removal?'Remove entire item line?':'Cancel unpaid bill?'),h('p',{},order.saleNumber+(item?': '+item.quantity+' × '+item.product.name:'')),h('p',{class:'muted'},'Only verified unpaid history is eligible. Original deductions are restored atomically after any required approval.'),h('label',{},'Reason',reason),h('label',{},'Correction recording shift',shift),error,h('div',{class:'actions'},cancel,confirm)));document.body.append(overlay);
}
const baseFinancialOrderCard=orderCard;
orderCard=function(order){const card=baseFinancialOrderCard(order);if(!state.mergeMode){if(order.status==='PAID'&&can('sales.return'))card.append(h('button',{class:'danger',onclick:()=>financialActionDialog(order,'RETURN')},'Return paid items'));if(!['CANCELLED','MERGED'].includes(order.status)&&can('pay.void'))card.append(h('button',{class:'ghost',onclick:()=>financialActionDialog(order,'PAYMENT_VOID')},'Review / void payments'));if(canFinancialAction())card.append(h('button',{class:'ghost',onclick:()=>financialHistoryDialog(order)},'Financial audit history'));}return card;};
// Invoice documents reuse current bill/ledger records; no invoice POST endpoint.
function invoicePath(kind,id='',action=''){return(kind==='sales'?'/invoices/sales':'/purchases')+(id?'/'+encodeURIComponent(id):'')+(action?'/'+action:'');}
async function loadInvoicePage(kind){
 const key=kind==='sales'?'salesInvoices':'purchaseInvoices',current=filterGuard(key);state.ledger[key]={loading:true};render();
 try{const data=await api(invoicePath(kind)+filterQuery(key));if(!current())return;state.ledger[key]={rows:kind==='sales'?data.invoices:data.purchases,note:data.attribution};state.filterPages[key]=data.pagination;}
 catch(e){if(current())state.ledger[key]={error:e.message};}finally{if(current())render();}
}
function invoiceDateText(value){return value?new Date(value).toLocaleString('en-KE',{timeZone:'Africa/Nairobi'}):'Not recorded';}
function invoiceTable(columns,rows,action){
 const header=h('tr',{},...columns.map(([label])=>h('th',{},label)),action?h('th',{},'Details'):null);
 const body=h('tbody',{},...rows.map(row=>h('tr',{},...columns.map(([,value])=>h('td',{},String(value(row)))),action?h('td',{},action(row)):null)));
 return h('div',{class:'filter-table'},h('table',{class:'report-table'},h('thead',{},header),body));
}
function invoicesView(kind){
 const sales=kind==='sales',key=sales?'salesInvoices':'purchaseInvoices',data=state.ledger[key],load=()=>loadInvoicePage(kind);
 const columns=sales?[['Invoice',i=>i.invoiceNumber],['Sale / bill',i=>i.saleNumber],['Customer',i=>i.customerName||'Not recorded'],['Origin date',i=>i.invoiceDate],['Staff',i=>i.staff?.name||'Unknown'],['Origin shift',i=>i.shift?.name||i.shiftId||'Unassigned'],['Net invoice',i=>ksh(i.total)],['Net collected',i=>ksh(i.amountPaid)],['Outstanding now',i=>ksh(i.balance)],['Status',i=>i.paymentStatus+' · '+i.returnStatus]]:[['Invoice',i=>i.invoiceNumber||'Supplier reference not recorded'],['Purchase',i=>i.purchaseNumber],['Supplier',i=>i.supplierName],['Invoice date',i=>i.invoiceDate||'Not recorded'],['Recorded',i=>invoiceDateText(i.createdAt)],['Staff',i=>i.staff?.name||'Unknown'],['Shift',i=>i.shift?.name||i.shiftId||'Unassigned'],['Method',i=>i.method],['Status',i=>i.paymentStatus],...(can('reports.financial')?[['Total',i=>Object.hasOwn(i,'totalAmount')?ksh(i.totalAmount):'Restricted']]:[])];
 const extras=[];
 if(!sales){const f=filterValues(key),supplier=h('input',{'aria-label':'Supplier filter',placeholder:'Supplier contains',value:f.supplier||'',oninput:e=>{f.supplier=e.target.value;}}),basis=h('select',{'aria-label':'Purchase date basis',onchange:e=>{f.dateBasis=e.target.value;}},h('option',{value:'recorded',selected:f.dateBasis!=='invoice'},'Recording date'),h('option',{value:'invoice',selected:f.dateBasis==='invoice'},'Supplier invoice date'));extras.push(h('div',{class:'row'},h('label',{},'Supplier',supplier),h('label',{},'Date basis',basis)),can('purchases.manage')?h('button',{class:'primary',onclick:async()=>{try{if(!state.stockData)await loadStock();purchaseDialog();}catch(e){toast(e.message,true);}}},'Record purchase invoice'):null);}
 return h('section',{'aria-label':sales?'Sales Invoices':'Purchase Invoices'},h('h2',{},sales?'Sales Invoices':'Purchase Invoices'),h('p',{class:'muted'},sales?'Current bill statements, not payment receipts or tax invoices. Date and shift select the original sale; balances include separate Phase 5 corrections. Customer information was not captured by the existing POS.':'Reuse recorded purchases and their linked outgoing expense/stock movements. Missing legacy links and supplier dates remain unverified; no history is inferred.'),...extras,
  filterControls(key,load,{statuses:sales?['UNPAID','PARTIAL','PAID','CANCELLED','MERGED']:['RECORDED_PAID','UNVERIFIED'],methods:!sales,search:sales?'Invoice or sale number':'Purchase reference, invoice or supplier'}),h('button',{class:'ghost',onclick:load},'Load invoices'),
  data?.loading?h('p',{role:'status'},'Loading invoices…'):data?.error?h('p',{class:'error',role:'alert'},data.error):data?.rows?.length?invoiceTable(columns,data.rows,row=>h('button',{class:'ghost',onclick:()=>invoiceDetails(kind,row.id)},'Invoice details')):h('p',{class:'muted'},data?'No matching invoices.':'Load invoices or apply filters.'),data?.note?h('p',{class:'muted'},data.note):null);
}
async function invoiceDetails(kind,id){
 const current=accessGuard(),overlay=h('div',{class:'overlay'}),body=h('div',{class:'modal'},h('p',{role:'status'},'Loading invoice…'));let closed=false;const close=()=>{closed=true;overlay.remove();};overlay.append(body);document.body.append(overlay);
 try{const {invoice:i}=await api(invoicePath(kind,id));if(!current()||closed)return;const sales=kind==='sales',financial=can('reports.financial'),lineColumns=[['Product',x=>x.name],['Quantity',x=>x.quantity],...(sales?[['Selling price',x=>ksh(x.unitPrice)],['Line amount',x=>ksh(x.subtotal)],['Line status',x=>x.removedAt?'Removed (audit only)':Number(x.returnedQuantity)>0?'Returned '+x.returnedQuantity:'Active']]:[]),...(financial?[['Unit cost',x=>Object.hasOwn(x,'unitCost')?ksh(x.unitCost):'Unverified']]:[])];
  body.replaceChildren(h('h2',{},sales?'Sales invoice details':'Purchase invoice details'),h('p',{},(sales?i.invoiceNumber:i.invoiceNumber||'No supplier reference')+' · '+(sales?i.saleNumber:i.purchaseNumber)),h('p',{},'Invoice date: '+(i.invoiceDate||'Not recorded')+' · Recorded: '+invoiceDateText(i.createdAt)),h('p',{},'Original shift: '+(i.shift?.name||i.shiftId||'Unassigned')+' · Staff: '+(i.staff?.name||'Unknown')),h('p',{},sales?'Customer: '+(i.customerName||'Not recorded'):'Supplier: '+i.supplierName),h('p',{},'Status: '+i.paymentStatus),
   sales?h('p',{},'Original bill '+ksh(i.originalTotal)+' · Returns '+ksh(i.returnedAmount)+' · Pricing change '+ksh(i.pricingDelta||0)+' · Net invoice '+ksh(i.total)+' · Net collected '+ksh(i.amountPaid)+' · Outstanding now '+ksh(i.balance)):Object.hasOwn(i,'totalAmount')?h('p',{},'Invoice total: '+ksh(i.totalAmount)):h('p',{class:'muted'},'Invoice costs require financial permission.'),
   i.verificationNotice?h('p',{class:'error'},i.verificationNotice):null,!sales&&!i.reconciliation.verified?h('p',{class:'error'},'Legacy or inconsistent evidence: manual review required.'):null,
   invoiceTable(lineColumns,i.items),
   sales&&Object.hasOwn(i,'cost')?h('p',{},'Net COGS '+ksh(i.cost)+' · Gross profit '+ksh(i.grossProfit)):null,
   sales&&Array.isArray(i.payments)?h('div',{},h('h3',{},'Recorded payment history'),...i.payments.map(p=>h('p',{},p.method+' '+ksh(p.amount)+' · '+(p.reference||'No reference')+' · '+(p.voided?'Internally voided':'Recorded')+' · '+invoiceDateText(p.createdAt)+' · Collection shift '+(p.receivedShiftId||'Unassigned')+' · '+p.providerConfirmation))):null,
   sales&&Object.hasOwn(i,'commissionAmount')?h('p',{},i.commissionVerified?'Original earned commission '+(i.commissionAmount===null?'Not earned':ksh(i.commissionAmount))+' · Net after corrections '+(i.netCommissionAmount===null?'Not earned':ksh(i.netCommissionAmount))+' · '+invoiceDateText(i.commissionEarnedAt):'Historical commission unverified'):null,
   sales?h('div',{},h('h3',{},'Separate correction history'),...i.corrections.map(a=>h('p',{},a.kind+' · '+a.reason+' · '+invoiceDateText(a.createdAt)+' · Recording shift '+a.shiftId+' · Sales delta '+ksh(a.salesDelta)))):h('div',{},h('p',{},'Linked expense: '+(i.expense?.expenseNumber||'Unverified')), ...i.items.map(x=>h('p',{},x.name+' · Stock movement '+(x.stockMovementId||'Unverified')))),
   h('p',{class:'muted'},'Viewing or printing never posts stock, expenses, collections or refunds. Internal M-Pesa records are not provider confirmation.'),h('div',{class:'actions'},can('receipt.print')?h('button',{class:'primary',onclick:()=>printInvoice(kind,id,'print')},'Print invoice'):null,can('receipt.reprint')?h('button',{class:'ghost',onclick:()=>printInvoice(kind,id,'reprint')},'Reprint invoice'):null,h('button',{class:'ghost',onclick:close},'Close')));
 }catch(e){if(current()&&!closed)body.replaceChildren(h('p',{class:'error',role:'alert'},e.message),h('button',{onclick:close},'Close'));}
}
async function printInvoice(kind,id,action){
 if(!can(action==='reprint'?'receipt.reprint':'receipt.print'))return;const current=accessGuard(),popup=window.open('','_blank');if(!popup){toast('Allow the document popup to view or print the invoice.',true);return;}
 try{const response=await fetch('/api'+invoicePath(kind,id,action),{credentials:'same-origin'});if(!current()){popup.close();return;}if(!response.ok){if(response.status===401)clearSession();throw Error('Invoice print access failed. Refresh permissions and retry.');}const html=await response.text();if(!current()){popup.close();return;}popup.document.open();popup.document.write(html);popup.document.close();popup.opener=null;const button=popup.document.getElementById('print-document');if(button)button.onclick=()=>popup.print();}
 catch(e){popup.close();if(current())toast(e.message,true);}
}

// ---------- SETTINGS: scoped configuration, explicit saves, no printer jobs ----------
async function loadSettings(){const current=accessGuard();if(!can('settings.manage')&&!can('printers.manage'))return;state.settingsLoading=true;state.settingsError=null;try{const data=await api('/settings');if(!current())return;state.settingsData=data;}catch(e){if(current())state.settingsError=e.message;}finally{if(current()){state.settingsLoading=false;if(state.boTab==='settings')render();}}}
async function loadSettingsAudit(){const current=accessGuard();state.settingsAuditLoading=true;try{const data=await api('/settings/audit?pageSize=25');if(current())state.settingsAudit=data;}catch(e){if(current())toast(e.message,true);}finally{if(current()){state.settingsAuditLoading=false;if(state.boTab==='settings')render();}}}
function settingsView(){
 if(!can('settings.manage')&&!can('printers.manage'))return h('p',{class:'error'},'Settings access is not permitted.');
 const heading=h('div',{class:'row'},h('h2',{},'Settings'),h('button',{class:'ghost',onclick:loadSettings,disabled:state.settingsLoading},'Refresh settings'));
 if(!state.settingsData){if(!state.settingsLoading&&!state.settingsError)void loadSettings();return h('section',{},heading,h('p',{class:state.settingsError?'error':'muted',role:state.settingsError?'alert':'status'},state.settingsError||'Loading settings…'));}
 const snapshot=state.settingsData,current=accessGuard(),cards=[],fields={},error=h('p',{class:'error',role:'alert'});
 const field=(category,key,label,type='text')=>{const value=snapshot.data[category][key],input=h('input',{type,'aria-label':label,...(type==='checkbox'?{checked:value}:{value})});(fields[category]||={})[key]=input;return h('label',{class:type==='checkbox'?'settings-checkbox':''},label,input);};
 const card=(title,...children)=>h('section',{class:'settings-card'},h('h3',{},title),...children);
 if(state.user?.role==='MANAGER'&&can('settings.manage'))cards.push(card('Branding',brandMark('full'),h('p',{},'Business name: '+(snapshot.data.general?.name||'Habibi Lounge')),h('p',{class:'muted'},'Proposed local logo. Branding files are reviewed with application releases; no staff uploads or unrestricted logo changes.'),h('a',{href:'/assets/branding/receipt-preview.html',target:'_blank',rel:'noopener'},'Preview branded sample receipt')));
 if(snapshot.data.general)cards.push(card('General business settings',field('general','name','Business name'),field('general','address','Business address'),field('general','phone','Business phone')));
 cards.push(card('Sales and payment settings',h('p',{},'Supported methods: '+snapshot.deployment.paymentMethods.join(', ')),h('p',{class:'muted'},'Payment calculations, external provider confirmation and manager approvals retain their existing rules. No new payment method is enabled here.')));
 cards.push(card('Shifts and operational settings',typeof businessDaySettings==='function'&&state.user?.role==='MANAGER'&&can('settings.manage')?h('button',{class:'ghost',onclick:businessDaySettings},'Business Day Start Time'):null,h('p',{},'Explicit intended open shift required. Business timezone: '+snapshot.deployment.businessTimezone),h('p',{class:'muted'},'Originating sales and collection/correction shifts remain separate. Closed-shift rules cannot be disabled.')));
 if(snapshot.data.documents)cards.push(card('Receipt and invoice formatting',field('documents','receiptFooter','Receipt footer'),field('documents','receiptShowStaff','Show staff on receipts','checkbox'),field('documents','receiptShowNotes','Show notes on receipts','checkbox'),field('documents','invoiceFooter','Invoice footer'),field('documents','invoiceShowStaff','Show staff on invoices','checkbox'),h('p',{class:'muted'},'Selling totals, fiscal disclaimers and provider warnings cannot be changed here. No physical test print.')));
 cards.push(card('Printer selection and connection',h('p',{},snapshot.deployment.dryRun?'Deployment mode: dry run; physical output disabled.':'Deployment mode: physical output configured by deployment.'),...(snapshot.data.printers?[field('printers','counterIp','Docket printer IPv4'),field('printers','defaultWaiterIp','Default receipt printer IPv4'),field('printers','port','Printer port','number')]:[h('p',{class:'muted'},'Printer destinations require printers.manage.')]),h('p',{class:'muted'},'Only private IPv4 and raw TCP 9100. Staff-specific mappings and physical activation stay deployment managed. Saving never probes or prints.')));
 cards.push(card('Staff, roles and permissions',can('users.manage')?h('button',{class:'ghost',onclick:()=>{state.boTab='staff';render();}},'Open staff administration'):h('p',{class:'muted'},'Staff administration requires users.manage.'),canManagePermissions()?h('button',{class:'ghost',onclick:()=>{state.boTab='permissions';render();void loadPermissions();}},'Open role permissions'):h('p',{class:'muted'},'Complete role matrix requires an authorized manager.')));
 if(snapshot.data.inventory)cards.push(card('Inventory settings',field('inventory','countSessionMinutes','New count-session minutes','number'),h('p',{class:'muted'},'1–60 whole minutes; applies only to new counting sessions. Existing baselines, expiry and stock pauses remain unchanged. Stock precision: '+snapshot.deployment.stockPrecision+' decimal places.')));
 cards.push(card('System and security settings',h('p',{},snapshot.deployment.sessionRevocation),h('p',{class:'muted'},snapshot.deployment.transport),h('p',{class:'muted'},'Credentials, database connections, JWT secrets, PINs and security bypasses are never editable or returned. Approval mode: '+snapshot.deployment.approvalMode)));
 const reason=h('input',{'aria-label':'Settings change reason',placeholder:'Required reason (3–200 characters)',maxlength:200});let busy=false;
 const save=h('button',{class:'primary',onclick:async()=>{if(busy||!current())return;const changes={};for(const [category,entries]of Object.entries(fields)){const value={};for(const [key,input]of Object.entries(entries))value[key]=input.type==='checkbox'?input.checked:input.type==='number'?Number(input.value):input.value;if(Object.keys(value).some(key=>value[key]!==snapshot.data[category][key]))changes[category]=value;}if(!Object.keys(changes).length){error.textContent='Change at least one supported setting.';return;}if(reason.value.trim().length<3){error.textContent='Enter a reason before saving.';return;}busy=true;save.disabled=true;error.textContent='';try{const result=await api('/settings',{method:'PUT',body:{version:snapshot.version,reason:reason.value,changes}});if(!current())return;state.settingsData={...snapshot,...result};state.settingsAudit=null;toast('Settings saved. Existing transactions and count sessions are unchanged.');render();}catch(e){if(current())error.textContent=e.status===409?'Settings changed elsewhere. Your entries remain here; use Refresh settings to review the current values before submitting again.':e.message;}finally{if(current()){busy=false;save.disabled=false;}}}},'Save settings');
 const events=state.settingsAudit?.events;
 return h('section',{'aria-label':'Settings'},heading,h('p',{class:'muted'},'Revision '+snapshot.version+' · explicit changes only · existing business records are never rewritten.'),h('div',{class:'settings-grid'},...cards),h('div',{class:'settings-save'},h('label',{},'Change reason',reason),error,save),h('h3',{},'Settings audit history'),h('button',{class:'ghost',onclick:loadSettingsAudit,disabled:state.settingsAuditLoading},'Load settings audit'),state.settingsAuditLoading?h('p',{role:'status'},'Loading audit…'):events?h('div',{},...(events.length?events.map(e=>h('article',{class:'settings-card'},h('p',{},e.actor.name+' · '+invoiceDateText(e.createdAt)+' · revision '+e.revision),h('p',{},e.reason),h('pre',{},JSON.stringify({before:e.before,after:e.after},null,2)))):[h('p',{class:'muted'},'No recorded settings changes.')])):null);
}



// Billing-only split; existing preparation and stock movements are unchanged.
async function splitBillDialog(order){
 if(!can('sales.split'))return;
 const d=financialModal('Split unpaid bill'),choices=[];
 d.content.append(h('p',{},'Move whole unpaid lines into a new bill in the same original open shift and accounting date. Bills with payments cannot be split.'));
 for(const item of order.items||[]){const input=h('input',{type:'checkbox','aria-label':'Split line '+item.id});choices.push({id:item.id,input});d.content.append(h('label',{},input,item.quantity+' × '+item.product.name));}
 const reason=h('input',{'aria-label':'Split reason',placeholder:'Mandatory reason'}),key=financialClientKey(),guard=workflowKey('split',order.id);
 const submit=h('button',{class:'primary',onclick:async()=>{
  if(d.busy||d.review||!d.current()||workflowWrites.has(guard))return;
  const itemIds=choices.filter(x=>x.input.checked).map(x=>x.id);
  if(!itemIds.length||itemIds.length===choices.length||reason.value.trim().length<3){d.error.textContent='Select whole lines, leave one on the original bill and enter a reason.';return;}
  d.setBusy(true);submit.disabled=true;workflowWrites.add(guard);
  try{const result=await api('/sales/'+encodeURIComponent(order.id)+'/split',{method:'POST',body:{itemIds,reason:reason.value.trim(),clientRequestId:key}});if(!d.current())return;d.close();toast('Bill split: '+result.splitSale.saleNumber+'. No additional stock deduction or print job.');await loadOrders();}
  catch(e){if(d.current()){financialFailure(d,e);if([403,404,409].includes(e.status))await loadOrders();}}
  finally{workflowWrites.delete(guard);if(d.current()){d.setBusy(false);submit.disabled=d.review;}}
 }},'Confirm split');
 d.content.append(h('label',{},'Reason',reason),d.error,submit,d.cancel);
}
const beforeSplitOrderCard=orderCard;
orderCard=function(order){const card=beforeSplitOrderCard(order);if(can('sales.split')&&order.status==='UNPAID'&&Number(order.amountPaid)===0&&(order.items||[]).length>1&&!state.mergeMode)card.append(h('button',{class:'ghost',onclick:()=>splitBillDialog(order)},'Split bill'));return card;};
async function staffAuditDialog(){
 if(state.user?.role!=='MANAGER'||!can('users.manage'))return;
 const d=financialModal('Staff administration audit');let page=1;
 const rows=h('div',{}),info=h('p',{role:'status'},'Loading audit…'),prev=h('button',{class:'ghost',onclick:()=>{if(page>1){page--;void load();}}},'Previous audit page'),next=h('button',{class:'ghost',onclick:()=>{page++;void load();}},'Next audit page');
 async function load(){prev.disabled=next.disabled=true;info.textContent='Loading audit…';try{const result=await api('/users/audit?page='+page+'&pageSize=25');if(!d.current())return;rows.replaceChildren(...(result.events.length?result.events.map(e=>h('article',{class:'card'},h('b',{},e.reason),h('p',{},invoiceDateText(e.createdAt)+' · actor '+e.actorId+' · staff '+e.targetUserId),h('p',{},(e.after.changedFields||[]).join(', ')+(e.after.credentialChanged?' · credentials changed (values never recorded)':'')))):[h('p',{},'No staff audit events on this page.')]));info.textContent='Page '+page+' · '+result.pagination.total+' events';prev.disabled=page<=1;next.disabled=page>=result.pagination.pages;}catch(e){if(d.current()){info.textContent=e.message;prev.disabled=page<=1;}}}
 d.content.append(info,rows,prev,next,d.cancel);await load();
}
const beforeStaffAuditView=staffView;
staffView=function(){const view=beforeStaffAuditView();if(state.user?.role==='MANAGER'&&can('users.manage'))view.append(h('button',{class:'ghost',onclick:staffAuditDialog},'Staff audit history'));return view;};

// Dashboard/global period presentation. Financial decisions stay on the server.
function ensureReportPeriod(key){
  if(!['daily','pnl','commissions','dashboard'].includes(key))return;
  const f=filterValues(key);if(f.date||f.start||f.end)return;
  if(['daily','dashboard'].includes(key))f.date=businessToday();else{f.start=businessToday().slice(0,8)+'01';f.end=businessToday();}
}
function reportPeriodNote(data){return h('p',{class:'muted'},data?.period?'Nairobi period: '+data.period.start+' to '+data.period.end:'Choose the period in the shared filters above.');}
const periodModules=['daily','pnl','commissions','dashboard','orders','expenses','salesInvoices','purchaseInvoices','movements','shifts','countHistory','inventoryReport'];
function sharePeriod(key){
  const source=filterValues(key),period={};for(const k of ['date','start','end','shiftId'])if(source[k])period[k]=source[k];
  state.globalPeriod={...period};
  for(const target of periodModules){const f=filterValues(target);for(const name of ['date','start','end','shiftId'])delete f[name];Object.assign(f,period);if(target==='countHistory')delete f.shiftId;f.page=1;state.filterDrafts[target]={...f};}
  state.reportData=state.pnlData=state.commissionsData=state.dashboardData=state.inventoryReportData=null;
  state.expensesData=state.shiftsList=null;state.ledger={};state.filterPages={};
}
function periodActions(key,inputs,apply){
  const read=()=>{const f=filterValues(key);for(const [name,node]of Object.entries(inputs))f[name]=node.value.trim();state.filterDrafts[key]={...f};f.page=1;};
  const meanings={daily:'Sales: origin date/shift; collections: receiving/correction date/shift.',pnl:'Sales and expenses retain their own origin/recording basis; corrections use correction period.',commissions:'Settlement/correction dates; shift selects original sale shift, staff selects waitress.',dashboard:'Each section labels its own date/shift/staff basis.',orders:'Original sale accounting date/shift; current status and balance.',expenses:'Expense recording date/shift and recorder.',salesInvoices:'Original sale date/shift; current net balance.',purchaseInvoices:'Recording date by default; supplier invoice date only when selected.',movements:'Actual movement date; explicit original sale/purchase shift.',shifts:'Shift opening date and owner; closed reconciliation is stored.',countHistory:'Count session date basis selected below; shift filtering is unavailable.',inventoryReport:'Current stock snapshot; date/shift/staff affect movement groups only.'};
  return h('div',{class:'period-context'},h('div',{class:'row'},h('button',{class:'ghost',onclick:()=>{const f=filterValues(key);delete f.start;delete f.end;f.date=businessToday();f.page=1;state.filterDrafts[key]={...f};apply();}},'Today'),h('button',{class:'ghost',onclick:()=>{read();sharePeriod(key);apply();}},'Use period / shift across views')),h('p',{class:'muted'},meanings[key]||'Dates use Africa/Nairobi. Staff meaning follows this module.'),h('p',{class:'muted'},'Only dates and supported shifts are shared. Search, staff, method, status and permissions remain module-specific.'));
}
const overviewMoney=v=>v==null?'Unavailable':ksh(v);
function overviewTable(headings,rows){return rows.length?h('table',{class:'report-table'},h('thead',{},h('tr',{},headings.map(x=>h('th',{},x)))),h('tbody',{},rows.map(row=>h('tr',{},row.map(value=>h('td',{},value??'Unassigned / unavailable')))))):h('p',{class:'muted'},'No matching records.');}
async function loadDashboard(){
  if(!can('dashboard.view'))return;ensureReportPeriod('dashboard');const current=filterGuard('dashboard');state.dashboardLoading=true;render();
  try{const data=await api('/reports/dashboard'+filterQuery('dashboard'));if(current())state.dashboardData=data;}
  catch(error){if(current())state.dashboardData={error:error.message};}
  finally{if(current()){state.dashboardLoading=false;if(state.boTab==='dashboard')render();}}
}
function dashboardName(name,kind){
  if(!name||/^[a-f0-9]{8}-[a-f0-9-]{27}$/i.test(name))return kind+' (unnamed)';
  return /synthetic|fixture|phase8|^test[-_ ]|^hybrid[-_ ]/i.test(name)?'Isolated test '+kind.toLowerCase():name;
}
function dashboardLink(label,tab,report){return h('button',{class:'bi-link',onclick:()=>{sharePeriod('dashboard');state.boTab=tab;if(report)state.reportTab=report;render();}},label+' →');}
function dashboardHelp(title,text){return h('details',{class:'bi-help'},h('summary',{},title),h('p',{class:'muted'},text));}
function dashboardToolbar(refresh){
  ensureReportPeriod('dashboard');
  const f=filterValues('dashboard'),draft=state.filterDrafts.dashboard||={...f},inputs={};
  const field=(key,label,type='text')=>{const input=h('input',{type,value:draft[key]??f[key]??'','aria-label':label,oninput:e=>{draft[key]=e.target.value;if(['start','end'].includes(key)&&e.target.value){draft.date='';inputs.date.value='';}if(key==='date'&&e.target.value){draft.start=draft.end='';inputs.start.value=inputs.end.value='';}}});inputs[key]=input;return h('label',{},h('span',{},label),input);};
  const select=(key,label,choices)=>{const selected=draft[key]??f[key]??'';if(selected&&!choices.some(c=>c.id===selected))choices.push({id:selected,name:'Selected '+label.toLowerCase()});const input=h('select',{'aria-label':label,onchange:e=>{draft[key]=e.target.value;}},...choices.map(c=>h('option',{value:c.id,selected:c.id===selected},c.name)));inputs[key]=input;return h('label',{},h('span',{},label),input);};
  const single=field('date','Business date (Nairobi)','date'),start=field('start','From (Nairobi)','date'),end=field('end','To (Nairobi)','date');
  const shift=select('shiftId','Shift',[{id:'',name:'All shifts'},{id:'unassigned',name:'Unassigned'},...(state.filterOptions?.shifts||[]).map(s=>({id:s.id,name:dashboardName(s.name,'Shift')+' · '+s.status}))]);
  const search=field('q','Bill, payment reference or staff'),staff=select('staffId','Staff member',[{id:'',name:'All staff'},...(state.filterOptions?.staff||[]).map(s=>({id:s.id,name:dashboardName(s.name,'Staff')}))]);
  const balance=select('balances','Balance view',[{id:'cutoff',name:'At selected cutoff'},{id:'current',name:'Current balances'}]);
  const apply=(sharing=false)=>{const next={};for(const [key,input]of Object.entries(inputs))if(input.value.trim())next[key]=input.value.trim();if(next.start||next.end)delete next.date;state.filters.dashboard={...next,page:1};state.filterDrafts.dashboard={...state.filters.dashboard};if(sharing===true)sharePeriod('dashboard');refresh();};
  const today=()=>{state.filters.dashboard={...f,date:businessToday(),page:1};delete state.filters.dashboard.start;delete state.filters.dashboard.end;state.filterDrafts.dashboard={...state.filters.dashboard};refresh();};
  const find=h('input',{'aria-label':'Find shift or staff choices',placeholder:'Find older shift / staff'});
  void filterOptions();
  return h('section',{class:'bi-toolbar filter-panel','aria-label':'dashboard filters'},
    h('div',{class:'bi-toolbar-main'},h('button',{class:'ghost',onclick:today},'Today'),start,end,shift,h('button',{class:'primary',disabled:state.dashboardLoading,onclick:apply},'Apply filters'),h('button',{class:'ghost',disabled:state.dashboardLoading,onclick:()=>{state.filterDrafts.dashboard={...f};refresh();}},'Refresh dashboard')),
    h('details',{class:'bi-advanced filter-more'},h('summary',{},'Advanced filters'),h('div',{class:'bi-advanced-fields'},single,search,staff,balance,h('label',{},'Find choices',find),h('button',{class:'ghost',onclick:()=>{state.filterOptions=null;void filterOptions(find.value.trim());}},'Find choices')),h('div',{class:'row'},h('button',{class:'ghost',onclick:()=>{state.filters.dashboard={};state.filterDrafts.dashboard={};refresh();}},'Clear filters'),h('button',{class:'ghost',onclick:()=>apply(true)},'Use period / shift across views')),h('p',{class:'muted'},'Apply changes to update all cards. Dates use Africa/Nairobi. Staff means sale owner for revenue, collector for collections; each event retains its own shift.')),
    state.filterOptions?.error?h('p',{class:'error'},'Filter choices unavailable. Refresh or find choices to retry.'):null);
}
function dashboardBars(title,rows,{money=true,description='',link=null}={}){
  const values=rows.filter(r=>Number.isFinite(Number(r.value))),max=Math.max(1,...values.map(r=>Math.abs(Number(r.value))));
  return h('section',{class:'bi-panel'},h('div',{class:'bi-panel-heading'},h('h3',{},title),link),description?h('p',{class:'bi-caption'},description):null,
    values.length?h('div',{class:'bi-bars',role:'list','aria-label':title},...values.map((r,i)=>{const label=dashboardName(r.label,'Record'),value=money?overviewMoney(r.value):String(r.value);return h('div',{class:'bi-bar-row',role:'listitem',tabindex:'0',title:label+': '+value},h('div',{class:'bi-bar-meta'},h('span',{},label),h('strong',{},value)),h('div',{class:'bi-bar-track'},h('span',{class:'bi-bar '+(Number(r.value)<0?'negative':i%2?'secondary':''),style:'width:'+Math.abs(Number(r.value))/max*100+'%'})));})):h('p',{class:'bi-empty'},'No matching activity for this period.'));
}
function dashboardSvg(tag,attrs,...children){
  if(!document.createElementNS)return h(tag,attrs,...children);
  const node=document.createElementNS('http://www.w3.org/2000/svg',tag);for(const [key,value]of Object.entries(attrs))node.setAttribute(key,value);for(const child of children.flat())node.append(child);return node;
}
function dashboardTrendChart(data){
  const rows=data.trend||[],keys=[...(can('reports.sales')&&data.sales?['sales']:[]),...(can('payments.view_collected')&&data.collections?['collections']:[])];
  const available=rows.length&&keys.some(k=>rows.some(r=>Number.isFinite(r[k])));
  const panel=h('section',{class:'bi-panel bi-trend'},h('div',{class:'bi-panel-heading'},h('h3',{},'Daily sales and collections'),can('reports.sales')?dashboardLink('Sales report','reports','daily'):null),h('p',{class:'bi-caption'},'Nairobi days · sales origin / correction dates; collections received / corrected dates'));
  if(!available){panel.append(h('p',{class:'bi-empty'},'No daily series available. Choose a period and refresh.'));return panel;}
  const values=rows.flatMap(r=>keys.map(k=>Number(r[k]||0))),min=Math.min(0,...values),max=Math.max(1,...values),x=i=>48+i*660/Math.max(1,rows.length-1),y=v=>168-(v-min)/(max-min)*140;
  const label=h('p',{class:'bi-chart-readout','aria-live':'polite'},'Select a day for exact amounts.');
  const svg=dashboardSvg('svg',{viewBox:'0 0 740 205',role:'img','aria-label':'Daily sales and collections in KSh'});
  for(const v of [min,(max+min)/2,max])svg.append(dashboardSvg('line',{x1:48,y1:y(v),x2:708,y2:y(v),class:'bi-gridline'}));
  for(const key of keys){const color=key==='sales'?'#ef8b12':'#69c8ba';svg.append(dashboardSvg('polyline',{points:rows.map((r,i)=>x(i)+','+y(Number(r[key]||0))).join(' '),fill:'none',stroke:color,'stroke-width':3}));
    rows.forEach((r,i)=>{const detail=r.date+' · '+(key==='sales'?'Sales':'Collections')+' '+overviewMoney(r[key]),point=dashboardSvg('circle',{cx:x(i),cy:y(Number(r[key]||0)),r:rows.length>90?2:4,fill:color,tabindex:'0',role:'button','aria-label':detail});const show=()=>{label.textContent=r.date+' · '+keys.map(k=>(k==='sales'?'Sales ':'Collections ')+overviewMoney(r[k])).join(' · ');};if(point.addEventListener){point.addEventListener('focus',show);point.addEventListener('mouseenter',show);point.addEventListener('click',show);}const title=dashboardSvg('title',{});title.textContent=detail;point.append(title);svg.append(point);});}
  panel.append(h('div',{class:'bi-legend'},...keys.map(k=>h('span',{class:k},k==='sales'?'● Sales':'● Collections'))),svg,h('div',{class:'bi-axis'},h('span',{},rows[0].date),h('span',{},rows.at(-1).date)),label,dashboardHelp('Trend scale',overviewMoney(max)+' top · '+overviewMoney(min)+' bottom. Negative corrections remain below zero; chart totals use the same report scope.'));
  return panel;
}
function dashboardView(){
  if(!can('dashboard.view'))return h('p',{},'Dashboard access is not permitted.');
  ensureReportPeriod('dashboard');
  const d=state.dashboardData,refresh=()=>{state.dashboardData=null;void loadDashboard();};
  const root=h('div',{class:'dashboard-overview bi-dashboard'},h('header',{class:'bi-heading'},h('div',{},h('div',{class:'brand-dashboard'},brandMark('compact'),h('p',{class:'bi-eyebrow'},'BUSINESS OVERVIEW')),h('h2',{},'Management Dashboard')),h('span',{class:'bi-status'},'Read-only overview')),dashboardToolbar(refresh));
  if(state.dashboardLoading){root.append(h('p',{role:'status'},'Loading dashboard…'));return root;}
  if(!d||d.error){root.append(h('p',{class:d?.error?'error':'muted',role:d?.error?'alert':'status'},d?.error||'Apply filters or refresh the dashboard.'));return root;}
  const sales=can('reports.sales')?d.sales:null,financial=can('reports.financial')?d.financial:null,collections=can('payments.view_collected')?d.collections:null,inventory=can('reports.inventory')&&(can('stock.view')||can('stock.count'))?d.inventory:null;
  const period=d.period?d.period.start+(d.period.end!==d.period.start?' — '+d.period.end:''):'Selected period',f=filterValues('dashboard'),shift=(state.filterOptions?.shifts||[]).find(s=>s.id===f.shiftId),staff=(state.filterOptions?.staff||[]).find(s=>s.id===f.staffId);
  root.append(h('div',{class:'bi-applied',role:'status'},h('strong',{},'Applied · '+period+' · Nairobi'),h('span',{},[f.shiftId?dashboardName(shift?.name,'Shift'):'All shifts',f.staffId?dashboardName(staff?.name,'Staff'):'All staff',f.q?'Search: '+f.q:'',d.generatedAt?'Updated '+invoiceDateText(d.generatedAt):''].filter(Boolean).join(' · '))));
  const cards=[],card=(label,value,basis,kind='')=>cards.push(h('article',{class:'bi-kpi '+kind},h('span',{class:'bi-kpi-label'},label),h('strong',{class:'bi-kpi-value'},value),h('small',{},basis)));
  if(sales)card('Total Sales',overviewMoney(sales.totals.sales),'Origin + corrections · '+period,'accent');
  if(collections)card('Collections',overviewMoney(collections.netCollections),'Received + corrections · '+period);
  if(sales)card('Outstanding Balances',overviewMoney(sales.outstanding),sales.balanceView==='current'?'Current balance · bills before selected cutoff':'All older bills · cutoff '+invoiceDateText(sales.cutoffExclusive));
  if(financial){card('COGS',overviewMoney(financial.cogs),'Captured costs + corrections · '+period);card('Gross Profit',overviewMoney(financial.grossProfit),'Sales less COGS · '+period);card('Gross Profit Margin',financial.grossMargin==null?'Unavailable':financial.grossMargin+'%','Gross profit / positive net sales');card('Expenses',overviewMoney(financial.totalExpenses),'Verified operating expenses · '+period);card('Net Profit',overviewMoney(financial.netProfit),'Gross profit less expenses · '+period,financial.netProfit==null?'uncertain':'accent');}
  root.append(h('div',{class:'bi-kpi-grid'},...cards));
  if(financial?.expenseVerification?.unclassifiedCount)root.append(h('div',{class:'bi-warning',role:'status'},h('strong',{},'Net profit unverified'),h('span',{},financial.expenseVerification.unclassifiedCount+' purchase expense link(s) need review · '+ksh(financial.expenseVerification.unclassifiedAmount)+'. No historical assignments inferred.')));
  const charts=[];
  if(sales||collections)charts.push(dashboardTrendChart(d));
  if(financial)charts.push(dashboardBars('Sales, COGS and gross profit',[{label:'Sales',value:financial.revenue},{label:'COGS',value:financial.cogs},{label:'Gross profit',value:financial.grossProfit}],{description:'Selected period · including separately dated corrections',link:dashboardLink('Profit & Loss','reports','pnl')}));
  if(sales){charts.push(dashboardBars('Sales by staff',sales.waiters.slice(0,5).map(w=>({label:dashboardName(w.name,'Staff'),value:w.total})),{description:'Top 5 · sale owner, original / correction period',link:dashboardLink('Staff detail','reports','daily')}));
    if(d.breakdowns){const b=d.breakdowns;charts.push(dashboardBars('Top-selling products',(b.topProducts||b.products||[]).slice(0,6).map(p=>({label:dashboardName(p.name,'Product'),value:p.sales})),{description:'Top 6 by net sales · selected period',link:dashboardLink('Sales detail','reports','daily')}),dashboardBars('Sales by current catalog category',b.categories.slice(0,5).map(c=>({label:dashboardName(c.name,'Category'),value:c.sales})),{description:'Top 5 · current classification, not historical categories'}));if(b.unverifiedAllocations||Object.values(b.reconciliation||{}).some(v=>v!==0))root.append(h('p',{class:'bi-warning'},'Product allocation reconciliation needs review; incomplete breakdowns should not be relied on.'));}}
  if(collections)charts.push(dashboardBars('Payment-method breakdown',[{label:'Cash',value:collections.methods.CASH},{label:'M-Pesa',value:collections.methods.MPESA}],{description:'Net collections · M-Pesa internally recorded, not provider-confirmed',link:dashboardLink('Payment detail','reports','payments')}));
  root.append(h('div',{class:'bi-chart-grid'},...charts));
  const operations=[];
  if(can('shifts.manage')&&d.shiftPerformance){
    const shifts=d.shiftPerformance.shifts;
    const rows=shifts.slice(0,3).map(s=>h('div',{class:'bi-operation'},
      h('div',{},h('strong',{},dashboardName(s.name,'Shift')),h('small',{},s.status)),
      h('div',{},sales&&s.periodSales!=null?h('span',{},'Sales '+overviewMoney(s.periodSales)):null,h('small',{},'Variance '+overviewMoney(s.variance)))));
    operations.push(h('section',{class:'bi-panel'},h('div',{class:'bi-panel-heading'},h('h3',{},'Shift performance'),dashboardLink('All shifts','shifts')),h('p',{class:'bi-caption'},'Opened in selected period ? latest 3 ? stored reconciliation'),...(rows.length?rows:[h('p',{class:'bi-empty'},'No matching shifts.')])));
  }
  if(sales)operations.push(h('section',{class:'bi-panel'},h('div',{class:'bi-panel-heading'},h('h3',{},'Outstanding overview'),dashboardLink('Balance report','reports','daily')),h('strong',{class:'bi-operation-value'},overviewMoney(sales.outstanding)),h('p',{class:'bi-caption'},'All older bills included · '+(sales.balanceView==='current'?'current balances':'selected cutoff')),h('p',{},sales.orders.unpaid+' unpaid · '+sales.orders.partial+' partial orders in origin period')));
  if(inventory)operations.push(h('section',{class:'bi-panel'},h('div',{class:'bi-panel-heading'},h('h3',{},'Inventory status'),dashboardLink('Inventory report','inventoryReport')),h('strong',{class:'bi-operation-value'},inventory.stockStatus?.tracked??'Unavailable'),h('p',{class:'bi-caption'},'Active stock-tracked products · current snapshot'),h('p',{},inventory.stockStatus?inventory.stockStatus.outOfStock+' at zero or below':'Stock summary unavailable'),h('small',{class:'muted'},'Low-stock thresholds are not configured; no low-stock alert is inferred.')));
  if(can('commissions.manage')&&d.commissions)operations.push(h('section',{class:'bi-panel'},h('div',{class:'bi-panel-heading'},h('h3',{},'Earned commissions'),dashboardLink('Commission report','reports','commissions')),h('strong',{class:'bi-operation-value'},overviewMoney(d.commissions.grandTotalCommission)),h('p',{class:'bi-caption'},'Settlement / correction period · not deducted again from net profit'),d.commissions.unverifiedOrders?h('p',{class:'bi-warning'},d.commissions.unverifiedOrders+' legacy orders unverified'):null));
  root.append(h('div',{class:'bi-operations'},...operations));
  if(d.accounting&&can('accounting.view')&&can('reports.financial')&&typeof accountingDashboard==='function')root.append(accountingDashboard(d.accounting));
  if(!cards.length&&!operations.length){root.append(h('p',{},'No report sections are authorized. Dashboard permission alone does not grant report access.'));return root;}
  root.append(dashboardHelp('About these figures','Revenue includes unpaid and partially paid eligible sales. Returns, voids and other corrections retain their correction periods. Collections use receiving/correction shifts; revenue uses origin/correction shifts. Outstanding includes older bills through the selected cutoff, with current balance available as an explicit alternative. COGS uses captured costs. Net profit is gross profit minus verified operating expenses; commission recognition remains separate. Unknown purchase links leave net profit unavailable. Original accounting dates are used where available; legacy missing dates use the existing report fallback. Current categories and stock are not historical snapshots. Detailed rows remain in their authorized report modules.'));
  return root;
}

function inventorySummary(data){return [h('h3',{},'Inventory insights'),h('p',{class:'muted'},data.basis),h('p',{class:'muted'},data.unavailable),overviewTable(['Current product','Quantity now','Unit'],data.currentStock.map(p=>[p.name,String(p.quantity),p.unitOfMeasure])),h('h3',{},'Movement groups — selected period'),overviewTable(['Product','Type','Change','Movements'],data.movements.map(m=>[m.product?.name||m.productId,m.type,m.quantityChange,m.movements])),h('p',{class:'muted'},'Current-stock page '+data.pagination.page+'; movement groups page '+data.movementPage+', limit '+data.movementLimit+'. No cross-unit quantity grand total.')];}
async function loadInventoryReport(){const current=filterGuard('inventoryReport');state.inventoryReportData={loading:true};render();try{const data=await api('/reports/inventory'+filterQuery('inventoryReport'));if(current())state.inventoryReportData=data;}catch(error){if(current())state.inventoryReportData={error:error.message};}finally{if(current())render();}}
function inventoryReportView(){if(!can('reports.inventory')||!(can('stock.view')||can('stock.count')))return h('p',{},'Inventory report authorization required.');const data=state.inventoryReportData;return h('div',{},h('h2',{},'Inventory report'),filterControls('inventoryReport',loadInventoryReport,{search:'Product name or code'}),h('button',{class:'ghost',onclick:loadInventoryReport},'Load inventory report'),data?.loading?h('p',{role:'status'},'Loading…'):data?.error?h('p',{class:'error'},data.error):data?[...inventorySummary(data),filterPagerForData('inventoryReport',data.pagination,loadInventoryReport),movementGroupPager(data.movementPagination)]:h('p',{},'Apply filters or load the report.'));}
function movementGroupPager(p){if(!p)return null;const go=delta=>{filterValues('inventoryReport').movementPage=p.page+delta;loadInventoryReport();};return h('div',{class:'row'},h('button',{class:'ghost',disabled:p.page<=1,onclick:()=>go(-1)},'Previous movement groups'),h('span',{},'Movement groups page '+p.page+' of '+Math.max(1,p.pages)+' ? '+p.total+' groups'),h('button',{class:'ghost',disabled:p.page>=p.pages,onclick:()=>go(1)},'Next movement groups'));}
function filterPagerForData(key,pagination,apply){state.filterPages[key]=pagination;return filterPager(key,apply);}
function countHistoryView(){const key='countHistory',f=filterValues(key);if(!can('stock.count')&&!can('stock.count_approve'))return h('p',{},'Count history authorization required.');const load=()=>loadLedger(key,'/stock/counts/history','counts');const basis=h('select',{'aria-label':'Count history date basis',onchange:e=>{f.dateBasis=e.target.value;f.page=1;load();}},...['created','submitted','completed'].map(x=>h('option',{value:x,selected:(f.dateBasis||'created')===x},x)));return h('div',{},h('h2',{},'Stock-count history'),h('label',{class:'stacked-field'},'Count date basis',basis),h('p',{class:'muted'},'Shift filtering unavailable: counts have no authoritative shift assignment. Non-approvers see their own sessions only.'),ledgerView(key,'/stock/counts/history','counts',[['Created',r=>invoiceDateText(r.createdAt)],['Submitted',r=>invoiceDateText(r.submittedAt)],['Completed',r=>invoiceDateText(r.completedAt)],['Status',r=>r.status],['Notes',r=>r.notes||''] ],{shift:false,statuses:['DRAFT','COMPLETED','CANCELLED'],search:'Count notes or identifier'}));}



async function exportDailyCsv(){const current=accessGuard();try{const response=await fetch('/api/reports/daily/csv'+filterQuery('daily'),{credentials:'same-origin',cache:'no-store'});if(!response.ok)throw Error('Sales export failed. Refresh permissions and retry.');const blob=await response.blob();if(!current())return;const url=URL.createObjectURL(blob),a=h('a',{href:url,download:'habibi-sales-'+(filterValues('daily').date||'period')+'.csv'});document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),30000);}catch(e){if(current())toast(e.message,true);}}



function mpesaMatchControl(){const input=h('input',{type:'search',inputmode:'search',maxlength:10,'aria-label':'M-Pesa identifying suffix',placeholder:'Last 3 characters (matching only)'}),results=h('div',{role:'status'});return h('details',{},h('summary',{},'Find an existing M-Pesa transaction'),h('label',{},'Full reference or suffix',input),h('button',{class:'ghost',onclick:async()=>{const current=accessGuard();try{const data=await api('/reports/mpesa-matches?suffix='+encodeURIComponent(input.value.trim()));if(!current()||!results.isConnected)return;results.replaceChildren(h('p',{},data.notice),h('p',{},data.more?'More than 50 matches — enter more characters.':data.ambiguous?'Multiple matches — compare complete references.':data.matches.length?'Existing transaction found — do not record it again.':'No stored match. This does not verify a provider transaction.'),...data.matches.map(m=>h('p',{},m.reference+' · '+ksh(m.amount)+' · '+m.saleNumber+' · '+m.source)));}catch(e){if(current()&&results.isConnected)results.textContent=e.message;}}},'Find matches'),results);}


// Audited sale pricing uses the existing financial correction API and navigation.
async function pricingDialog(order,kind){
 if(!can(kind==='SALE_DISCOUNT'?'sales.discount':'sales.change_price'))return;
 const d=financialModal(kind==='SALE_DISCOUNT'?'Discount bill or item':'Change item selling price');d.content.append(d.error,d.cancel);
 try{
  const info=await api('/financial-operations/sales/'+encodeURIComponent(order.id)+'/options');if(!d.current())return d.close();
  const key=financialClientKey(),scope=h('select',{'aria-label':'Pricing scope',onchange:invalidate},...(kind==='SALE_DISCOUNT'?[h('option',{value:''},'Whole remaining bill')]:[h('option',{value:''},'Choose an item')]),...info.items.filter(i=>Number(i.quantity)>Number(i.returnedQuantity)).map(i=>h('option',{value:i.id},i.name))),type=h('select',{'aria-label':'Discount type',onchange:invalidate},h('option',{value:'FIXED'},'KSh amount'),h('option',{value:'PERCENT'},'Percentage')),
  value=h('input',{type:'text',inputmode:'decimal','aria-label':'Pricing value',oninput:invalidate}),reason=h('input',{'aria-label':'Pricing correction reason',placeholder:'Reason (at least 3 characters)'}),shift=financialShiftSelect(order,info.recordingShifts),prior=h('input',{type:'checkbox','aria-label':'Acknowledge earlier pricing',onchange:invalidate}),zero=h('input',{type:'checkbox','aria-label':'Authorize zero price',onchange:invalidate}),cash=h('input',{type:'text',inputmode:'decimal','aria-label':'Pricing cash refund',value:'0',oninput:invalidate}),mpesa=h('input',{type:'text',inputmode:'decimal','aria-label':'Pricing M-Pesa refund',value:'0',oninput:invalidate}),reference=h('input',{'aria-label':'Pricing external refund reference',oninput:invalidate}),handled=h('input',{type:'checkbox','aria-label':'Pricing refund handled externally',onchange:invalidate}),preview=h('div',{role:'status'});
  let quote=null;const submit=h('button',{class:'primary',disabled:true,onclick:send},info.pricingRequiresApproval?'Submit for manager approval':'Confirm pricing correction');
  function invalidate(){quote=null;submit.disabled=true;preview.replaceChildren(h('p',{},'Review a fresh preview after changing pricing or refund details.'));}
  function body(){const refunds=[];for(const[method,input]of[['CASH',cash],['MPESA',mpesa]]){if(input.value.trim()&&Number(input.value)!==0)refunds.push({method,amount:input.value.trim(),...(method==='MPESA'?{externalReference:reference.value.trim(),externallyHandled:handled.checked}:{})});}return{kind,saleId:order.id,clientRequestId:key,expectedUpdatedAt:info.updatedAt,reason:reason.value.trim(),value:value.value.trim(),...(scope.value?{saleItemId:scope.value}:{}),...(kind==='SALE_DISCOUNT'?{discountType:type.value}:{}),acknowledgePriorPricing:prior.checked,acknowledgeZeroPrice:zero.checked,refunds,...(shift.value?{shiftId:shift.value}:{})};}
  const review=h('button',{class:'ghost',onclick:async()=>{if(d.busy||d.review)return;if(reason.value.trim().length<3){d.error.textContent='Enter a reason before previewing.';return;}d.setBusy(true);try{const submitted=JSON.stringify(body());quote=await api('/financial-operations/sales/'+encodeURIComponent(order.id)+'/pricing-quote',{method:'POST',body:JSON.parse(submitted)});if(!d.current())return;if(submitted!==JSON.stringify(body())){invalidate();return;}quote.submitted=submitted;preview.replaceChildren(h('p',{},'Original net '+ksh(info.netTotal)+' → revised net '+ksh(quote.netTotal)),h('p',{},'Revenue change '+ksh(quote.salesDelta)+' · required refund '+ksh(quote.requiredRefund)+' · entered refund '+ksh(quote.refundTotal)),h('p',{},'Original payments, stock and COGS are preserved.'),...quote.after.map(row=>h('p',{},(info.items.find(i=>i.id===row.id)?.name||'Original item')+': remaining '+row.quantity+' · '+ksh(quote.before.find(i=>i.id===row.id).amount)+' → '+ksh(row.amount))));if(!quote.storageAvailable)preview.append(h('p',{class:'muted'},'Preview only: reviewed database migration is awaiting owner authorization.'));submit.disabled=!quote.storageAvailable||quote.refundAuthorized===false||Number(quote.requiredRefund)!==Number(quote.refundTotal);}catch(e){financialFailure(d,e);}finally{if(d.current())d.setBusy(false);}}},'Preview correction');
  async function send(){if(d.busy||d.review||!quote||!quote.storageAvailable)return;if(quote.submitted!==JSON.stringify(body())){invalidate();return;}if(!shift.value||reason.value.trim().length<3){d.error.textContent='Choose an open recording shift and enter a reason.';return;}d.setBusy(true);submit.disabled=true;try{const result=await api('/financial-operations',{method:'POST',body:body()});if(!d.current())return;d.close();toast(result.request?'Pricing request submitted; no financial change yet.':'Pricing correction recorded; original history preserved.');state.ledger={};state.reportData=state.pnlData=state.commissionsData=null;await loadOrders();render();}catch(e){financialFailure(d,e);}finally{if(d.current())d.setBusy(false);}}
  d.content.prepend(...[h('p',{},info.saleNumber+' · net '+ksh(info.netTotal)+' · paid '+ksh(info.amountPaid)+' · outstanding '+ksh(info.balance)),h('label',{},'Apply to',scope),kind==='SALE_DISCOUNT'?h('label',{},'Discount type',type):null,h('label',{},kind==='SALE_DISCOUNT'?'Discount value':'New net unit selling price (replaces earlier line pricing)',value),info.priorPricing?h('label',{},prior,' I reviewed prior corrections. This discount is an additional deliberate reduction of the displayed remaining value. A price override replaces the selected remaining line price.'):null,kind==='SALE_PRICE_CHANGE'?h('label',{},zero,' I explicitly authorize a zero selling price if entered.'):null,h('label',{},'Reason',reason),h('details',{},h('summary',{},'Refund evidence (only if reduction exceeds outstanding balance)'),h('label',{},'Cash refund',cash),h('label',{},'M-Pesa refund',mpesa),h('label',{},'External M-Pesa refund reference',reference),h('label',{},handled,' I handled the M-Pesa refund externally. This POS does not send it.')),h('label',{},'Recording shift',shift),review,preview,submit].filter(Boolean));
 }catch(e){if(d.current())financialFailure(d,e);}
}
const pricingOrderCard=orderCard;
orderCard=function(order){const card=pricingOrderCard(order);if(!state.mergeMode&&!['CANCELLED','MERGED'].includes(order.status)){if(can('sales.discount'))card.append(h('button',{class:'ghost',onclick:()=>pricingDialog(order,'SALE_DISCOUNT')},'Discount bill / item'));if(can('sales.change_price'))card.append(h('button',{class:'ghost',onclick:()=>pricingDialog(order,'SALE_PRICE_CHANGE')},'Change selling price'));}return card;};

boot();
