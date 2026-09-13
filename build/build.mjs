#!/usr/bin/env node
/**
 * Build the on-hub dashboard assets from cf-hubitat-dashboard's frontend.
 *
 *   node build/build.mjs [--source <path-or-url>] [--out dist] [--chunk-kb 96]
 *
 * What it does:
 *   1. Reads cf-hubitat-dashboard's src/assets/index.html (see resolveSource).
 *   2. Applies the transport patches in build/patches.mjs (each asserted).
 *   3. Splits the result into a shell (head + CSS + body markup + loader) and
 *      the application JS, then chunks the JS under Hubitat's size ceilings.
 *   4. Writes everything to dist/ for upload to Hubitat's File Manager.
 *
 * Why a build step exists at all — two hard platform ceilings:
 *   - File Manager caps a single file at 124 KB.
 *   - Hubitat Cloud's OAuth proxy caps a single response at roughly 128 KB.
 *   The upstream dashboard is one ~280 KB HTML file, so it cannot be stored or
 *   served whole. evdev/hubitat-modern-dashboard hit the same wall and solved it
 *   the same way (a build that enforces the limits and fails if a chunk grows
 *   past them); this is that idea applied to a file we do not control.
 *
 * The frontend is deliberately NOT vendored into this repo. It is read from a
 * sibling checkout or fetched from GitHub at build time, so there is no second
 * copy of the production dashboard here to drift out of sync.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyPatches, applyRelabels } from './patches.mjs';
import { createZip } from './zip.mjs';

/**
 * Hubitat bundle identity. A bundle is a flat ZIP of `<namespace>.<Name>.groovy`
 * files plus install.txt/update.txt, each of which is:
 *   line 1: namespace
 *   line 2: bundle name
 *   line 3+: `app|driver|library <file> [oauthClientId] [oauthClientSecret]`
 * Confirmed by unpacking real published bundles, not from documentation.
 *
 * The OAuth client id/secret fields are deliberately omitted. Bundles *can*
 * carry them so OAuth arrives pre-enabled, but those credentials would then be
 * identical for everyone who installs from this repo. Skipping them costs one
 * click ("OAuth -> Enable OAuth in App") and keeps no shared secret in a public
 * repository.
 */
const BUNDLE_NAMESPACE = 'bdwilson';
const BUNDLE_NAME = 'Hubitat Native Dashboard';
const APP_SOURCE = 'app/HubitatNativeDashboard.groovy';
const BUNDLE_APP_FILE = 'bdwilson.HubitatNativeDashboard.groovy';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** File Manager's hard per-file cap. */
const FILE_MANAGER_MAX = 124 * 1024;
/**
 * Safe ceiling for one response through Hubitat Cloud's OAuth proxy. The
 * documented cap is ~128 KB; cloud OAuth overhead eats into that, so the
 * usable budget is smaller. evdev's build uses ~118 KB for cloud-critical
 * chunks — same number here, for the same reason.
 */
const CLOUD_RESPONSE_MAX = 118 * 1024;

const UPSTREAM_RAW =
  'https://raw.githubusercontent.com/bdwilson/cf-hubitat-dashboard/main/src/assets/index.html';
const SIBLING_CHECKOUT = path.resolve(REPO_ROOT, '..', 'cf-hubitat-dashboard', 'src', 'assets', 'index.html');

function parseArgs(argv) {
  const args = { source: null, out: 'dist', chunkKb: 96 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--source') args.source = argv[++i];
    else if (a.startsWith('--source=')) args.source = a.slice('--source='.length);
    else if (a === '--out') args.out = argv[++i];
    else if (a.startsWith('--out=')) args.out = a.slice('--out='.length);
    else if (a === '--chunk-kb') args.chunkKb = Number(argv[++i]);
    else if (a.startsWith('--chunk-kb=')) args.chunkKb = Number(a.slice('--chunk-kb='.length));
    else if (a === '-h' || a === '--help') args.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

/**
 * Find the upstream frontend, in order of preference:
 *   1. --source (a path or an http(s) URL)
 *   2. $CF_DASHBOARD_SRC
 *   3. a sibling checkout at ../cf-hubitat-dashboard
 *   4. GitHub raw (so a fresh clone of this repo builds with no setup)
 */
async function resolveSource(explicit) {
  const candidate = explicit || process.env.CF_DASHBOARD_SRC;
  if (candidate) {
    if (/^https?:\/\//.test(candidate)) return { kind: 'url', at: candidate };
    const abs = path.resolve(candidate);
    if (!existsSync(abs)) throw new Error(`--source path does not exist: ${abs}`);
    return { kind: 'file', at: abs };
  }
  if (existsSync(SIBLING_CHECKOUT)) return { kind: 'file', at: SIBLING_CHECKOUT };
  return { kind: 'url', at: UPSTREAM_RAW };
}

async function loadSource(src) {
  if (src.kind === 'file') return readFile(src.at, 'utf8');
  const res = await fetch(src.at);
  if (!res.ok) {
    throw new Error(
      `fetching ${src.at} failed: HTTP ${res.status} ${res.statusText}. ` +
        'Pass --source with a local path to cf-hubitat-dashboard/src/assets/index.html instead.',
    );
  }
  return res.text();
}

/**
 * Split the patched HTML into the static shell and the application JS.
 * Upstream is one <script> block at the end of <body>; assert that so a
 * restructured upstream fails here rather than producing a broken shell.
 */
function splitShellAndScript(html) {
  const OPEN = '\n<script>\n';
  const CLOSE = '\n</script>\n';
  const opens = html.split(OPEN).length - 1;
  const closes = html.split(CLOSE).length - 1;
  if (opens !== 1 || closes !== 1) {
    throw new Error(
      `expected exactly one <script> block in the upstream page, found ${opens} open / ${closes} close. ` +
        'cf-hubitat-dashboard may have been restructured; update build/build.mjs.',
    );
  }
  const i = html.indexOf(OPEN);
  const j = html.indexOf(CLOSE);
  return {
    head: html.slice(0, i),
    js: html.slice(i + OPEN.length, j),
    tail: html.slice(j + CLOSE.length),
  };
}

/** Chunk text on line boundaries so no chunk exceeds maxBytes. */
function chunkByLines(text, maxBytes) {
  const lines = text.split('\n');
  const chunks = [];
  let cur = [];
  let curBytes = 0;
  for (const line of lines) {
    const lineBytes = Buffer.byteLength(line, 'utf8') + 1; // + newline
    if (curBytes + lineBytes > maxBytes && cur.length) {
      chunks.push(cur.join('\n'));
      cur = [];
      curBytes = 0;
    }
    cur.push(line);
    curBytes += lineBytes;
  }
  if (cur.length) chunks.push(cur.join('\n'));
  return chunks;
}

/**
 * The loader that replaces the inline <script> block.
 *
 * Chunks are fetched as TEXT and concatenated before a single indirect eval,
 * rather than loaded as separate <script src> tags. That matters: the upstream
 * app is one big IIFE, so splitting it across script tags would tear a function
 * in half. Rejoining the raw text first means the split point can fall anywhere
 * and the browser still parses exactly the original program — and, unlike
 * wrapping each chunk in a string literal, it costs zero bytes of escaping.
 */
function buildLoader(chunkNames, version) {
  const list = JSON.stringify(chunkNames);
  return `<script>
(function () {
  'use strict';
  var PARTS = ${list};
  var VERSION = ${JSON.stringify(version)};
  var token = new URLSearchParams(location.search).get('access_token') || '';

  function assetUrl(name) {
    return 'asset?f=' + encodeURIComponent(name) +
           '&v=' + encodeURIComponent(VERSION) +
           (token ? '&access_token=' + encodeURIComponent(token) : '');
  }

  function fail(msg, detail) {
    var el = document.getElementById('hnd-boot');
    if (el) {
      el.innerHTML = '<h2>Dashboard failed to load</h2><p>' + msg + '</p>' +
        (detail ? '<pre>' + String(detail).replace(/[<&]/g, function (c) {
          return c === '<' ? '&lt;' : '&amp;';
        }) + '</pre>' : '') +
        '<p>Check that every dist/ file was uploaded to Hubitat&rsquo;s File Manager ' +
        '(Settings &rarr; File Manager), then reload.</p>';
      el.style.display = '';
    }
  }

  // Hide the Hub Connection credential fields. On this build the Maker API URL,
  // app ID and token come from the App's own settings page on the hub, so these
  // inputs are inert and misleading.
  //
  // They are HIDDEN, not removed: the upstream code reads these elements by id
  // in readSettingsForm() and on import, so deleting them would turn a cosmetic
  // cleanup into a null-dereference. Hiding keeps every code path intact.
  //
  // Note this cannot simply hide "everything between the Hub Connection heading
  // and the next one" — upstream puts the display settings and the save buttons
  // in that same stretch, with no heading of their own.
  function hideHubConnectionFields() {
    try {
      var ids = ['cfg-url', 'cfg-app', 'cfg-token', 'cfg-is-cloud'];
      for (var i = 0; i < ids.length; i++) {
        var el = document.getElementById(ids[i]);
        var row = el && el.closest ? el.closest('.form-row') : null;
        if (row) row.style.display = 'none';
      }
      var modal = document.getElementById('settings-modal');
      if (!modal) return;
      var h3s = modal.getElementsByTagName('h3');
      for (var j = 0; j < h3s.length; j++) {
        if ((h3s[j].textContent || '').trim() === 'Hub Connection') {
          h3s[j].style.display = 'none';
          break;
        }
      }
      // The panel's opening blurb explains browser-vs-Worker credential storage,
      // which does not apply here.
      var card = modal.querySelector('.modal-card');
      var firstHelp = card ? card.querySelector('.help') : null;
      if (firstHelp && /credential|token/i.test(firstHelp.textContent || '')) {
        firstHelp.textContent =
          'Tiles, layout and visibility are stored on the hub by this app. ' +
          'Maker API credentials are configured on the app\\'s own settings page in Hubitat.';
      }
    } catch (e) {
      console.warn('native UI tweak skipped', e);
    }
  }

  // Where does this browser's layout live — on the hub (shared) or here only?
  // Adds the toggle to the settings panel and keeps the rest of the panel
  // honest about the current choice.
  var MODE_KEY = 'hnd-config-mode';
  // Upstream's localStorage key. Read directly so "publish my local layout" can
  // work from here without reaching into the app's closure.
  var CACHE_KEY = 'hubitat-dash-v4-cache';

  function isLocalMode() {
    var q = new URLSearchParams(location.search).get('local');
    if (q === '1') return true;
    if (q === '0') return false;
    try { return localStorage.getItem(MODE_KEY) === 'local'; } catch (e) { return false; }
  }

  // Reload without ?local=, so the remembered mode is what takes effect.
  function reloadWithStoredMode() {
    var u = new URL(location.href);
    u.searchParams.delete('local');
    location.href = u.toString();
  }

  function setMode(mode) {
    try { localStorage.setItem(MODE_KEY, mode); } catch (e) {}
  }

  // Build the /config payload from the browser's cached layout. Mirrors what the
  // app's own save sends, minus the hub block — Maker API credentials live in
  // the App's settings on the hub and must not be overwritten from a browser.
  function publishLocalLayout(token) {
    var raw = null;
    try { raw = localStorage.getItem(CACHE_KEY); } catch (e) {}
    if (!raw) return Promise.reject(new Error('no layout cached in this browser yet'));
    var c = JSON.parse(raw);
    var payload = {
      dashboard: {
        title: c.title, pollSec: c.pollSec, slots: c.slots, layout: c.layout,
        gridCols: c.gridCols, tileH: c.tileH, iconScale: c.iconScale,
        hubExternalUrl: c.hubExternalUrl, chipAccent: c.chipAccent,
        chipAccentDynamic: c.chipAccentDynamic, theme: c.theme,
      },
    };
    if (c.dynamic) payload.dynamic = c.dynamic;
    if (c.custom) payload.custom = c.custom;
    if (c.dashboardsVisible) payload.dashboardsVisible = c.dashboardsVisible;
    if (c.dashboardsOrder) payload.dashboardsOrder = c.dashboardsOrder;
    if (c.statusBarPresenceDevices) payload.statusBarPresenceDevices = c.statusBarPresenceDevices;
    return fetch('config' + (token ? '?access_token=' + encodeURIComponent(token) : ''), {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return true;
    });
  }

  // Copy the hub's stored layout into this browser's cache, so switching to
  // local mode starts from exactly what is on screen and then diverges.
  //
  // This is not optional. boot() applies the hub config to memory but never
  // writes it to the browser cache, so without this step switching to local
  // would reload whatever stale cache happened to be there — not the layout the
  // user was just looking at.
  function copyHubConfigToLocal(token) {
    return fetch('config' + (token ? '?access_token=' + encodeURIComponent(token) : ''))
      .then(function (r) {
        if (!r.ok) throw new Error('HTTP ' + r.status);
        return r.json();
      })
      .then(function (c) {
        var existing = {};
        try {
          var raw = localStorage.getItem(CACHE_KEY);
          if (raw) existing = JSON.parse(raw);
        } catch (e) {}

        var d = c.dashboard || {};
        var cache = existing;
        function put(key, value) { if (value !== undefined && value !== null) cache[key] = value; }

        put('title', d.title); put('pollSec', d.pollSec); put('slots', d.slots);
        put('layout', d.layout); put('gridCols', d.gridCols); put('tileH', d.tileH);
        put('iconScale', d.iconScale); put('hubExternalUrl', d.hubExternalUrl);
        put('chipAccent', d.chipAccent); put('chipAccentDynamic', d.chipAccentDynamic);
        put('theme', d.theme);
        if (c.hub) {
          put('hubBaseUrl', c.hub.baseUrl);
          put('hubAppId', c.hub.appId);
          put('hubIsCloud', c.hub.isCloud);
          put('hubHasToken', c.hub.hasToken);
        }
        put('dynamic', c.dynamic); put('custom', c.custom);
        put('dashboardsVisible', c.dashboardsVisible);
        put('dashboardsOrder', c.dashboardsOrder);
        put('statusBarPresenceDevices', c.statusBarPresenceDevices);

        localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
        return true;
      });
  }

  function installConfigModeUi() {
    try {
      var local = isLocalMode();
      var save = document.getElementById('save-cfg');
      if (save) save.style.display = local ? 'none' : '';

      var row = save && save.closest ? save.closest('.btn-row') : null;
      if (!row || document.getElementById('hnd-mode-box')) return;

      var box = document.createElement('div');
      box.id = 'hnd-mode-box';
      box.className = 'form-row';
      box.innerHTML =
        '<label>Where this dashboard\\'s layout is stored</label>' +
        '<select id="hnd-mode-select">' +
        '<option value="hub">On the hub — shared by every browser</option>' +
        '<option value="local">In this browser only — private layout</option>' +
        '</select>' +
        '<div class="help" id="hnd-mode-help" style="margin-top:4px;font-size:11px"></div>';
      row.parentNode.insertBefore(box, row);

      var sel = document.getElementById('hnd-mode-select');
      var help = document.getElementById('hnd-mode-help');
      sel.value = local ? 'local' : 'hub';
      help.innerHTML = local
        ? 'This browser keeps its own layout. The hub\\'s shared config is neither ' +
          'read nor written — devices and commands still go to the same hub.'
        : 'The layout is stored on the hub, so every browser opening this link sees ' +
          'the same dashboard.';

      if (local) {
        var pub = document.createElement('button');
        pub.className = 'btn secondary';
        pub.id = 'hnd-publish';
        pub.textContent = '⬆ Publish this layout to the hub';
        pub.style.marginTop = '6px';
        pub.addEventListener('click', function () {
          if (!confirm('Replace the hub\\'s shared layout with this browser\\'s layout, ' +
                       'and switch this browser back to the shared layout?')) return;
          var token = new URLSearchParams(location.search).get('access_token') || '';
          publishLocalLayout(token).then(function () {
            setMode('hub');
            reloadWithStoredMode();
          }).catch(function (e) {
            alert('Could not publish to the hub: ' + e.message);
          });
        });
        box.appendChild(pub);
      }

      sel.addEventListener('change', function () {
        if (sel.value === 'local') {
          // Take a copy of what is on screen first, then stop syncing. Without
          // the copy this would reload a stale browser cache instead of the
          // hub layout the user is currently looking at.
          sel.disabled = true;
          help.textContent = 'Copying the hub layout into this browser…';
          var t = new URLSearchParams(location.search).get('access_token') || '';
          copyHubConfigToLocal(t).then(function () {
            setMode('local');
            reloadWithStoredMode();
          }).catch(function (e) {
            sel.disabled = false;
            sel.value = 'hub';
            help.textContent = '';
            alert('Could not copy the hub layout into this browser: ' + e.message +
                  '\\n\\nStaying on the shared layout.');
          });
          return;
        }
        // Switching back adopts the hub's layout, replacing this browser's.
        // Cancel aborts the switch entirely — no hidden second meaning.
        if (!confirm('Switch to the shared layout stored on the hub?\\n\\n' +
                     'This browser\\'s private layout will be replaced by the shared one. ' +
                     'To keep it, cancel and use "Publish this layout to the hub" instead, ' +
                     'or Download Config first.')) {
          sel.value = 'local';
          return;
        }
        setMode('hub');
        reloadWithStoredMode();
      });
    } catch (e) {
      console.warn('config mode UI skipped', e);
    }
  }

  Promise.all(PARTS.map(function (name) {
    return fetch(assetUrl(name)).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' loading ' + name);
      return r.text();
    });
  })).then(function (texts) {
    var boot = document.getElementById('hnd-boot');
    if (boot) boot.style.display = 'none';
    // Indirect eval: run in global scope, exactly as the original inline
    // <script> would have. The rejoined text is byte-identical to upstream's
    // program, so behaviour matches the Cloudflare build.
    (0, eval)(texts.join('\\n'));
    hideHubConnectionFields();
    installConfigModeUi();
  }).catch(function (e) {
    fail('Could not load the dashboard code from the hub.', e && e.message);
  });
})();
</script>`;
}

const BOOT_NOTICE = `<div id="hnd-boot" style="position:fixed;inset:0;z-index:99999;background:#0d1117;color:#e8e8ea;font:14px/1.5 -apple-system,system-ui,sans-serif;padding:24px;overflow:auto">
<h2 style="margin:0 0 8px">Loading dashboard&hellip;</h2>
<p style="color:#9a9ba3;margin:0">Fetching the app from this hub&rsquo;s File Manager.</p>
</div>`;

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(
      'Usage: node build/build.mjs [--source <path-or-url>] [--out dist] [--chunk-kb 96]',
    );
    return;
  }

  const src = await resolveSource(args.source);
  console.log(`source:  ${src.at}${src.kind === 'url' ? '  (fetched)' : ''}`);

  const raw = await loadSource(src);
  const upstreamHash = createHash('sha256').update(raw).digest('hex').slice(0, 12);
  console.log(`upstream: ${Buffer.byteLength(raw, 'utf8').toLocaleString()} bytes, sha256:${upstreamHash}`);

  const { out: transportPatched, applied } = applyPatches(raw);
  console.log(`patches: ${applied.length} applied (${applied.join(', ')})`);

  const { out: patched, counts: relabelCounts } = applyRelabels(transportPatched);
  const relabelled = relabelCounts.filter((c) => c.hits > 0).length;
  const missedRelabels = relabelCounts.filter((c) => c.hits === 0);
  console.log(
    `relabels: ${relabelled}/${relabelCounts.length} matched` +
      (missedRelabels.length
        ? ` (no longer present, harmless: ${missedRelabels.map((c) => JSON.stringify(c.find.slice(0, 28))).join(', ')})`
        : ''),
  );

  const { head, js, tail } = splitShellAndScript(patched);

  const chunkMax = Math.floor(args.chunkKb * 1024);
  const chunks = chunkByLines(js, chunkMax);
  const chunkNames = chunks.map((_, i) => `hnd-app-${i + 1}.js`);

  // The build id has to cover everything that determines the output, not just
  // the upstream source: the loader and boot markup are generated here, so
  // hashing only `patched` would let a change to this file ship different bytes
  // under an unchanged id — and the app's update check would report "up to date"
  // for a build that is not. The loader is hashed with a placeholder id to avoid
  // depending on its own hash.
  const version = createHash('sha256')
    .update(patched)
    .update(BOOT_NOTICE)
    .update(buildLoader(chunkNames, '__VERSION__'))
    .digest('hex')
    .slice(0, 10);

  // A greppable build stamp. The app reads this back out of the INSTALLED shell
  // and compares it to the installed manifest's version. Without it, uploading a
  // new shell over old chunks (or vice versa) leaves a mismatched set that still
  // looks complete — every file present, nothing obviously wrong, a dashboard
  // that half works. The loader's VERSION is the same value, but it lives in JS
  // the Groovy side has no business parsing.
  const stamp = `<!-- hnd-build: ${version} -->`;
  const shell = `${head}\n${stamp}\n${BOOT_NOTICE}\n${buildLoader(chunkNames, version)}\n${tail}`;

  const outDir = path.resolve(REPO_ROOT, args.out);

  // Reuse the previous builtAt when the content is unchanged, so rebuilding
  // identical inputs produces byte-identical output. Without this, every
  // scheduled CI run would rewrite the timestamp and commit a no-op change
  // daily — and `git status` would stop being a usable signal for "did the
  // build actually change anything?".
  let builtAt = new Date().toISOString();
  try {
    const prev = JSON.parse(await readFile(path.join(outDir, 'hnd-manifest.json'), 'utf8'));
    if (prev.version === version && prev.builtAt) builtAt = prev.builtAt;
  } catch (e) { /* no previous build, or unreadable — use now */ }

  await rm(outDir, { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const files = [['hnd-shell.html', shell], ...chunkNames.map((n, i) => [n, chunks[i]])];
  for (const [name, content] of files) {
    await writeFile(path.join(outDir, name), content, 'utf8');
  }

  // Hubitat bundle: the app code only. Bundles cannot carry File Manager files
  // (verified by unpacking published bundles — entries are only app/driver/
  // library), so the UI chunks still have to get there another way: either the
  // app's own "Install/update dashboard UI" button, or a manual upload.
  const appSource = await readFile(path.resolve(REPO_ROOT, APP_SOURCE), 'utf8');
  const bundleManifest =
    `${BUNDLE_NAMESPACE}\n${BUNDLE_NAME}\napp ${BUNDLE_APP_FILE}\n`;
  const bundleZip = createZip([
    { name: BUNDLE_APP_FILE, data: appSource },
    { name: 'install.txt', data: bundleManifest },
    { name: 'update.txt', data: bundleManifest },
  ]);
  await writeFile(path.join(outDir, 'hubitat-native-dashboard.zip'), bundleZip);

  // The app reads this to know what to serve and to reject anything else.
  const manifest = {
    version,
    upstreamSha256: upstreamHash,
    // Deliberately no upstreamSource path here. It differs between a local
    // checkout and CI, which would churn this file on every alternating build,
    // and a local build would otherwise commit an absolute filesystem path into
    // a public repo. upstreamSha256 identifies the content regardless of where
    // it was read from, which is the part that actually matters.
    builtAt,
    shell: 'hnd-shell.html',
    chunks: chunkNames,
    bundle: 'hubitat-native-dashboard.zip',
    patches: applied,
    relabels: relabelCounts.filter((c) => c.hits > 0).length,
    bytes: Object.fromEntries(files.map(([n, c]) => [n, Buffer.byteLength(c, 'utf8')])),
  };
  await writeFile(path.join(outDir, 'hnd-manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');

  // ---- size enforcement -----------------------------------------------------
  console.log('\noutput:');
  let failed = false;
  for (const [name, content] of files) {
    const bytes = Buffer.byteLength(content, 'utf8');
    const overFm = bytes > FILE_MANAGER_MAX;
    const overCloud = bytes > CLOUD_RESPONSE_MAX;
    const flags = [
      overFm ? 'OVER File Manager 124KB' : null,
      overCloud ? 'OVER cloud response ~118KB' : null,
    ].filter(Boolean);
    if (flags.length) failed = true;
    console.log(
      `  ${name.padEnd(22)} ${String(bytes).padStart(7)} bytes  ${(bytes / 1024).toFixed(1).padStart(6)} KB` +
        (flags.length ? `  <-- ${flags.join(', ')}` : ''),
    );
  }
  console.log(`\nversion: ${version}  (${chunks.length} JS chunk(s))`);

  if (failed) {
    console.error(
      '\nBUILD FAILED: at least one file exceeds a Hubitat ceiling.\n' +
        'Lower --chunk-kb (JS chunks) or, if hnd-shell.html itself is too big, the\n' +
        "upstream page's CSS + markup have outgrown one response and the shell needs\n" +
        'splitting too.',
    );
    process.exitCode = 1;
    return;
  }

  console.log(
    `\nNext:\n` +
      `  App code:  install ${args.out}/hubitat-native-dashboard.zip via Bundles, or paste ${APP_SOURCE}.\n` +
      `  UI files:  use the app's "Install/update dashboard UI" button, or upload the\n` +
      `             hnd-* files in ${args.out}/ to Settings -> File Manager by hand.`,
  );
}

main().catch((err) => {
  console.error(`\nBUILD FAILED: ${err.message}`);
  process.exitCode = 1;
});
