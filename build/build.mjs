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

  // In ?local=1 the hub config is neither read nor written, so "Save Config to
  // Hub" would do nothing while reporting success. Replace it with a statement
  // of what is actually happening rather than leaving a button that lies.
  function markLocalOnlyMode() {
    if (new URLSearchParams(location.search).get('local') !== '1') return;
    try {
      var save = document.getElementById('save-cfg');
      if (save) save.style.display = 'none';
      var modal = document.getElementById('settings-modal');
      var card = modal ? modal.querySelector('.modal-card') : null;
      if (card && !document.getElementById('hnd-local-note')) {
        var note = document.createElement('div');
        note.id = 'hnd-local-note';
        note.className = 'help';
        note.style.cssText = 'border-left:3px solid #ef6c00;padding-left:8px;margin:8px 0';
        note.innerHTML =
          '<b>Local-only mode.</b> This browser keeps its own layout and does not ' +
          'read or write the dashboard config stored on the hub. Devices and ' +
          'commands still go to the same hub. Drop <code>&amp;local=1</code> from the ' +
          'URL to go back to the shared layout.';
        card.insertBefore(note, card.firstChild ? card.firstChild.nextSibling : null);
      }
    } catch (e) {
      console.warn('local-only marker skipped', e);
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
    markLocalOnlyMode();
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
    upstreamSource: src.at,
    builtAt: new Date().toISOString(),
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
