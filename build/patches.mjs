// Transport patches applied to cf-hubitat-dashboard's index.html to make it
// run as an on-hub Hubitat App instead of a Cloudflare Worker.
//
// This is the entire "second implementation of the transport layer" that
// cf-hubitat-dashboard's CLAUDE.md anticipated. Everything else in that
// frontend — tiles, layout, editor, custom dashboards, config shape — runs
// unchanged, which is what keeps config exports compatible between the two.
//
// Every patch is asserted: `find` must occur EXACTLY `count` times in the
// source or the build fails. That is deliberate. These patterns match code in
// a repo this one does not control, so silent drift (a renamed helper, a
// reformatted line) must break the build loudly rather than quietly produce a
// dashboard whose network layer half-works.

/**
 * Reads the OAuth access token from the page URL. The dashboard page is always
 * opened as `.../dashboard?access_token=<token>`, and every same-origin call
 * back into the app needs that token, so each patched call site re-derives it
 * rather than depending on load order.
 */
const TOKEN_EXPR =
  "encodeURIComponent(new URLSearchParams(location.search).get('access_token') || '')";

export const PATCHES = [
  {
    name: 'head-pwa-links',
    why:
      'The manifest and icon files live in the Worker\'s static assets. There is no ' +
      'equivalent on the hub — and Hubitat Cloud corrupts binary responses, so serving ' +
      'PNGs through the app is not an option either. Dropping them costs the custom ' +
      'PWA icon and nothing else.',
    count: 1,
    find: `<link rel="manifest" href="/manifest.json">
<link rel="icon" type="image/png" sizes="32x32" href="/icons/favicon-32x32.png">
<link rel="icon" type="image/png" sizes="16x16" href="/icons/favicon-16x16.png">
<link rel="shortcut icon" href="/icons/favicon.ico">
<link rel="apple-touch-icon" href="/icons/apple-touch-icon.png">`,
    replace: `<!-- PWA manifest/icons removed by hubitat-native-dashboard build:
     no static asset origin on the hub, and Hubitat Cloud corrupts binary responses. -->`,
  },

  {
    name: 'api-config-const',
    why:
      'Worker route /api/config becomes the app\'s own "config" mapping. Relative (no ' +
      'leading slash) so it resolves under the app base path, which differs between ' +
      'local (/apps/api/<id>/) and cloud (/api/<hubUID>/apps/<id>/).',
    count: 1,
    find: `const API_CONFIG = '/api/config';`,
    replace: `const API_CONFIG = 'config?access_token=' + ${TOKEN_EXPR};`,
  },

  {
    name: 'api-hub-const',
    why: 'Worker route /api/hub becomes the app\'s own "hub" mapping (relative, as above).',
    count: 1,
    find: `const API_HUB    = '/api/hub';`,
    replace: `const API_HUB    = 'hub';`,
  },

  {
    name: 'config-include-secrets-separator',
    why:
      'API_CONFIG now already carries a query string (?access_token=...), so the ' +
      'include_secrets flag has to be appended with & rather than starting a second ?.',
    count: 1,
    find: 'const url = includeSecrets ? `${API_CONFIG}?include_secrets=1` : API_CONFIG;',
    replace: 'const url = includeSecrets ? `${API_CONFIG}&include_secrets=1` : API_CONFIG;',
  },

  {
    name: 'local-only-mode-flag',
    why:
      'Opt-in per-browser mode (?local=1). One hub, one link, but each person can ' +
      'keep their own layout instead of sharing the one stored on the hub.',
    count: 1,
    find: `const STORAGE_KEY = 'hubitat-dash-v4-cache';`,
    replace: `const STORAGE_KEY = 'hubitat-dash-v4-cache';
// hubitat-native-dashboard: in local mode this browser keeps its layout to
// itself — the hub's stored config is neither read nor written. Everything
// still runs against the same hub and the same devices; only where the tile
// layout lives changes.
//
// The mode is remembered per browser (settings panel toggle). ?local=1 and
// ?local=0 force it for one load regardless, so a link can be handed to someone
// without changing what their browser remembers.
const HND_MODE_KEY = 'hnd-config-mode';
// Last config epoch this browser saw from the hub. Kept in its OWN key, not in
// the layout cache, because the whole point is to survive clearing that cache.
const HND_EPOCH_KEY = 'hnd-config-epoch';
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

// Did the hub's config get wiped since this browser last looked? Returns true
// if so, having started a reload — the caller must stop what it was doing.
//
// Wiping the hub's copy is only half a reset: this browser holds a full layout
// in localStorage, and applyServerConfig() deliberately ignores empty values
// from the server (that is what makes browser-only mode work). So without this,
// a hub-side wipe reset the title, poll interval and main slots while custom
// dashboards, hidden devices, kind overrides, nav order and status-bar chips all
// came back from cache — a partial reset, worse than either extreme.
//
// Reloading rather than resetting each variable in place is deliberate: boot()
// already does exactly the right thing with no cache, and enumerating every
// piece of in-memory state here would silently rot the next time one is added.
// The epoch is written BEFORE the reload, so the fresh load sees them equal and
// cannot loop.
function hndConfigWasWiped(serverCfg) {
  const epoch = serverCfg && serverCfg.configEpoch;
  if (!epoch) return false;
  let seen = null;
  try { seen = localStorage.getItem(HND_EPOCH_KEY); } catch (e) { return false; }
  if (seen === String(epoch)) return false;
  try { localStorage.setItem(HND_EPOCH_KEY, String(epoch)); } catch (e) {}
  // First sight is not a wipe — this browser has simply never recorded one.
  if (seen === null) return false;
  try { localStorage.removeItem(STORAGE_KEY); } catch (e) {}
  console.warn('Dashboard config was wiped on the hub — clearing this browser\\'s cached layout.');
  location.reload();
  return true;
}`,
  },

  {
    name: 'config-epoch-clears-stale-cache',
    why:
      'Makes a hub-side wipe actually reach browsers. Without it, wiping config ' +
      'from the app page is a PARTIAL reset — title, pollSec and main slots come ' +
      'back as defaults, while custom dashboards, hidden devices, overrides, nav ' +
      'visibility/order and status-bar chips are restored from localStorage, and ' +
      'the next save pushes all of it back onto the hub. Placed at the top of ' +
      'applyServerConfig() because that is the one funnel every server config ' +
      'passes through, on boot and after any refetch. Local-only mode never ' +
      'reaches here (fetchConfigFromWorker throws first), which is correct: it ' +
      'promises the hub config is neither read nor written.',
    count: 1,
    find: `function applyServerConfig(serverCfg) {
  if (!serverCfg) return;`,
    replace: `function applyServerConfig(serverCfg) {
  if (!serverCfg) return;
  if (hndConfigWasWiped(serverCfg)) return; // reloading; nothing else is valid`,
  },

  {
    name: 'local-only-skips-config-read',
    why:
      'In local-only mode the hub config must not be loaded, or it would overwrite ' +
      "this browser's layout on every page load. Throwing is the right signal: " +
      'boot() already catches a failed config fetch and falls back to the ' +
      'localStorage cache, which is exactly the wanted behaviour.',
    count: 1,
    find: 'async function fetchConfigFromWorker(includeSecrets) {',
    replace: `async function fetchConfigFromWorker(includeSecrets) {
  if (HND_LOCAL_ONLY) throw new Error('local-only mode (?local=1) — hub config not loaded');`,
  },

  {
    name: 'local-only-skips-config-write',
    why:
      'Hiding the save button is not enough: hiding a device and reordering or ' +
      'editing a custom dashboard push to the server on their own. Without this a ' +
      '"local" browser would still mutate the layout everyone else sees. Resolves ' +
      'rather than throws so those background saves stay silent.',
    count: 1,
    find: 'async function pushConfigToWorker(payload) {',
    replace: `async function pushConfigToWorker(payload) {
  if (HND_LOCAL_ONLY) return { ok: true, localOnly: true };`,
  },

  {
    name: 'local-only-reset-spares-hub-config',
    why:
      'DATA LOSS without this. Reset Everything does its own ' +
      "fetch(API_CONFIG, {method:'DELETE'}) rather than going through " +
      'pushConfigToWorker, so the local-only write gate does not cover it: a ' +
      'browser in local mode would wipe the SHARED config off the hub — exactly ' +
      'the thing local mode promises never to touch. Also makes the confirm text ' +
      'state which of the two it is about to erase.',
    count: 1,
    find: `  if (!confirm('Wipe ALL dashboard config from browser and KV (if configured)? Cannot be undone.')) return;
  let kvMsg = '';
  try {
    const r = await fetch(API_CONFIG, { method: 'DELETE', credentials: 'same-origin', headers: workerHeaders() });`,
    replace: `  if (!confirm(HND_LOCAL_ONLY
    ? 'Wipe ALL dashboard config from this browser? The layout stored on the hub is not touched. Cannot be undone.'
    : 'Wipe ALL dashboard config from this browser and from the hub? Cannot be undone.')) return;
  let kvMsg = '';
  try {
    // In local mode the hub's config is not this browser's to delete. Skip the
    // request and stand in a success so the browser-side reset below still runs.
    const r = HND_LOCAL_ONLY
      ? { ok: true, status: 200 }
      : await fetch(API_CONFIG, { method: 'DELETE', credentials: 'same-origin', headers: workerHeaders() });`,
  },

  {
    name: 'hub-path',
    why:
      'The Worker proxied arbitrary sub-paths (/api/hub/devices/123/on/50). Hubitat ' +
      'mappings only match static paths — colon-style path variables are unverified on ' +
      'this platform — so the whole sub-path is passed as one query param to a single ' +
      '"hub" route, which the app URL-decodes and forwards to Maker API.',
    count: 1,
    find: "return `${API_HUB}${path.startsWith('/') ? path : '/' + path}`;",
    replace:
      'return `${API_HUB}?access_token=${' +
      TOKEN_EXPR +
      "}&path=${encodeURIComponent(path.startsWith('/') ? path : '/' + path)}`;",
  },

  {
    name: 'import-syncs-all-settings-inputs',
    why:
      'UPSTREAM BUG, reproduced on the Cloudflare build too. applyImportedConfig() ' +
      'writes the imported values into cfg and syncs SOME settings inputs back ' +
      '(url, appId, isCloud, hub link, chip accents, theme) but not cfg-title, ' +
      'cfg-poll, cfg-grid-cols, cfg-tile-h or cfg-icon-scale. readSettingsForm() ' +
      'runs on the next save and reads all of those straight off the form, so ' +
      'importing a backup and then saving silently reverts title, poll interval, ' +
      'grid columns, tile height and icon scale to their pre-import values. ' +
      'Verified in a browser: import set the page title to the restored name, then ' +
      'save wrote the OLD title to the server. Fix belongs upstream; patched here ' +
      'so restore actually restores.',
    count: 1,
    find: `  const urlField = document.getElementById('cfg-url');`,
    replace: `  const syncImportedField = (id, v) => {
    const el = document.getElementById(id);
    if (el && v != null) el.value = v;
  };
  syncImportedField('cfg-title', cfg.title);
  syncImportedField('cfg-poll', cfg.pollSec);
  syncImportedField('cfg-grid-cols', cfg.gridCols);
  syncImportedField('cfg-tile-h', cfg.tileH);
  syncImportedField('cfg-icon-scale', cfg.iconScale);
  const urlField = document.getElementById('cfg-url');`,
  },

  {
    name: 'websocket-url',
    why:
      'The Worker proxied the hub eventsocket because it sat outside the LAN. This app ' +
      'IS the hub, so the browser can reach ws://<hub>/eventsocket directly on the same ' +
      'origin the page was served from — one less hop than the Worker build.',
    count: 1,
    find: 'const url   = `${proto}//${location.host}/api/hub/events${query}`;',
    replace: 'const url   = `${proto}//${location.host}/eventsocket`;',
  },

  {
    name: 'websocket-cloud-guard',
    why:
      'Upstream skips the eventsocket when the configured hub URL is a cloud URL. Here ' +
      'what matters is how the BROWSER reached this page: over the cloud link there is ' +
      'no eventsocket to reach, over the local link there is, regardless of config.',
    count: 1,
    find: 'if (cfg.hubIsCloud) { startPolling(); return; }',
    replace: 'if (HND_VIA_CLOUD) { startPolling(); return; }',
  },

  {
    name: 'polltick-reconnect-guard',
    why:
      'Same cloud-vs-local question as websocket-cloud-guard, second site — added ' +
      "upstream by PR #46 (pollTick's reconnect for a socket that died without " +
      'closing). Left unpatched it reads cfg.hubIsCloud, which in local-only mode ' +
      'is never loaded from the hub and so keeps its default of true: the socket ' +
      'connects once at boot and, if it drops, is never retried for the rest of ' +
      'the session. Polling still runs at full rate, so the dashboard degrades to ' +
      'poll-only rather than freezing — but push never comes back.',
    count: 1,
    find: 'if (!ws && !cfg.hubIsCloud && Date.now() - lastWsAttemptAt >= WS_RECONNECT_MS) {',
    replace: 'if (!ws && !HND_VIA_CLOUD && Date.now() - lastWsAttemptAt >= WS_RECONNECT_MS) {',
  },

  {
    name: 'ws-dot-transport-label',
    why:
      'Third cfg.hubIsCloud site, also from PR #46: the ws-dot tooltip that reports ' +
      'which transport is actually in use. Upstream added it precisely so a stale ' +
      'dashboard could be diagnosed by hovering instead of opening a console, so a ' +
      'wrong answer here is worse than none — in local-only mode it would claim ' +
      '"cloud — no WebSocket" on a local link that has a perfectly good socket.',
    count: 1,
    find:
      "const mode = wsIsLive() ? 'WebSocket (live)' : (cfg.hubIsCloud ? 'Polling (cloud — no WebSocket)' : 'Polling');",
    replace:
      "const mode = wsIsLive() ? 'WebSocket (live)' : (HND_VIA_CLOUD ? 'Polling (cloud — no WebSocket)' : 'Polling');",
  },
];

/**
 * Guards: upstream constructs this build has deliberately diverged from, pinned
 * by count.
 *
 * PATCHES catch SYNTACTIC drift — upstream renames a helper or reflows a line,
 * the pattern stops matching, the build fails. What they structurally cannot
 * catch is SEMANTIC drift: upstream adding NEW code that should have been
 * patched but wasn't. Nothing asserts on text no patch mentions, so the build
 * goes green and the divergence ships.
 *
 * That is not hypothetical. cf-hubitat-dashboard PR #46 added two new
 * cfg.hubIsCloud sites — both encoding the very predicate websocket-cloud-guard
 * exists to reject — and this build stayed green through it. The
 * polltick-reconnect-guard and ws-dot-transport-label patches above are the
 * cleanup; these guards are so the next one fails the build instead.
 *
 * Counted against the RAW upstream source, before any patch runs, so the
 * expected number describes upstream and does not shift as patches are added.
 *
 * When one trips, the fix is a decision, not a number bump: look at the new
 * site and either patch it or satisfy yourself that upstream's behaviour is
 * correct here too — then update `expect` with a note saying which.
 */
export const GUARDS = [
  {
    name: 'hub-is-cloud-sites',
    pattern: 'cfg.hubIsCloud',
    expect: 11,
    why:
      'This build answers cloud-vs-local from location.hostname (HND_VIA_CLOUD), ' +
      'not from the configured hub URL. Every upstream site has to be reviewed: ' +
      'settings-form plumbing is fine as-is, anything gating the eventsocket or ' +
      'reporting transport is not.',
  },
  {
    name: 'direct-fetch-calls',
    pattern: 'fetch(',
    expect: 5,
    why:
      'Calls that bypass api()/fetchConfigFromWorker() and hit a URL directly. ' +
      'Each one needs its own patch to reach an app route and carry the OAuth ' +
      'token — a new unpatched one is a call that 404s on the hub.',
  },
  {
    name: 'local-storage-sites',
    pattern: 'localStorage',
    expect: 3,
    why:
      'local-only mode depends on knowing every place the layout cache is read or ' +
      'written. A new site upstream could read hub config in local mode or write ' +
      'to a key copyHubConfigToLocal() does not seed.',
  },
];

/**
 * Check every guard against the raw upstream source. Throws on the first
 * mismatch, naming the guard, both counts and what the divergence is about.
 */
export function checkGuards(source) {
  const checked = [];
  for (const g of GUARDS) {
    const hits = source.split(g.pattern).length - 1;
    if (hits !== g.expect) {
      throw new Error(
        `guard "${g.name}": found ${hits} occurrence(s) of ${JSON.stringify(g.pattern)}, expected ${g.expect}.\n` +
          `  Why this is guarded: ${g.why}\n` +
          `  cf-hubitat-dashboard has ${hits > g.expect ? 'ADDED' : 'REMOVED'} a site this build cares about.\n` +
          `  Review it, patch it if it needs patching, then update GUARDS in\n` +
          `  build/patches.mjs with the new count and a note on what was decided.`,
      );
    }
    checked.push({ name: g.name, hits });
  }
  return checked;
}

/**
 * Cosmetic relabels: user-visible wording that names Cloudflare/KV, which do not
 * exist in this build.
 *
 * These are deliberately NOT asserted, unlike PATCHES above. A patch that stops
 * matching means the network layer is broken and the build must fail. A relabel
 * that stops matching just means a button says "KV" — worth fixing, never worth
 * blocking a build over. So these are replace-all, best-effort, and the build
 * reports how many landed.
 *
 * This matters more than it sounds: the "Save Config to KV" button is what
 * actually writes config to the hub's app state on this build, and a user who
 * reads that label as "Cloudflare thing I don't have" will leave their config
 * stranded in one browser's localStorage.
 *
 * Order matters — longer, more specific phrases first.
 */
export const RELABELS = [
  ['☁ Save Config to KV', '💾 Save Config to Hub'],
  // "Save to Browser & Test" still saves settings to this browser, but its
  // useful effect here is reloading the device list and proving Maker API
  // works — and the credential fields it implies you just filled in are hidden
  // on this build.
  ['Save to Browser &amp; Test', 'Reload Devices &amp; Test'],
  // Upstream refers to that same button by a third name in one runtime message.
  ['Test &amp; Load Devices', 'Reload Devices &amp; Test'],
  ['Save Config to KV', 'Save Config to Hub'],
  ['Save to KV', 'Save to Hub'],
  ['Wipes all config from KV and browser', 'Wipes all config from the hub and this browser'],
  ['never sent to Cloudflare KV', 'never sent off the hub'],
  ['can be saved to KV for cross-device sync', 'can be saved to the hub for cross-device sync'],
  ['namespaces your config in KV', 'namespaces your config'],
  ['token in KV (legacy); re-enter to move to browser', 'token stored on the hub; re-enter to change'],
  ["'✓ in KV'", "'✓ on hub'"],
  ['Saving to KV…', 'Saving to hub…'],
  ['✓ Saved to Cloudflare KV.', '✓ Saved to hub.'],
  // Runtime messages. The Reset Everything confirm() is NOT here — the
  // local-only-reset-spares-hub-config patch rewrites it, because its wording
  // has to change with the mode, which a static relabel cannot do.
  [" (KV not configured — browser only)", ' (hub storage unavailable — browser only)'],
  ['Could not fetch from KV: ', 'Could not fetch from the hub: '],
  ['Could not load config from Worker, using cache:', 'Could not load config from the hub, using cache:'],
  ['// fresh from KV — no unsaved changes', '// fresh from the hub — no unsaved changes'],
];

/** Apply the cosmetic relabels, returning counts. Never throws. */
export function applyRelabels(source) {
  let out = source;
  const counts = [];
  for (const [find, replace] of RELABELS) {
    const hits = out.split(find).length - 1;
    if (hits > 0) out = out.split(find).join(replace);
    counts.push({ find, hits });
  }
  return { out, counts };
}

/**
 * Apply every patch, asserting each matches exactly the expected number of times.
 * Throws with the patch name and its rationale when a pattern has drifted, so the
 * failure says what upstream change broke it and what the patch was for.
 */
export function applyPatches(source) {
  let out = source;
  const applied = [];
  for (const p of PATCHES) {
    const hits = out.split(p.find).length - 1;
    if (hits !== p.count) {
      throw new Error(
        `patch "${p.name}" matched ${hits} time(s), expected ${p.count}.\n` +
          `  Purpose: ${p.why}\n` +
          `  This usually means cf-hubitat-dashboard changed upstream. Re-read the\n` +
          `  relevant code there and update build/patches.mjs to match.\n` +
          `  Pattern:\n    ${p.find.split('\n')[0]}`,
      );
    }
    out = out.split(p.find).join(p.replace);
    applied.push(p.name);
  }
  return { out, applied };
}
