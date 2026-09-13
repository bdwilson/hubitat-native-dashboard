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

2. **Install the app code**, either way:
   - **Bundle** — Settings → **Bundles** → *Import ZIP* → upload [`dist/hubitat-native-dashboard.zip`](dist/). Installs the app code in one step.
   - **Paste** — Apps Code → New App → paste `app/HubitatNativeDashboard.groovy` → **Save**. (Or use **Import** with this repo's raw URL; the app's `importUrl` is already set for updates.)

3. **Enable OAuth** — in Apps Code, click **OAuth** → **Enable OAuth in App** → **Update**. Required; the dashboard links won't work without it. (Bundles *can* ship OAuth pre-enabled, but that would bake one shared OAuth client secret into every install from this repo, so this one doesn't.)

4. Apps → **Add User App** → *Hubitat Native Dashboard*. Paste the Maker API **App ID** and **Access Token** → **Done**.

5. **Install the UI.** Reopen the app and click **"Install / update dashboard UI"**. It downloads the built files and writes them into File Manager itself.
   - Needs hub firmware **2.3.4.134+** (for `uploadHubFile()`). Older hubs: upload the `hnd-*` files from `dist/` to **Settings → File Manager** by hand — the app page tells you if this applies.
   - This is the only moment anything is fetched from outside the hub. Afterwards, serving, device access and config are all local.
   - Point **UI source URL** at your own host if you'd rather not fetch from GitHub.

6. Reopen the app for the **Local** and **Cloud** dashboard links.

**Updating:** re-run `node build/build.mjs` (only needed if you changed the frontend), then use **Import** in Apps Code for the Groovy and the **Install / update dashboard UI** button for the UI.

`dist/` is committed on purpose — the self-install button fetches those files from this repo. Regenerate it whenever `cf-hubitat-dashboard`'s frontend changes:

```sh
node build/build.mjs            # sibling checkout, else fetches from GitHub
node build/build.mjs --source <path-or-url>
```

## Per-browser layouts

The settings panel has **"Where this dashboard's layout is stored"**:

- **On the hub** — shared; every browser opening the link sees the same dashboard. (Default.)
- **In this browser only** — private to that browser. The hub's config is **neither read nor written**.

Devices, commands and real-time updates always come from the same hub. Only *where the tile layout lives* changes.

**Switching to local copies the hub's layout in first**, so you start from exactly what's on screen and then diverge — take a shared dashboard, tweak it for one wall tablet, and the shared one is untouched. (This copy is load-bearing: the app applies the hub config to memory but never writes it to the browser cache, so without it you'd get whatever stale cache happened to be there.)

**Switching back** offers both directions, each as its own control so neither has a hidden second meaning:
- **⬆ Publish this layout to the hub** — pushes your private layout up, replacing the shared one, and returns you to shared mode.
- **The toggle itself** — adopts the hub's layout, replacing your private one. Cancelling aborts the switch; it never silently discards anything.

In local mode the **Save Config to Hub** button is hidden, since it would do nothing while reporting success.

The choice is remembered per browser. `&local=1` / `&local=0` on the URL still force a mode for one load regardless, so you can hand out a link without changing what someone's browser remembers.

Two things worth knowing:
- Hiding a device and editing a custom dashboard normally save to the hub **on their own**, without the save button. Local mode suppresses those too, so a private browser can't quietly rewrite what everyone else sees. Verified: a session in local mode issued zero writes and left the hub's config untouched.
- A private layout lives in that browser's `localStorage`, so clearing site data loses it. Use **Download Config** to keep a copy.

## Building in CI

`.github/workflows/build.yml` builds `dist/` on a GitHub runner and commits it back, so no local Node install is needed to produce a distribution. It runs on pushes touching `app/` or `build/`, nightly, and on demand.

It commits `dist/` rather than uploading an artifact because the app's **Install / update dashboard UI** button fetches those files from this repo — as artifacts they'd be unreachable from a hub.

The nightly run earns its keep twice over. The frontend is read from `cf-hubitat-dashboard` at build time rather than vendored, so it picks up upstream changes automatically — and because the build asserts every transport patch matches **exactly once**, a restructured upstream fails the run and names the patch that stopped matching, instead of that surfacing as a broken dashboard on a hub.

The build is reproducible: rebuilding unchanged inputs produces byte-identical output (`builtAt` is reused when the build id is unchanged, and no local source path is recorded), so CI only commits when something genuinely changed. A local build and a CI build of the same inputs are identical. CI also compiles the app with `check-groovy.groovy` and fails before building if it won't compile.

## Version tracking

The app page tells you what's installed and whether it's current:

- **App version** — a constant in the Groovy, shown under *About*.
- **UI build** — a 10-char id in `hnd-manifest.json`, hashed over the patched upstream source *and* this project's loader/shell generation, so any change that alters the shipped bytes produces a new id.
- **Update check** — a **Check for updates** button fetches the manifest from the UI source URL and compares build ids: *Up to date*, *Update available: installed X, available Y*, or a failure. Cached for 6 hours; never fetched just because the settings page rendered.
- **Integrity, not just presence** — the app verifies each installed file is the exact byte size the manifest recorded, and that the shell's own `<!-- hnd-build: … -->` stamp matches the manifest's version.

That last check exists because presence alone is misleading. The shell embeds the chunk list and the `?v=` cache key, so re-uploading *some* files leaves a shell from one build driving chunks from another — everything "present", nothing obviously wrong, and a dashboard that half works. Verified both failure modes (stale chunk, mixed build) are detected.

The `status` route returns all of it as JSON: `appVersion`, `installedUiBuild`, `updateCheck`, `firmware`, `hubFileApi`, plus config size and hub IP.

## Differences you'll notice from the Cloudflare build

The frontend is the same, but a few things are adjusted because Cloudflare isn't involved:

- **"💾 Save Config to Hub"** is what upstream calls *Save Config to KV*. It writes to the app's `state` on your hub. **Closing the settings panel only saves to that browser** — click this to make a layout visible on your phone and every other device.
- **Every "KV"/"Cloudflare"/"Worker" string a user can see is rewritten**, including runtime prompts — the *Reset Everything* confirmation now says it wipes config "from this browser and from the hub". Function names and code comments keep their upstream spelling; renaming those would be churn with no user-facing benefit.
- **The Hub Connection fields are hidden.** Maker API URL/app ID/token come from the app's settings page in Hubitat, so those inputs are inert here. They're hidden rather than deleted, since upstream's code still reads them.
- **Every other "KV"/"Cloudflare" label** is rewritten to say hub.

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
| Config backup → restore → save round-trip | ✅ in Chromium (caught a real bug — see below) |
| "Save Config to Hub" button persists server-side | ✅ in Chromium (PUT issued, config read back) |
| Bundle ZIP is a valid archive, matches the real bundle layout | ✅ unpacked with `unzip`, app file byte-identical |
| Groovy compiles | ✅ Groovy 2.4.21, `CLASS_GENERATION` |
| **The rewritten Groovy app on a real hub** | ⚠️ **partly** — Maker API proxy, listing, commands and both links confirmed; asset serving, config API and self-install not yet |

### An upstream bug this shook out

Testing restore end-to-end surfaced a bug **that affects the Cloudflare build too**: `applyImportedConfig()` writes imported values into `cfg` and syncs *some* settings inputs back to the form, but not `cfg-title`, `cfg-poll`, `cfg-grid-cols`, `cfg-tile-h` or `cfg-icon-scale`. Since `readSettingsForm()` reads all of those straight off the form on the next save, **importing a backup and then saving silently reverts those five settings** to their pre-import values. Observed directly: import set the page title to the restored name, then save wrote the *old* title to the server.

The `import-syncs-all-settings-inputs` patch fixes it here. The real fix belongs in cf-hubitat-dashboard, which this repo deliberately does not push to.

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
