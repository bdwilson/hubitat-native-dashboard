(() => {
'use strict';

// ── Constants ─────────────────────────────────────────────────────────────────

const API_CONFIG = 'config?access_token=' + encodeURIComponent(new URLSearchParams(location.search).get('access_token') || '');
const API_HUB    = 'hub';
const STORAGE_KEY = 'hubitat-dash-v4-cache';
// hubitat-native-dashboard: in local mode this browser keeps its layout to
// itself — the hub's stored config is neither read nor written. Everything
// still runs against the same hub and the same devices; only where the tile
// layout lives changes.
//
// The mode is remembered per browser (settings panel toggle). ?local=1 and
// ?local=0 force it for one load regardless, so a link can be handed to someone
// without changing what their browser remembers.
const HND_MODE_KEY = 'hnd-config-mode';
const HND_LOCAL_ONLY = (function () {
  var q = new URLSearchParams(location.search).get('local');
  if (q === '1') return true;
  if (q === '0') return false;
  try { return localStorage.getItem(HND_MODE_KEY) === 'local'; } catch (e) { return false; }
})();
// hubitat-native-dashboard: upstream decides "can this setup use the
// eventsocket?" from cfg.hubIsCloud — the hub URL typed into settings. On this
// build that is the wrong question, and worse, it is not always answerable:
// local-only mode never loads the hub's config, so cfg.hubIsCloud keeps its
// upstream default of TRUE and every check against it reads backwards.
//
// What decides it here is how the BROWSER reached this page. Over the cloud
// link there is no eventsocket to reach; over the local link there is,
// whatever settings say. Declared once, used by every patched site.
const HND_VIA_CLOUD = location.hostname.includes('cloud.hubitat.com');

// Default layout: section → ordered slot IDs.
// Slot IDs are stable — KV config keys off them.
// To add tiles, append new IDs; to remove, just exclude from the layout array.
const LAYOUT_DEFAULTS = {
  row1:       ['s1','s2','s3'],
  row2:       ['s4','s5','s6'],
  row3:       ['s7','s8','s9'],
  cameras:    ['cam1','cam2','cam3','cam4','cam5','cam6'],
  'right-col':['r1','r2','r3','r4','r5','r6','r7','r8','r9'],
  'row-bottom':['b1','b2','b3'],
};

const DEFAULT_SLOTS = {
  s1:   { label:'Slot 1',   kind:'hidden' },
  s2:   { label:'Slot 2',   kind:'hidden' },
  s3:   { label:'Slot 3',   kind:'hidden' },
  s4:   { label:'Slot 4',   kind:'hidden' },
  s5:   { label:'Slot 5',   kind:'hidden' },
  s6:   { label:'Slot 6',   kind:'hidden' },
  s7:   { label:'Slot 7',   kind:'hidden' },
  s8:   { label:'Slot 8',   kind:'hidden' },
  s9:   { label:'Slot 9',   kind:'hidden' },
  cam1: { label:'Image 1',  kind:'hidden' },
  cam2: { label:'Image 2',  kind:'hidden' },
  cam3: { label:'Image 3',  kind:'hidden' },
  cam4: { label:'Image 4',  kind:'hidden' },
  cam5: { label:'Image 5',  kind:'hidden' },
  cam6: { label:'Image 6',  kind:'hidden' },
  r1:   { label:'Right 1',  kind:'hidden' },
  r2:   { label:'Right 2',  kind:'hidden' },
  r3:   { label:'Right 3',  kind:'hidden' },
  r4:   { label:'Right 4',  kind:'hidden' },
  r5:   { label:'Right 5',  kind:'hidden' },
  r6:   { label:'Right 6',  kind:'hidden' },
  r7:   { label:'Right 7',  kind:'hidden' },
  r8:   { label:'Right 8',  kind:'hidden' },
  r9:   { label:'Right 9',  kind:'hidden' },
  b1:   { label:'Bottom 1', kind:'hidden' },
  b2:   { label:'Bottom 2', kind:'hidden' },
  b3:   { label:'Bottom 3', kind:'hidden' },
};

const defaultConfig = {
  hubBaseUrl: '', hubAppId: '', hubToken: '',
  hubIsCloud: true, hubHasToken: false,
  pollSec: 5, title: 'Home',
  slots: JSON.parse(JSON.stringify(DEFAULT_SLOTS)),
  layout: null,   // null = use LAYOUT_DEFAULTS
  gridCols: 3,    // grid columns per section
  tileH: 80,      // tile row height in px
  iconScale: 1,   // global icon size multiplier
  hubExternalUrl: '', // opened by the topbar external-link button
  chipAccent: '#2d7fbf', // nav-chip accent color (Main + custom dashboards)
  chipAccentDynamic: '#2d7fbf', // nav-chip accent color (auto-generated dashboards)
  theme: 'auto',  // 'auto' | 'light' | 'dark' — auto follows local time of day
};

// Dynamic dashboard definitions
// Dynamic groups use dynKindForDevice() so manual overrides are respected.
// Battery is attribute-based and intentionally overlaps with other groups.
const DYNAMIC_GROUPS = [
  { key:'switches',  label:'Switches',        match: d => dynKindForDevice(d) === 'switch' },
  { key:'lights',    label:'Lights',          match: d => dynKindForDevice(d) === 'bulb' },
  { key:'locks',     label:'Locks',           match: d => dynKindForDevice(d) === 'lock' },
  { key:'battery',   label:'Battery',         match: d => getAttr(d,'battery') != null },
  { key:'presence',  label:'Presence',        match: d => dynKindForDevice(d) === 'presence' },
  { key:'contact',   label:'Contact Sensors', match: d => dynKindForDevice(d) === 'contact' },
  { key:'shades',    label:'Shades',          match: d => dynKindForDevice(d) === 'shade' },
  { key:'thermostats', label:'Thermostats',   match: d => dynKindForDevice(d) === 'thermostat' },
  { key:'buttons',   label:'Buttons',         match: d => dynKindForDevice(d) === 'momentary' },
];

// ── Grid helpers ──────────────────────────────────────────────────────────────

/**
 * Convert user-facing colSpan (0.5 | 1 | 2 | 3 | …) to CSS grid span units.
 * The .section grid uses 2× the user column count internally, so:
 *   ½ col → span 1   |   1 col → span 2   |   2 cols → span 4   |   N cols → span 2N
 * Previously this hardcoded 0.5/2/3 and returned 2 for anything else, so a
 * 4-, 5- or 6-column span silently rendered as one column.
 */
function colToSpan(colSpan) {
  if (colSpan === 0.5) return 1;
  const n = Number(colSpan);
  if (!isFinite(n) || n < 1) return 2;
  return Math.round(n) * 2;
}

/**
 * Convert CSS span units back to user-facing colSpan.
 */
function spanToCol(cssSpan) {
  if (cssSpan === 1) return 0.5;
  const n = Number(cssSpan);
  if (!isFinite(n) || n < 2) return 1;
  return Math.round(n / 2);
}

/**
 * How many columns a grid element actually has, read from the rendered grid.
 *
 * Deriving it rather than assuming is the point: the custom/dynamic resize
 * handler used to compute a column as `offsetWidth / 3` while the grid was
 * really `auto-fill minmax(130px, 1fr)` — nine tracks at 1280px, not three —
 * so a drag needed about four times the expected travel and its snap points
 * lined up with nothing. Reading the computed value cannot drift from the CSS.
 */
function gridColumnCount(gridEl, fallback) {
  if (!gridEl) return fallback;
  const cols = getComputedStyle(gridEl).gridTemplateColumns;
  if (!cols || cols === 'none') return fallback;
  // A display:none grid reports the SPECIFIED value rather than resolved track
  // sizes — "repeat(6, minmax(0, 1fr))" would count as a couple of tokens and
  // silently pass for a real column count. Only a resolved list is usable.
  if (cols.includes('repeat(') || cols.includes('auto-fill') || cols.includes('auto-fit')) return fallback;
  const n = cols.trim().split(/\s+/).length;
  return n > 0 ? n : fallback;
}

// ── State ─────────────────────────────────────────────────────────────────────

// Must be declared before loadConfigCache() because it accesses them
let dynamicHidden    = {};        // { deviceId: true } — from KV
let dynamicOrder     = {};        // { groupKey: [deviceId, ...] } — from KV
let dynamicOverrides = {};        // { deviceId: kindString } — manual kind overrides
let customDashboards = {};        // { name: { title, tiles: [...] } } — from KV
let dashboardsVisible = {};       // { 'main': true, 'switches': false, ... } — user preferences
let dashboardsOrder = [];         // ['main', 'switches', 'locks', ...] — user-defined order
let statusBarPresenceDevices = {};// { deviceId: { label, kind } } — presence devices to show in status bar (even if tile hidden)

let cfg            = loadConfigCache();
let devices        = [];
let hubModes       = [];
let pollTimer      = null;
let ws             = null;
let wsReconnTimer  = null;
let editMode       = false;
let currentView    = 'main';      // 'main' | 'dynamic/switches' | 'custom/name'
let devicePickerCallback = null;  // set before opening device picker
let imageLastRefreshed   = {};    // { slotId: timestamp } — tracks last img.src update

// Image URL tracking — only update <img> when the attribute value actually changes.
// This prevents the flicker caused by unconditionally resetting img.src every poll.

// Drag state — main dashboard (edit mode)
let dragSlot    = null;
let dragSection = null;

// Drag state — dynamic dashboard
let dragDynId = null;

// Custom tile editor state
let editingCustom = null; // { dashName, slotId } when editing a custom tile

// Dirty flag — set when layout/tiles changed but not yet saved to KV
let isDirty = false;
function markDirty() {
  isDirty = true;
  const badge = document.getElementById('dirty-badge');
  if (badge) badge.style.display = '';
}
function markClean() {
  isDirty = false;
  const badge = document.getElementById('dirty-badge');
  if (badge) badge.style.display = 'none';
}

// Selected device IDs for multi-select picker
const selectedDeviceIds = new Set();

// ── Config cache ──────────────────────────────────────────────────────────────

function loadConfigCache() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const c = JSON.parse(raw);
      c.slots = c.slots || {};
      for (const id of Object.keys(DEFAULT_SLOTS)) {
        if (!c.slots[id]) c.slots[id] = { ...DEFAULT_SLOTS[id] };
      }
      // Restore dynamic and custom from cache
      if (c.dynamic) {
        dynamicHidden    = c.dynamic.hidden    || {};
        dynamicOrder     = c.dynamic.order     || {};
        dynamicOverrides = c.dynamic.overrides || {};
      }
      if (c.custom) {
        customDashboards = c.custom;
      }
      // Restore dashboard visibility and ordering preferences
      if (c.dashboardsVisible) {
        dashboardsVisible = c.dashboardsVisible;
      }
      if (c.dashboardsOrder) {
        dashboardsOrder = c.dashboardsOrder;
      }
      // Restore presence devices that should show in status bar
      if (c.statusBarPresenceDevices) {
        statusBarPresenceDevices = c.statusBarPresenceDevices;
      }
      // Remove these from the cfg object before returning
      delete c.dynamic;
      delete c.custom;
      delete c.dashboardsVisible;
      delete c.dashboardsOrder;
      delete c.statusBarPresenceDevices;
      return Object.assign({}, defaultConfig, c);
    }
  } catch (e) { console.warn('loadConfigCache', e); }
  return JSON.parse(JSON.stringify(defaultConfig));
}

function saveConfigCache() {
  try {
    const cache = {
      ...cfg,
      dynamic: (Object.keys(dynamicHidden).length || Object.keys(dynamicOrder).length || Object.keys(dynamicOverrides).length)
        ? { hidden: dynamicHidden, order: dynamicOrder,
            overrides: Object.keys(dynamicOverrides).length ? dynamicOverrides : undefined }
        : undefined,
      custom: Object.keys(customDashboards).length ? customDashboards : undefined,
      dashboardsVisible: Object.keys(dashboardsVisible).length ? dashboardsVisible : undefined,
      dashboardsOrder: dashboardsOrder.length ? dashboardsOrder : undefined,
      statusBarPresenceDevices: Object.keys(statusBarPresenceDevices).length ? statusBarPresenceDevices : undefined,
    };
    localStorage.setItem(STORAGE_KEY, JSON.stringify(cache));
  }
  catch (e) { console.warn('saveConfigCache', e); }
}

// ── Hub ID helpers ────────────────────────────────────────────────────────────
//
// The hub UID namespaces all KV keys so multiple hubs can share one Worker.
// For cloud URLs it is extracted from the base URL automatically.
// For LAN/tunnel URLs the Hub ID is derived from the hostname so every browser
// visiting the same tunnel URL shares the same KV namespace automatically.

function extractHubId(urlOverride) {
  const base = urlOverride || cfg.hubBaseUrl;
  if (base) {
    const cloudMatch = base.match(/cloud\.hubitat\.com\/api\/([a-f0-9-]+)/i);
    if (cloudMatch) return cloudMatch[1];
    // LAN/tunnel: use hostname so the ID is deterministic and the same on every device
    try {
      const hostname = new URL(base).hostname;
      if (hostname) return hostname;
    } catch {}
  }
  // No base URL yet — nothing to derive from
  return '';
}

function workerHeaders(extra = {}) {
  const h = { ...extra };
  const hubId = extractHubId();
  if (hubId) h['X-Hub-Id'] = hubId;
  return h;
}

function hubProxyHeaders() {
  const h = workerHeaders();
  if (cfg.hubToken) {
    h['X-Hub-Token']    = cfg.hubToken;
    h['X-Hub-Base-Url'] = cfg.hubBaseUrl;
    h['X-Hub-App-Id']   = cfg.hubAppId;
    h['X-Hub-Is-Cloud'] = cfg.hubIsCloud ? '1' : '0';
  }
  return h;
}

async function fetchConfigFromWorker(includeSecrets) {
  if (HND_LOCAL_ONLY) throw new Error('local-only mode (?local=1) — hub config not loaded');
  const url = includeSecrets ? `${API_CONFIG}&include_secrets=1` : API_CONFIG;
  const r = await fetch(url, { credentials: 'same-origin', headers: workerHeaders() });
  if (!r.ok) throw new Error(`HTTP ${r.status} ${r.statusText}`);
  return r.json();
}

async function pushConfigToWorker(payload) {
  if (HND_LOCAL_ONLY) return { ok: true, localOnly: true };
  const r = await fetch(API_CONFIG, {
    method: 'PUT',
    headers: workerHeaders({ 'content-type': 'application/json' }),
    credentials: 'same-origin',
    body: JSON.stringify(payload),
  });
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText} ${body.substring(0,200)}`);
  }
  return r.json();
}

function applyServerConfig(serverCfg) {
  if (!serverCfg) return;
  if (serverCfg.dashboard) {
    cfg.title   = serverCfg.dashboard.title   ?? cfg.title;
    cfg.pollSec = serverCfg.dashboard.pollSec ?? cfg.pollSec;
    if (serverCfg.dashboard.slots) {
      cfg.slots = { ...DEFAULT_SLOTS, ...serverCfg.dashboard.slots };
    }
    if (serverCfg.dashboard.layout)    cfg.layout    = serverCfg.dashboard.layout;
    if (serverCfg.dashboard.gridCols)  cfg.gridCols  = serverCfg.dashboard.gridCols;
    if (serverCfg.dashboard.tileH)     cfg.tileH     = serverCfg.dashboard.tileH;
    if (serverCfg.dashboard.iconScale) cfg.iconScale = serverCfg.dashboard.iconScale;
    if (serverCfg.dashboard.hubExternalUrl != null) cfg.hubExternalUrl = serverCfg.dashboard.hubExternalUrl;
    if (serverCfg.dashboard.chipAccent) cfg.chipAccent = serverCfg.dashboard.chipAccent;
    if (serverCfg.dashboard.chipAccentDynamic) cfg.chipAccentDynamic = serverCfg.dashboard.chipAccentDynamic;
    if (serverCfg.dashboard.theme)     cfg.theme     = serverCfg.dashboard.theme;
    applyCssVars();
  }
  if (serverCfg.hub) {
    cfg.hubBaseUrl = serverCfg.hub.baseUrl || '';
    cfg.hubAppId   = serverCfg.hub.appId   || '';
    cfg.hubIsCloud = !!serverCfg.hub.isCloud;
    if (typeof serverCfg.hub.token === 'string') {
      cfg.hubToken    = serverCfg.hub.token;
      cfg.hubHasToken = serverCfg.hub.token.length > 0;
    } else {
      cfg.hubHasToken = !!serverCfg.hub.hasToken;
    }
  }
  if (serverCfg.dynamic) {
    dynamicHidden    = serverCfg.dynamic.hidden    || {};
    dynamicOrder     = serverCfg.dynamic.order     || {};
    dynamicOverrides = serverCfg.dynamic.overrides || {};
  }
  if (serverCfg.custom && Object.keys(serverCfg.custom).length > 0) {
    // Only overwrite if server has custom dashboards; preserve in-memory if server is empty
    customDashboards = serverCfg.custom;
  }
  if (serverCfg.dashboardsVisible && Object.keys(serverCfg.dashboardsVisible).length > 0) {
    dashboardsVisible = serverCfg.dashboardsVisible;
  }
  if (serverCfg.dashboardsOrder && serverCfg.dashboardsOrder.length > 0) {
    dashboardsOrder = serverCfg.dashboardsOrder;
  }
  if (serverCfg.statusBarPresenceDevices && Object.keys(serverCfg.statusBarPresenceDevices).length > 0) {
    statusBarPresenceDevices = serverCfg.statusBarPresenceDevices;
  }
  saveConfigCache();
}

// ── CSS variable helpers ──────────────────────────────────────────────────────

function applyCssVars() {
  document.documentElement.style.setProperty('--grid-cols', String(cfg.gridCols || 3));
  document.documentElement.style.setProperty('--row-h', `${cfg.tileH || 80}px`);
  document.documentElement.style.setProperty('--icon-scale', String(cfg.iconScale || 1));
  document.documentElement.style.setProperty('--chip-accent', cfg.chipAccent || '#2d7fbf');
  document.documentElement.style.setProperty('--chip-accent-dynamic', cfg.chipAccentDynamic || '#2d7fbf');
  applyTheme();
}

// ── Theme helpers ─────────────────────────────────────────────────────────────
// 'auto' mode uses a fixed local-time window rather than a configurable
// sunrise/sunset — simpler to reason about and good enough for a wall-mounted
// dashboard that isn't relocating between time zones.
const THEME_DAY_START_HOUR = 7;   // 7am
const THEME_NIGHT_START_HOUR = 19; // 7pm

function resolveTheme() {
  if (cfg.theme === 'light' || cfg.theme === 'dark') return cfg.theme;
  const h = new Date().getHours();
  return (h >= THEME_DAY_START_HOUR && h < THEME_NIGHT_START_HOUR) ? 'light' : 'dark';
}

function applyTheme() {
  const resolved = resolveTheme();
  document.documentElement.dataset.theme = resolved;
  const metaTheme = document.querySelector('meta[name="theme-color"]');
  if (metaTheme) metaTheme.content = resolved === 'light' ? '#eef0f3' : '#000000';
  const btn = document.getElementById('theme-toggle');
  if (btn) {
    const mode = cfg.theme || 'auto';
    btn.textContent = mode === 'light' ? '☀' : mode === 'dark' ? '☾' : '◐';
    btn.title = `Theme: ${mode}${mode === 'auto' ? ` (currently ${resolved})` : ''} — click to change`;
  }
}

// ── Layout helpers ────────────────────────────────────────────────────────────

function getLayout() {
  return cfg.layout || LAYOUT_DEFAULTS;
}

function generateSlotId() {
  const all = new Set(Object.keys(cfg.slots));
  let n = 1;
  while (all.has(`u${n}`)) n++;
  return `u${n}`;
}

// ── Device helpers ────────────────────────────────────────────────────────────

function hubPath(path) {
  return `${API_HUB}?access_token=${encodeURIComponent(new URLSearchParams(location.search).get('access_token') || '')}&path=${encodeURIComponent(path.startsWith('/') ? path : '/' + path)}`;
}
async function api(path) {
  const fullUrl = hubPath(path);
  const headers = hubProxyHeaders();
  let r;
  // Device state must always be fresh — the Worker already sends
  // Cache-Control: no-store, but iOS Safari (particularly in standalone/
  // home-screen PWA mode) has a history of serving disk-cached fetch()
  // responses despite that header, so ask explicitly too.
  try { r = await fetch(fullUrl, { credentials: 'same-origin', headers, cache: 'no-store' }); }
  catch (netErr) { throw new Error(`Network error fetching ${fullUrl} — ${netErr.message}`); }
  if (!r.ok) {
    const body = await r.text().catch(() => '');
    throw new Error(`HTTP ${r.status} ${r.statusText} for ${fullUrl}${body ? ' — ' + body.substring(0,200) : ''}`);
  }
  try { return await r.json(); }
  catch (e) {
    const text = await r.text().catch(() => '');
    throw new Error(`Non-JSON response from ${fullUrl}: ${text.substring(0,200)}`);
  }
}
async function sendCommand(deviceId, command, secondary) {
  let path = `/devices/${deviceId}/${encodeURIComponent(command)}`;
  if (secondary !== undefined) path += `/${encodeURIComponent(secondary)}`;
  return api(path);
}

function findDevice(id) { return devices.find(d => String(d.id) === String(id)); }
function getAttr(device, name) {
  if (!device) return undefined;
  if (Array.isArray(device.attributes)) {
    const a = device.attributes.find(x => x.name === name);
    return a ? a.currentValue : undefined;
  }
  return device.attributes ? device.attributes[name] : undefined;
}
function hasCapability(device, cap) {
  if (!device || !device.capabilities) return false;
  return device.capabilities.some(c => typeof c === 'string' ? c === cap : false);
}
// Maker API lists each device's available custom commands (name only — it
// doesn't expose argument types/constraints, so a momentary tile only offers
// one free-text argument, matching the one optional path segment the Maker
// API command endpoint itself supports).
function deviceCommands(device) {
  if (!device || !Array.isArray(device.commands)) return [];
  return device.commands.map(c => typeof c === 'string' ? c : c.command).filter(Boolean);
}

// ── Thermostat helpers ────────────────────────────────────────────────────────

// Prefers the live operating state (what the thermostat is actually doing right
// now) over the mode setting — a unit left in "auto" that's actively cooling
// should show a snowflake, not the neutral dial icon `mode` alone would imply.
function thermostatModeIcon(mode, opState) {
  const os = (opState || '').toLowerCase();
  if (os === 'cooling') return 'snowflake';
  if (os.includes('heat')) return 'fire'; // "heating" or "pending heat"
  const m = (mode || '').toLowerCase();
  if (m === 'cool') return 'snowflake';
  if (m.includes('heat')) return 'fire';
  return 'thermostat';
}
// Short setpoint text for the tile-battery badge, e.g. "68°" (heat/cool) or "68°/74°" (auto).
function thermostatSetpointBadge(d, mode) {
  const m = (mode || '').toLowerCase();
  const heatSp = getAttr(d, 'heatingSetpoint');
  const coolSp = getAttr(d, 'coolingSetpoint');
  if (m === 'auto') return (heatSp != null && coolSp != null) ? `${heatSp}°/${coolSp}°` : '';
  if (m === 'cool') return coolSp != null ? `${coolSp}°` : '';
  if (m.includes('heat')) return heatSp != null ? `${heatSp}°` : '';
  return '';
}
// Hubitat's supportedThermostatModes/supportedThermostatFanModes attributes are a JSON-array string.
function parseSupportedList(d, attrName) {
  const raw = getAttr(d, attrName);
  if (!raw) return null;
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map(v => String(v).toLowerCase()) : null;
  } catch { return null; }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
}
// Strips event-handler attributes and javascript:/vbscript: URLs from HTML-formatted
// attribute values (e.g. Device Watchdog's <table> report) before rendering them.
// Uses DOMParser rather than a live-document element: parsing into a DOMParser
// document does not run scripts or fire resource-load events (onerror/onload),
// unlike setting innerHTML on an element that belongs to the real document.
function sanitizeHtml(html) {
  const doc = new DOMParser().parseFromString(String(html ?? ''), 'text/html');
  ['script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form'].forEach(tag => {
    doc.querySelectorAll(tag).forEach(el => el.remove());
  });
  doc.querySelectorAll('*').forEach(el => {
    [...el.attributes].forEach(attr => {
      const name = attr.name.toLowerCase();
      if (name.startsWith('on')) { el.removeAttribute(attr.name); return; }
      if (['href', 'src', 'action', 'formaction'].includes(name) && /^\s*(javascript|vbscript):/i.test(attr.value)) {
        el.removeAttribute(attr.name);
      }
    });
  });
  return doc.body.innerHTML;
}
function isImageDevice(d) {
  return getAttr(d,'imageUrl') !== undefined ||
         getAttr(d,'image')    !== undefined ||
         getAttr(d,'imageUri') !== undefined ||
         hasCapability(d,'ImageUrl') ||
         hasCapability(d,'ImageCapture') ||
         hasCapability(d,'VideoCapture');
}
function getImageUrl(d) {
  return getAttr(d,'imageUrl') || getAttr(d,'image') || getAttr(d,'imageUri') || '';
}

// MDI icons from GitHub
const MDI_ICONS = {
  'push-button': '<svg viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,5A7,7 0 0,1 19,12A7,7 0 0,1 12,19A7,7 0 0,1 5,12A7,7 0 0,1 12,5M12,8A4,4 0 0,0 8,12A4,4 0 0,0 12,16A4,4 0 0,0 16,12A4,4 0 0,0 12,8" /></svg>',
  'speedometer': '<svg viewBox="0 0 24 24"><path d="M12,16A3,3 0 0,1 9,13C9,11.88 9.61,10.9 10.5,10.39L20.21,4.77L14.68,14.35C14.18,15.33 13.17,16 12,16M12,3C13.81,3 15.5,3.5 16.97,4.32L14.87,5.53C14,5.19 13,5 12,5A8,8 0 0,0 4,13C4,15.21 4.89,17.21 6.34,18.65H6.35C6.74,19.04 6.74,19.67 6.35,20.06C5.96,20.45 5.32,20.45 4.93,20.07V20.07C3.12,18.26 2,15.76 2,13A10,10 0 0,1 12,3M22,13C22,15.76 20.88,18.26 19.07,20.07V20.07C18.68,20.45 18.05,20.45 17.66,20.06C17.27,19.67 17.27,19.04 17.66,18.65V18.65C19.11,17.2 20,15.21 20,13C20,12 19.81,11 19.46,10.1L20.67,8C21.5,9.5 22,11.18 22,13Z" /></svg>',
  'speedometer-medium': '<svg viewBox="0 0 24 24"><path d="M12 1.38L9.14 12.06C8.8 13.1 9.04 14.29 9.86 15.12C11.04 16.29 12.94 16.29 14.11 15.12C14.9 14.33 15.16 13.2 14.89 12.21M14.6 3.35L15.22 5.68C18.04 6.92 20 9.73 20 13C20 15.21 19.11 17.21 17.66 18.65H17.65C17.26 19.04 17.26 19.67 17.65 20.06C18.04 20.45 18.68 20.45 19.07 20.07C20.88 18.26 22 15.76 22 13C22 8.38 18.86 4.5 14.6 3.35M9.4 3.36C5.15 4.5 2 8.4 2 13C2 15.76 3.12 18.26 4.93 20.07C5.32 20.45 5.95 20.45 6.34 20.06C6.73 19.67 6.73 19.04 6.34 18.65C4.89 17.2 4 15.21 4 13C4 9.65 5.94 6.86 8.79 5.65" /></svg>',
  'speedometer-slow': '<svg viewBox="0 0 24 24"><path d="M12 16C13.66 16 15 14.66 15 13C15 11.88 14.39 10.9 13.5 10.39L3.79 4.77L9.32 14.35C9.82 15.33 10.83 16 12 16M12 3C10.19 3 8.5 3.5 7.03 4.32L9.13 5.53C10 5.19 11 5 12 5C16.42 5 20 8.58 20 13C20 15.21 19.11 17.21 17.66 18.65H17.65C17.26 19.04 17.26 19.67 17.65 20.06C18.04 20.45 18.68 20.45 19.07 20.07C20.88 18.26 22 15.76 22 13C22 7.5 17.5 3 12 3M2 13C2 15.76 3.12 18.26 4.93 20.07C5.32 20.45 5.95 20.45 6.34 20.06C6.73 19.67 6.73 19.04 6.34 18.65C4.89 17.2 4 15.21 4 13C4 12 4.19 11 4.54 10.1L3.33 8C2.5 9.5 2 11.18 2 13Z" /></svg>',
  'gauge': '<svg viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12C20,14.4 19,16.5 17.3,18C15.9,16.7 14,16 12,16C10,16 8.2,16.7 6.7,18C5,16.5 4,14.4 4,12A8,8 0 0,1 12,4M14,5.89C13.62,5.9 13.26,6.15 13.1,6.54L11.81,9.77L11.71,10C11,10.13 10.41,10.6 10.14,11.26C9.73,12.29 10.23,13.45 11.26,13.86C12.29,14.27 13.45,13.77 13.86,12.74C14.12,12.08 14,11.32 13.57,10.76L13.67,10.5L14.96,7.29L14.97,7.26C15.17,6.75 14.92,6.17 14.41,5.96C14.28,5.91 14.15,5.89 14,5.89M10,6A1,1 0 0,0 9,7A1,1 0 0,0 10,8A1,1 0 0,0 11,7A1,1 0 0,0 10,6M7,9A1,1 0 0,0 6,10A1,1 0 0,0 7,11A1,1 0 0,0 8,10A1,1 0 0,0 7,9M17,9A1,1 0 0,0 16,10A1,1 0 0,0 17,11A1,1 0 0,0 18,10A1,1 0 0,0 17,9Z" /></svg>',
  'gauge-empty': '<svg viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12C4,14.4 5,16.5 6.7,18C8.1,16.7 10,16 12,16C14,16 15.8,16.7 17.3,18C19,16.5 20,14.4 20,12A8,8 0 0,0 12,4M14,6A1,1 0 0,1 15,7A1,1 0 0,1 14,8A1,1 0 0,1 13,7A1,1 0 0,1 14,6M10,6A1,1 0 0,1 11,7A1,1 0 0,1 10,8A1,1 0 0,1 9,7A1,1 0 0,1 10,6M6.91,8.94C7.04,8.94 7.16,8.97 7.3,9L10.5,10.32L10.77,10.43C11.33,10 12.09,9.88 12.75,10.15C13.77,10.56 14.27,11.73 13.85,12.75C13.44,13.77 12.27,14.27 11.25,13.85C10.59,13.59 10.12,13 10,12.28L9.77,12.18L6.55,10.88L6.53,10.87C6,10.66 5.77,10.08 5.97,9.56C6.13,9.18 6.5,8.93 6.91,8.94V8.94M17,9A1,1 0 0,1 18,10A1,1 0 0,1 17,11A1,1 0 0,1 16,10A1,1 0 0,1 17,9Z" /></svg>',
  'gauge-full': '<svg viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M12,4A8,8 0 0,1 20,12C20,14.4 19,16.5 17.3,18C15.9,16.7 14,16 12,16C10,16 8.2,16.7 6.7,18C5,16.5 4,14.4 4,12A8,8 0 0,1 12,4M10,6A1,1 0 0,0 9,7A1,1 0 0,0 10,8A1,1 0 0,0 11,7A1,1 0 0,0 10,6M14,6A1,1 0 0,0 13,7A1,1 0 0,0 14,8A1,1 0 0,0 15,7A1,1 0 0,0 14,6M17.09,8.94C16.96,8.94 16.84,8.97 16.7,9L13.5,10.32L13.23,10.43C12.67,10 11.91,9.88 11.25,10.15C10.23,10.56 9.73,11.73 10.15,12.75C10.56,13.77 11.73,14.27 12.75,13.85C13.41,13.59 13.88,13 14,12.28L14.23,12.18L17.45,10.88L17.47,10.87C18,10.66 18.23,10.08 18.03,9.56C17.87,9.18 17.5,8.93 17.09,8.94M7,9A1,1 0 0,0 6,10A1,1 0 0,0 7,11A1,1 0 0,0 8,10A1,1 0 0,0 7,9Z" /></svg>',
  'gauge-low': '<svg viewBox="0 0 24 24"><path d="M12,2A10,10 0 0,1 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12A10,10 0 0,1 12,2M12,4A8,8 0 0,0 4,12C4,14.4 5,16.5 6.7,18C8.1,16.7 10,16 12,16C14,16 15.8,16.7 17.3,18C19,16.5 20,14.4 20,12A8,8 0 0,0 12,4M10,5.89C10.38,5.9 10.74,6.15 10.9,6.54L12.19,9.77L12.29,10C13,10.13 13.59,10.6 13.86,11.26C14.27,12.29 13.77,13.45 12.74,13.86C11.71,14.27 10.55,13.77 10.14,12.74C9.88,12.08 10,11.32 10.43,10.76L10.33,10.5L9.04,7.29L9.03,7.26C8.83,6.75 9.08,6.17 9.59,5.96C9.72,5.91 9.85,5.89 10,5.89V5.89M14,6A1,1 0 0,1 15,7A1,1 0 0,1 14,8A1,1 0 0,1 13,7A1,1 0 0,1 14,6M17,9A1,1 0 0,1 18,10A1,1 0 0,1 17,11A1,1 0 0,1 16,10A1,1 0 0,1 17,9M7,9A1,1 0 0,1 8,10A1,1 0 0,1 7,11A1,1 0 0,1 6,10A1,1 0 0,1 7,9Z" /></svg>',
  'fan': '<svg viewBox="0 0 24 24"><path d="M12,11A1,1 0 0,0 11,12A1,1 0 0,0 12,13A1,1 0 0,0 13,12A1,1 0 0,0 12,11M12.5,2C17,2 17.11,5.57 14.75,6.75C13.76,7.24 13.32,8.29 13.13,9.22C13.61,9.42 14.03,9.73 14.35,10.13C18.05,8.13 22.03,8.92 22.03,12.5C22.03,17 18.46,17.1 17.28,14.73C16.78,13.74 15.72,13.3 14.79,13.11C14.59,13.59 14.28,14 13.88,14.34C15.87,18.03 15.08,22 11.5,22C7,22 6.91,18.42 9.27,17.24C10.25,16.75 10.69,15.71 10.89,14.79C10.4,14.59 9.97,14.27 9.65,13.87C5.96,15.85 2,15.07 2,11.5C2,7 5.56,6.89 6.74,9.26C7.24,10.25 8.29,10.68 9.22,10.87C9.41,10.39 9.73,9.97 10.14,9.65C8.15,5.96 8.94,2 12.5,2Z" /></svg>',
  'fan-off': '<svg viewBox="0 0 24 24"><path d="M12.5,2C9.64,2 8.57,4.55 9.29,7.47L15,13.16C15.87,13.37 16.81,13.81 17.28,14.73C18.46,17.1 22.03,17 22.03,12.5C22.03,8.92 18.05,8.13 14.35,10.13C14.03,9.73 13.61,9.42 13.13,9.22C13.32,8.29 13.76,7.24 14.75,6.75C17.11,5.57 17,2 12.5,2M3.28,4L2,5.27L4.47,7.73C3.22,7.74 2,8.87 2,11.5C2,15.07 5.96,15.85 9.65,13.87C9.97,14.27 10.4,14.59 10.89,14.79C10.69,15.71 10.25,16.75 9.27,17.24C6.91,18.42 7,22 11.5,22C13.8,22 14.94,20.36 14.94,18.21L18.73,22L20,20.72L3.28,4Z" /></svg>',
  'fan-speed-1': '<svg viewBox="0 0 24 24"><path d="M13 19C13 17.59 13.5 16.3 14.3 15.28C14.17 14.97 14.03 14.65 13.86 14.34C14.26 14 14.57 13.59 14.77 13.11C15.26 13.21 15.78 13.39 16.25 13.67C17.07 13.25 18 13 19 13C20.05 13 21.03 13.27 21.89 13.74C21.95 13.37 22 12.96 22 12.5C22 8.92 18.03 8.13 14.33 10.13C14 9.73 13.59 9.42 13.11 9.22C13.3 8.29 13.74 7.24 14.73 6.75C17.09 5.57 17 2 12.5 2C8.93 2 8.14 5.96 10.13 9.65C9.72 9.97 9.4 10.39 9.21 10.87C8.28 10.68 7.23 10.25 6.73 9.26C5.56 6.89 2 7 2 11.5C2 15.07 5.95 15.85 9.64 13.87C9.96 14.27 10.39 14.59 10.88 14.79C10.68 15.71 10.24 16.75 9.26 17.24C6.9 18.42 7 22 11.5 22C12.31 22 13 21.78 13.5 21.41C13.19 20.67 13 19.86 13 19M12 13C11.43 13 11 12.55 11 12S11.43 11 12 11C12.54 11 13 11.45 13 12S12.54 13 12 13M17 15V17H18V23H20V15H17Z" /></svg>',
  'fan-speed-2': '<svg viewBox="0 0 24 24"><path d="M13 19C13 17.59 13.5 16.3 14.3 15.28C14.17 14.97 14.03 14.65 13.86 14.34C14.26 14 14.57 13.59 14.77 13.11C15.26 13.21 15.78 13.39 16.25 13.67C17.07 13.25 18 13 19 13C20.05 13 21.03 13.27 21.89 13.74C21.95 13.37 22 12.96 22 12.5C22 8.92 18.03 8.13 14.33 10.13C14 9.73 13.59 9.42 13.11 9.22C13.3 8.29 13.74 7.24 14.73 6.75C17.09 5.57 17 2 12.5 2C8.93 2 8.14 5.96 10.13 9.65C9.72 9.97 9.4 10.39 9.21 10.87C8.28 10.68 7.23 10.25 6.73 9.26C5.56 6.89 2 7 2 11.5C2 15.07 5.95 15.85 9.64 13.87C9.96 14.27 10.39 14.59 10.88 14.79C10.68 15.71 10.24 16.75 9.26 17.24C6.9 18.42 7 22 11.5 22C12.31 22 13 21.78 13.5 21.41C13.19 20.67 13 19.86 13 19M12 13C11.43 13 11 12.55 11 12S11.43 11 12 11C12.54 11 13 11.45 13 12S12.54 13 12 13M16 15V17H19V18H18C16.9 18 16 18.9 16 20V23H21V21H18V20H19C20.11 20 21 19.11 21 18V17C21 15.9 20.11 15 19 15H16Z" /></svg>',
  'fan-speed-3': '<svg viewBox="0 0 24 24"><path d="M13 19C13 17.59 13.5 16.3 14.3 15.28C14.17 14.97 14.03 14.65 13.86 14.34C14.26 14 14.57 13.59 14.77 13.11C15.26 13.21 15.78 13.39 16.25 13.67C17.07 13.25 18 13 19 13C20.05 13 21.03 13.27 21.89 13.74C21.95 13.37 22 12.96 22 12.5C22 8.92 18.03 8.13 14.33 10.13C14 9.73 13.59 9.42 13.11 9.22C13.3 8.29 13.74 7.24 14.73 6.75C17.09 5.57 17 2 12.5 2C8.93 2 8.14 5.96 10.13 9.65C9.72 9.97 9.4 10.39 9.21 10.87C8.28 10.68 7.23 10.25 6.73 9.26C5.56 6.89 2 7 2 11.5C2 15.07 5.95 15.85 9.64 13.87C9.96 14.27 10.39 14.59 10.88 14.79C10.68 15.71 10.24 16.75 9.26 17.24C6.9 18.42 7 22 11.5 22C12.31 22 13 21.78 13.5 21.41C13.19 20.67 13 19.86 13 19M12 13C11.43 13 11 12.55 11 12S11.43 11 12 11C12.54 11 13 11.45 13 12S12.54 13 12 13M21 21V20.5C21 19.67 20.33 19 19.5 19C20.33 19 21 18.33 21 17.5V17C21 15.89 20.1 15 19 15H16V17H19V18H17V20H19V21H16V23H19C20.11 23 21 22.11 21 21" /></svg>',
  'ceiling-fan': '<svg viewBox="0 0 24 24"><path d="M8 3V5H11V10.27C10.38 10.63 10 11.29 10 12V13H14V12C14 11.29 13.62 10.63 13 10.27V5H16V3H8M6 12C3.79 12 2 12.67 2 13.5S3.79 15 6 15 10 14.33 10 13.5 8.21 12 6 12M18 12C15.79 12 14 12.67 14 13.5S15.79 15 18 15 22 14.33 22 13.5 20.21 12 18 12M10 14V15C10 15.72 10.38 16.38 11 16.73C11.62 17.09 12.38 17.09 13 16.73C13.62 16.38 14 15.71 14 15V14H10Z" /></svg>',
  'ceiling-fan-light': '<svg viewBox="0 0 24 24"><path d="M8 3V5H11V10.27C10.38 10.63 10 11.29 10 12V13H14V12C14 11.29 13.62 10.63 13 10.27V5H16V3H8M6 12C3.79 12 2 12.67 2 13.5C2 14.33 3.79 15 6 15S10 14.33 10 13.5C10 12.67 8.21 12 6 12M18 12C15.79 12 14 12.67 14 13.5C14 14.33 15.79 15 18 15S22 14.33 22 13.5C22 12.67 20.21 12 18 12M10 14V15C10 15.72 10.38 16.38 11 16.73C11.62 17.09 12.38 17.09 13 16.73C13.62 16.38 14 15.71 14 15V14H10M13 19V22H11V19H13M15.88 16.46L18 18.59L16.59 20L14.47 17.88L15.88 16.46M9.54 17.88L7.41 20L6 18.59L8.12 16.47L9.54 17.88" /></svg>',
  'weather-windy': '<svg viewBox="0 0 24 24"><path d="M4,10A1,1 0 0,1 3,9A1,1 0 0,1 4,8H12A2,2 0 0,0 14,6A2,2 0 0,0 12,4C11.45,4 10.95,4.22 10.59,4.59C10.2,5 9.56,5 9.17,4.59C8.78,4.2 8.78,3.56 9.17,3.17C9.9,2.45 10.9,2 12,2A4,4 0 0,1 16,6A4,4 0 0,1 12,10H4M19,12A1,1 0 0,0 20,11A1,1 0 0,0 19,10C18.72,10 18.47,10.11 18.29,10.29C17.9,10.68 17.27,10.68 16.88,10.29C16.5,9.9 16.5,9.27 16.88,8.88C17.42,8.34 18.17,8 19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14H5A1,1 0 0,1 4,13A1,1 0 0,1 5,12H19M18,18H4A1,1 0 0,1 3,17A1,1 0 0,1 4,16H18A3,3 0 0,1 21,19A3,3 0 0,1 18,22C17.17,22 16.42,21.66 15.88,21.12C15.5,20.73 15.5,20.1 15.88,19.71C16.27,19.32 16.9,19.32 17.29,19.71C17.47,19.89 17.72,20 18,20A1,1 0 0,0 19,19A1,1 0 0,0 18,18Z" /></svg>',
  'lock': '<svg viewBox="0 0 24 24"><path d="M12,17A2,2 0 0,0 14,15C14,13.89 13.1,13 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V10C4,8.89 4.9,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" /></svg>',
  'lock-open': '<svg viewBox="0 0 24 24"><path d="M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V10A2,2 0 0,1 6,8H15V6A3,3 0 0,0 12,3A3,3 0 0,0 9,6H7A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,17A2,2 0 0,0 14,15A2,2 0 0,0 12,13A2,2 0 0,0 10,15A2,2 0 0,0 12,17Z" /></svg>',
  'lock-outline': '<svg viewBox="0 0 24 24"><path d="M12,17C10.89,17 10,16.1 10,15C10,13.89 10.89,13 12,13A2,2 0 0,1 14,15A2,2 0 0,1 12,17M18,20V10H6V20H18M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V10C4,8.89 4.89,8 6,8H7V6A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,3A3,3 0 0,0 9,6V8H15V6A3,3 0 0,0 12,3Z" /></svg>',
  'lock-open-outline': '<svg viewBox="0 0 24 24"><path d="M18,20V10H6V20H18M18,8A2,2 0 0,1 20,10V20A2,2 0 0,1 18,22H6C4.89,22 4,21.1 4,20V10A2,2 0 0,1 6,8H15V6A3,3 0 0,0 12,3A3,3 0 0,0 9,6H7A5,5 0 0,1 12,1A5,5 0 0,1 17,6V8H18M12,17A2,2 0 0,1 10,15A2,2 0 0,1 12,13A2,2 0 0,1 14,15A2,2 0 0,1 12,17Z" /></svg>',
  'lock-alert': '<svg viewBox="0 0 24 24"><path d="M10 17C11.1 17 12 16.1 12 15C12 13.9 11.1 13 10 13C8.9 13 8 13.9 8 15S8.9 17 10 17M16 8C17.1 8 18 8.9 18 10V20C18 21.1 17.1 22 16 22H4C2.9 22 2 21.1 2 20V10C2 8.9 2.9 8 4 8H5V6C5 3.2 7.2 1 10 1S15 3.2 15 6V8H16M10 3C8.3 3 7 4.3 7 6V8H13V6C13 4.3 11.7 3 10 3M22 13H20V7H22V13M22 17H20V15H22V17Z" /></svg>',
  'lock-clock': '<svg viewBox="0 0 24 24"><path d="M8.5,2C6,2 4,4 4,6.5V7C2.89,7 2,7.89 2,9V18C2,19.11 2.89,20 4,20H8.72C10.18,21.29 12.06,22 14,22A8,8 0 0,0 22,14A8,8 0 0,0 14,6C13.66,6 13.32,6.03 13,6.08C12.76,3.77 10.82,2 8.5,2M8.5,4A2.5,2.5 0 0,1 11,6.5V7H6V6.5A2.5,2.5 0 0,1 8.5,4M14,8A6,6 0 0,1 20,14A6,6 0 0,1 14,20A6,6 0 0,1 8,14A6,6 0 0,1 14,8M13,10V15L16.64,17.19L17.42,15.9L14.5,14.15V10H13Z" /></svg>',
  'lock-question': '<svg viewBox="0 0 24 24"><path d="M12,1A5,5 0 0,0 7,6V8H6A2,2 0 0,0 4,10V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V10A2,2 0 0,0 18,8H17V6A5,5 0 0,0 12,1M12,2.9C13.71,2.9 15.1,4.29 15.1,6V8H8.9V6C8.9,4.29 10.29,2.9 12,2.9M12.19,10.5C13.13,10.5 13.88,10.71 14.42,11.12C14.96,11.54 15.23,12.1 15.23,12.8C15.23,13.24 15.08,13.63 14.79,14C14.5,14.36 14.12,14.64 13.66,14.85C13.4,15 13.23,15.15 13.14,15.32C13.05,15.5 13,15.72 13,16H11C11,15.5 11.1,15.16 11.29,14.92C11.5,14.68 11.84,14.4 12.36,14.08C12.62,13.94 12.83,13.76 13,13.54C13.14,13.33 13.22,13.08 13.22,12.8C13.22,12.5 13.13,12.28 12.95,12.11C12.77,11.93 12.5,11.85 12.19,11.85C11.92,11.85 11.7,11.92 11.5,12.06C11.34,12.2 11.24,12.41 11.24,12.69H9.27C9.22,12 9.5,11.4 10.05,11.04C10.59,10.68 11.3,10.5 12.19,10.5M11,17H13V19H11V17Z" /></svg>',
  'lock-smart': '<svg viewBox="0 0 24 24"><path d="M12,2A6,6 0 0,0 6,8V16A6,6 0 0,0 12,22A6,6 0 0,0 18,16V8A6,6 0 0,0 12,2M8,6H10V8H8V6M11,6H13V8H11V6M14,6H16V8H14V6M8,9H10V11H8V9M11,9H13V11H11V9M14,9H16V11H14V9M8,12H10V14H8V12M11,12H13V14H11V12M14,12H16V14H14V12M12,16A2,2 0 0,1 14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18A2,2 0 0,1 12,16Z" /></svg>',
  'key': '<svg viewBox="0 0 24 24"><path d="M7 14C5.9 14 5 13.1 5 12S5.9 10 7 10 9 10.9 9 12 8.1 14 7 14M12.6 10C11.8 7.7 9.6 6 7 6C3.7 6 1 8.7 1 12S3.7 18 7 18C9.6 18 11.8 16.3 12.6 14H16V18H20V14H23V10H12.6Z" /></svg>',
  'key-variant': '<svg viewBox="0 0 24 24"><path d="M22,18V22H18V19H15V16H12L9.74,13.74C9.19,13.91 8.61,14 8,14A6,6 0 0,1 2,8A6,6 0 0,1 8,2A6,6 0 0,1 14,8C14,8.61 13.91,9.19 13.74,9.74L22,18M7,5A2,2 0 0,0 5,7A2,2 0 0,0 7,9A2,2 0 0,0 9,7A2,2 0 0,0 7,5Z" /></svg>',
  'garage': '<svg viewBox="0 0 24 24"><path d="M19,20H17V11H7V20H5V9L12,5L19,9V20M8,12H16V14H8V12M8,15H16V17H8V15M16,18V20H8V18H16Z" /></svg>',
  'garage-open': '<svg viewBox="0 0 24 24"><path d="M19,20H17V11H7V20H5V9L12,5L19,9V20M8,12H16V14H8V12Z" /></svg>',
  'garage-alert': '<svg viewBox="0 0 24 24"><path d="M17,20H15V11H5V20H3V9L10,5L17,9V20M6,12H14V14H6V12M6,15H14V17H6V15M19,15V10H21V15H19M19,19V17H21V19H19Z" /></svg>',
  'garage-variant': '<svg viewBox="0 0 24 24"><path d="M22 9V20H20V11H4V20H2V9L12 5L22 9M19 12H5V14H19V12M19 18H5V20H19V18M19 15H5V17H19V15Z" /></svg>',
  'garage-variant-lock': '<svg viewBox="0 0 24 24"><path d="M21.8 16V14.5C21.8 13.1 20.4 12 19 12S16.2 13.1 16.2 14.5V16C15.6 16 15 16.6 15 17.2V20.7C15 21.4 15.6 22 16.2 22H21.7C22.4 22 23 21.4 23 20.8V17.3C23 16.6 22.4 16 21.8 16M20.5 16H17.5V14.5C17.5 13.7 18.2 13.2 19 13.2S20.5 13.7 20.5 14.5V16M5 12H15.04C14.61 12.59 14.35 13.27 14.26 14H5V12M16.06 11H4V20H2V9L12 5L22 9V11.04C21.17 10.4 20.13 10 19 10C17.9 10 16.88 10.39 16.06 11M13 20H5V18H13V20M5 15H13.95C13.42 15.54 13.08 16.24 13 17H5V15Z" /></svg>',
  'lightbulb': '<svg viewBox="0 0 24 24"><path d="M12,2A7,7 0 0,0 5,9C5,11.38 6.19,13.47 8,14.74V17A1,1 0 0,0 9,18H15A1,1 0 0,0 16,17V14.74C17.81,13.47 19,11.38 19,9A7,7 0 0,0 12,2M9,21A1,1 0 0,0 10,22H14A1,1 0 0,0 15,21V20H9V21Z" /></svg>',
  'lightbulb-on': '<svg viewBox="0 0 24 24"><path d="M12,6A6,6 0 0,1 18,12C18,14.22 16.79,16.16 15,17.2V19A1,1 0 0,1 14,20H10A1,1 0 0,1 9,19V17.2C7.21,16.16 6,14.22 6,12A6,6 0 0,1 12,6M14,21V22A1,1 0 0,1 13,23H11A1,1 0 0,1 10,22V21H14M20,11H23V13H20V11M1,11H4V13H1V11M13,1V4H11V1H13M4.92,3.5L7.05,5.64L5.63,7.05L3.5,4.93L4.92,3.5M16.95,5.63L19.07,3.5L20.5,4.93L18.37,7.05L16.95,5.63Z" /></svg>',
  'lightbulb-outline': '<svg viewBox="0 0 24 24"><path d="M12,2A7,7 0 0,1 19,9C19,11.38 17.81,13.47 16,14.74V17A1,1 0 0,1 15,18H9A1,1 0 0,1 8,17V14.74C6.19,13.47 5,11.38 5,9A7,7 0 0,1 12,2M9,21V20H15V21A1,1 0 0,1 14,22H10A1,1 0 0,1 9,21M12,4A5,5 0 0,0 7,9C7,11.05 8.23,12.81 10,13.58V16H14V13.58C15.77,12.81 17,11.05 17,9A5,5 0 0,0 12,4Z" /></svg>',
  'lightbulb-on-outline': '<svg viewBox="0 0 24 24"><path d="M20,11H23V13H20V11M1,11H4V13H1V11M13,1V4H11V1H13M4.92,3.5L7.05,5.64L5.63,7.05L3.5,4.93L4.92,3.5M16.95,5.63L19.07,3.5L20.5,4.93L18.37,7.05L16.95,5.63M12,6A6,6 0 0,1 18,12C18,14.22 16.79,16.16 15,17.2V19A1,1 0 0,1 14,20H10A1,1 0 0,1 9,19V17.2C7.21,16.16 6,14.22 6,12A6,6 0 0,1 12,6M14,21V22A1,1 0 0,1 13,23H11A1,1 0 0,1 10,22V21H14M11,18H13V15.87C14.73,15.43 16,13.86 16,12A4,4 0 0,0 12,8A4,4 0 0,0 8,12C8,13.86 9.27,15.43 11,15.87V18Z" /></svg>',
  'lightbulb-group': '<svg viewBox="0 0 24 24"><path d="M15 14V16A1 1 0 0 1 14 17H10A1 1 0 0 1 9 16V14A5 5 0 1 1 15 14M14 18H10V19A1 1 0 0 0 11 20H13A1 1 0 0 0 14 19M7 19V18H5V19A1 1 0 0 0 6 20H7.17A2.93 2.93 0 0 1 7 19M5 10A6.79 6.79 0 0 1 5.68 7A4 4 0 0 0 4 14.45V16A1 1 0 0 0 5 17H7V14.88A6.92 6.92 0 0 1 5 10M17 18V19A2.93 2.93 0 0 1 16.83 20H18A1 1 0 0 0 19 19V18M18.32 7A6.79 6.79 0 0 1 19 10A6.92 6.92 0 0 1 17 14.88V17H19A1 1 0 0 0 20 16V14.45A4 4 0 0 0 18.32 7Z" /></svg>',
  'lightbulb-multiple': '<svg viewBox="0 0 24 24"><path d="M17 16V18C17 18.55 16.53 19 16 19H12C11.42 19 11 18.55 11 18V16C8.77 14.34 8.32 11.21 10 9S14.77 6.34 17 8 19.63 12.79 18 15C17.69 15.38 17.35 15.72 17 16M16 20H12V21C12 21.55 12.42 22 13 22H15C15.53 22 16 21.55 16 21M7.66 15H7V16C7 16.55 7.42 17 8 17H9V16.88C8.44 16.33 8 15.7 7.66 15M13.58 5C12.46 2.47 9.5 1.33 7 2.45S3.31 6.5 4.43 9.04C4.77 9.81 5.3 10.5 6 11V13C6 13.55 6.42 14 7 14H7.28C7.07 13.35 6.97 12.68 7 12C6.97 8.29 9.87 5.21 13.58 5Z" /></svg>',
  'lightbulb-cfl': '<svg viewBox="0 0 24 24"><path d="M10.5 2C11.88 2 13 3.12 13 4.5V14H14V4.47C14 3.56 13.63 2.7 13 2.05C13.17 2 13.33 2 13.5 2C14.88 2 16 3.12 16 4.5V14H17V17C17 17.55 16.55 18 16 18H8C7.45 18 7 17.55 7 17V14H8V4.5C8 3.12 9.12 2 10.5 2M10.5 4C10.22 4 10 4.22 10 4.5V14H11V4.5C11 4.22 10.78 4 10.5 4M9 20H15V21C15 21.55 14.55 22 14 22H10C9.45 22 9 21.55 9 21V20Z" /></svg>',
  'ceiling-light': '<svg viewBox="0 0 24 24"><path d="M8,9H11V4H13V9H16L20,17H4L8,9M14,18A2,2 0 0,1 12,20A2,2 0 0,1 10,18H14Z" /></svg>',
  'track-light': '<svg viewBox="0 0 24 24"><path d="M6,1V3H9V6.4L4.11,4.38L1.43,10.84L6.97,13.14L11.94,16.82L13.79,17.59L17.62,8.35L15.77,7.58L11,6.87V3H14V1H6M21.81,6.29L19.5,7.25L20.26,9.1L22.57,8.14L21.81,6.29M19.78,13.57L19,15.42L21.79,16.57L22.55,14.72L19.78,13.57M16.19,18.93L14.34,19.69L15.3,22L17.15,21.23L16.19,18.93Z" /></svg>',
  'wall-sconce': '<svg viewBox="0 0 24 24"><path d="M11,4L7,13H19L15,4H11M4,14V22H6V19H14V14H12V17H6V14H4Z" /></svg>',
  'floor-lamp': '<svg viewBox="0 0 24 24"><path d="M15,2L17,9H7L9,2M11,10H13V20H16V22H8V20H11V10Z" /></svg>',
  'led-strip-variant': '<svg viewBox="0 0 24 24"><path d="M2.95 3L2 6.91L19.34 11.25L20.29 7.34L2.95 3M6.09 6.89L4.16 6.41L4.64 4.46L6.57 4.94L6.09 6.89M9.94 7.86L8 7.38L8.5 5.42L10.42 5.91L9.94 7.86M13.8 8.82L11.87 8.34L12.35 6.39L14.27 6.87L13.8 8.82M17.65 9.79L15.72 9.31L16.2 7.35L18.13 7.84L17.65 9.79M4.66 12.75L3.71 16.66L21.05 21L22 17.1L4.66 12.75M7.8 16.65L5.88 16.16L6.35 14.21L8.28 14.69L7.8 16.65M11.65 17.61L9.73 17.13L10.2 15.18L12.13 15.66L11.65 17.61M15.5 18.58L13.58 18.09L14.06 16.14L16 16.62L15.5 18.58M19.36 19.54L17.43 19.06L17.91 17.11L19.84 17.59L19.36 19.54M6.25 12.11L11 10.2L17.75 11.89L13 13.8L6.25 12.11Z" /></svg>',
  'spotlight': '<svg viewBox="0 0 24 24"><path d="M2,6L7.09,8.55C6.4,9.5 6,10.71 6,12C6,13.29 6.4,14.5 7.09,15.45L2,18V6M6,3H18L15.45,7.09C14.5,6.4 13.29,6 12,6C10.71,6 9.5,6.4 8.55,7.09L6,3M22,6V18L16.91,15.45C17.6,14.5 18,13.29 18,12C18,10.71 17.6,9.5 16.91,8.55L22,6M18,21H6L8.55,16.91C9.5,17.6 10.71,18 12,18C13.29,18 14.5,17.6 15.45,16.91L18,21M12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12A4,4 0 0,1 12,8M12,10A2,2 0 0,0 10,12A2,2 0 0,0 12,14A2,2 0 0,0 14,12A2,2 0 0,0 12,10Z" /></svg>',
  'toggle-switch': '<svg viewBox="0 0 24 24"><path d="M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M17,15A3,3 0 0,1 14,12A3,3 0 0,1 17,9A3,3 0 0,1 20,12A3,3 0 0,1 17,15Z" /></svg>',
  'toggle-switch-off': '<svg viewBox="0 0 24 24"><path d="M17,7H7A5,5 0 0,0 2,12A5,5 0 0,0 7,17H17A5,5 0 0,0 22,12A5,5 0 0,0 17,7M7,15A3,3 0 0,1 4,12A3,3 0 0,1 7,9A3,3 0 0,1 10,12A3,3 0 0,1 7,15Z" /></svg>',
  'toggle-switch-outline': '<svg viewBox="0 0 24 24"><path d="M17 6H7C3.69 6 1 8.69 1 12S3.69 18 7 18H17C20.31 18 23 15.31 23 12S20.31 6 17 6M17 16H7C4.79 16 3 14.21 3 12S4.79 8 7 8H17C19.21 8 21 9.79 21 12S19.21 16 17 16M17 9C15.34 9 14 10.34 14 12S15.34 15 17 15 20 13.66 20 12 18.66 9 17 9Z" /></svg>',
  'toggle-switch-off-outline': '<svg viewBox="0 0 24 24"><path d="M17 6H7c-3.31 0-6 2.69-6 6s2.69 6 6 6h10c3.31 0 6-2.69 6-6s-2.69-6-6-6zm0 10H7c-2.21 0-4-1.79-4-4s1.79-4 4-4h10c2.21 0 4 1.79 4 4s-1.79 4-4 4zM7 9c-1.66 0-3 1.34-3 3s1.34 3 3 3 3-1.34 3-3-1.34-3-3-3z" /></svg>',
  'light-switch': '<svg viewBox="0 0 24 24"><path d="M8 6V18H16V6H8M14 10H10V8H14V10M19.4 1.6C19 1.2 18.5 1 18 1H6C5.5 1 5 1.2 4.6 1.6C4.2 2 4 2.5 4 3V21C4 21.5 4.2 22 4.6 22.4C5 22.8 5.5 23 6 23H18C18.5 23 19 22.8 19.4 22.4C19.8 22 20 21.5 20 21V3C20 2.5 19.8 2 19.4 1.6M18 21H6V3H18V21Z" /></svg>',
  'power-plug': '<svg viewBox="0 0 24 24"><path d="M16,7V3H14V7H10V3H8V7H8C7,7 6,8 6,9V14.5L9.5,18V21H14.5V18L18,14.5V9C18,8 17,7 16,7Z" /></svg>',
  'power-plug-off': '<svg viewBox="0 0 24 24"><path d="M20.84 22.73L15.31 17.2L14.5 18V21H9.5V18L6 14.5V9C6 8.7 6.1 8.41 6.25 8.14L1.11 3L2.39 1.73L22.11 21.46L20.84 22.73M18 14.5V9C18 8 17 7 16 7V3H14V7H10.2L17.85 14.65L18 14.5M10 3H8V4.8L10 6.8V3Z" /></svg>',
  'power-socket-us': '<svg viewBox="0 0 24 24"><path d="M8,7H10V12H8V7M4.22,2H19.78C21,2 22,3 22,4.22V19.78A2.22,2.22 0 0,1 19.78,22H4.22C3,22 2,21 2,19.78V4.22A2.22,2.22 0 0,1 4.22,2M12,4A8,8 0 0,0 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12A8,8 0 0,0 12,4M14,7.5H16V11.5H14V7.5M10.5,16.25A1.5,1.5 0 0,1 12,14.75A1.5,1.5 0 0,1 13.5,16.25V17H10.5V16.25Z" /></svg>',
  'valve': '<svg viewBox="0 0 24 24"><path d="M4 22H2V2H4M22 2H20V22H22M17.24 5.34L13.24 9.34A3 3 0 0 0 9.24 13.34L5.24 17.34L6.66 18.76L10.66 14.76A3 3 0 0 0 14.66 10.76L18.66 6.76Z" /></svg>',
  'valve-closed': '<svg viewBox="0 0 24 24"><path d="M22 2V22H20V13H14.82A3 3 0 0 1 9.18 13H4V22H2V2H4V11H9.18A3 3 0 0 1 14.82 11H20V2Z" /></svg>',
  'water-pump': '<svg viewBox="0 0 24 24"><path d="M19,14.5C19,14.5 21,16.67 21,18A2,2 0 0,1 19,20A2,2 0 0,1 17,18C17,16.67 19,14.5 19,14.5M5,18V9A2,2 0 0,1 3,7A2,2 0 0,1 5,5V4A2,2 0 0,1 7,2H9A2,2 0 0,1 11,4V5H19A2,2 0 0,1 21,7V9L21,11A1,1 0 0,1 22,12A1,1 0 0,1 21,13H17A1,1 0 0,1 16,12A1,1 0 0,1 17,11V9H11V18H12A2,2 0 0,1 14,20V22H2V20A2,2 0 0,1 4,18H5Z" /></svg>',
  'pipe': '<svg viewBox="0 0 24 24"><path d="M22,14H20V16H14V13H16V11H14V6A2,2 0 0,0 12,4H4V2H2V10H4V8H10V11H8V13H10V18A2,2 0 0,0 12,20H20V22H22" /></svg>',
  'pipe-valve': '<svg viewBox="0 0 24 24"><path d="M22 13V21H20V19H16.58C15.81 20.76 14.05 22 12 22S8.19 20.76 7.42 19H4V21H2V13H4V15H7.43C7.93 13.85 8.85 12.93 10 12.42V11H8V9H16V11H14V12.42C15.15 12.93 16.07 13.85 16.57 15H20V13H22M17 2H7C6.45 2 6 2.45 6 3S6.45 4 7 4H10V5H11V8H13V5H14V4H17C17.55 4 18 3.55 18 3S17.55 2 17 2Z" /></svg>',
  'door': '<svg viewBox="0 0 24 24"><path d="M8,3C6.89,3 6,3.89 6,5V21H18V5C18,3.89 17.11,3 16,3H8M8,5H16V19H8V5M13,11V13H15V11H13Z" /></svg>',
  'door-closed': '<svg viewBox="0 0 24 24"><path d="M16,11H18V13H16V11M12,3H19C20.11,3 21,3.89 21,5V19H22V21H2V19H10V5C10,3.89 10.89,3 12,3M12,5V19H19V5H12Z" /></svg>',
  'door-open': '<svg viewBox="0 0 24 24"><path d="M12,3C10.89,3 10,3.89 10,5H3V19H2V21H22V19H21V5C21,3.89 20.11,3 19,3H12M12,5H19V19H12V5M5,11H7V13H5V11Z" /></svg>',
  'window-open': '<svg viewBox="0 0 24 24"><path d="M6,8H10V6H14V8H18V4H6V8M18,10H6V15H18V10M6,20H18V17H6V20M6,2H18A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2Z" /></svg>',
  'window-closed': '<svg viewBox="0 0 24 24"><path d="M6,11H10V9H14V11H18V4H6V11M18,13H6V20H18V13M6,2H18A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2Z" /></svg>',
  'window-shutter': '<svg viewBox="0 0 24 24"><path d="M3 4H21V8H19V20H17V8H7V20H5V8H3V4M8 9H16V11H8V9M8 12H16V14H8V12M8 15H16V17H8V15M8 18H16V20H8V18Z" /></svg>',
  'window-shutter-open': '<svg viewBox="0 0 24 24"><path d="M3 4H21V8H19V20H17V8H7V20H5V8H3V4M8 9H16V11H8V9Z" /></svg>',
  'window-shutter-cog': '<svg viewBox="0 0 24 24"><path d="M21.7 18.6V17.6L22.8 16.8C22.9 16.7 23 16.6 22.9 16.5L21.9 14.8C21.9 14.7 21.7 14.7 21.6 14.7L20.4 15.2C20.1 15 19.8 14.8 19.5 14.7L19.3 13.4C19.3 13.3 19.2 13.2 19.1 13.2H17.1C16.9 13.2 16.8 13.3 16.8 13.4L16.6 14.7C16.3 14.9 16.1 15 15.8 15.2L14.6 14.7C14.5 14.7 14.4 14.7 14.3 14.8L13.3 16.5C13.3 16.6 13.3 16.7 13.4 16.8L14.5 17.6V18.6L13.4 19.4C13.3 19.5 13.2 19.6 13.3 19.7L14.3 21.4C14.4 21.5 14.5 21.5 14.6 21.5L15.8 21C16 21.2 16.3 21.4 16.6 21.5L16.8 22.8C16.9 22.9 17 23 17.1 23H19.1C19.2 23 19.3 22.9 19.3 22.8L19.5 21.5C19.8 21.3 20 21.2 20.3 21L21.5 21.4C21.6 21.4 21.7 21.4 21.8 21.3L22.8 19.6C22.9 19.5 22.9 19.4 22.8 19.4L21.7 18.6M18 19.5C17.2 19.5 16.5 18.8 16.5 18S17.2 16.5 18 16.5 19.5 17.2 19.5 18 18.8 19.5 18 19.5M8 9H16V11H8V9M17 8H7V20H5V8H3V4H21V8H19V11.1C18.7 11.1 18.3 11 18 11S17.3 11 17 11.1V8M11.3 20H8V18H11C11 18.7 11.1 19.4 11.3 20M8 12H14.4C13.6 12.5 12.8 13.2 12.3 14H8V12M8 15H11.7C11.4 15.6 11.2 16.3 11.1 17H8V15Z" /></svg>',
  'blinds': '<svg viewBox="0 0 24 24"><path d="M3,2H21A1,1 0 0,1 22,3V5A1,1 0 0,1 21,6H20V13A1,1 0 0,1 19,14H13V16.17C14.17,16.58 15,17.69 15,19A3,3 0 0,1 12,22A3,3 0 0,1 9,19C9,17.69 9.83,16.58 11,16.17V14H5A1,1 0 0,1 4,13V6H3A1,1 0 0,1 2,5V3A1,1 0 0,1 3,2M12,18A1,1 0 0,0 11,19A1,1 0 0,0 12,20A1,1 0 0,0 13,19A1,1 0 0,0 12,18Z" /></svg>',
  'blinds-open': '<svg viewBox="0 0 24 24"><path d="M3 2H21C21.55 2 22 2.45 22 3V5C22 5.55 21.55 6 21 6H20V7C20 7.55 19.55 8 19 8H13V10.17C14.17 10.58 15 11.7 15 13C15 14.66 13.66 16 12 16C10.34 16 9 14.66 9 13C9 11.69 9.84 10.58 11 10.17V8H5C4.45 8 4 7.55 4 7V6H3C2.45 6 2 5.55 2 5V3C2 2.45 2.45 2 3 2M12 12C11.45 12 11 12.45 11 13C11 13.55 11.45 14 12 14C12.55 14 13 13.55 13 13C13 12.45 12.55 12 12 12Z" /></svg>',
  'curtains': '<svg viewBox="0 0 24 24"><path d="M23 3H1V1H23V3M2 22H6C6 19 4 17 4 17C10 13 11 4 11 4H2V22M22 4H13C13 4 14 13 20 17C20 17 18 19 18 22H22V4Z" /></svg>',
  'curtains-closed': '<svg viewBox="0 0 24 24"><path d="M23 3H1V1H23V3M2 22H11V4H2V22M22 4H13V22H22V4Z" /></svg>',
  'thermometer': '<svg viewBox="0 0 24 24"><path d="M15 13V5A3 3 0 0 0 9 5V13A5 5 0 1 0 15 13M12 4A1 1 0 0 1 13 5V8H11V5A1 1 0 0 1 12 4Z" /></svg>',
  'thermostat': '<svg viewBox="0 0 24 24"><path d="M16.95,16.95L14.83,14.83C15.55,14.1 16,13.1 16,12C16,11.26 15.79,10.57 15.43,10L17.6,7.81C18.5,9 19,10.43 19,12C19,13.93 18.22,15.68 16.95,16.95M12,5C13.57,5 15,5.5 16.19,6.4L14,8.56C13.43,8.21 12.74,8 12,8A4,4 0 0,0 8,12C8,13.1 8.45,14.1 9.17,14.83L7.05,16.95C5.78,15.68 5,13.93 5,12A7,7 0 0,1 12,5M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12C22,6.47 17.5,2 12,2Z" /></svg>',
  'thermostat-box': '<svg viewBox="0 0 24 24"><path d="M5,3A2,2 0 0,0 3,5V19A2,2 0 0,0 5,21H19A2,2 0 0,0 21,19V5C21,3.89 20.1,3 19,3H5M12,5C13.57,5 15,5.5 16.19,6.4L14,8.56C13.43,8.21 12.74,8 12,8A4,4 0 0,0 8,12C8,13.1 8.45,14.1 9.17,14.83L7.05,16.95C5.78,15.68 5,13.93 5,12A7,7 0 0,1 12,5M17.6,7.81C18.5,9 19,10.43 19,12C19,13.93 18.22,15.68 16.95,16.95L14.83,14.83C15.55,14.1 16,13.1 16,12C16,11.26 15.79,10.57 15.43,10L17.6,7.81Z" /></svg>',
  'snowflake': '<svg viewBox="0 0 24 24"><path d="M11 2V6.66L8.11 3.78L6.7 5.19L11 9.5V11H9.5L5.19 6.7L3.78 8.11L6.66 11H2V13H6.66L3.78 15.89L5.19 17.3L9.5 13H11V14.5L6.7 18.81L8.11 20.22L11 17.34V22H13V17.34L15.89 20.22L17.3 18.81L13 14.5V13H14.5L18.81 17.3L20.22 15.89L17.34 13H22V11H17.34L20.22 8.11L18.81 6.7L14.5 11H13V9.5L17.3 5.19L15.89 3.78L13 6.66V2H11Z" /></svg>',
  'water-percent': '<svg viewBox="0 0 24 24"><path d="M12,3.25C12,3.25 6,10 6,14C6,17.32 8.69,20 12,20A6,6 0 0,0 18,14C18,10 12,3.25 12,3.25M14.47,9.97L15.53,11.03L9.53,17.03L8.47,15.97M9.75,10A1.25,1.25 0 0,1 11,11.25A1.25,1.25 0 0,1 9.75,12.5A1.25,1.25 0 0,1 8.5,11.25A1.25,1.25 0 0,1 9.75,10M14.25,14.5A1.25,1.25 0 0,1 15.5,15.75A1.25,1.25 0 0,1 14.25,17A1.25,1.25 0 0,1 13,15.75A1.25,1.25 0 0,1 14.25,14.5Z" /></svg>',
  'water-alert': '<svg viewBox="0 0 24 24"><path d="M10 3.25C10 3.25 16 10 16 14C16 17.31 13.31 20 10 20S4 17.31 4 14C4 10 10 3.25 10 3.25M20 7V13H18V7H20M18 17H20V15H18V17Z" /></svg>',
  'motion-sensor': '<svg viewBox="0 0 24 24"><path d="M10,0.2C9,0.2 8.2,1 8.2,2C8.2,3 9,3.8 10,3.8C11,3.8 11.8,3 11.8,2C11.8,1 11,0.2 10,0.2M15.67,1A7.33,7.33 0 0,0 23,8.33V7A6,6 0 0,1 17,1H15.67M18.33,1C18.33,3.58 20.42,5.67 23,5.67V4.33C21.16,4.33 19.67,2.84 19.67,1H18.33M21,1A2,2 0 0,0 23,3V1H21M7.92,4.03C7.75,4.03 7.58,4.06 7.42,4.11L2,5.8V11H3.8V7.33L5.91,6.67L2,22H3.8L6.67,13.89L9,17V22H10.8V15.59L8.31,11.05L9.04,8.18L10.12,10H15V8.2H11.38L9.38,4.87C9.08,4.37 8.54,4.03 7.92,4.03Z" /></svg>',
  'motion-sensor-off': '<svg viewBox="0 0 24 24"><path d="M11.4 8.2H15V10H13.2L11.4 8.2M19.67 1H18.33C18.33 3.58 20.42 5.67 23 5.67V4.33C21.16 4.33 19.67 2.84 19.67 1M21 1C21 2.11 21.9 3 23 3V1H21M17 1H15.67C15.67 5.05 18.95 8.33 23 8.33V7C19.69 7 17 4.31 17 1M10 3.8C11 3.8 11.8 3 11.8 2S11 .2 10 .2 8.2 1 8.2 2 9 3.8 10 3.8M2.39 1.73L1.11 3L3.46 5.35L2 5.8V11H3.8V7.33L5.05 6.94L5.68 7.57L2 22H3.8L6.67 13.89L9 17V22H10.8V15.59L8.31 11.05L8.5 10.37L20.84 22.73L22.11 21.46L2.39 1.73M9.38 4.87C9.08 4.37 8.54 4.03 7.92 4.03C7.75 4.03 7.58 4.06 7.42 4.11L7.34 4.14L11.35 8.15L9.38 4.87Z" /></svg>',
  'smoke-detector': '<svg viewBox="0 0 24 24"><path d="M12,18A6,6 0 0,0 18,12C18,8.68 15.31,6 12,6C8.68,6 6,8.68 6,12A6,6 0 0,0 12,18M19,3A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5C3.89,21 3,20.1 3,19V5C3,3.89 3.89,3 5,3H19M8,12A4,4 0 0,1 12,8A4,4 0 0,1 16,12A4,4 0 0,1 12,16A4,4 0 0,1 8,12Z" /></svg>',
  'smoke-detector-alert': '<svg viewBox="0 0 24 24"><path d="M10 18C13.3 18 16 15.3 16 12C16 8.7 13.3 6 10 6C6.7 6 4 8.7 4 12C4 15.3 6.7 18 10 18M17 3C18.1 3 19 3.9 19 5V19C19 20.1 18.1 21 17 21H3C1.9 21 1 20.1 1 19V5C1 3.9 1.9 3 3 3H17M6 12C6 9.8 7.8 8 10 8S14 9.8 14 12 12.2 16 10 16 6 14.2 6 12M23 7H21V13H23V8M23 15H21V17H23V15Z" /></svg>',
  'fire': '<svg viewBox="0 0 24 24"><path d="M17.66 11.2C17.43 10.9 17.15 10.64 16.89 10.38C16.22 9.78 15.46 9.35 14.82 8.72C13.33 7.26 13 4.85 13.95 3C13 3.23 12.17 3.75 11.46 4.32C8.87 6.4 7.85 10.07 9.07 13.22C9.11 13.32 9.15 13.42 9.15 13.55C9.15 13.77 9 13.97 8.8 14.05C8.57 14.15 8.33 14.09 8.14 13.93C8.08 13.88 8.04 13.83 8 13.76C6.87 12.33 6.69 10.28 7.45 8.64C5.78 10 4.87 12.3 5 14.47C5.06 14.97 5.12 15.47 5.29 15.97C5.43 16.57 5.7 17.17 6 17.7C7.08 19.43 8.95 20.67 10.96 20.92C13.1 21.19 15.39 20.8 17.03 19.32C18.86 17.66 19.5 15 18.56 12.72L18.43 12.46C18.22 12 17.66 11.2 17.66 11.2M14.5 17.5C14.22 17.74 13.76 18 13.4 18.1C12.28 18.5 11.16 17.94 10.5 17.28C11.69 17 12.4 16.12 12.61 15.23C12.78 14.43 12.46 13.77 12.33 13C12.21 12.26 12.23 11.63 12.5 10.94C12.69 11.32 12.89 11.7 13.13 12C13.9 13 15.11 13.44 15.37 14.8C15.41 14.94 15.43 15.08 15.43 15.23C15.46 16.05 15.1 16.95 14.5 17.5H14.5Z" /></svg>',
  'gas-cylinder': '<svg viewBox="0 0 24 24"><path d="M16,9V14L16,20A2,2 0 0,1 14,22H10A2,2 0 0,1 8,20V14L8,9C8,7.14 9.27,5.57 11,5.13V4H9V2H15V4H13V5.13C14.73,5.57 16,7.14 16,9Z" /></svg>',
  'shield-home': '<svg viewBox="0 0 24 24"><path d="M11,13H13V16H16V11H18L12,6L6,11H8V16H11V13M12,1L21,5V11C21,16.55 17.16,21.74 12,23C6.84,21.74 3,16.55 3,11V5L12,1Z" /></svg>',
  'shield-alert': '<svg viewBox="0 0 24 24"><path d="M12,1L3,5V11C3,16.55 6.84,21.74 12,23C17.16,21.74 21,16.55 21,11V5M11,7H13V13H11M11,15H13V17H11" /></svg>',
  'alarm-light': '<svg viewBox="0 0 24 24"><path d="M6,6.9L3.87,4.78L5.28,3.37L7.4,5.5L6,6.9M13,1V4H11V1H13M20.13,4.78L18,6.9L16.6,5.5L18.72,3.37L20.13,4.78M4.5,10.5V12.5H1.5V10.5H4.5M19.5,10.5H22.5V12.5H19.5V10.5M6,20H18A2,2 0 0,1 20,22H4A2,2 0 0,1 6,20M12,5A6,6 0 0,1 18,11V19H6V11A6,6 0 0,1 12,5Z" /></svg>',
  'alarm-light-outline': '<svg viewBox="0 0 24 24"><path d="M6,6.9L3.87,4.78L5.28,3.37L7.4,5.5L6,6.9M13,1V4H11V1H13M20.13,4.78L18,6.9L16.6,5.5L18.72,3.37L20.13,4.78M4.5,10.5V12.5H1.5V10.5H4.5M19.5,10.5H22.5V12.5H19.5V10.5M6,20H18A2,2 0 0,1 20,22H4A2,2 0 0,1 6,20M12,5A6,6 0 0,1 18,11V19H6V11A6,6 0 0,1 12,5M12,7A4,4 0 0,0 8,11V17H16V11A4,4 0 0,0 12,7Z" /></svg>',
  'bell': '<svg viewBox="0 0 24 24"><path d="M21,19V20H3V19L5,17V11C5,7.9 7.03,5.17 10,4.29C10,4.19 10,4.1 10,4A2,2 0 0,1 12,2A2,2 0 0,1 14,4C14,4.1 14,4.19 14,4.29C16.97,5.17 19,7.9 19,11V17L21,19M14,21A2,2 0 0,1 12,23A2,2 0 0,1 10,21" /></svg>',
  'bell-alert': '<svg viewBox="0 0 24 24"><path d="M23 7V13H21V7M21 15H23V17H21M12 2A2 2 0 0 0 10 4A2 2 0 0 0 10 4.29C7.12 5.14 5 7.82 5 11V17L3 19V20H21V19L19 17V11C19 7.82 16.88 5.14 14 4.29A2 2 0 0 0 14 4A2 2 0 0 0 12 2M10 21A2 2 0 0 0 12 23A2 2 0 0 0 14 21Z" /></svg>',
  'cctv': '<svg viewBox="0 0 24 24"><path d="M6.03 12.03L8.03 15.5L5.5 18.68L2 12.62L6.03 12.03M17 18V15.29C17.88 14.9 18.5 14.03 18.5 13C18.5 12.43 18.3 11.9 17.97 11.5L19.94 10.35C20.95 9.76 21.3 8.47 20.71 7.46L19.33 5.06C18.74 4.05 17.45 3.7 16.44 4.28L8.31 9C7.36 9.53 7.03 10.75 7.58 11.71L9.08 14.31C9.63 15.26 10.86 15.59 11.81 15.04L13.69 13.96C13.94 14.55 14.41 15.03 15 15.29V18C15 19.1 15.9 20 17 20H22V18H17Z" /></svg>',
  'camera': '<svg viewBox="0 0 24 24"><path d="M4,4H7L9,2H15L17,4H20A2,2 0 0,1 22,6V18A2,2 0 0,1 20,20H4A2,2 0 0,1 2,18V6A2,2 0 0,1 4,4M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9Z" /></svg>',
  'camera-outline': '<svg viewBox="0 0 24 24"><path d="M20,4H16.83L15,2H9L7.17,4H4A2,2 0 0,0 2,6V18A2,2 0 0,0 4,20H20A2,2 0 0,0 22,18V6A2,2 0 0,0 20,4M20,18H4V6H8.05L9.88,4H14.12L15.95,6H20V18M12,7A5,5 0 0,0 7,12A5,5 0 0,0 12,17A5,5 0 0,0 17,12A5,5 0 0,0 12,7M12,15A3,3 0 0,1 9,12A3,3 0 0,1 12,9A3,3 0 0,1 15,12A3,3 0 0,1 12,15Z" /></svg>',
  'home-alert': '<svg viewBox="0 0 24 24"><path d="M12 3L2 12H5V20H19V12H22L12 3M13 18H11V16H13V18M13 14H11V8H13V14Z" /></svg>',
  'home-account': '<svg viewBox="0 0 24 24"><path d="M12,3L2,12H5V20H19V12H22L12,3M12,8.75A2.25,2.25 0 0,1 14.25,11A2.25,2.25 0 0,1 12,13.25A2.25,2.25 0 0,1 9.75,11A2.25,2.25 0 0,1 12,8.75M12,15C13.5,15 16.5,15.75 16.5,17.25V18H7.5V17.25C7.5,15.75 10.5,15 12,15Z" /></svg>',
  'home-import-outline': '<svg viewBox="0 0 24 24"><path d="M15 13L11 17V14H2V12H11V9L15 13M5 20V16H7V18H17V10.19L12 5.69L7.21 10H4.22L12 3L22 12H19V20H5Z" /></svg>',
  'account': '<svg viewBox="0 0 24 24"><path d="M12,4A4,4 0 0,1 16,8A4,4 0 0,1 12,12A4,4 0 0,1 8,8A4,4 0 0,1 12,4M12,14C16.42,14 20,15.79 20,18V20H4V18C4,15.79 7.58,14 12,14Z" /></svg>',
  'account-multiple': '<svg viewBox="0 0 24 24"><path d="M16 17V19H2V17S2 13 9 13 16 17 16 17M12.5 7.5A3.5 3.5 0 1 0 9 11A3.5 3.5 0 0 0 12.5 7.5M15.94 13A5.32 5.32 0 0 1 18 17V19H22V17S22 13.37 15.94 13M15 4A3.39 3.39 0 0 0 13.07 4.59A5 5 0 0 1 13.07 10.41A3.39 3.39 0 0 0 15 11A3.5 3.5 0 0 0 15 4Z" /></svg>',
  'sleep': '<svg viewBox="0 0 24 24"><path d="M23,12H17V10L20.39,6H17V4H23V6L19.62,10H23V12M15,16H9V14L12.39,10H9V8H15V10L11.62,14H15V16M7,20H1V18L4.39,14H1V12H7V14L3.62,18H7V20Z" /></svg>',
  'weather-night': '<svg viewBox="0 0 24 24"><path d="M17.75,4.09L15.22,6.03L16.13,9.09L13.5,7.28L10.87,9.09L11.78,6.03L9.25,4.09L12.44,4L13.5,1L14.56,4L17.75,4.09M21.25,11L19.61,12.25L20.2,14.23L18.5,13.06L16.8,14.23L17.39,12.25L15.75,11L17.81,10.95L18.5,9L19.19,10.95L21.25,11M18.97,15.95C19.8,15.87 20.69,17.05 20.16,17.8C19.84,18.25 19.5,18.67 19.08,19.07C15.17,23 8.84,23 4.94,19.07C1.03,15.17 1.03,8.83 4.94,4.93C5.34,4.53 5.76,4.17 6.21,3.85C6.96,3.32 8.14,4.21 8.06,5.04C7.79,7.9 8.75,10.87 10.95,13.06C13.14,15.26 16.1,16.22 18.97,15.95M17.33,17.97C14.5,17.81 11.7,16.64 9.53,14.5C7.36,12.31 6.2,9.5 6.04,6.68C3.23,9.82 3.34,14.64 6.35,17.66C9.37,20.67 14.19,20.78 17.33,17.97Z" /></svg>',
  'white-balance-sunny': '<svg viewBox="0 0 24 24"><path d="M3.55 19.09L4.96 20.5L6.76 18.71L5.34 17.29M12 6C8.69 6 6 8.69 6 12S8.69 18 12 18 18 15.31 18 12C18 8.68 15.31 6 12 6M20 13H23V11H20M17.24 18.71L19.04 20.5L20.45 19.09L18.66 17.29M20.45 5L19.04 3.6L17.24 5.39L18.66 6.81M13 1H11V4H13M6.76 5.39L4.96 3.6L3.55 5L5.34 6.81L6.76 5.39M1 13H4V11H1M13 20H11V23H13" /></svg>',
  'walk': '<svg viewBox="0 0 24 24"><path d="M14.12,10H19V8.2H15.38L13.38,4.87C13.08,4.37 12.54,4.03 11.92,4.03C11.74,4.03 11.58,4.06 11.42,4.11L6,5.8V11H7.8V7.33L9.91,6.67L6,22H7.8L10.67,13.89L13,17V22H14.8V15.59L12.31,11.05L13.04,8.18M14,3.8C15,3.8 15.8,3 15.8,2C15.8,1 15,0.2 14,0.2C13,0.2 12.2,1 12.2,2C12.2,3 13,3.8 14,3.8Z" /></svg>',
  'run': '<svg viewBox="0 0 24 24"><path d="M13.5,5.5C14.59,5.5 15.5,4.58 15.5,3.5C15.5,2.38 14.59,1.5 13.5,1.5C12.39,1.5 11.5,2.38 11.5,3.5C11.5,4.58 12.39,5.5 13.5,5.5M9.89,19.38L10.89,15L13,17V23H15V15.5L12.89,13.5L13.5,10.5C14.79,12 16.79,13 19,13V11C17.09,11 15.5,10 14.69,8.58L13.69,7C13.29,6.38 12.69,6 12,6C11.69,6 11.5,6.08 11.19,6.08L6,8.28V13H8V9.58L9.79,8.88L8.19,17L3.29,16L2.89,18L9.89,19.38Z" /></svg>',
  'battery': '<svg viewBox="0 0 24 24"><path d="M16.67,4H15V2H9V4H7.33A1.33,1.33 0 0,0 6,5.33V20.67C6,21.4 6.6,22 7.33,22H16.67A1.33,1.33 0 0,0 18,20.67V5.33C18,4.6 17.4,4 16.67,4Z" /></svg>',
  'battery-outline': '<svg viewBox="0 0 24 24"><path d="M16,20H8V6H16M16.67,4H15V2H9V4H7.33A1.33,1.33 0 0,0 6,5.33V20.67C6,21.4 6.6,22 7.33,22H16.67A1.33,1.33 0 0,0 18,20.67V5.33C18,4.6 17.4,4 16.67,4Z" /></svg>',
  'battery-alert': '<svg viewBox="0 0 24 24"><path d="M13 14H11V8H13M13 18H11V16H13M16.7 4H15V2H9V4H7.3C6.6 4 6 4.6 6 5.3V20.6C6 21.4 6.6 22 7.3 22H16.6C17.3 22 17.9 21.4 17.9 20.7V5.3C18 4.6 17.4 4 16.7 4Z" /></svg>',
  'wifi': '<svg viewBox="0 0 24 24"><path d="M12,21L15.6,16.2C14.6,15.45 13.35,15 12,15C10.65,15 9.4,15.45 8.4,16.2L12,21M12,3C7.95,3 4.21,4.34 1.2,6.6L3,9C5.5,7.12 8.62,6 12,6C15.38,6 18.5,7.12 21,9L22.8,6.6C19.79,4.34 16.05,3 12,3M12,9C9.3,9 6.81,9.89 4.8,11.4L6.6,13.8C8.1,12.67 9.97,12 12,12C14.03,12 15.9,12.67 17.4,13.8L19.2,11.4C17.19,9.89 14.7,9 12,9Z" /></svg>',
  'wifi-off': '<svg viewBox="0 0 24 24"><path d="M2.28,3L1,4.27L2.47,5.74C2.04,6 1.61,6.29 1.2,6.6L3,9C3.53,8.6 4.08,8.25 4.66,7.93L6.89,10.16C6.15,10.5 5.44,10.91 4.8,11.4L6.6,13.8C7.38,13.22 8.26,12.77 9.2,12.47L11.75,15C10.5,15.07 9.34,15.5 8.4,16.2L12,21L14.46,17.73L17.74,21L19,19.72M12,3C9.85,3 7.8,3.38 5.9,4.07L8.29,6.47C9.5,6.16 10.72,6 12,6C15.38,6 18.5,7.11 21,9L22.8,6.6C19.79,4.34 16.06,3 12,3M12,9C11.62,9 11.25,9 10.88,9.05L14.07,12.25C15.29,12.53 16.43,13.07 17.4,13.8L19.2,11.4C17.2,9.89 14.7,9 12,9Z" /></svg>',
  'water': '<svg viewBox="0 0 24 24"><path d="M12,20A6,6 0 0,1 6,14C6,10 12,3.25 12,3.25C12,3.25 18,10 18,14A6,6 0 0,1 12,20Z" /></svg>',
  'water-off': '<svg viewBox="0 0 24 24"><path d="M20.84 22.73L16.29 18.18C15.2 19.3 13.69 20 12 20C8.69 20 6 17.31 6 14C6 12.67 6.67 11.03 7.55 9.44L1.11 3L2.39 1.73L22.11 21.46L20.84 22.73M18 14C18 10 12 3.25 12 3.25S10.84 4.55 9.55 6.35L17.95 14.75C18 14.5 18 14.25 18 14Z" /></svg>',
  'radiator': '<svg viewBox="0 0 24 24"><path d="M7.95,3L6.53,5.19L7.95,7.4H7.94L5.95,10.5L4.22,9.6L5.64,7.39L4.22,5.19L6.22,2.09L7.95,3M13.95,2.89L12.53,5.1L13.95,7.3L13.94,7.31L11.95,10.4L10.22,9.5L11.64,7.3L10.22,5.1L12.22,2L13.95,2.89M20,2.89L18.56,5.1L20,7.3V7.31L18,10.4L16.25,9.5L17.67,7.3L16.25,5.1L18.25,2L20,2.89M2,22V14A2,2 0 0,1 4,12H20A2,2 0 0,1 22,14V22H20V20H4V22H2M6,14A1,1 0 0,0 5,15V17A1,1 0 0,0 6,18A1,1 0 0,0 7,17V15A1,1 0 0,0 6,14M10,14A1,1 0 0,0 9,15V17A1,1 0 0,0 10,18A1,1 0 0,0 11,17V15A1,1 0 0,0 10,14M14,14A1,1 0 0,0 13,15V17A1,1 0 0,0 14,18A1,1 0 0,0 15,17V15A1,1 0 0,0 14,14M18,14A1,1 0 0,0 17,15V17A1,1 0 0,0 18,18A1,1 0 0,0 19,17V15A1,1 0 0,0 18,14Z" /></svg>',
  'air-conditioner': '<svg viewBox="0 0 24 24"><path d="M6.59,0.66C8.93,-1.15 11.47,1.06 12.04,4.5C12.47,4.5 12.89,4.62 13.27,4.84C13.79,4.24 14.25,3.42 14.07,2.5C13.65,0.35 16.06,-1.39 18.35,1.58C20.16,3.92 17.95,6.46 14.5,7.03C14.5,7.46 14.39,7.89 14.16,8.27C14.76,8.78 15.58,9.24 16.5,9.06C18.63,8.64 20.38,11.04 17.41,13.34C15.07,15.15 12.53,12.94 11.96,9.5C11.53,9.5 11.11,9.37 10.74,9.15C10.22,9.75 9.75,10.58 9.93,11.5C10.35,13.64 7.94,15.39 5.65,12.42C3.83,10.07 6.05,7.53 9.5,6.97C9.5,6.54 9.63,6.12 9.85,5.74C9.25,5.23 8.43,4.76 7.5,4.94C5.37,5.36 3.62,2.96 6.59,0.66M5,16H7A2,2 0 0,1 9,18V24H7V22H5V24H3V18A2,2 0 0,1 5,16M5,18V20H7V18H5M12.93,16H15L12.07,24H10L12.93,16M18,16H21V18H18V22H21V24H18A2,2 0 0,1 16,22V18A2,2 0 0,1 18,16Z" /></svg>',
  'fridge': '<svg viewBox="0 0 24 24"><path d="M7,2H17A2,2 0 0,1 19,4V9H5V4A2,2 0 0,1 7,2M19,19A2,2 0 0,1 17,21V22H15V21H9V22H7V21A2,2 0 0,1 5,19V10H19V19M8,5V7H10V5H8M8,12V15H10V12H8Z" /></svg>',
  'washing-machine': '<svg viewBox="0 0 24 24"><path d="M14.83,11.17C16.39,12.73 16.39,15.27 14.83,16.83C13.27,18.39 10.73,18.39 9.17,16.83L14.83,11.17M6,2H18A2,2 0 0,1 20,4V20A2,2 0 0,1 18,22H6A2,2 0 0,1 4,20V4A2,2 0 0,1 6,2M7,4A1,1 0 0,0 6,5A1,1 0 0,0 7,6A1,1 0 0,0 8,5A1,1 0 0,0 7,4M10,4A1,1 0 0,0 9,5A1,1 0 0,0 10,6A1,1 0 0,0 11,5A1,1 0 0,0 10,4M12,8A6,6 0 0,0 6,14A6,6 0 0,0 12,20A6,6 0 0,0 18,14A6,6 0 0,0 12,8Z" /></svg>',
  'dishwasher': '<svg viewBox="0 0 24 24"><path d="M18,2H6A2,2 0 0,0 4,4V20A2,2 0 0,0 6,22H18A2,2 0 0,0 20,20V4A2,2 0 0,0 18,2M10,4A1,1 0 0,1 11,5A1,1 0 0,1 10,6A1,1 0 0,1 9,5A1,1 0 0,1 10,4M7,4A1,1 0 0,1 8,5A1,1 0 0,1 7,6A1,1 0 0,1 6,5A1,1 0 0,1 7,4M18,20H6V8H18V20M14.67,15.33C14.69,16.03 14.41,16.71 13.91,17.21C12.86,18.26 11.15,18.27 10.09,17.21C9.59,16.71 9.31,16.03 9.33,15.33C9.4,14.62 9.63,13.94 10,13.33C10.37,12.5 10.81,11.73 11.33,11L12,10C13.79,12.59 14.67,14.36 14.67,15.33" /></svg>',
  'robot-vacuum': '<svg viewBox="0 0 24 24"><path d="M12,2C14.65,2 17.19,3.06 19.07,4.93L17.65,6.35C16.15,4.85 14.12,4 12,4C9.88,4 7.84,4.84 6.35,6.35L4.93,4.93C6.81,3.06 9.35,2 12,2M3.66,6.5L5.11,7.94C4.39,9.17 4,10.57 4,12A8,8 0 0,0 12,20A8,8 0 0,0 20,12C20,10.57 19.61,9.17 18.88,7.94L20.34,6.5C21.42,8.12 22,10.04 22,12A10,10 0 0,1 12,22A10,10 0 0,1 2,12C2,10.04 2.58,8.12 3.66,6.5M12,6A6,6 0 0,1 18,12C18,13.59 17.37,15.12 16.24,16.24L14.83,14.83C14.08,15.58 13.06,16 12,16C10.94,16 9.92,15.58 9.17,14.83L7.76,16.24C6.63,15.12 6,13.59 6,12A6,6 0 0,1 12,6M12,8A1,1 0 0,0 11,9A1,1 0 0,0 12,10A1,1 0 0,0 13,9A1,1 0 0,0 12,8Z" /></svg>',
  'television': '<svg viewBox="0 0 24 24"><path d="M21,17H3V5H21M21,3H3A2,2 0 0,0 1,5V17A2,2 0 0,0 3,19H8V21H16V19H21A2,2 0 0,0 23,17V5A2,2 0 0,0 21,3Z" /></svg>',
  'speaker': '<svg viewBox="0 0 24 24"><path d="M12,12A3,3 0 0,0 9,15A3,3 0 0,0 12,18A3,3 0 0,0 15,15A3,3 0 0,0 12,12M12,20A5,5 0 0,1 7,15A5,5 0 0,1 12,10A5,5 0 0,1 17,15A5,5 0 0,1 12,20M12,4A2,2 0 0,1 14,6A2,2 0 0,1 12,8C10.89,8 10,7.1 10,6C10,4.89 10.89,4 12,4M17,2H7C5.89,2 5,2.89 5,4V20A2,2 0 0,0 7,22H17A2,2 0 0,0 19,20V4C19,2.89 18.1,2 17,2Z" /></svg>',
  'garage-lock': '<svg viewBox="0 0 24 24"><path d="M20.8 16V14.5C20.8 13.1 19.4 12 18 12S15.2 13.1 15.2 14.5V16C14.6 16 14 16.6 14 17.2V20.7C14 21.4 14.6 22 15.2 22H20.7C21.4 22 22 21.4 22 20.8V17.3C22 16.6 21.4 16 20.8 16M19.5 16H16.5V14.5C16.5 13.7 17.2 13.2 18 13.2S19.5 13.7 19.5 14.5V16M5 12H13V14H5V12M5 15H12.95C12.42 15.54 12.08 16.24 12 17H5V15M12 20H5V18H12V20M14 11H4V20H2V9L9 5L16 9V10.44C15.19 10.8 14.5 11.36 14 12.06V11Z" /></svg>',
};

function iconSvg(name) {
  return MDI_ICONS[name] || '';
}

// ── Status bar ────────────────────────────────────────────────────────────────

function updateStatusBar() {
  const bar = document.getElementById('status-bar');
  const chips = [];

  // HSM chip — clickable, opens HSM picker
  const hsm = (window.__hsmState || '').toLowerCase();
  const hsmLabel = window.__hsmState || '—';
  const hsmArmed = hsm && !hsm.includes('disarm') && hsm !== '—' && hsm !== '';
  chips.push(`<span class="status-chip ${hsmArmed ? 'hsm-armed' : 'hsm-disarmed'}" data-action="hsm-picker" title="Click to change HSM state">
    <span class="chip-dot"></span>HSM: ${escapeHtml(hsmLabel)}</span>`);

  // Mode chip — clickable, opens mode picker
  const modeName = window.__currentMode || '—';
  chips.push(`<span class="status-chip mode-chip" data-action="mode-picker" title="Click to change mode">
    ◐ Mode: ${escapeHtml(modeName)}</span>`);

  // Presence chips — every slot configured as presence type with a device
  // These are ALWAYS shown in the status bar, regardless of main dashboard visibility
  // Also includes hidden presence tiles (preserved in statusBarPresenceDevices)
  const presenceDevices = new Set();

  // Collect from active presence tiles
  for (const s of Object.values(cfg.slots)) {
    if (s.kind === 'presence' && s.deviceId) {
      presenceDevices.add(s.deviceId);
    }
  }

  // Also include presence devices from hidden tiles
  for (const deviceId of Object.keys(statusBarPresenceDevices)) {
    presenceDevices.add(deviceId);
  }

  // Render a chip for each presence device
  for (const deviceId of presenceDevices) {
    const d = findDevice(deviceId);
    if (!d) continue; // Device not found, skip
    const present = getAttr(d, 'presence');
    if (present === undefined) continue; // No presence attribute, skip

    // Get label from: active slot → saved statusBarPresenceDevices → device name/label → deviceId
    let label = '';

    // Try active presence slot first
    for (const s of Object.values(cfg.slots)) {
      if (s.deviceId === deviceId && s.kind === 'presence' && s.label) {
        label = s.label;
        break;
      }
    }

    // Try saved statusBarPresenceDevices label
    if (!label && statusBarPresenceDevices[deviceId]?.label) {
      label = statusBarPresenceDevices[deviceId].label;
    }

    // Fall back to device's own label/name
    if (!label && d) {
      label = d.label || d.name || '';
    }

    // Last resort: use deviceId
    if (!label) {
      label = deviceId;
    }

    const isPresent = present === 'present';
    chips.push(`<span class="status-chip ${isPresent ? 'presence-home' : 'presence-away'}">
      <span class="chip-dot"></span>${escapeHtml(label)}: ${isPresent ? 'Home' : 'Away'}</span>`);
  }

  bar.innerHTML = chips.join('');

  // Bind click actions for clickable chips
  bar.querySelectorAll('[data-action]').forEach(el => {
    el.addEventListener('click', () => {
      if (el.dataset.action === 'hsm-picker')  showHsmPicker();
      if (el.dataset.action === 'mode-picker') showModePicker();
    });
  });
}

// ── View routing ──────────────────────────────────────────────────────────────

function navigate(view) {
  if (view === currentView) return;
  currentView = view;
  history.replaceState(null, '', `#${view === 'main' ? '' : view}`);
  renderView();
}

function renderView() {
  const isMain     = currentView === 'main';
  const isDynamic  = currentView.startsWith('dynamic/');
  const isCustom   = currentView.startsWith('custom/');

  document.getElementById('view-main').style.display    = isMain    ? '' : 'none';
  document.getElementById('view-dynamic').style.display = isDynamic ? '' : 'none';
  document.getElementById('view-custom').style.display  = isCustom  ? '' : 'none';

  document.getElementById('dash-title').textContent = isMain ? (cfg.title || 'Home') : '';

  if (isDynamic) {
    const key = currentView.replace('dynamic/', '');
    renderDynamicDashboard(key);
  }
  if (isCustom) {
    const name = currentView.replace('custom/', '');
    renderCustomDashboard(name);
  }

  updateNavChips();
}

function readHash() {
  const h = location.hash.replace(/^#\/?/, '') || 'main';
  currentView = h || 'main';
}

window.addEventListener('hashchange', () => {
  readHash();
  renderView();
});

// ── Nav chips ─────────────────────────────────────────────────────────────────

// Does this auto-generated group currently match any device? Used to keep empty
// groups out of the nav bar. Derived from `devices` on every render rather than
// stored, so it self-corrects as devices are added or reclassified — note that
// `devices` is empty until refreshDevices() returns, which is why boot() calls
// updateNavChips() again afterwards.
function dynamicGroupHasDevices(key) {
  const group = DYNAMIC_GROUPS.find(g => g.key === key);
  if (!group) return false;
  // Not .some(group.match) — some() passes (value, index, array) and a stray
  // index argument is exactly the kind of thing that silently changes a match.
  return devices.some(d => group.match(d));
}

function updateNavChips() {
  const nav = document.getElementById('dash-nav');
  const chips = [];

  // Build list of all dashboards with their keys
  const allDashboards = [
    { key: 'main', label: 'Main', kind: 'main', viewPath: 'main' },
    ...DYNAMIC_GROUPS.map(g => ({ key: g.key, label: g.label, kind: 'dynamic', viewPath: 'dynamic/' + g.key })),
    ...Object.entries(customDashboards).map(([name, dash]) =>
      ({ key: 'custom/' + name, label: dash.title || name, kind: 'custom', viewPath: 'custom/' + name }))
  ];

  // Initialize defaults if empty (first load, or after Reset Everything).
  // EVERYTHING starts visible, dynamic groups included. They used to default to
  // hidden ("opt-in"), which meant a fresh or wiped config showed only Main and
  // the "auto-generated dashboards" settings box came up unchecked — so the
  // groups the dashboard generates for you were invisible until you went
  // looking for a checkbox you had no reason to know existed. Empty groups are
  // handled at render time below, not by hiding all of them up front.
  if (!dashboardsOrder.length) {
    dashboardsOrder = allDashboards.map(d => d.key);
    dashboardsVisible = {};
    allDashboards.forEach(d => { dashboardsVisible[d.key] = true; });
  }

  // Add new dashboards to the order list if they don't exist
  for (const d of allDashboards) {
    if (!dashboardsOrder.includes(d.key)) {
      dashboardsOrder.push(d.key);
      dashboardsVisible[d.key] = true; // New dashboards visible by default
    }
  }

  // Render chips in stored order, skipping hidden ones
  for (const key of dashboardsOrder) {
    if (dashboardsVisible[key] === false) continue; // Skip hidden dashboards
    const dashboard = allDashboards.find(d => d.key === key);
    if (!dashboard) continue; // Skip if dashboard not found (e.g., deleted custom dashboard)

    // A dynamic group with no matching devices would be a chip leading to an
    // empty dashboard — "Shades" on a hub with no shades. Now that these
    // default to visible, filter the empty ones HERE rather than persisting
    // them as hidden: this is derived from the current device list, so a group
    // appears by itself when a matching device shows up and never leaves a
    // stale `false` in config that would keep it hidden afterwards. The
    // Dashboard Manager still lists every group, so they stay toggleable.
    if (dashboard.kind === 'dynamic' && !dynamicGroupHasDevices(key)) continue;

    const isActive = currentView === dashboard.viewPath;
    const cls = `nav-chip ${dashboard.kind}${isActive ? ' active' : ''}`;
    chips.push(`<span class="${cls}" data-view="${dashboard.viewPath}">${escapeHtml(dashboard.label)}</span>`);
  }

  nav.innerHTML = chips.join('');
  nav.classList.add('visible');

  nav.querySelectorAll('[data-view]').forEach(el => {
    el.addEventListener('click', () => navigate(el.dataset.view));
  });
}

// ── Main dashboard layout ─────────────────────────────────────────────────────

function buildLayout() {
  applyCssVars();
  const layout = getLayout();

  // Grid sections
  ['row1','row2','row3','row-bottom'].forEach(sectionId => {
    const container = document.getElementById(sectionId);
    if (!container) return;
    const ids = layout[sectionId] || LAYOUT_DEFAULTS[sectionId] || [];
    container.innerHTML = ids.map(id => slotHtml(id, sectionId)).join('') +
      `<div class="tile-add" data-add-section="${sectionId}">+</div>`;
  });

  // Cameras column
  const camContainer = document.getElementById('cameras');
  if (camContainer) {
    const ids = layout['cameras'] || LAYOUT_DEFAULTS['cameras'] || [];
    camContainer.innerHTML = ids.map(id => slotHtml(id, 'cameras')).join('') +
      `<div class="tile-add" data-add-section="cameras">+</div>`;
  }

  // Right column
  const rightContainer = document.getElementById('right-col');
  if (rightContainer) {
    const ids = layout['right-col'] || LAYOUT_DEFAULTS['right-col'] || [];
    rightContainer.innerHTML = ids.map(id => slotHtml(id, 'right-col')).join('') +
      `<div class="tile-add" data-add-section="right-col">+</div>`;
  }

  // Bind events
  document.querySelectorAll('[data-slot]').forEach(el => {
    el.addEventListener('click', onTileClick);
    bindDragEvents(el, el.dataset.section);
    bindResizeHandle(el, el.dataset.slot);
  });
  document.querySelectorAll('.tile-remove').forEach(el => {
    el.addEventListener('click', onRemoveTile);
  });
  document.querySelectorAll('[data-add-section]').forEach(el => {
    el.addEventListener('click', () => onAddTile(el.dataset.addSection));
  });
}

function slotHtml(slotId, sectionId) {
  const s = cfg.slots[slotId] || {};
  const rowSpan = s.rowSpan || 1;
  // Convert user colSpan to CSS span units (doubled grid)
  const cssSpan = colToSpan(s.colSpan);
  const colAttr = cssSpan !== 2 ? ` data-col="${cssSpan}"` : '';
  const rowAttr = rowSpan > 1 ? ` data-row="${rowSpan}"` : '';

  if (s.kind === 'image') {
    const orient = s.imageOrientation === 'portrait' ? ' portrait' : '';
    // rowAttr belongs here too. It was computed above and then only used by the
    // regular-tile branch below, so an image tile's rowSpan was stored in config
    // and never reached the DOM — a 3-row camera rendered identically to a
    // 1-row one. The CSS has always had .image-tile[data-row=…] rules, and the
    // custom-dashboard renderer has always emitted both attributes.
    return `<div class="image-tile${orient}" data-slot="${slotId}" data-section="${sectionId}"${colAttr}${rowAttr}>
      <div class="image-empty">${escapeHtml(s.label || slotId)}</div>
      <span class="image-edit" data-edit="${slotId}">⋮</span>
      <div class="resize-handle" data-resize="${slotId}"></div>
    </div>`;
  }

  return `<div class="tile" data-slot="${slotId}" data-section="${sectionId}"${colAttr}${rowAttr}>
    <button class="tile-remove" data-slot="${slotId}" title="Hide tile">×</button>
    <span class="tile-edit" data-edit="${slotId}">⋮</span>
    <span class="tile-battery" data-field="battery"></span>
    <span class="tile-label"  data-field="label">${escapeHtml(s.label || slotId)}</span>
    <span class="tile-value"  data-field="value"></span>
    <span class="tile-drag-handle" title="Drag to reorder">⠿</span>
    <div class="resize-handle" data-resize="${slotId}"></div>
  </div>`;
}

// ── Tile rendering ────────────────────────────────────────────────────────────

function renderTile(slotId, force) {
  const el = document.querySelector(`[data-slot="${slotId}"]`);
  if (!el) return;
  const s = cfg.slots[slotId] || {};
  const d = s.deviceId ? findDevice(s.deviceId) : null;

  if (s.kind === 'hidden') { el.classList.add('hidden'); return; }
  el.classList.remove('hidden');

  if (s.kind === 'image') {
    if (!el.classList.contains('image-tile')) {
      // Shell changed from non-image to image — rebuild
      const sectionId = el.dataset.section || '';
      el.outerHTML = slotHtml(slotId, sectionId);
      const newEl = document.querySelector(`[data-slot="${slotId}"]`);
      if (newEl) { newEl.addEventListener('click', onTileClick); bindDragEvents(newEl, sectionId); }
      return renderTile(slotId);
    }
    // Portrait class
    el.classList.toggle('portrait', s.imageOrientation === 'portrait');

    const rawUrl = d ? getImageUrl(d) : s.url || '';

    if (rawUrl) {
      // Respect the refresh interval the device itself declares.
      // Hubitat's Virtual Image driver uses 'refreshRate' in seconds (SetRefreshRateInSeconds).
      // Generic fallbacks ('refreshInterval', 'pollInterval') are also treated as seconds.
      let refreshMs = 0; // 0 = refresh every poll cycle
      if (d) {
        const rateMin = getAttr(d, 'refreshRate');
        if (rateMin != null) {
          const parsed = parseFloat(rateMin);
          if (!isNaN(parsed) && parsed > 0) refreshMs = parsed * 1000; // seconds → ms
        } else {
          const rateSecAttr = getAttr(d, 'refreshInterval') ?? getAttr(d, 'pollInterval');
          if (rateSecAttr != null) {
            const parsed = parseFloat(rateSecAttr);
            if (!isNaN(parsed) && parsed > 0) refreshMs = parsed * 1000; // seconds → ms
          }
        }
      }

      const existingImg = el.querySelector('img');
      const now = Date.now();
      const last = imageLastRefreshed[slotId] || 0;
      const due = force || !existingImg || refreshMs === 0 || (now - last >= refreshMs);

      if (due) {
        imageLastRefreshed[slotId] = now;
        // Cache-bust so the browser re-fetches even when the raw URL hasn't changed.
        const busted = rawUrl + (rawUrl.includes('?') ? '&' : '?') + '_t=' + now;
        if (existingImg) {
          existingImg.src = busted;
          const lbl = el.querySelector('.image-label');
          if (lbl) lbl.textContent = s.label || '';
        } else {
          // The resize handle must be re-emitted here. slotHtml() puts one in
          // the shell, but this innerHTML replaces the shell's children on the
          // first render that has an image to show — so the handle vanished
          // before the user ever saw it, and image tiles could not be resized
          // at all even where the grid supports it.
          el.innerHTML = `
            <img src="${escapeHtml(busted)}" alt="">
            <span class="image-label">${escapeHtml(s.label || '')}</span>
            <span class="image-edit" data-edit="${slotId}">⋮</span>
            <div class="resize-handle" data-resize="${slotId}"></div>`;
          // Replacing innerHTML discarded the handle buildLayout() had bound,
          // so the new one needs its listener. (bindResizeHandle no-ops outside
          // a .section, which is what keeps camera tiles handle-free.)
          bindResizeHandle(el, slotId);
        }
      }
      const imgEl = el.querySelector('img');
      if (imgEl) imgEl.style.objectFit = s.imageFit === 'contain' ? 'contain' : 'cover';
    } else {
      el.innerHTML = `
        <div class="image-empty">${escapeHtml(s.label || slotId)} (unmapped)</div>
        <span class="image-edit" data-edit="${slotId}">⋮</span>
        <div class="resize-handle" data-resize="${slotId}"></div>`;
      bindResizeHandle(el, slotId);
    }
    return;
  }

  // If shell was previously an image tile, rebuild as regular tile
  if (el.classList.contains('image-tile')) {
    const sectionId = el.dataset.section || '';
    el.outerHTML = slotHtml(slotId, sectionId);
    const newEl = document.querySelector(`[data-slot="${slotId}"]`);
    if (newEl) {
      newEl.addEventListener('click', onTileClick);
      newEl.querySelector('.tile-remove')?.addEventListener('click', onRemoveTile);
      bindDragEvents(newEl, sectionId);
    }
    return renderTile(slotId);
  }

  // Reset classes
  el.className = 'tile';
  if (el.dataset.section) el.dataset.section = el.dataset.section; // preserve
  const labelEl   = el.querySelector('[data-field="label"]');
  const valueEl   = el.querySelector('[data-field="value"]');
  const batteryEl = el.querySelector('[data-field="battery"]');
  if (labelEl)   labelEl.textContent  = s.label || slotId;
  if (valueEl)   { valueEl.textContent = ''; valueEl.className = 'tile-value'; }
  if (batteryEl) batteryEl.textContent = '';

  if (s.style === 'flat') el.classList.add('flat');
  else if (s.style === 'info') el.classList.add('info');

  switch (s.kind) {
    case 'dashboard-link':
      if (!s.style || s.style === 'auto') el.classList.add('info');
      break;
    case 'hsm': {
      const state = window.__hsmState || '—';
      if (valueEl) valueEl.textContent = state;
      const armed = state && state !== 'disarmed' && state !== '—';
      if (armed) el.classList.add('active');
      break;
    }
    case 'mode':
      if (valueEl) valueEl.textContent = window.__currentMode || '—';
      break;
    case 'switch': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const on = getAttr(d, 'switch') === 'on';
      if (s.style !== 'flat' && on) el.classList.add('active');
      const swIcon = (on ? s.iconOn : s.iconOff) || s.icon || (on ? 'toggle-switch' : 'toggle-switch-off');
      if (valueEl) valueEl.innerHTML = `${iconSvg(swIcon)}<span>${on ? 'On' : 'Off'}</span>`;
      break;
    }
    case 'bulb': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const on = getAttr(d, 'switch') === 'on';
      const level = getAttr(d, 'level');
      if (s.style !== 'flat' && on) el.classList.add('active');
      const levelStr = on && level != null ? `${level}%` : (on ? 'On' : 'Off');
      if (valueEl) valueEl.innerHTML = `${iconSvg(s.icon || 'lightbulb')}<span>${levelStr}</span>`;
      break;
    }
    case 'presence': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const presenceVal = getAttr(d, 'presence');
      const isSleep = getAttr(d, 'sleeping') === 'sleeping';
      if (presenceVal === 'present' && !isSleep) el.classList.add('active');
      let icon, text;
      if (presenceVal === 'present' && isSleep) {
        icon = iconSvg(s.icon || 'sleep');
        text = 'Sleep';
      } else if (presenceVal === 'present') {
        icon = iconSvg(s.icon || 'home-account');
        text = 'Home';
      } else {
        icon = iconSvg(s.icon || 'door-open');
        text = 'Away';
      }
      if (valueEl) valueEl.innerHTML = `${icon}<span>${text}</span>`;
      break;
    }
    case 'lock': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const lk = getAttr(d, 'lock');
      const battery = getAttr(d, 'battery');
      const locked = lk === 'locked';
      if (locked) el.classList.add('active');
      else if (lk === 'unlocked') el.classList.add('alert');
      if (batteryEl && battery != null) batteryEl.textContent = `${battery}%`;
      const lockIcon = (locked ? s.iconOn : s.iconOff) || s.icon || (locked ? 'lock' : 'lock-open');
      if (valueEl) valueEl.innerHTML = `${iconSvg(lockIcon)}<span>${lk || '—'}</span>`;
      break;
    }
    case 'garage': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const door = getAttr(d, 'door') || getAttr(d, 'contact');
      const isOpen = door === 'open' || door === 'opening';
      el.classList.remove('active', 'alert');
      el.classList.add(isOpen ? 'alert' : 'active');
      const garageIcon = (isOpen ? s.iconOn : s.iconOff) || s.icon || (isOpen ? 'garage-open' : 'garage');
      if (valueEl) valueEl.innerHTML = `${iconSvg(garageIcon)}<span>${door || '—'}</span>`;
      break;
    }
    case 'contact': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const c = getAttr(d, 'contact');
      if (c === 'open') el.classList.add('alert');
      if (valueEl) valueEl.textContent = c || '';
      break;
    }
    case 'water': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const w = getAttr(d, 'water');
      if (w === 'wet') el.classList.add('alert');
      if (valueEl) valueEl.innerHTML = `${iconSvg(s.icon || 'water-percent')}<span>${w || '—'}</span>`;
      break;
    }
    case 'valve': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const v = getAttr(d, 'valve');
      const isOpen = v === 'open';
      if (isOpen) el.classList.add('active');
      const valveIcon = (isOpen ? s.iconOn : s.iconOff) || s.icon || (isOpen ? 'valve' : 'valve-closed');
      if (valueEl) valueEl.innerHTML = `${iconSvg(valveIcon)}<span>${v || '—'}</span>`;
      break;
    }
    case 'shade': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const shadePos = getAttr(d, 'windowShade');
      const isClosed = shadePos === 'closed';
      if (shadePos === 'open') el.classList.add('active');
      const shadeIcon = (!isClosed ? s.iconOn : s.iconOff) || s.icon || (isClosed ? 'window-closed' : 'window-shutter-open');
      if (valueEl) valueEl.innerHTML = `${iconSvg(shadeIcon)}<span>${shadePos || '—'}</span>`;
      break;
    }
    case 'thermostat': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      const temp = getAttr(d, 'temperature');
      const mode = getAttr(d, 'thermostatMode');
      const opState = (getAttr(d, 'thermostatOperatingState') || '').toLowerCase();
      if (opState === 'heating' || opState === 'cooling') el.classList.add('active');
      const thermoIcon = s.icon || thermostatModeIcon(mode, opState);
      if (valueEl) valueEl.innerHTML = `${iconSvg(thermoIcon)}<span>${temp != null ? temp + '°' : '—'}</span>`;
      if (batteryEl) batteryEl.textContent = thermostatSetpointBadge(d, mode);
      break;
    }
    case 'momentary': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      // Stateless — no attribute to reflect, so never gets an 'active' class.
      if (valueEl) valueEl.innerHTML = `${iconSvg(s.icon || 'push-button')}<span>${escapeHtml(s.command || 'Press')}</span>`;
      break;
    }
    case 'text': {
      if (!s.deviceId) { el.classList.add('unmapped'); break; }
      if (!d) { if (valueEl) valueEl.textContent = '(device?)'; break; }
      if (!s.attribute) { if (valueEl) valueEl.textContent = '(set attribute)'; break; }
      const attrEntry = Array.isArray(d.attributes)
        ? d.attributes.find(a => a.name === s.attribute) : null;
      const v = attrEntry ? attrEntry.currentValue
               : (d.attributes ? d.attributes[s.attribute] : undefined);
      const rawUnit = (attrEntry && attrEntry.unit) ? attrEntry.unit : '';
      const unit = rawUnit ? (rawUnit.startsWith('°') ? rawUnit : ` ${rawUnit}`) : '';
      const textVal = v != null ? `${String(v)}${unit}` : `(${s.attribute}?)`;
      const isHtml = !!(s.renderHtml && v != null);
      if (valueEl) {
        valueEl.classList.toggle('html-content', isHtml);
        if (isHtml) valueEl.innerHTML = sanitizeHtml(textVal);
        else valueEl.textContent = textVal;
      }
      break;
    }
    case 'spacer':
      el.classList.add('spacer');
      if (labelEl) labelEl.textContent = 'spacer';
      break;
    default:
      if (!s.deviceId) el.classList.add('unmapped');
  }
}

function renderAll(force) {
  document.getElementById('dash-title').textContent = cfg.title || 'Home';
  // NOT .forEach(renderTile) — forEach passes (value, index, array), and
  // that index would otherwise be misread as the `force` argument.
  Object.keys(cfg.slots).forEach(slotId => renderTile(slotId, force));
  updateStatusBar();
  updateSectionVisibility();

  if (currentView.startsWith('dynamic/')) {
    renderDynamicDashboard(currentView.replace('dynamic/', ''));
  } else if (currentView.startsWith('custom/')) {
    renderCustomDashboard(currentView.replace('custom/', ''), force);
  }
  // The lightbox lives outside the normal tile-render flow (see
  // refreshLightboxImage's comment) — only worth touching on an explicit
  // forced refresh, not every background poll tick.
  if (force) refreshLightboxImage();
}

/**
 * Hide sections (rows, split) that are entirely empty (all tiles kind='hidden')
 * when not in edit mode. In edit mode, always show so tiles can be edited.
 */
function updateSectionVisibility() {
  const layout = getLayout();

  // Grid section rows
  ['row1','row2','row3','row-bottom'].forEach(sectionId => {
    const el = document.getElementById(sectionId);
    if (!el) return;
    const ids = layout[sectionId] || LAYOUT_DEFAULTS[sectionId] || [];
    const allHidden = ids.every(id => (cfg.slots[id] || {}).kind === 'hidden');
    el.style.display = (!editMode && allHidden) ? 'none' : '';
  });

  // Cameras and right column (inside .split)
  const camIds   = (layout['cameras']   || LAYOUT_DEFAULTS['cameras']   || []);
  const rightIds = (layout['right-col'] || LAYOUT_DEFAULTS['right-col'] || []);
  const camsHidden  = camIds.every(id  => (cfg.slots[id]  || {}).kind === 'hidden');
  const rightHidden = rightIds.every(id => (cfg.slots[id] || {}).kind === 'hidden');
  const splitEl = document.querySelector('.split');
  if (splitEl) {
    splitEl.style.display = (!editMode && camsHidden && rightHidden) ? 'none' : '';
  }
}

// ── Tile interaction ──────────────────────────────────────────────────────────

async function onTileClick(e) {
  // Capture the tile element now — e.currentTarget is nulled out by the
  // browser once the synchronous dispatch phase ends, which for an async
  // handler is as soon as the first `await` below is reached. Using
  // e.currentTarget later (e.g. in the catch block) throws instead of
  // flashing the tile red, silently skipping whatever runs after it.
  const tileEl = e.currentTarget;
  const slotId = tileEl.dataset.slot;

  // Ignore clicks on remove (×) and resize handle — they have their own handlers
  if (e.target.closest('.tile-remove') || e.target.closest('.resize-handle')) return;

  const editTarget = e.target.closest('[data-edit]');

  // Edit icon always opens editor regardless of edit mode state
  if (editTarget) {
    e.preventDefault(); e.stopPropagation();
    openTileEditor(slotId);
    return;
  }
  // In edit mode, any click on the tile body opens the editor
  if (editMode) {
    openTileEditor(slotId);
    return;
  }

  const s = cfg.slots[slotId] || {};
  const d = s.deviceId ? findDevice(s.deviceId) : null;

  // Spacer tiles: only interactive in edit mode (handled above via editMode check)
  if (s.kind === 'spacer') return;

  try {
    switch (s.kind) {
      case 'switch': {
        if (!d) { openTileEditor(slotId); return; }
        const on = getAttr(d, 'switch') === 'on';
        const action = on ? 'off' : 'on';
        if (s.requireConfirm) {
          const ok = await showConfirm(`Turn ${s.label || 'switch'} ${action}?`);
          if (!ok) return;
        }
        applyDeviceAttrUpdate(s.deviceId, 'switch', action); // instant feedback — corrected by the refresh below if the command actually fails
        await sendCommand(s.deviceId, action);
        break;
      }
      case 'bulb': {
        if (!d) { openTileEditor(slotId); return; }
        showBulbLevelPicker(s.deviceId, s.label);
        return;
      }
      case 'lock': {
        if (!d) { openTileEditor(slotId); return; }
        const lk = getAttr(d, 'lock');
        const lockAction = lk === 'locked' ? 'unlock' : 'lock';
        // requireConfirm defaults to true for locks (safety-critical)
        if (s.requireConfirm !== false) {
          const ok = await showConfirm(`${lockAction === 'unlock' ? 'Unlock' : 'Lock'} ${s.label || 'door'}?`);
          if (!ok) return;
        }
        applyDeviceAttrUpdate(s.deviceId, 'lock', lockAction === 'lock' ? 'locked' : 'unlocked');
        await sendCommand(s.deviceId, lockAction);
        break;
      }
      case 'garage': {
        if (!d) { openTileEditor(slotId); return; }
        const doorAttr = getAttr(d, 'door') !== undefined ? 'door' : 'contact';
        const isOpen = getAttr(d, doorAttr) === 'open' || getAttr(d, doorAttr) === 'opening';
        const garageAction = isOpen ? 'close' : 'open';
        // requireConfirm defaults to true for garages (safety-critical)
        if (s.requireConfirm !== false) {
          const ok = await showConfirm(`${isOpen ? 'Close' : 'Open'} ${s.label || 'garage'}?`);
          if (!ok) return;
        }
        applyDeviceAttrUpdate(s.deviceId, doorAttr, isOpen ? 'closed' : 'open');
        await sendCommand(s.deviceId, garageAction);
        break;
      }
      case 'mode': { showModePicker(); return; }
      case 'hsm':  { showHsmPicker();  return; }
      case 'dashboard-link': {
        if (s.url) {
          if (s.url.startsWith('#')) {
            navigate(s.url.replace(/^#\/?/, '') || 'main');
          } else if (s.urlNewTab) {
            window.open(s.url, '_blank');
          } else {
            window.location.href = s.url;
          }
        } else {
          openTileEditor(slotId);
        }
        return;
      }
      case 'image': {
        // Tap → open lightbox with full-size image