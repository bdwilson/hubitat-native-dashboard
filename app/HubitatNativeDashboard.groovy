// Hubitat Native Dashboard — an on-hub port of bdwilson/cf-hubitat-dashboard
//
// Runs the same dashboard frontend as the Cloudflare Worker build, but served
// entirely from the hub: no Cloudflare account, no Worker, no KV, no external
// hosting. The App wraps an existing Maker API instance for device access and
// stores dashboard config in its own `state`.
//
// Config is stored in — and exported in — exactly the shape the Cloudflare
// build uses, so a config exported from either dashboard imports into the
// other. See CONFIG COMPATIBILITY below.
//
// THE UI IS NOT IN THIS FILE. Hubitat cannot compile a ~280 KB frontend into
// App code, and Hubitat Cloud caps a single response at ~128 KB. So the UI is
// built into chunks (see build/build.mjs), uploaded to the hub's File Manager,
// and re-served through this app's own routes. That is the same approach
// evdev/hubitat-modern-dashboard uses, for the same two reasons.
//
// INSTALL:
//   1. Maker API: Apps -> Add Built-in App -> Maker API. Select the devices you
//      want on the dashboard. Note its App ID and Access Token.
//   2. Build the UI:  node build/build.mjs
//   3. Upload every file from dist/ to Settings -> File Manager on the hub.
//   4. Apps Code -> New App -> paste this file -> Save.
//   5. Click "OAuth" -> Enable OAuth -> Save.
//   6. Apps -> Add User App -> Hubitat Native Dashboard.
//   7. Paste the Maker API App ID + Access Token, click Done.
//   8. Reopen the app for the Local/Cloud dashboard links.
//
// CONFIG COMPATIBILITY (with bdwilson/cf-hubitat-dashboard):
//   GET  config                    -> PublicConfig (no token)
//   GET  config?include_secrets=1  -> FullConfig (includes the Maker API token)
//   PUT  config                    -> partial update, same merge rules as the Worker
//   DEL  config                    -> wipe dashboard config (Maker API creds are
//                                     app preferences and are NOT touched)
//   The JSON shape matches the Worker's /api/config byte-for-byte in the fields
//   both support, which is what makes Download Config / Upload Config portable
//   in both directions.

definition(
    name: "Hubitat Native Dashboard",
    namespace: "bdwilson",
    author: "bdwilson",
    description: "On-hub port of cf-hubitat-dashboard: serves the same dashboard from the hub itself, wrapping an existing Maker API instance. No external hosting.",
    category: "My Apps",
    iconUrl: "",
    iconX2Url: "",
    importUrl: "https://raw.githubusercontent.com/bdwilson/hubitat-native-dashboard/main/app/HubitatNativeDashboard.groovy",
    oauth: [displayName: "Hubitat Native Dashboard", displayLink: ""]
)

preferences {
    page(name: "mainPage", title: "Hubitat Native Dashboard", install: true, uninstall: true)
}

// ---------------------------------------------------------------------------
// Asset names. These must match what build/build.mjs emits into dist/.
// ---------------------------------------------------------------------------

// Bump when this file changes in a way users should know about. Surfaced on the
// settings page and by the `status` route so an installed app can be identified
// without diffing source.
private String appVersion() { "1.1.0" }

private String shellFileName() { "hnd-shell.html" }
private String manifestFileName() { "hnd-manifest.json" }

// Only files matching this are readable through the `asset` route. Without it,
// the cloud endpoint would become an unauthenticated reader for every file in
// File Manager — locally those are already served at /local/<file>, but over
// the cloud link they are not, and this app must not be the thing that changes
// that.
private String assetNamePattern() { /^hnd-[A-Za-z0-9._-]{1,60}\.(js|html|json|css)$/ }

// ---------------------------------------------------------------------------
// Settings page
// ---------------------------------------------------------------------------

def mainPage() {
    if (!state.accessToken) {
        createAccessToken()
    }
    dynamicPage(name: "mainPage", install: true, uninstall: true) {
        section("Maker API connection") {
            paragraph "This app reads devices and sends commands through an existing " +
                "Maker API instance on this hub. Create one first (Apps -> Add Built-in " +
                "App -> Maker API), select the devices you want on the dashboard, then " +
                "paste its App ID and Access Token here."
            input "makerApiAppId", "text", title: "Maker API App ID", required: true, submitOnChange: true
            input "makerApiToken", "text", title: "Maker API Access Token", required: true, submitOnChange: true
        }

        section("Dashboard UI files") {
            def status = assetStatus()
            if (status.ok) {
                paragraph "<b style='color:#2e7d32'>Installed and verified.</b> ${status.message}"
            } else {
                paragraph "<b style='color:#c62828'>Problem.</b> ${status.message}"
            }

            def upd = updateStatus(false)
            if (!upd.checked) {
                paragraph "<b>Updates:</b> not checked yet."
            } else if (!upd.ok) {
                paragraph "<b style='color:#c62828'>Update check failed.</b> ${upd.message}"
            } else if (upd.upToDate) {
                paragraph "<b style='color:#2e7d32'>Up to date.</b> ${upd.message}"
            } else {
                paragraph "<b style='color:#ef6c00'>Update available.</b> ${upd.message}" +
                    (upd.builtAt ? "<br><span style='font-size:12px'>Built ${upd.builtAt}</span>" : "")
            }
            input "checkUpdates", "button", title: "Check for updates"

            if (state.uiInstallResult) {
                paragraph "<span style='font-size:12px'><b>Last install:</b> ${state.uiInstallResult}</span>"
            }
            if (hasHubFileApi()) {
                paragraph "Click below to download the built UI and write it into this hub's " +
                    "File Manager. This is the only time anything is fetched from outside the " +
                    "hub — serving, devices and config are all local afterwards."
                input "installUi", "button", title: "Install / update dashboard UI"
                input "uiSourceUrl", "text", title: "UI source URL (blank = this project's GitHub)",
                    required: false, submitOnChange: false
            } else {
                paragraph "This hub runs firmware ${location.hub.firmwareVersionString}. Writing " +
                    "File Manager files from an app needs 2.3.4.134 or newer, so install the UI by " +
                    "hand: run <code>node build/build.mjs</code> and upload the <code>hnd-*</code> " +
                    "files from <code>dist/</code> to <b>Settings -> File Manager</b>."
            }
            input "checkAssets", "button", title: "Re-check File Manager"
        }

        section("Dashboard links") {
            if (state.accessToken) {
                paragraph "<b>Local:</b><br><a href='${localDashboardUrl()}' target='_blank'>${localDashboardUrl()}</a>"
                paragraph "<b>Cloud:</b><br><a href='${cloudDashboardUrl()}' target='_blank'>${cloudDashboardUrl()}</a>"
                paragraph "Anyone with either link can control every device exposed through " +
                    "your Maker API instance. Treat these links like secrets — the same trust " +
                    "model as Maker API's own URLs."
                paragraph "Real-time updates via the hub's event socket work on the <b>local</b> " +
                    "link only. The cloud link polls instead — Hubitat's cloud proxy does not " +
                    "expose the event socket."
            } else {
                paragraph "OAuth token not yet created — click Done, then reopen this page."
            }
        }

        section("Config") {
            paragraph "Dashboard layout and settings are stored in this app and are " +
                "export-compatible with the Cloudflare build (cf-hubitat-dashboard): use " +
                "<b>Download Config</b> / <b>Upload Config</b> in the dashboard's own settings " +
                "panel to move between them."
            paragraph "Stored config size: ${storedConfigBytes()} bytes."
            input "resetConfig", "bool", title: "Wipe stored dashboard config on Done (Maker API credentials are kept)", defaultValue: false
        }

        section("About") {
            def st = assetStatus()
            paragraph "<span style='font-size:12px'>App version <b>${appVersion()}</b> &middot; " +
                "UI build <b>${st.installedVersion ?: 'not installed'}</b> &middot; " +
                "hub firmware ${location?.hub?.firmwareVersionString}</span>"
        }
    }
}

def appButtonHandler(String btn) {
    if (btn == "checkAssets") {
        state.remove("assetStatusCache")
        state.remove("assetStatusAt")
    } else if (btn == "installUi") {
        def result = installUiFiles()
        state.uiInstallResult = "${result.message} (${new Date().format('yyyy-MM-dd HH:mm', location.timeZone)})"
        // The installed build just changed, so both cached answers are stale.
        state.remove("assetStatusCache")
        state.remove("assetStatusAt")
        state.remove("updateCheckJson")
        state.remove("updateCheckAt")
        if (result.ok) {
            log.info "Dashboard UI install: ${result.message}"
        } else {
            log.error "Dashboard UI install failed: ${result.message}"
        }
    } else if (btn == "checkUpdates") {
        def upd = updateStatus(true)
        log.info "Dashboard UI update check: ${upd.message}"
    }
}

// Checking the assets means self-fetching the shell, the manifest and every JS
// chunk — a few hundred KB of loopback HTTP. The settings page re-renders on
// every input change, so without this cache that happens constantly. The
// "Re-check File Manager" button clears it.
private Map assetStatus() {
    def age = now() - ((state.assetStatusAt ?: 0) as Long)
    if (state.assetStatusCache && age < 60000) {
        try {
            def cached = new groovy.json.JsonSlurper().parseText(state.assetStatusCache.toString())
            if (cached instanceof Map) return cached
        } catch (e) { /* fall through and re-check */ }
    }
    def result = assetStatusUncached()
    state.assetStatusCache = groovy.json.JsonOutput.toJson(result)
    state.assetStatusAt = now()
    return result
}

// Checks the installed UI is not just present but internally consistent:
//
//  - every file the manifest lists actually exists, and
//  - each one is the size the manifest recorded at build time, and
//  - the shell's own build stamp matches the manifest's version.
//
// Presence alone is not enough. Re-uploading some files and not others leaves a
// shell from one build driving chunks from another: the shell embeds the chunk
// list and the ?v= cache key, so the mismatch produces a dashboard that loads
// and then misbehaves, with nothing obviously missing to point at.
private Map assetStatusUncached() {
    def shell = fetchLocalAsset(shellFileName())
    if (!shell) {
        return [ok: false, installedVersion: null,
                message: "${shellFileName()} is not in File Manager yet."]
    }

    def manifestRaw = fetchLocalAsset(manifestFileName())
    if (!manifestRaw) {
        return [ok: false, installedVersion: null,
                message: "${shellFileName()} is installed but ${manifestFileName()} is missing, so its build " +
                    "cannot be identified or verified. Re-install the UI."]
    }

    def m
    try {
        m = new groovy.json.JsonSlurper().parseText(manifestRaw)
    } catch (e) {
        return [ok: false, installedVersion: null,
                message: "${manifestFileName()} is not valid JSON (${e.message}). Re-install the UI."]
    }

    def version = (m?.version ?: "unknown").toString()
    def chunks = (m?.chunks instanceof List) ? m.chunks*.toString() : []
    def sizes = (m?.bytes instanceof Map) ? m.bytes : [:]

    def problems = []

    def stamp = shellBuildStamp(shell)
    if (stamp && stamp != version) {
        problems << "${shellFileName()} is from build ${stamp} but the manifest says ${version} — mixed builds"
    } else if (!stamp) {
        problems << "${shellFileName()} has no build stamp (built by an older version of build.mjs)"
    }

    ([shellFileName()] + chunks).each { name ->
        def expected = sizes[name]
        def actual = (name == shellFileName()) ? byteLength(shell) : assetByteLength(name)
        if (actual == 0) {
            problems << "${name} is missing"
        } else if (expected instanceof Number && actual != (expected as Integer)) {
            problems << "${name} is ${actual} bytes, expected ${expected} — stale or truncated"
        }
    }

    if (problems) {
        return [ok: false, installedVersion: version,
                message: "Build ${version} has problems: ${problems.join('; ')}."]
    }
    return [ok: true, installedVersion: version,
            message: "Build ${version}, ${chunks.size()} JS chunk(s), all present and the expected size."]
}

private String shellBuildStamp(String shell) {
    def m = (shell =~ /<!--\s*hnd-build:\s*([A-Za-z0-9]+)\s*-->/)
    return m.find() ? m.group(1) : null
}

private int byteLength(String s) {
    s ? s.getBytes("UTF-8").length : 0
}

// Byte length of an installed file. Uses downloadHubFile's byte array directly
// where available so multi-byte characters (the UI has plenty) are counted the
// way the build counted them, rather than as String length.
private int assetByteLength(String name) {
    if (hasHubFileApi()) {
        try {
            byte[] data = downloadHubFile(name)
            return data == null ? 0 : data.length
        } catch (e) {
            return 0
        }
    }
    return byteLength(fetchLocalAsset(name))
}

// ---------------------------------------------------------------------------
// Update checking: compare the installed build against the one at uiSourceUrl.
// ---------------------------------------------------------------------------

private int updateCheckMaxAgeMs() { 21600000 }  // 6 hours

private Map updateStatus(Boolean force = false) {
    def age = now() - ((state.updateCheckAt ?: 0) as Long)
    if (!force && state.updateCheckJson && age < updateCheckMaxAgeMs()) {
        try {
            def cached = new groovy.json.JsonSlurper().parseText(state.updateCheckJson.toString())
            if (cached instanceof Map) return cached
        } catch (e) { /* fall through and re-check */ }
    }
    if (!force) {
        // Never reach out just because the settings page was rendered. An update
        // check is a network call; it happens on the button, or once the cached
        // answer has gone stale.
        if (state.updateCheckJson) {
            try {
                def cached = new groovy.json.JsonSlurper().parseText(state.updateCheckJson.toString())
                if (cached instanceof Map) return cached
            } catch (e) { }
        }
        return [checked: false, message: "Not checked yet."]
    }

    def raw = httpGetText("${uiSourceUrl()}/${manifestFileName()}")
    if (!raw) {
        def result = [checked: true, ok: false,
                      message: "Could not reach ${uiSourceUrl()} to check for updates."]
        state.updateCheckJson = groovy.json.JsonOutput.toJson(result)
        state.updateCheckAt = now()
        return result
    }

    def available = "unknown"
    def builtAt = null
    try {
        def m = new groovy.json.JsonSlurper().parseText(raw)
        available = (m?.version ?: "unknown").toString()
        builtAt = m?.builtAt
    } catch (e) {
        def result = [checked: true, ok: false, message: "Remote ${manifestFileName()} is not valid JSON: ${e.message}"]
        state.updateCheckJson = groovy.json.JsonOutput.toJson(result)
        state.updateCheckAt = now()
        return result
    }

    def installed = assetStatus()?.installedVersion
    def upToDate = (installed != null && installed == available)
    def result = [
        checked  : true,
        ok       : true,
        installed: installed,
        available: available,
        builtAt  : builtAt,
        upToDate : upToDate,
        message  : installed == null
            ? "No UI installed. Build ${available} is available."
            : (upToDate
                ? "Up to date (build ${available})."
                : "Update available: installed ${installed}, available ${available}."),
    ]
    state.updateCheckJson = groovy.json.JsonOutput.toJson(result)
    state.updateCheckAt = now()
    return result
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
    if (settings?.resetConfig) {
        state.remove("configJson")
        app.updateSetting("resetConfig", [value: "false", type: "bool"])
        log.warn "Dashboard config wiped by request. Maker API credentials kept."
    }
}

// ---------------------------------------------------------------------------
// URL helpers
// ---------------------------------------------------------------------------

// Both links point at "/dashboard", not the bare root "/". The cloud link 403s
// with AWS API Gateway's "Missing Authentication Token" (its generic
// no-matching-route response) when pointed at bare "/", confirmed on a real
// hub. evdev's dashboardUrl() builder uses "/dashboard" for the same reason.
private String localDashboardUrl() {
    "${getFullLocalApiServerUrl()}/dashboard?access_token=${state.accessToken}"
}

private String cloudDashboardUrl() {
    "${getFullApiServerUrl()}/dashboard?access_token=${state.accessToken}"
}

// The hub calling itself. Port 8080, NOT 80/443: port 80 fronts the
// admin/browser-facing web server, while the internal app engine that serves
// /apps/api/... and /local/... to the hub itself listens on 8080/8443.
// Confirmed the hard way on real hardware — both plain 127.0.0.1 (port 80) and
// location.hub.localIP (port 80) get connection refused. Matches evdev's
// hubLoginUri() ("http://127.0.0.1:8080") and the Hubitat community's
// documented convention for hub self-calls.
private String hubSelfBase() { "http://127.0.0.1:8080" }

// Fallback for the same idea via the LAN interface. evdev's hubBaseUri() uses
// this form for File Manager reads specifically, so try it if loopback comes
// back empty rather than making the user debug it.
private String hubLanBase() { "http://${location.hub.localIP}:8080" }

private String makerApiLocalBase() {
    "${hubSelfBase()}/apps/api/${settings?.makerApiAppId}"
}

// ---------------------------------------------------------------------------
// HTTP mappings — static paths + query params only. Hubitat's colon-style
// path-variable syntax (path("/devices/:id")) is deliberately unused: it has no
// verified precedent in shipped code. The frontend's whole Maker API sub-path
// is passed to `hub` as one URL-encoded query param instead.
// ---------------------------------------------------------------------------
mappings {
    path("/")            { action: [GET: "renderDashboard"] }
    path("/dashboard")   { action: [GET: "renderDashboard"] }
    path("/asset")       { action: [GET: "serveAsset"] }
    path("/hub")         { action: [GET: "proxyHub"] }
    path("/config")      { action: [GET: "getConfig", PUT: "putConfig", POST: "putConfig", DELETE: "deleteConfig"] }
    path("/status")      { action: [GET: "renderStatus"] }
    // Kept from the original spike — handy for isolating a broken proxy without
    // the whole UI in the way.
    path("/devices/all") { action: [GET: "proxyDevicesAll"] }
    path("/cmd")         { action: [GET: "proxyCommand"] }
}

// ---------------------------------------------------------------------------
// Routes: UI
// ---------------------------------------------------------------------------

def renderDashboard() {
    def shell = fetchLocalAsset(shellFileName())
    if (!shell) {
        render contentType: "text/html", data: setupHtml(), status: 200, headers: noStoreHeaders()
        return
    }
    // no-store: the shell embeds the current build's chunk list, so a stale
    // cached copy would keep asking for chunks that no longer exist.
    render contentType: "text/html", data: shell, status: 200, headers: noStoreHeaders()
}

def serveAsset() {
    def name = params?.f?.toString()
    if (!name || !(name ==~ assetNamePattern())) {
        render contentType: "application/json", data: '{"error":"unknown asset"}', status: 400, headers: noStoreHeaders()
        return
    }
    def body = fetchLocalAsset(name)
    if (!body) {
        render contentType: "application/json",
            data: "{\"error\":\"${jsonEscape(name)} is not in this hub's File Manager\"}",
            status: 404, headers: noStoreHeaders()
        return
    }
    warnIfOverCloudLimit(name, body)
    // A ?v= means the URL is build-stamped, so the response is safe to cache hard.
    def headers = params?.v ? immutableHeaders() : noStoreHeaders()
    render contentType: contentTypeFor(name), data: body, status: 200, headers: headers
}

private String contentTypeFor(String name) {
    if (name.endsWith(".js")) return "application/javascript"
    if (name.endsWith(".css")) return "text/css"
    if (name.endsWith(".json")) return "application/json"
    return "text/html"
}

// ---------------------------------------------------------------------------
// Routes: Maker API proxy
// ---------------------------------------------------------------------------

// GET hub?path=/devices/all
// GET hub?path=/devices/123/setLevel/50
//
// The frontend builds Maker API's own sub-path shape and hands it over whole,
// so the JSON and command semantics stay byte-identical to what the Cloudflare
// build talks to. That is what lets the same frontend drive both.
def proxyHub() {
    def path = params?.path?.toString()
    if (!path) {
        render contentType: "application/json", data: '{"error":"missing path query param"}', status: 400, headers: noStoreHeaders()
        return
    }
    if (!path.startsWith("/")) path = "/" + path
    // Never let a caller smuggle in their own token or escape the app's base.
    if (path.contains("..") || path.toLowerCase().contains("access_token")) {
        render contentType: "application/json", data: '{"error":"invalid path"}', status: 400, headers: noStoreHeaders()
        return
    }
    def result = makerApiGet(path)
    warnIfOverCloudLimit("hub${path}", result)
    render contentType: "application/json", data: result, status: 200, headers: noStoreHeaders()
}

def proxyDevicesAll() {
    def result = makerApiGet("/devices/all")
    warnIfOverCloudLimit("/devices/all", result)
    render contentType: "application/json", data: result, status: 200, headers: noStoreHeaders()
}

// GET cmd?id=<deviceId>&c=<command>&v=<optionalSingleArgument>
def proxyCommand() {
    def id  = params?.id
    def cmd = params?.c
    def val = params?.v
    if (!id || !cmd) {
        render contentType: "application/json", data: '{"error":"missing id or c query param"}', status: 400, headers: noStoreHeaders()
        return
    }
    def path = "/devices/${id}/${cmd}" + (val ? "/${val}" : "")
    def result = makerApiGet(path)
    render contentType: "application/json", data: result, status: 200, headers: noStoreHeaders()
}

// ---------------------------------------------------------------------------
// Routes: config (shape-compatible with cf-hubitat-dashboard's /api/config)
// ---------------------------------------------------------------------------

def getConfig() {
    def cfg = loadConfig()
    def includeSecrets = (params?.include_secrets?.toString() == "1")

    def hub = [
        baseUrl: "http://${location.hub.localIP}",
        appId  : settings?.makerApiAppId ?: "",
        isCloud: false,
    ]
    if (includeSecrets) {
        hub.token = settings?.makerApiToken ?: ""
    } else {
        hub.hasToken = (settings?.makerApiToken ? true : false)
    }

    def out = [
        hub      : hub,
        dashboard: cfg.dashboard ?: defaultDashboard(),
    ]
    if (cfg.dynamic != null)                  out.dynamic = cfg.dynamic
    if (cfg.custom != null)                   out.custom = cfg.custom
    if (cfg.dashboardsVisible != null)        out.dashboardsVisible = cfg.dashboardsVisible
    if (cfg.dashboardsOrder != null)          out.dashboardsOrder = cfg.dashboardsOrder
    if (cfg.statusBarPresenceDevices != null) out.statusBarPresenceDevices = cfg.statusBarPresenceDevices

    render contentType: "application/json",
        data: groovy.json.JsonOutput.toJson(out), status: 200, headers: noStoreHeaders()
}

def putConfig() {
    def body = requestBody()
    if (!(body instanceof Map)) {
        render contentType: "application/json", data: '{"error":"body must be a JSON object"}', status: 400, headers: noStoreHeaders()
        return
    }

    def cfg = loadConfig()

    // body.hub is deliberately ignored. On this build the Maker API credentials
    // are app preferences, not dashboard config — so importing a config exported
    // from the Cloudflare build brings the layout across without repointing this
    // app at whatever hub URL that export happened to contain.
    if (body.dashboard instanceof Map) {
        def existing = (cfg.dashboard instanceof Map) ? cfg.dashboard : defaultDashboard()
        def d = body.dashboard
        def merged = [:] + existing
        if (d.title != null)              merged.title = d.title
        if (d.pollSec != null)            merged.pollSec = d.pollSec
        if (d.slots instanceof Map)       merged.slots = ((existing.slots instanceof Map) ? existing.slots : [:]) + d.slots
        if (d.layout instanceof Map)      merged.layout = d.layout
        if (d.gridCols != null)           merged.gridCols = d.gridCols
        if (d.tileH != null)              merged.tileH = d.tileH
        if (d.iconScale != null)          merged.iconScale = d.iconScale
        if (d.hubExternalUrl != null)     merged.hubExternalUrl = d.hubExternalUrl
        if (d.chipAccent != null)         merged.chipAccent = d.chipAccent
        if (d.chipAccentDynamic != null)  merged.chipAccentDynamic = d.chipAccentDynamic
        if (d.theme != null)              merged.theme = d.theme
        cfg.dashboard = merged
    }
    if (body.dynamic instanceof Map)                  cfg.dynamic = body.dynamic
    if (body.custom instanceof Map)                   cfg.custom = body.custom
    if (body.dashboardsVisible instanceof Map)        cfg.dashboardsVisible = body.dashboardsVisible
    if (body.dashboardsOrder instanceof List)         cfg.dashboardsOrder = body.dashboardsOrder
    if (body.statusBarPresenceDevices instanceof Map) cfg.statusBarPresenceDevices = body.statusBarPresenceDevices

    def json = groovy.json.JsonOutput.toJson(cfg)
    // App state is not unlimited, and a state write that overflows fails in ways
    // that are much harder to diagnose than being told about it here.
    if (json.length() > maxConfigBytes()) {
        render contentType: "application/json",
            data: "{\"error\":\"config is ${json.length()} bytes, over this app's ${maxConfigBytes()}-byte limit. Remove some custom dashboards or tiles.\"}",
            status: 413, headers: noStoreHeaders()
        return
    }
    state.configJson = json
    render contentType: "application/json", data: '{"ok":true}', status: 200, headers: noStoreHeaders()
}

def deleteConfig() {
    state.remove("configJson")
    render contentType: "application/json", data: '{"ok":true}', status: 200, headers: noStoreHeaders()
}

def renderStatus() {
    def status = assetStatus()
    def upd = updateStatus(false)
    def out = [
        app             : "hubitat-native-dashboard",
        appVersion      : appVersion(),
        firmware        : location?.hub?.firmwareVersionString,
        hubFileApi      : hasHubFileApi(),
        assetsOk        : status.ok,
        assets          : status.message,
        installedUiBuild: status.installedVersion,
        uiSourceUrl     : uiSourceUrl(),
        updateCheck     : upd,
        makerApiAppId   : settings?.makerApiAppId ?: "",
        hasMakerToken   : (settings?.makerApiToken ? true : false),
        configBytes     : storedConfigBytes(),
        configLimit     : maxConfigBytes(),
        hubLocalIp      : location?.hub?.localIP,
    ]
    render contentType: "application/json",
        data: groovy.json.JsonOutput.toJson(out), status: 200, headers: noStoreHeaders()
}

// ---------------------------------------------------------------------------
// Config storage
// ---------------------------------------------------------------------------

// Stored as a JSON string rather than a nested map in state: state round-trips
// large nested structures unpredictably, and a string is exactly what both the
// export format and the PUT body already are. Same approach evdev's app uses
// for all of its stored structures.
private int maxConfigBytes() { 90000 }

private Map loadConfig() {
    if (!state.configJson) return [dashboard: defaultDashboard()]
    try {
        def parsed = new groovy.json.JsonSlurper().parseText(state.configJson.toString())
        return (parsed instanceof Map) ? parsed : [dashboard: defaultDashboard()]
    } catch (e) {
        log.error "Stored dashboard config is not valid JSON, falling back to defaults: ${e.message}"
        return [dashboard: defaultDashboard()]
    }
}

private int storedConfigBytes() {
    state.configJson ? state.configJson.toString().length() : 0
}

// Slots are left empty on purpose: the frontend has its own DEFAULT_SLOTS and
// merges whatever the server sends over them, so an empty map means "use the
// frontend's defaults" without this file having to duplicate that list.
private Map defaultDashboard() {
    [title: "Home", pollSec: 5, slots: [:]]
}

// ---------------------------------------------------------------------------
// Maker API + File Manager self-calls
// ---------------------------------------------------------------------------

private String makerApiGet(String path) {
    if (!settings?.makerApiAppId || !settings?.makerApiToken) {
        return '{"error":"Maker API App ID/token not set — open this app\'s settings page on the hub."}'
    }
    def result = '{"error":"no response"}'
    try {
        def uri = "${makerApiLocalBase()}${path}?access_token=${settings.makerApiToken}"
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
        result = "{\"error\":\"${jsonEscape(e.message)}\"}"
    }
    return result
}

// Read a file out of the hub's own File Manager.
//
// Prefers the platform's built-in downloadHubFile() (Hubitat 2.3.4.134+), which
// reads the file directly with no HTTP hop at all. Falls back to the self-call
// pattern adapted from evdev's fetchLocalAssetUncached() (Apache 2.0 — see
// NOTICE) on older firmware: loopback first (the form confirmed working on this
// hub for /apps/api/), then the LAN interface (the form evdev uses for /local/),
// so a difference between those two shows up as a log line rather than an empty
// dashboard.
private String fetchLocalAsset(String fileName) {
    if (hasHubFileApi()) {
        try {
            byte[] data = downloadHubFile(fileName)
            if (data != null && data.length > 0) return new String(data, "UTF-8")
            return ""
        } catch (e) {
            // A missing file throws here; that is an expected state during setup.
            log.debug "downloadHubFile(${fileName}): ${e.message}"
            return ""
        }
    }
    def body = fetchLocalAssetFrom(hubSelfBase(), fileName)
    if (body) return body
    body = fetchLocalAssetFrom(hubLanBase(), fileName)
    if (body) {
        log.warn "File Manager read of ${fileName} needed the LAN interface (${hubLanBase()}); loopback returned nothing."
    }
    return body
}

// uploadHubFile()/downloadHubFile() landed in Hubitat 2.3.4.134. Everything
// still works without them — reads fall back to an HTTP self-call, and the UI
// files can be uploaded by hand — but self-install needs the write side.
private Boolean hasHubFileApi() {
    return firmwareAtLeast("2.3.4.134")
}

private Boolean firmwareAtLeast(String wanted) {
    try {
        def fw = location.hub.firmwareVersionString?.tokenize(".")*.toInteger()
        def want = wanted.tokenize(".")*.toInteger()
        if (!fw) return false
        for (int i = 0; i < want.size(); i++) {
            int have = (i < fw.size()) ? fw[i] : 0
            if (have != want[i]) return have > want[i]
        }
        return true
    } catch (e) {
        log.warn "Could not parse firmware version '${location.hub.firmwareVersionString}': ${e.message}"
        return false
    }
}

// ---------------------------------------------------------------------------
// Self-install: fetch the built UI files and write them into File Manager.
//
// A Hubitat bundle cannot carry File Manager files — bundles hold only app,
// driver and library code — so without this the UI files have to be uploaded by
// hand, one at a time. uploadHubFile() lets the app do it itself.
//
// This is the one place the project reaches outside the hub, and only when the
// button is pressed. Once the files are written, nothing external is involved
// again: serving, device access and config are all local. Point uiSourceUrl at
// any host (a LAN web server, a local file share) if fetching from GitHub is
// not wanted, or skip this entirely and upload the files manually.
// ---------------------------------------------------------------------------

private String defaultUiSourceUrl() {
    "https://raw.githubusercontent.com/bdwilson/hubitat-native-dashboard/main/dist"
}

private String uiSourceUrl() {
    def u = (settings?.uiSourceUrl ?: defaultUiSourceUrl()).toString().trim()
    return u.endsWith("/") ? u[0..-2] : u
}

def installUiFiles() {
    if (!hasHubFileApi()) {
        return [ok: false, message: "This hub runs firmware ${location.hub.firmwareVersionString}. " +
            "Writing File Manager files from an app needs 2.3.4.134 or newer — upload the hnd-* files by hand instead."]
    }

    def base = uiSourceUrl()
    def manifestRaw = httpGetText("${base}/${manifestFileName()}")
    if (!manifestRaw) {
        return [ok: false, message: "Could not fetch ${manifestFileName()} from ${base} — check the URL and that this hub has internet access."]
    }

    def manifest
    try {
        manifest = new groovy.json.JsonSlurper().parseText(manifestRaw)
    } catch (e) {
        return [ok: false, message: "${manifestFileName()} from ${base} is not valid JSON: ${e.message}"]
    }

    def wanted = [manifestFileName(), (manifest?.shell ?: shellFileName()).toString()]
    if (manifest?.chunks instanceof List) wanted.addAll(manifest.chunks*.toString())

    def installed = []
    def failed = []
    wanted.unique().each { name ->
        if (!(name ==~ assetNamePattern())) {
            failed << "${name} (unexpected file name)"
            return
        }
        def body = (name == manifestFileName()) ? manifestRaw : httpGetText("${base}/${name}")
        if (!body) {
            failed << "${name} (download failed)"
            return
        }
        try {
            uploadHubFile(name, body.getBytes("UTF-8"))
            installed << name
        } catch (e) {
            failed << "${name} (${e.message})"
        }
    }

    state.remove("assetStatusCache")
    state.remove("assetStatusAt")

    if (failed) {
        return [ok: false, message: "Installed ${installed.size()} file(s); failed: ${failed.join('; ')}"]
    }
    return [ok: true, message: "Installed ${installed.size()} file(s) for build ${manifest?.version ?: 'unknown'}: ${installed.join(', ')}"]
}

// Plain text fetch used only by the installer, for an external URL rather than
// the hub itself. Kept separate from the File Manager reader so the two cannot
// be confused: this one is allowed to leave the hub, that one never does.
private String httpGetText(String url) {
    def result = ""
    try {
        httpGet([uri: url, contentType: "text/plain", textParser: true, timeout: 60, ignoreSSLIssues: true]) { resp ->
            def code = resp?.status ?: resp?.statusCode
            if (code == 200 && resp?.data != null) {
                def data = resp.getData() != null ? resp.getData() : resp.data
                result = readHttpBody(data)
            } else {
                log.warn "httpGetText(${url}): HTTP ${code}"
            }
        }
    } catch (e) {
        log.error "httpGetText(${url}): ${e.message}"
    }
    return result
}

private String fetchLocalAssetFrom(String base, String fileName) {
    def result = ""
    try {
        httpGet([
            uri: "${base}/local/${fileName}",
            contentType: "text/plain",
            textParser: true,
            timeout: 30,
            ignoreSSLIssues: true
        ]) { resp ->
            def code = resp?.status ?: resp?.statusCode
            if (code == 200 && resp?.data != null) {
                def data = resp.getData() != null ? resp.getData() : resp.data
                result = readHttpBody(data)
            }
        }
    } catch (e) {
        // A missing file is a 404 here, which is an expected state during setup
        // (and while checking which chunks exist) — not worth an error log.
        if (!"${e.message}".contains("404")) {
            log.debug "fetchLocalAssetFrom(${base}, ${fileName}): ${e.message}"
        }
    }
    return result
}

// Adapted from evdev/hubitat-modern-dashboard's readHttpBody() (Apache 2.0) —
// see NOTICE. resp.data from httpGet is not reliably a plain String; it can be
// Reader-like and needs draining defensively.
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
// Response helpers
// ---------------------------------------------------------------------------

private Map noStoreHeaders() {
    ["Cache-Control": "no-store, no-cache, must-revalidate, max-age=0"]
}

private Map immutableHeaders() {
    ["Cache-Control": "private, max-age=31536000, immutable"]
}

// Hubitat Cloud caps a single response at roughly 128 KB. Over the local link
// nothing breaks, so this warns rather than fails — but when the cloud link
// mysteriously shows an empty dashboard or an empty device list, this log line
// is the answer.
private void warnIfOverCloudLimit(String what, String body) {
    if (body && body.length() > 118000) {
        log.warn "Response for ${what} is ${body.length()} bytes — over Hubitat Cloud's ~128 KB " +
            "response cap. It will work on the local link and fail or truncate on the cloud link."
    }
}

private Map requestBody() {
    def body = request?.JSON
    if (body == null) {
        try {
            def raw = request?.postBody ?: request?.content
            if (raw) body = new groovy.json.JsonSlurper().parseText(raw.toString())
        } catch (e) {
            log.error "Could not parse request body: ${e.message}"
        }
    }
    return (body instanceof Map) ? body : null
}

private String jsonEscape(String s) {
    if (s == null) return ""
    s.replace("\\", "\\\\").replace("\"", "'").replace("\n", " ").replace("\r", " ")
}

private String setupHtml() {
    def base = '''<!doctype html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Hubitat Native Dashboard - setup</title>
<style>
  body { font-family: -apple-system, system-ui, sans-serif; background: #0d1117; color: #e8e8ea; margin: 0; padding: 24px; line-height: 1.55; }
  h1 { font-size: 20px; margin: 0 0 4px; }
  p.sub { color: #9a9ba3; margin: 0 0 20px; }
  ol { padding-left: 20px; }
  li { margin-bottom: 10px; }
  code { background: #1f222a; padding: 2px 6px; border-radius: 4px; font-size: 13px; }
  .box { background: #2a1f1f; border: 1px solid #5a3030; border-radius: 8px; padding: 14px 16px; margin-bottom: 20px; }
</style>
</head>
<body>
<h1>Dashboard UI not installed yet</h1>
<p class="sub">The app is running, but its UI files are not in this hub&rsquo;s File Manager.</p>
<div class="box">
  <b>ASSET_NAME</b> was not found at <code>/local/ASSET_NAME</code>.
</div>
<ol>
  <li>On a machine with Node installed, from a checkout of
      <code>bdwilson/hubitat-native-dashboard</code>, run:<br>
      <code>node build/build.mjs</code></li>
  <li>That writes the UI into <code>dist/</code> as a shell plus several JS chunks,
      each kept under Hubitat&rsquo;s 124&nbsp;KB File Manager limit and ~128&nbsp;KB cloud
      response limit.</li>
  <li>On the hub, go to <b>Settings &rarr; File Manager</b> and upload
      <b>every file</b> from <code>dist/</code>.</li>
  <li>Reload this page.</li>
</ol>
<p class="sub">The app page has a &ldquo;Re-check File Manager&rdquo; button that reports which
files it can see.</p>
</body>
</html>
'''
    return base.replace("ASSET_NAME", shellFileName())
}
