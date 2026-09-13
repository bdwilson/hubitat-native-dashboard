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
