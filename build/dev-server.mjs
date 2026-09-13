#!/usr/bin/env node
/**
 * Local stand-in for the Hubitat App, for working on the frontend/build without
 * a hub.
 *
 *   node build/build.mjs && node build/dev-server.mjs
 *   -> http://127.0.0.1:8099/apps/api/1/dashboard?access_token=devtoken
 *
 * It implements the same routes the Groovy app exposes (dashboard, asset, hub,
 * config) and serves them under a base path of the same SHAPE the hub uses
 * (/apps/api/<appId>/...). The base path matters: every URL the built dashboard
 * requests is relative, so serving it from the web root would not exercise the
 * thing most likely to break.
 *
 * IMPORTANT: this is a simulation, not the app. It is a second implementation
 * of those routes in JavaScript and can drift from app/HubitatNativeDashboard.groovy.
 * A green run here means the built frontend, the chunk loader and the transport
 * patches are sound. It says nothing about whether the Groovy is correct — only
 * a real hub can say that.
 *
 * Device data is faked in Maker API's documented /devices/all shape (attributes
 * as a flat object keyed by name), so tile rendering exercises the real shape.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.resolve(REPO_ROOT, 'dist');
const PORT = Number(process.env.PORT || 8099);
const APP_ID = '1';
const BASE = `/apps/api/${APP_ID}`;
const TOKEN = 'devtoken';

const FAKE_DEVICES = [
  {
    id: '101', name: 'Generic Zigbee Outlet', label: 'Living Room Lamp', type: 'Generic Zigbee Outlet',
    capabilities: ['Actuator', 'Switch', 'Refresh'],
    attributes: { switch: 'off' },
    commands: [{ command: 'on' }, { command: 'off' }, { command: 'refresh' }],
  },
  {
    id: '102', name: 'Generic Zigbee Dimmer', label: 'Kitchen Lights', type: 'Generic Zigbee Dimmer',
    capabilities: ['Actuator', 'Switch', 'SwitchLevel'],
    attributes: { switch: 'on', level: '65' },
    commands: [{ command: 'on' }, { command: 'off' }, { command: 'setLevel' }],
  },
  {
    id: '103', name: 'Contact Sensor', label: 'Front Door', type: 'Generic Zigbee Contact Sensor',
    capabilities: ['ContactSensor', 'Battery'],
    attributes: { contact: 'closed', battery: '87' },
    commands: [],
  },
  {
    id: '104', name: 'Temp Sensor', label: 'Porch', type: 'Generic Zigbee Temperature Sensor',
    capabilities: ['TemperatureMeasurement', 'Battery'],
    attributes: { temperature: '71.4', battery: '92' },
    commands: [],
  },
  {
    id: '105', name: 'Lock', label: 'Back Door Lock', type: 'Generic Z-Wave Lock',
    capabilities: ['Lock', 'Battery'],
    attributes: { lock: 'locked', battery: '55' },
    commands: [{ command: 'lock' }, { command: 'unlock' }],
  },
];

/** In-memory stand-in for the app's `state.configJson`. */
let storedConfig = null;

function defaultDashboard() {
  return { title: 'Home', pollSec: 5, slots: {} };
}

function loadConfig() {
  if (!storedConfig) return { dashboard: defaultDashboard() };
  return JSON.parse(storedConfig);
}

function json(res, value, status = 200) {
  const body = typeof value === 'string' ? value : JSON.stringify(value);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
  });
  res.end(body);
}

const ASSET_RE = /^hnd-[A-Za-z0-9._-]{1,60}\.(js|html|json|css)$/;

function contentTypeFor(name) {
  if (name.endsWith('.js')) return 'application/javascript; charset=utf-8';
  if (name.endsWith('.css')) return 'text/css; charset=utf-8';
  if (name.endsWith('.json')) return 'application/json; charset=utf-8';
  return 'text/html; charset=utf-8';
}

/** Mirrors the Groovy app's Maker API proxy, against the fake device list. */
function handleHub(subPath, res) {
  if (subPath === '/devices/all' || subPath === '/devices') {
    return json(res, FAKE_DEVICES);
  }
  // Maker API also exposes hub-level endpoints the dashboard polls for its
  // status bar. Faked here so a dev run has no spurious 404s hiding real ones.
  if (subPath === '/modes') {
    return json(res, [
      { id: 1, name: 'Day', active: true },
      { id: 2, name: 'Evening', active: false },
      { id: 3, name: 'Night', active: false },
    ]);
  }
  if (subPath.startsWith('/modes/')) {
    const want = subPath.split('/')[2];
    return json(res, [
      { id: 1, name: 'Day', active: want === '1' },
      { id: 2, name: 'Evening', active: want === '2' },
      { id: 3, name: 'Night', active: want === '3' },
    ]);
  }
  if (subPath === '/hsm') return json(res, { hsm: 'disarmed' });
  if (subPath.startsWith('/hsm/')) return json(res, { hsm: subPath.split('/')[2] });
  const m = subPath.match(/^\/devices\/([^/]+)$/);
  if (m) {
    const d = FAKE_DEVICES.find((x) => x.id === m[1]);
    return d ? json(res, d) : json(res, { error: 'device not found' }, 404);
  }
  // /devices/{id}/{command}[/{secondary}]
  const c = subPath.match(/^\/devices\/([^/]+)\/([^/]+)(?:\/([^/]+))?$/);
  if (c) {
    const [, id, command, arg] = c;
    const d = FAKE_DEVICES.find((x) => x.id === id);
    if (!d) return json(res, { error: 'device not found' }, 404);
    if (command === 'on' || command === 'off') d.attributes.switch = command;
    else if (command === 'setLevel' && arg != null) d.attributes.level = String(arg);
    else if (command === 'lock' || command === 'unlock') {
      d.attributes.lock = command === 'lock' ? 'locked' : 'unlocked';
    }
    console.log(`  [hub] ${id} <- ${command}${arg != null ? '/' + arg : ''}`);
    return json(res, d);
  }
  return json(res, { error: `unhandled hub path ${subPath}` }, 404);
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname.startsWith(BASE) ? url.pathname.slice(BASE.length) : null;
  console.log(`${req.method} ${url.pathname}${url.search ? '?…' : ''}`);

  if (route === null) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    return res.end(`not found — try ${BASE}/dashboard?access_token=${TOKEN}`);
  }

  // The app rejects requests without the OAuth token; mirror that so a missing
  // token in the built frontend shows up here rather than on a real hub.
  const token = url.searchParams.get('access_token');
  if (route !== '/status' && token !== TOKEN) {
    return json(res, { error: 'missing or bad access_token' }, 401);
  }

  if (route === '/' || route === '/dashboard') {
    const shell = path.join(DIST, 'hnd-shell.html');
    if (!existsSync(shell)) {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<h1>Run `node build/build.mjs` first</h1>');
    }
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store, no-cache, must-revalidate, max-age=0',
    });
    return res.end(await readFile(shell, 'utf8'));
  }

  if (route === '/asset') {
    const name = url.searchParams.get('f') || '';
    if (!ASSET_RE.test(name)) return json(res, { error: 'unknown asset' }, 400);
    const file = path.join(DIST, name);
    if (!existsSync(file)) return json(res, { error: `${name} not found` }, 404);
    res.writeHead(200, {
      'content-type': contentTypeFor(name),
      'cache-control': url.searchParams.get('v')
        ? 'private, max-age=31536000, immutable'
        : 'no-store',
    });
    return res.end(await readFile(file, 'utf8'));
  }

  if (route === '/hub') {
    let p = url.searchParams.get('path') || '';
    if (!p) return json(res, { error: 'missing path query param' }, 400);
    if (!p.startsWith('/')) p = '/' + p;
    if (p.includes('..') || p.toLowerCase().includes('access_token')) {
      return json(res, { error: 'invalid path' }, 400);
    }
    return handleHub(p, res);
  }

  if (route === '/config') {
    if (req.method === 'GET') {
      const cfg = loadConfig();
      const includeSecrets = url.searchParams.get('include_secrets') === '1';
      const hub = { baseUrl: 'http://127.0.0.1', appId: APP_ID, isCloud: false };
      if (includeSecrets) hub.token = 'fake-maker-token';
      else hub.hasToken = true;
      const out = { hub, dashboard: cfg.dashboard || defaultDashboard() };
      for (const k of ['dynamic', 'custom', 'dashboardsVisible', 'dashboardsOrder', 'statusBarPresenceDevices']) {
        if (cfg[k] != null) out[k] = cfg[k];
      }
      return json(res, out);
    }
    if (req.method === 'PUT' || req.method === 'POST') {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return json(res, { error: 'body must be a JSON object' }, 400);
      }
      const cfg = loadConfig();
      if (body.dashboard && typeof body.dashboard === 'object') {
        const existing = cfg.dashboard || defaultDashboard();
        const d = body.dashboard;
        const merged = { ...existing };
        for (const k of ['title', 'pollSec', 'layout', 'gridCols', 'tileH', 'iconScale',
                         'hubExternalUrl', 'chipAccent', 'chipAccentDynamic', 'theme']) {
          if (d[k] != null) merged[k] = d[k];
        }
        if (d.slots && typeof d.slots === 'object') {
          merged.slots = { ...(existing.slots || {}), ...d.slots };
        }
        cfg.dashboard = merged;
      }
      for (const k of ['dynamic', 'custom', 'dashboardsVisible', 'dashboardsOrder', 'statusBarPresenceDevices']) {
        if (body[k] != null) cfg[k] = body[k];
      }
      storedConfig = JSON.stringify(cfg);
      console.log(`  [config] stored ${storedConfig.length} bytes`);
      return json(res, { ok: true });
    }
    if (req.method === 'DELETE') {
      storedConfig = null;
      return json(res, { ok: true });
    }
    return json(res, { error: 'method not allowed' }, 405);
  }

  if (route === '/status') {
    return json(res, { app: 'dev-server', assetsOk: existsSync(path.join(DIST, 'hnd-shell.html')) });
  }

  return json(res, { error: `no route ${route}` }, 404);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`dev server: http://127.0.0.1:${PORT}${BASE}/dashboard?access_token=${TOKEN}`);
});
