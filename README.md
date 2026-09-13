# Hubitat Native Dashboard

**An on-hub port of [bdwilson/cf-hubitat-dashboard](https://github.com/bdwilson/cf-hubitat-dashboard) — the same dashboard, served entirely from the Hubitat hub.** No Cloudflare account, no Worker, no KV, no external hosting.

It runs the *same frontend* as the Cloudflare build. Only the transport layer differs: device access goes through an existing Maker API instance on the hub, and config lives in the app's own `state` instead of KV. Because the config format is identical, **a config exported from either dashboard imports into the other.**

```
Browser ──OAuth token──► This App (on the hub)
                              │
                              ├──httpGet 127.0.0.1:8080──► Maker API (same hub) ──► your devices
                              │
                              └──httpGet 127.0.0.1:8080──► File Manager (the UI files)
```

## Why there's a build step

Two hard platform ceilings make it impossible to just paste the dashboard into an app:

- **File Manager caps a single file at 124 KB.**
- **Hubitat Cloud caps a single response at roughly 128 KB.**

The upstream dashboard is one ~280 KB HTML file. So `build/build.mjs` splits it into a shell plus JS chunks, each kept under both ceilings, and **fails the build** if any piece grows past them. The app re-serves those chunks through its own routes; the browser refetches them as text and runs them as the original single program. [evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard) hit the same wall and solved it the same way.

The frontend is **not vendored into this repo.** The build reads it from a sibling checkout of `cf-hubitat-dashboard` or fetches it from GitHub, so there is no second copy of that project's code here to drift out of sync.

## Setup

You need a Maker API instance first. If you already run one (Alexa, HomeBridge, etc.), reuse it.

1. **Maker API** — Apps → Add Built-in App → Maker API. Select the devices you want on the dashboard. Note its **App ID** and **Access Token**.

2. **Build the UI** (needs Node 18+):
   ```sh
   node build/build.mjs
   ```
   Reads `../cf-hubitat-dashboard/src/assets/index.html` if you have that repo checked out next to this one; otherwise fetches it from GitHub. Override with `--source <path-or-url>`.

3. **Upload** every file from `dist/` to the hub: **Settings → File Manager**.

4. **Install the app** — Apps Code → New App → paste `app/HubitatNativeDashboard.groovy` → **Save**. Then click **OAuth** → **Enable OAuth** → **Save**. (Required; the dashboard link won't work without it.)

5. Apps → **Add User App** → *Hubitat Native Dashboard*. Paste the Maker API **App ID** and **Access Token** → **Done**.

6. Reopen the app. It shows whether it can see the UI files, plus the **Local** and **Cloud** dashboard links.

To update later: re-run the build, re-upload `dist/`, and use the app's **Import** button (its `importUrl` points at this repo) to pull the newest Groovy.

## Config interop with the Cloudflare dashboard

Both dashboards speak the same config JSON, so the frontend's own **Download Config** / **Upload Config** buttons move a setup between them in either direction.

| | Cloudflare build | This build |
|---|---|---|
| Config store | Workers KV | the app's `state` |
| Config API | `/api/config` | `config` |
| Device access | `/api/hub/*` → Maker API | `hub?path=…` → Maker API |
| Hub credentials | in config (`hub.baseUrl/appId/token`) | app preferences |

Exporting from this app with *include token* writes real, working Maker API credentials (`hub.baseUrl`, `appId`, `token`) into the file, so that export can be imported straight into the Cloudflare dashboard and will connect.

Going the other way, **`hub` is deliberately ignored on import here** — this app gets its Maker API credentials from its own settings page, so importing a Cloudflare export brings the layout across without repointing the app at whatever hub URL that export happened to contain.

## Routes

| Route | Purpose |
|---|---|
| `dashboard` | the dashboard page (shell from File Manager) |
| `asset?f=<name>` | one built UI file, re-served from File Manager |
| `hub?path=<maker-api-path>` | Maker API proxy |
| `config` | `GET` / `PUT` / `DELETE` — config, in the Cloudflare build's shape |
| `status` | JSON diagnostics: assets found, config size, hub IP |
| `devices/all`, `cmd?id=&c=&v=` | kept from the original spike for isolating a broken proxy |

Sub-paths are passed to `hub` as one URL-encoded query param rather than as path segments, because Hubitat's colon-style path-variable mapping syntax has no verified precedent in shipped code.

## Developing without a hub

```sh
node build/build.mjs
node build/dev-server.mjs
# http://127.0.0.1:8099/apps/api/1/dashboard?access_token=devtoken
```

`build/dev-server.mjs` stands in for the Groovy app: it implements the same routes, serves the built files, and fakes Maker API device data in its real `/devices/all` shape. It deliberately serves from a base path of the same shape the hub uses (`/apps/api/<appId>/…`), because every URL the dashboard requests is relative — serving from the web root would skip the thing most likely to break.

It is a **simulation, not the app.** A green run proves the built frontend, the chunk loader and the transport patches are sound. It says nothing about whether the Groovy is correct.

For the Groovy itself:

```sh
apt-get install -y groovy      # 2.4.x, matching Hubitat
groovy build/check-groovy.groovy app/HubitatNativeDashboard.groovy
```

That compiles to `CLASS_GENERATION`, which is the phase that catches the errors Hubitat's editor rejects on Save — including `Modifier 'private' not allowed here`, which this repo shipped once and which earlier compiler phases let through. It cannot tell you the app *works*, only that the hub will accept the file.

## What's been verified, and how

| | Status |
|---|---|
| Maker API proxy, device listing | ✅ on a real hub (141 devices) |
| Command proxying, local + cloud links | ✅ on a real hub |
| Build: patches apply, chunks under both ceilings | ✅ enforced by the build itself |
| Chunk split/rejoin is byte-exact | ✅ asserted against the patched source |
| Dashboard boots, renders tiles, drives devices, saves config | ✅ in Chromium against `dev-server.mjs` |
| Groovy compiles | ✅ Groovy 2.4.21, `CLASS_GENERATION` |
| **The rewritten Groovy app on a real hub** | ❌ **not yet tested** |

The last row is the important one: the app was rewritten substantially (asset serving, config storage, the `hub` proxy) and has not been run on hardware since. Expect to shake out real-hub issues the way the earlier rounds did.

## Known limits (from the platform, not this app)

- **~128 KB per cloud response.** A large `/devices/all` can exceed this — 141 devices with full attributes is close. It works fine on the local link; on cloud it truncates or fails. The app logs a warning naming the response that went over, because otherwise this shows up as a silently empty dashboard.
- **Real-time updates are local-only.** The dashboard connects straight to the hub's `ws://<hub>/eventsocket` on the local link — one hop fewer than the Cloudflare build, which has to proxy it. Over the cloud link there is no event socket, so it polls. Same limitation the Cloudflare build has.
- **App `state` is not unlimited.** Config is capped at 90 KB here; `PUT config` returns a clear 413 rather than letting a too-large write fail obscurely. Many custom dashboards with many tiles could approach it.
- **No PWA icons.** The build strips the manifest and icon links: there is no static asset origin on the hub, and Hubitat Cloud corrupts binary responses. Installing to a home screen works; it just gets a default icon.
- **Security is the URL.** Anyone with a dashboard link can control every device exposed through your Maker API instance — the same trust model as Maker API's own URLs. There is no per-user identity here, unlike Cloudflare Access in front of the production dashboard.

## Trade-offs versus reimplementing device access natively

**Wrapping Maker API (this project)**
- Reuses Maker API's JSON and command shapes, so the production dashboard's frontend runs with only its transport swapped
- Much less Groovy to write and maintain
- Requires Maker API installed and configured separately (two apps, not one)
- Inherits Maker API's **one-argument-per-command** limit
- Extra HTTP round-trip per request (loopback, so cheap, but not free)

**Reimplementing natively** (what [evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard) does)
- One app, no Maker API dependency, direct in-process device access
- Can dispatch multi-argument commands that Maker API's URL shape can't express
- Uses Hubitat's capability-bucketed device pickers, which don't map cleanly onto a "any device, any tile type" dashboard
- Substantially more Groovy to write and keep working

A middle path, if this ever outgrows Maker API: native device access, but serialize the JSON to *match* Maker API's shape anyway. That drops the dependency and the one-argument ceiling while keeping the frontend unchanged — at the cost of writing that serialization yourself.

## Credits

Groovy platform patterns (hub self-calls, defensive HTTP response reading, File Manager asset serving) were adapted from [evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard), Apache 2.0 — see [NOTICE](NOTICE). The dashboard frontend is [bdwilson/cf-hubitat-dashboard](https://github.com/bdwilson/cf-hubitat-dashboard), read at build time rather than copied in.
