# CLAUDE.md — Hubitat Native Dashboard (spike)

This file gives future Claude sessions enough context to work in this repo **without any other repo open**. Read this before making any changes.

## What this is

A **feasibility spike**, not a product yet. The question it exists to answer: can a Hubitat dashboard run **entirely on the hub** — no Cloudflare Worker, no external hosting, no separate cloud account — by wrapping Hubitat's existing Maker API from inside a native, OAuth-enabled Hubitat App?

This repo is deliberately separate from **[bdwilson/cf-hubitat-dashboard](https://github.com/bdwilson/cf-hubitat-dashboard)**, the maintainer's actual production dashboard (Cloudflare Worker + KV, actively used, actively developed). That project has its own CLAUDE.md with its own architecture, conventions, and history — **do not assume anything from that project applies here**, and do not port work from here into that repo unless the maintainer explicitly asks. This repo's job is to prove or disprove an idea in isolation. If it works out, a future decision (by the maintainer) determines whether/how it feeds back into the production dashboard. Until then, treat these as two unrelated codebases that happen to be about the same subject.

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

## The core idea this spike tests: wrap Maker API instead of reimplementing device access

A Hubitat App can `httpGet` any URL, including the hub's own Maker API endpoint on `127.0.0.1:8080` — mechanically identical to what evdev's project already proves works (its `fetchLocalAssetUncached()` does `httpGet` to `${hubBaseUri()}/local/<file>`, the hub calling itself). So instead of rebuilding device access, capability detection, and command dispatch from scratch in Groovy (evdev's approach), this spike's App can be a **thin proxy** in front of an existing, separately-configured Maker API instance:

- `GET /devices/all` on this App → internally `httpGet`s `http://127.0.0.1:8080/apps/api/{makerApiAppId}/devices/all?access_token={makerApiToken}` → relays the JSON straight through.

  **Confirmed on real hardware, after two wrong attempts:** plain `127.0.0.1` (port 80) and `location.hub.localIP` (port 80) both fail with connection refused from app code. The fix is `127.0.0.1:8080` — port 80/443 fronts the hub's admin/browser-facing web server, while the internal app engine that serves `/apps/api/...` to the hub calling itself listens on 8080/8443. This matches the Hubitat community's own documented convention for hub self-calls (thebearmay/hubitat's `endpoints.txt`: "use ports 8080 and 8443 and IP 127.0.0.1 if calling hub from itself").
- Commands → same idea, proxied to Maker API's own command endpoint shape.

### Why this fits cf-hubitat-dashboard's design specifically (even though this repo doesn't touch that code)

cf-hubitat-dashboard's tile system is a **flat, free-form device list** — any tile can be assigned any device with any capability, picked from one big dropdown. That's Maker API's model exactly. evdev's capability-bucketed `input` pickers don't map onto that without redesigning the tile editor. Wrapping Maker API keeps the existing device-selection screen, the existing JSON shape (`getAttr()`, `hasCapability()`, `dynKindForDevice()` — all of it), and the existing command URL shape (`/devices/{id}/{command}/{secondary}`) that the production dashboard's frontend already expects. If this spike is ever ported back, the goal is that as much of that frontend logic as possible needs **zero changes** — only the transport layer (how the frontend fetches data / sends commands, and how config gets persisted) would need a second implementation.

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

## What is NOT yet verified

Nothing in this repo has been run against a real Hubitat hub. There is no way to compile or test Groovy in this development environment — no Hubitat hub, no emulator. Every file here should be treated as "written carefully against verified patterns, but unconfirmed" until the maintainer pastes it into a real hub's Apps Code and reports back what happened. Do not claim something "works" — say what it's expected to do and that it needs real-hub testing, matching how the rest of this spike's documentation is written.

## Repo layout

```
CLAUDE.md              — this file
README.md              — user-facing: what this is, setup, current status
NOTICE                 — attribution for patterns adapted from evdev/hubitat-modern-dashboard (Apache 2.0)
app/
  HubitatNativeDashboard.groovy   — the spike App: OAuth, mappings, Maker API proxy, minimal test page
```

## Boundary with cf-hubitat-dashboard (read this before touching either repo)

- Do not copy code, config, or conventions from cf-hubitat-dashboard into this repo without the maintainer asking — this repo's whole purpose is to be tested in isolation.
- Do not push changes from this repo into cf-hubitat-dashboard, or vice versa, without an explicit instruction to do so.
- If a future session is asked to "port this spike back" or "apply what we learned here to the real dashboard," that is a cf-hubitat-dashboard task — go read *that* repo's CLAUDE.md fresh rather than assuming this file's contents transfer directly. Some things will transfer (the verified Groovy patterns above); most of the actual code will not (this spike's minimal test page is not the real dashboard's tile system).

## Status

Spike in progress. See README.md for the current concrete test plan (what to paste where, what to check) and results once the maintainer has tried it on a real hub.
