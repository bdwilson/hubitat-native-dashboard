// Hubitat Native Dashboard — Maker API wrapper spike
//
// PROOF OF CONCEPT. Not a real dashboard. Validates one question: can a
// native, OAuth-enabled Hubitat App proxy an existing Maker API instance
// (internal httpGet to its own 127.0.0.1:8080) and serve a minimal browser UI entirely
// from the hub, with no external hosting at all?
//
// Standalone spike — deliberately NOT wired into
// https://github.com/bdwilson/cf-hubitat-dashboard. See this repo's
// CLAUDE.md for the full context, the architecture comparison, and which
// patterns below are verified against evdev/hubitat-modern-dashboard's
// actual shipped source vs. newly written for this spike.
//
// NOT YET TESTED ON A REAL HUB. See README.md for setup + test steps and
// where to report back what actually happened.
//
// INSTALL:
//   1. Apps Code -> New App -> paste this file -> Save.
//   2. Click "OAuth" (top of the code editor) -> Enable OAuth -> Save.
//   3. Apps -> Add User App -> Hubitat Native Dashboard (spike).
//   4. First create a Maker API app (Apps -> Add Built-in App -> Maker API)
//      if you don't already have one, select the devices you want exposed,
//      and note its App ID and Access Token (shown on its own app page).
//   5. Enter that Maker API App ID + Access Token into this app's page,
//      click Done.
//   6. Reopen this app's page for the Local/Cloud dashboard links.

definition(
    name: "Hubitat Native Dashboard (spike)",
    namespace: "bdwilson",
    author: "bdwilson",
    description: "Proof-of-concept: native on-hub dashboard that wraps an existing Maker API instance. Not a production dashboard.",
    category: "My Apps",
    iconUrl: "",
    iconX2Url: "",
    oauth: [displayName: "Hubitat Native Dashboard (spike)", displayLink: ""]
)

preferences {
    page(name: "mainPage", title: "Hubitat Native Dashboard (spike)", install: true, uninstall: true)
}

def mainPage() {
    if (!state.accessToken) {
        createAccessToken()
    }
    dynamicPage(name: "mainPage", install: true, uninstall: true) {
        section("What this is") {
            paragraph "Proof-of-concept spike: this app proxies an existing Maker API " +
                "instance so a dashboard can be served entirely from this hub, with no " +
                "external hosting. Not a real dashboard yet — see the linked repo's README."
        }
        section("Maker API connection") {
            paragraph "Create a Maker API app first if you don't have one (Apps -> Add " +
                "Built-in App -> Maker API), select the devices you want available here, " +
                "then paste its App ID and Access Token below (both shown on the Maker API " +
                "app's own page)."
            input "makerApiAppId", "text", title: "Maker API App ID", required: true, submitOnChange: true
            input "makerApiToken", "text", title: "Maker API Access Token", required: true, submitOnChange: true
        }
        section("Dashboard links") {
            if (state.accessToken) {
                paragraph "<b>Local:</b><br><a href='${localDashboardUrl()}' target='_blank'>${localDashboardUrl()}</a>"
                paragraph "<b>Cloud:</b><br><a href='${cloudDashboardUrl()}' target='_blank'>${cloudDashboardUrl()}</a>"
                paragraph "Anyone with either link can control the devices exposed through " +
                    "your Maker API instance. Treat these links like secrets, same as Maker API's own URLs."
            } else {
                paragraph "OAuth token not yet created — click Done, then reopen this page."
            }
        }
    }
}

def installed() { initialize() }
def updated() { initialize() }
def initialize() {
    if (!state.accessToken) {
        try {
            createAccessToken()
        } catch (e) {
            log.error "Could not create an OAuth token — click 'OAuth' in Apps Code and enable it for this app, then Save and reinstall. ${e.message}"
        }
    }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// Both links point at "/dashboard", not the bare root "/". evdev/hubitat-
// modern-dashboard's own dashboardUrl() builder does the same
// ("${base}/dashboard?access_token=...") even though its mappings block
// also (redundantly) maps "/" — "/dashboard" is what its real, shipping
// cloud links actually use. This spike's cloud link 403'd with AWS API
// Gateway's "Missing Authentication Token" (its generic no-matching-route
// response) when pointed at bare "/"; switching to "/dashboard" to match
// the precedent that's actually exercised in production.
private String localDashboardUrl() {
    "${getFullLocalApiServerUrl()}/dashboard?access_token=${state.accessToken}"
}

private String cloudDashboardUrl() {
    "${getFullApiServerUrl()}/dashboard?access_token=${state.accessToken}"
}

// Internal call to this hub's own Maker API instance — the same mechanism
// evdev/hubitat-modern-dashboard uses to read its own File Manager assets
// (an App calling its own hub over HTTP), just pointed at Maker API instead
// of /local/. See CLAUDE.md's "Verified Hubitat/Groovy patterns" section
// for where this pattern was confirmed.
//
// Uses 127.0.0.1:8080 — real-hub testing showed both plain 127.0.0.1 (port
// 80) and location.hub.localIP (port 80) get connection refused from app
// code. Port 80/443 fronts the hub's admin/browser-facing web server; the
// internal app engine that serves /apps/api/... to the hub calling itself
// listens on 8080/8443. Confirmed against the Hubitat community's own
// documented convention for this (thebearmay/hubitat's endpoints
// reference: "use ports 8080 and 8443 and IP 127.0.0.1 if calling hub
// from itself" — https://raw.githubusercontent.com/thebearmay/hubitat/main/libraries/endpoints.txt).
private String makerApiLocalBase() {
    "http://127.0.0.1:8080/apps/api/${makerApiAppId}"
}

// ---------------------------------------------------------------------------
// HTTP mappings — static paths + query params only. Hubitat's colon-style
// path-variable mapping syntax (path("/devices/:id")) is NOT used here
// because it hasn't been verified against real shipped code; evdev's own
// project avoids it too, using GET /cmd?id=&c=&v= instead. See CLAUDE.md.
// ---------------------------------------------------------------------------
mappings {
    path("/")            { action: [GET: "renderIndex"] }
    path("/dashboard")   { action: [GET: "renderIndex"] }
    path("/devices/all") { action: [GET: "proxyDevicesAll"] }
    path("/cmd")          { action: [GET: "proxyCommand"] }
}

def renderIndex() {
    render contentType: "text/html", data: indexHtml(), status: 200
}

def proxyDevicesAll() {
    def result = makerApiGet("/devices/all")
    render contentType: "application/json", data: result, status: 200
}

// GET /cmd?id=<deviceId>&c=<command>&v=<optionalSingleArgument>
// Mirrors Maker API's own /devices/{id}/{command}/{secondary} shape
// internally — only the external URL convention differs (query params
// instead of path segments), per the mapping-syntax note above.
def proxyCommand() {
    def id  = params?.id
    def cmd = params?.c
    def val = params?.v
    if (!id || !cmd) {
        render contentType: "application/json", data: '{"error":"missing id or c query param"}', status: 400
        return
    }
    def path = "/devices/${id}/${cmd}" + (val ? "/${val}" : "")
    def result = makerApiGet(path)
    render contentType: "application/json", data: result, status: 200
}

private String makerApiGet(String path) {
    def result = '{"error":"no response"}'
    try {
        def uri = "${makerApiLocalBase()}${path}?access_token=${makerApiToken}"
        httpGet([uri: uri, contentType: "text/plain", textParser: true, timeout: 20, ignoreSSLIssues: true]) { resp ->
            def code = resp?.status ?: resp?.statusCode
            if (code == 200 && resp?.data != null) {
                def data = resp.getData() != null ? resp.getData() : resp.data
                result = readHttpBody(data)
            } else {
                result = "{\"error\":\"Maker API returned HTTP ${code}\"}"
            }
        }
    } catch (e) {
        log.error "makerApiGet(${path}): ${e.message}"
        result = "{\"error\":\"${e.message?.replace('"', "'")}\"}"
    }
    return result
}

// Adapted from evdev/hubitat-modern-dashboard's readHttpBody() (Apache 2.0) —
// see NOTICE. resp.data from httpGet is not reliably a plain String; it can
// be Reader-like and needs draining defensively.
private String readHttpBody(data) {
    if (data == null) return ""
    try {
        def sb = new StringBuilder()
        int i = data.read()
        while (i != -1) {
            sb.append((char) i)
            i = data.read()
        }
        if (sb.length() > 0) return sb.toString()
    } catch (e) {}
    def s = data.toString()
    return s.startsWith("java.io.") ? "" : s
}

// ---------------------------------------------------------------------------
// Minimal test page — proves the mechanism (OAuth-gated page, device list
// via the Maker API proxy, on/off commands via the proxy). Not a real
// dashboard UI; deliberately small so failures are easy to isolate.
//
// This is a method (not a top-level "private static final" field) because
// Hubitat compiles app code as a Groovy script, not a class — modifiers
// like private/static are not valid on top-level declarations there
// ("Modifier 'private' not allowed here"). A method returning the string
// is the working equivalent.
// ---------------------------------------------------------------------------
private String indexHtml() {
    '''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Native Dashboard Spike</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #16181d; color: #e8e8ea; margin: 0; padding: 16px; }
  h1 { font-size: 18px; margin: 0 0 4px; }
  p.sub { color: #9a9ba3; font-size: 13px; margin: 0 0 16px; }
  #status { padding: 10px 12px; border-radius: 6px; font-size: 13px; margin-bottom: 12px; }
  #status.ok { background: #16331f; color: #7fd99a; }
  #status.err { background: #3a1a1a; color: #f0a3a3; }
  .device { display: flex; align-items: center; justify-content: space-between; gap: 12px; padding: 10px 12px; background: #1f222a; border-radius: 6px; margin-bottom: 6px; }
  .device .name { font-size: 14px; }
  .device .meta { font-size: 11px; color: #9a9ba3; }
  .device button { background: #2d7fbf; color: #fff; border: none; border-radius: 4px; padding: 6px 10px; font-size: 12px; cursor: pointer; }
  .device button:active { background: #235f8f; }
  .device button.off { background: #444; }
</style>
</head>
<body>
<h1>Hubitat Native Dashboard — spike</h1>
<p class="sub">Proof of concept only. Devices come from your Maker API instance, proxied through this app.</p>
<div id="status">Loading devices…</div>
<div id="devices"></div>
<script>
(() => {
  'use strict';
  // Fetch paths below are deliberately path-relative (no leading "/"): this
  // page is served at .../apps/api/<appId>/ (local) or .../apps/<appId>/
  // (cloud), and a root-relative fetch would resolve against the hub's
  // origin root instead of that app base, missing this app's mappings
  // entirely and hitting something else on the hub instead.
  const token = new URLSearchParams(location.search).get('access_token') || '';
  const q = token ? ('?access_token=' + encodeURIComponent(token)) : '';

  function setStatus(text, ok) {
    const el = document.getElementById('status');
    el.textContent = text;
    el.className = ok ? 'ok' : 'err';
  }

  // Maker API's /devices/all returns "attributes" as a flat object keyed by
  // attribute name (e.g. {"switch":"off"}), not an array of {name,
  // currentValue} objects — confirmed against community-documented example
  // responses. Handles a {value: ...}-wrapped shape too, just in case.
  function getAttr(device, name) {
    if (!device.attributes || typeof device.attributes !== 'object') return undefined;
    const v = device.attributes[name];
    if (v && typeof v === 'object' && 'value' in v) return v.value;
    return v;
  }

  async function sendCommand(id, cmd) {
    try {
      const r = await fetch('cmd?id=' + encodeURIComponent(id) + '&c=' + encodeURIComponent(cmd) + '&access_token=' + encodeURIComponent(token));
      const body = await r.json();
      if (body && body.error) throw new Error(body.error);
      setStatus('Sent "' + cmd + '" to device ' + id, true);
      // Buttons capture on/off state at render time (a closure over the
      // device list from the last load()), so nothing on the page reflects
      // the new state until the list is re-fetched and re-rendered.
      await load();
    } catch (e) {
      setStatus('Command failed: ' + e.message, false);
    }
  }

  function renderDevices(devices) {
    const container = document.getElementById('devices');
    container.innerHTML = '';
    devices.forEach(d => {
      const row = document.createElement('div');
      row.className = 'device';
      const hasSwitch = getAttr(d, 'switch') !== undefined;
      const on = getAttr(d, 'switch') === 'on';
      row.innerHTML =
        '<div><div class="name">' + (d.label || d.name || d.id) + '</div>' +
        '<div class="meta">#' + d.id + ' · ' + (d.type || '') + '</div></div>';
      if (hasSwitch) {
        const btn = document.createElement('button');
        btn.textContent = on ? 'On' : 'Off';
        btn.className = on ? '' : 'off';
        btn.onclick = () => sendCommand(d.id, on ? 'off' : 'on');
        row.appendChild(btn);
      }
      container.appendChild(row);
    });
  }

  async function load() {
    if (!token) { setStatus('No access_token in URL — open this page from the app\\'s own link.', false); return; }
    try {
      const r = await fetch('devices/all' + q);
      const body = await r.json();
      if (body && body.error) throw new Error(body.error);
      if (!Array.isArray(body)) throw new Error('Unexpected response shape — got: ' + JSON.stringify(body).slice(0, 200));
      setStatus('Loaded ' + body.length + ' device(s) via Maker API proxy.', true);
      renderDevices(body);
    } catch (e) {
      setStatus('Failed to load devices: ' + e.message, false);
    }
  }

  load();
})();
</script>
</body>
</html>
'''
}
