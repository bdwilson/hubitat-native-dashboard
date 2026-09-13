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
    replace: "if (location.hostname.includes('cloud.hubitat.com')) { startPolling(); return; }",
  },
];

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
