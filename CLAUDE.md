# CLAUDE.md — Hubitat Native Dashboard

This file gives future Claude sessions enough context to work in this repo **without any other repo open**. Read this before making any changes.

## What this is

An **on-hub port of [bdwilson/cf-hubitat-dashboard](https://github.com/bdwilson/cf-hubitat-dashboard)**: the same dashboard frontend, served entirely from the Hubitat hub, with Maker API wrapped for device access and the app's own `state` for config. No Cloudflare Worker, no external hosting, no separate cloud account.

It began as a feasibility spike asking whether that was possible at all. It is no longer a spike — the mechanism was proved on real hardware (see Status), and the maintainer then asked to build it out to match the production dashboard, with interoperable config exports. History matters for reading old commits, but the current job is a working dashboard, not an experiment.

### The relationship to cf-hubitat-dashboard has changed — read this

The original boundary was "these are two unrelated codebases; do not copy between them." **That was superseded when the maintainer asked to mimic the Cloudflare dashboard and make config exports portable between the two.** The current arrangement:

- This repo **reads** cf-hubitat-dashboard's `src/assets/index.html` at build time and patches its transport layer. It does **not** vendor a copy — there is no duplicated frontend here to drift.
- The config JSON shape is **deliberately identical** to that project's, because that is what makes exports portable. Changing the shape here without changing it there breaks the feature the maintainer asked for.
- Still true: **do not push changes from here into cf-hubitat-dashboard** without an explicit instruction. Reading it is expected; writing to it is not.
- Still true: that project has its own CLAUDE.md, architecture and conventions. Go read it before touching it; none of this file's conventions transfer there.

## Why this exists (origin of the idea)

The production dashboard (cf-hubitat-dashboard) requires a Cloudflare account, a Worker deployment, and (optionally) a KV namespace. The maintainer asked whether that dashboard could also run purely on-hub, with no external dependency at all, and pointed at **[evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard)** as an existing example of a dashboard that does exactly that — a real, apparently-shipping project, Apache-2.0 licensed. That repo was cloned and read directly (not guessed from memory) to ground this spike in verified platform behavior rather than assumption. Everything under "Verified Hubitat/Groovy patterns" below was confirmed by reading that project's actual source, not recalled from general Hubitat knowledge — treat anything **not** sourced that way as unverified until tested on a real hub.

### What evdev's project actually does (and doesn't)

- It is a **custom Hubitat App** (`ModernLightsDashboard.groovy`), OAuth-enabled, with ~50 routes in a `mappings {}` block. It talks to devices **directly in-process** via Groovy device objects (`device.on()`, native `subscribe()`) — it does **not** use Maker API at all. The initial assumption going into this research ("it probably uses Maker API + an OAuth token") was wrong; confirmed by reading the source.
- Device selection happens via Hubitat's native capability-bucketed `input` preference pickers (`input "lights", "capability.switch", multiple: true`), not a free-form "any device, any tile" picker.
- The UI is **not** embedded in the Groovy source — Hubitat can't compile huge blobs into App code. Instead, 12 static files (5 JS chunks, 2 CSS chunks, HTML, manifest, service worker, 2 base64-encoded PNG icons) are uploaded to Hubitat's **File Manager**, and the Groovy app fetches them from itself at request time via an internal `httpGet` to its own hub (`http://<hub>/local/<file>`), then re-serves them through its own routes. This exists because of two real, confirmed platform ceilings:
  - **124 KB per file** in File Manager
  - **~128 KB total response size** through Hubitat Cloud's OAuth proxy (tighter, ~118 KB, for a few specific "cloud-critical" chunks — cloud OAuth overhead eats into the budget)
  Their `build.mjs` enforces both limits and fails the build if a chunk gets too big. This is why their project has a real build step (esbuild) at all.
- Config (room order, favorites, snapshots, schedules) lives in the App's own `state`/`atomicState` — no external database.
- Auth is the OAuth `access_token` in the URL, full stop. Their own README says it plainly: "Anyone with the URL can control the devices you selected... treat links like secrets." They added an *optional* password gate on top as a partial mitigation. There is no per-user identity model like Cloudflare Access gives the production dashboard.
- Real-time updates: local-only WebSocket (`ws://<hub-ip>/eventsocket`, undocumented Hubitat feature), polling fallback always. Cloud URL is polling-only — cloud proxy doesn't expose eventsocket. (This is the *same* limitation cf-hubitat-dashboard already has and already handles the same way — not a new problem introduced by going hub-native.)
- A real, non-obvious gotcha they hit and documented: **do not proxy binary image bytes through Hubitat Cloud** — its render path corrupts binary responses. Their PWA icons are hosted externally on `raw.githubusercontent.com` instead, specifically to avoid this. Their in-app icons are base64-encoded text files in File Manager (`.b64`), decoded server-side, rendered as `image/png` — worth reusing that exact pattern if this spike ever needs to serve binary assets.

## The core idea: wrap Maker API instead of reimplementing device access

A Hubitat App can `httpGet` any URL, including the hub's own Maker API endpoint on `127.0.0.1:8080` — mechanically identical to what evdev's project already proves works (its `fetchLocalAssetUncached()` does `httpGet` to `${hubBaseUri()}/local/<file>`, the hub calling itself). So instead of rebuilding device access, capability detection, and command dispatch from scratch in Groovy (evdev's approach), this spike's App can be a **thin proxy** in front of an existing, separately-configured Maker API instance:

- `GET /devices/all` on this App → internally `httpGet`s `http://127.0.0.1:8080/apps/api/{makerApiAppId}/devices/all?access_token={makerApiToken}` → relays the JSON straight through.

  **Confirmed on real hardware, after two wrong attempts:** plain `127.0.0.1` (port 80) and `location.hub.localIP` (port 80) both fail with connection refused from app code. The fix is `127.0.0.1:8080` — port 80/443 fronts the hub's admin/browser-facing web server, while the internal app engine that serves `/apps/api/...` to the hub calling itself listens on 8080/8443. This matches the Hubitat community's own documented convention for hub self-calls (thebearmay/hubitat's `endpoints.txt`: "use ports 8080 and 8443 and IP 127.0.0.1 if calling hub from itself").
- Commands → same idea, proxied to Maker API's own command endpoint shape.

### Why this fits cf-hubitat-dashboard's design specifically (even though this repo doesn't touch that code)

cf-hubitat-dashboard's tile system is a **flat, free-form device list** — any tile can be assigned any device with any capability, picked from one big dropdown. That's Maker API's model exactly. evdev's capability-bucketed `input` pickers don't map onto that without redesigning the tile editor. Wrapping Maker API keeps the existing device-selection screen, the existing JSON shape (`getAttr()`, `hasCapability()`, `dynKindForDevice()` — all of it), and the existing command URL shape (`/devices/{id}/{command}/{secondary}`) that the production dashboard's frontend already expects. That prediction held exactly: the port needed **zero changes** to tiles, layout, the editor, custom dashboards or the config model. The entire delta is seven transport patches in `build/patches.mjs` plus a config store in the app's `state`. If a future change here starts needing changes to frontend *logic* rather than transport, that is a sign something has gone wrong — reach for a patch to the seam, not a fork of the UI.

### Real trade-offs of wrapping vs. reimplementing (evdev's approach)

| | Wrap Maker API (this spike) | Reimplement natively (evdev's approach) |
|---|---|---|
| Setup | Two apps: Maker API *and* this App | One app |
| Device access | HTTP round-trip (localhost) | Direct in-process, faster |
| Command arguments | Inherits Maker API's **one-argument-only** command URL shape | Could use Groovy dynamic dispatch (`device."$cmd"(arg1, arg2)`) for multi-arg commands |
| Matches cf-hubitat-dashboard's frontend | Yes, by construction | No — would need a redesigned device-selection UX |
| Token storage | Maker API's token lives in this App's preferences/state | N/A — no second token |

A middle path exists and is worth remembering if this spike proves out: keep native device access (one broad `input "any", "capability.*", multiple: true` grant, no Maker API dependency, no HTTP round-trip, no one-argument ceiling) but **serialize the JSON to match Maker API's exact shape anyway**. That gets the "frontend needs no changes" property without the Maker API dependency — more Groovy to write, but a cleaner end state. Not attempted yet; wrapping is the deliberately-smaller first step.

## Verified Hubitat/Groovy patterns (sourced from evdev's actual code — not guessed)

Use these exact patterns rather than inventing syntax from general Hubitat knowledge. Each is confirmed by direct inspection of `evdev/hubitat-modern-dashboard`'s `app/ModernLightsDashboard.groovy.template`.

- **`definition()` + OAuth**:
  ```groovy
  definition(
      name: "...", namespace: "...", author: "...", description: "...",
      category: "My Apps", iconUrl: "", iconX2Url: "",
      oauth: [displayName: "...", displayLink: ""]
  )
  ```
- **`preferences { page(...) }` + `dynamicPage`**: standard `mainPage()` function returning `dynamicPage(name: "mainPage", install: true, uninstall: true) { section("...") { ... } }`. `createAccessToken()` is called unconditionally near the top of `mainPage()` (not wrapped defensively) once OAuth is enabled on the app.
- **URL helpers**: `getFullLocalApiServerUrl()` and `getFullApiServerUrl()` are real, used methods for building local/cloud dashboard links.
- **Hub self-calls use port 8080, not 80/443**: evdev's project defines two distinct helpers —
  ```groovy
  def hubBaseUri()  { return "http://${location.hub.localIP}:8080" }
  def hubLoginUri() { return "http://127.0.0.1:8080" }
  ```
  `hubBaseUri()` (LAN IP) is used for fetching File Manager assets; `hubLoginUri()` (loopback) is used for hub-local login. Both hardcode port **8080** — port 80/443 fronts the hub's admin/browser-facing web server, while the internal app engine that serves local endpoints (File Manager, `/apps/api/...`) to the hub calling itself listens on 8080/8443. This spike originally missed the port entirely (tried plain `127.0.0.1` and `location.hub.localIP`, both on the implicit port 80) and got connection refused on real hardware both times; confirmed fixed by switching to `127.0.0.1:8080`, matching `hubLoginUri()` above.
- **`mappings {}` routing style — static paths + query params, NOT colon-style path variables**:
  ```groovy
  mappings {
      path("/dashboard") { action: [GET: "renderIndex"] }
      path("/cmd")       { action: [GET: "doCmd"] }   // reads params.id / params.c / params.v
  }
  ```
  evdev's own project uses `GET /cmd?id=…&c=…&v=…` rather than `/devices/:id/:command`-style path variables, even though their *internal* Maker-API-style shape would have supported it. This spike follows the same static-path-plus-query-param convention deliberately, since it's the one with actual precedent in shipped code — path-variable mapping syntax (`path("/devices/:id")`) has **not** been verified here and should not be assumed to work without testing.

  **The dashboard entry point specifically must be `/dashboard`, not the bare root `/`.** evdev's project maps both, but its own `dashboardUrl()` builder — the one that generates the actual links shown to users — only ever produces `"${base}/dashboard?access_token=..."`, never a bare-root link. This spike originally used bare `/` for its dashboard link and got AWS API Gateway's generic "Missing Authentication Token" (its standard no-matching-route response) when opening the **cloud** link on a real hub — local worked fine regardless, since local routing doesn't go through API Gateway. Fixed by switching both `localDashboardUrl()`/`cloudDashboardUrl()` and the corresponding `mappings` entry to `/dashboard` (bare `/` is still mapped too, matching evdev's belt-and-suspenders pattern, just no longer what the generated links use).
- **Internal self-calls (the core mechanism this spike relies on)**:
  ```groovy
  httpGet([uri: uri, contentType: "text/plain", textParser: true, timeout: 30, ignoreSSLIssues: true]) { resp ->
      def code = resp?.status ?: resp?.statusCode
      if (code == 200 && resp?.data != null) {
          def data = resp.getData() != null ? resp.getData() : resp.data
          result = readHttpBody(data)
      }
  }
  ```
  `resp.data` is not reliably a plain String — it can be Reader-like and needs draining. evdev's `readHttpBody()` handles this defensively:
  ```groovy
  def readHttpBody(data) {
      if (data == null) return ""
      try {
          def sb = new StringBuilder()
          int i = data.read()
          while (i != -1) { sb.append((char) i); i = data.read() }
          if (sb.length() > 0) return sb.toString()
      } catch (e) {}
      def s = data.toString()
      return s.startsWith("java.io.") ? "" : s
  }
  ```
  Reuse this verbatim rather than assuming `resp.data.toString()` is safe.
- **`render` syntax**: `render contentType: "application/json", data: jsonString, status: 200, headers: [...]` — a named-parameter call, not a builder/DSL block.
- **Binary assets**: base64-encode as text (`.b64` files), decode server-side (`bytes.decodeBase64()`), `render contentType: "image/png", data: new String(bytes, "ISO-8859-1"), status: 200`. Do not attempt to proxy raw binary bytes through Hubitat Cloud — corrupts.
- **Maker API's `GET /devices/all` returns `attributes` as a flat object keyed by attribute name** — `{"switch": "off", ...}` — **not** an array of `{name, currentValue}` objects. Confirmed against community-documented example responses (this spike's first pass assumed the array shape, which meant every `getAttr()` lookup silently returned `undefined` and no device ever appeared controllable — no runtime error, just nothing worked). `GET /devices/{id}` (single device) may format attributes differently than `/devices/all` — this has been reported as an inconsistency in Maker API itself, not verified further here since this spike only uses `/devices/all`.

## Architecture: how the frontend gets onto the hub

The UI is not in the Groovy file, and cannot be. Two ceilings force a build step:
**File Manager caps a file at 124 KB**, and **Hubitat Cloud caps a response at ~128 KB**.
The upstream dashboard is one ~280 KB HTML file.

So `build/build.mjs`:

1. Reads cf-hubitat-dashboard's `src/assets/index.html` — from `--source`, `$CF_DASHBOARD_SRC`, a sibling checkout, or GitHub raw. **Never vendored.**
2. Applies the transport patches in `build/patches.mjs`.
3. Splits it into `hnd-shell.html` (head + CSS + body markup + a chunk loader) and `hnd-app-N.js` chunks.
4. **Fails the build** if any file exceeds either ceiling.

The user uploads `dist/` to File Manager; the app re-serves those files through its own routes.

### The chunk loader, and why it is not `<script src>`

The upstream app is one big IIFE. Splitting it across `<script>` tags would tear functions in half. Instead the loader fetches each chunk **as text**, concatenates, and runs one indirect `eval`. The rejoined text is byte-identical to the patched original (asserted during development), so the browser parses exactly the upstream program. It also costs zero escaping overhead, unlike wrapping each chunk in a string literal.

### Getting the code and the UI onto a hub

Two mechanisms, and it matters which does what:

- **Bundles** (`dist/hubitat-native-dashboard.zip`, built by `build/build.mjs`). A bundle is a **flat ZIP** of `<namespace>.<Name>.groovy` files plus `install.txt`/`update.txt`, each of which is: line 1 namespace, line 2 bundle name, then `app|driver|library <file> [oauthClientId] [oauthClientSecret]`. **Verified by unpacking real published bundles** (thebearmay's webCoRE/AirThings/secureLogin), not from documentation — docs2.hubitat.com is blocked from this environment.
  - **A bundle CANNOT carry File Manager files.** Entry types are only app/driver/library; no published bundle examined contained anything but Groovy and the two manifests. So bundles solve app-code install and nothing about the UI chunks.
  - The OAuth client id/secret fields are **deliberately left empty**. They would otherwise be one shared secret across every install from this public repo, to save a single click.
- **Self-install** (`installUiFiles()` in the app). Hubitat exposes built-in `uploadHubFile(name, bytes)` / `downloadHubFile(name)` since **2.3.4.134**, so the app writes its own File Manager files. This is why `dist/` is **committed**: the button fetches those files from this repo's raw GitHub URLs.
  - This is the only outbound call the project ever makes, and only on a button press. Runtime stays entirely local. `uiSourceUrl` lets a user point it elsewhere.
  - `downloadHubFile()` is also now the preferred *read* path, falling back to the HTTP self-call on older firmware.

### Versioning, and the failure it is designed to catch

- `appVersion()` in the Groovy — bump it when the app changes meaningfully.
- The **UI build id** in `hnd-manifest.json` is hashed over the patched upstream source **plus `BOOT_NOTICE` and the generated loader**. Hashing only the patched source was wrong and was fixed: the loader and boot markup are generated by `build.mjs`, so a change to that file alone would otherwise ship different bytes under an unchanged id, and the app's update check would report "up to date" for a build that is not.
- The shell carries `<!-- hnd-build: <id> -->`, which the app greps back out of the *installed* shell.

`assetStatusUncached()` checks presence, **per-file byte size against `manifest.bytes`, and shell-stamp-vs-manifest-version**. Presence alone is not enough: the shell embeds the chunk list and the `?v=` cache key, so a partial re-upload leaves a shell from one build driving chunks from another — every file present, nothing obviously missing, a dashboard that half works.

Byte sizes are compared as **UTF-8 bytes on both sides** (`Buffer.byteLength` in the build, `downloadHubFile()`'s array length or `getBytes("UTF-8").length` in the app). The UI contains plenty of multi-byte characters, so String length would not agree. This was verified by running the app's actual stamp regex and byte counting under Groovy 2.4.21 against the real `dist/` files, including both negative cases.

`updateStatus(force)` compares the installed build id against the manifest at `uiSourceUrl`, cached 6 hours. It **never** fetches merely because the settings page rendered — only on the button or when the cache is stale.

### The transport seam

Everything that differs between the Cloudflare build and this one lives in `build/patches.mjs`, in two deliberately different categories:

- **`PATCHES`** — semantic. Asserted: each **must** match exactly once or the build fails loudly, because these patterns match code in a repo this one does not control and a silent miss means a broken network layer.
- **`RELABELS`** — cosmetic wording (KV/Cloudflare → hub). Best-effort replace-all; a miss is reported, never fatal. A button saying the wrong word is not worth blocking a build over.

`RELABELS` must cover **runtime strings, not just markup**. The first pass only caught static labels, and a user hit a `confirm()` during *Reset Everything* asking about wiping "KV" on a hub with no Cloudflare anywhere. When adding one, grep the built `dist/` output, not just the source markup. Function names (`fetchConfigFromWorker`, `pushConfigToWorker`) and code comments are deliberately left alone — renaming them is churn with no user-facing benefit and more drift surface.

**Local mode** is three patches plus loader UI, and it needs all of them. `fetchConfigFromWorker` throws (boot() already falls back to the localStorage cache, which is exactly the wanted behaviour) and `pushConfigToWorker` resolves as a no-op. The write side is not optional: hiding a device and editing a custom dashboard push to the server on their own, so without it a "local" browser would still mutate the shared layout. The loader hides the save button, which would otherwise report success for a write that never happened.

The mode is remembered in `localStorage` (`hnd-config-mode`); `?local=1` / `?local=0` override for one load so a link can be handed out without changing what a browser remembers.

**Switching hub → local must copy the hub config into the browser cache first** (`copyHubConfigToLocal` in the loader). `boot()` applies the hub config to memory but never calls `saveConfigCache()`, so without the copy the reload restores a stale cache instead of the layout the user was looking at. The loader can do this without app internals because the cache is just `{...cfg, dynamic, custom, dashboardsVisible, dashboardsOrder, statusBarPresenceDevices}` under `hubitat-dash-v4-cache`; `publishLocalLayout` reads the same shape back for the opposite direction. Both directions are exposed as separate controls on purpose — a single confirm() whose Cancel branch means "discard my layout" is a trap.

Do not move an item between those categories casually. The one that bit a user: "Save Config to KV" is the button that writes to the hub's app state on this build, and read as a Cloudflare feature it looks skippable — which strands config in one browser's localStorage.

The Hub Connection credential inputs are **hidden at runtime by the loader, not deleted**, because upstream reads those elements by id in `readSettingsForm()` and on import. Deleting them converts a cosmetic cleanup into a null-dereference. Note also that they cannot be hidden by "everything between the Hub Connection heading and the next heading" — upstream puts the display settings and the save buttons in that same stretch with no heading of their own.

| What | Cloudflare | Here |
|---|---|---|
| Config API | `/api/config` | `config?access_token=…` |
| Device access | `/api/hub/<sub-path>` | `hub?path=<url-encoded sub-path>` |
| Event socket | Worker proxies `/api/hub/events` | browser hits `ws://<hub>/eventsocket` directly |
| Cloud detection | configured hub URL | `location.hostname` — how the *browser* reached the page |
| PWA manifest/icons | Worker static assets | stripped (no asset origin; cloud corrupts binaries) |

One patch, `import-syncs-all-settings-inputs`, is **not** a transport change — it fixes a real upstream bug. `applyImportedConfig()` syncs only some settings inputs back to the form, so `readSettingsForm()` on the next save reverts title, poll interval, grid columns, tile height and icon scale to their pre-import values. This breaks restore on the Cloudflare build too. The proper fix belongs upstream; if it lands there, this patch will stop matching and the build will say so.

Sub-paths go in a query param because Hubitat's colon-style path-variable mapping syntax has no verified precedent in shipped code.

**If a patch stops matching**, upstream changed. Go read the relevant code in cf-hubitat-dashboard and update the patch — do not loosen it into a regex that "probably still works."

## CI

`.github/workflows/build.yml` compiles the app with `check-groovy.groovy`, builds `dist/`, and commits it back. `dist/` is committed rather than uploaded as an artifact because the app's self-install button fetches it from this repo.

**The build must stay reproducible** or CI commits noise on every nightly run. Two rules follow from that: `builtAt` is reused when the build id is unchanged, and no source *path* is recorded in the manifest (it differs between a local checkout and CI, and would leak an absolute path into a public repo). Verified: two consecutive builds, and a local-source vs GitHub-source build, all produce byte-identical `dist/`. If you add a field to the manifest, make sure it is content-derived.

The push trigger excludes `dist/**` so the workflow's own commit cannot retrigger it. The nightly run doubles as upstream-drift detection — an asserted patch that stops matching fails the run and names itself.

## Tooling that exists now (this environment CAN test some things)

An earlier version of this file said there was no way to compile or test anything here. That is no longer true:

- **`groovy build/check-groovy.groovy app/HubitatNativeDashboard.groovy`** compiles the app to `CLASS_GENERATION`. Install with `apt-get install -y groovy` (2.4.x, matching Hubitat). This catches what the hub's editor rejects on Save — verified by feeding it this repo's own historical `Modifier 'private' not allowed here` bug, which **`CONVERSION` and `SEMANTIC_ANALYSIS` both let through**; only `CLASS_GENERATION` catches it. Run it before handing any Groovy change to the maintainer.
- **`node build/dev-server.mjs`** stands in for the app (same routes, faked Maker API data in its real `/devices/all` shape) so the frontend and build can be exercised in a browser. Chromium is available at `/opt/pw-browsers/chromium-*/chrome-linux/chrome` with `PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`.

What that tooling does **not** prove: that the Groovy behaves correctly on a hub. `dev-server.mjs` is a second implementation in JavaScript and can drift from the Groovy. A green browser run means the frontend, loader and patches are sound — nothing more. Still do not claim the app "works" on a hub until the maintainer says it did.

## Repo layout

```
CLAUDE.md              — this file
README.md              — user-facing: what this is, setup, interop, limits
NOTICE                 — attribution for patterns adapted from evdev/hubitat-modern-dashboard (Apache 2.0)
app/
  HubitatNativeDashboard.groovy   — the App: OAuth, mappings, asset serving, Maker API proxy, config API
build/
  build.mjs            — reads upstream frontend, patches, chunks, enforces size ceilings, builds the bundle
  patches.mjs          — asserted transport PATCHES + best-effort cosmetic RELABELS
  zip.mjs              — dependency-free store-only ZIP writer, for the bundle
  dev-server.mjs       — local stand-in for the app; simulation, not the real thing
  check-groovy.groovy  — compile the app without a hub
dist/                  — COMMITTED build output: the UI chunks the app self-installs from,
                         plus the Hubitat bundle ZIP
```

## Status

The Maker API proxy, device listing, command dispatch and both dashboard links are **confirmed working on a real hub**. The full frontend, the chunked build and the transport patches are **confirmed working in a browser** against `dev-server.mjs`. The rewritten Groovy app — asset serving, the `hub` proxy, the config API — **has not been run on a hub yet**. See README.md for the verification table and what remains.
