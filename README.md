# Hubitat Native Dashboard — spike

**Proof of concept. Not a working dashboard. Core mechanism (Maker API proxy → device listing) confirmed working on a real hub; command proxying and the cloud URL not yet confirmed.**

This repo exists to answer one question:

> Can a Hubitat dashboard run **entirely on the hub** — no Cloudflare, no external hosting, no separate cloud account — by wrapping Hubitat's existing **Maker API** from inside a native, OAuth-enabled Hubitat App?

It is deliberately separate from [bdwilson/cf-hubitat-dashboard](https://github.com/bdwilson/cf-hubitat-dashboard) (the actual production dashboard, Cloudflare Worker + KV). Nothing here is wired into that project, and this experiment should not disturb it.

## The idea

A Hubitat App can make HTTP calls to any URL — including its own hub, on `127.0.0.1:8080`. So instead of reimplementing device access, capability detection, and command dispatch in Groovy from scratch, this App acts as a **thin proxy** in front of an existing Maker API instance:

```
Browser ──OAuth token──► This App (on the hub)
                              │
                              └──httpGet 127.0.0.1:8080──► Maker API (same hub)
                                                          │
                                                          └──► your devices
```

The payoff, if it works: the JSON shape and command URL shape stay *exactly* what Maker API already produces — which is exactly what the production dashboard's frontend already speaks. In principle, most of that frontend's device logic could run against this backend unchanged, with only the transport layer swapped.

## What's here

```
app/HubitatNativeDashboard.groovy   the spike App — OAuth, routes, Maker API proxy,
                                    and a minimal HTML test page
CLAUDE.md                           full context for AI-assisted development
NOTICE                              attribution for patterns adapted from
                                    evdev/hubitat-modern-dashboard (Apache 2.0)
```

The test page is intentionally minimal — it lists your devices and toggles switches. That's it. It exists to isolate whether the *mechanism* works, not to look like a dashboard.

## Setup

You need a Maker API instance first. If you already run one (for Alexa, HomeBridge, etc.), you can reuse it.

1. **Maker API** — Apps → Add Built-in App → Maker API. Select the devices you want available. Note the **App ID** and **Access Token** from its page.
2. **This app** — Apps Code → New App → paste `app/HubitatNativeDashboard.groovy` → **Save**.
3. Click **OAuth** at the top of the code editor → **Enable OAuth** → **Save**. (Required — the dashboard link won't work without it.)
4. Apps → **Add User App** → *Hubitat Native Dashboard (spike)*.
5. Paste the Maker API **App ID** and **Access Token** → **Done**.
6. Reopen the app — it shows **Local** and **Cloud** dashboard links.

## What to check when testing

These are the interesting failure points, roughly in the order they'd bite:

| Check | What it tells us | Status |
|---|---|---|
| Does the app **save** in Apps Code without a compile error? | Groovy syntax is valid | ✅ confirmed |
| Does the app page show Local/Cloud links? | OAuth + `createAccessToken()` worked | ✅ confirmed |
| Does the **local** link load the page? | `mappings`/`render` routing works | ✅ confirmed |
| Does it list devices? | **The core question** — internal `httpGet` to Maker API on `127.0.0.1:8080` works | ✅ confirmed — loaded 141 devices |
| Does toggling a switch work? | Command proxying works | fix just applied, not yet re-tested |
| Does the **cloud** link do all of the above? | Hubitat's cloud OAuth proxy passes through correctly | fix just applied, not yet re-tested |

If the device list fails, **Logs** in the Hubitat admin UI (filtered to this app) will have the error — `makerApiGet` logs failures with the message. Issues already found and fixed during real-hub testing (see commit history):
- The embedded test page originally used root-relative fetch URLs (`/devices/all`, `/cmd`), which resolve against the hub's origin root instead of this app's own base path — fixed by making them path-relative.
- Self-calls need port **8080**, not port 80/443. Two wrong attempts confirmed this: plain `127.0.0.1` (port 80) and `location.hub.localIP` (port 80) both fail with connection refused. Port 80/443 fronts the hub's admin/browser-facing web server; the internal app engine that serves `/apps/api/...` to the hub calling itself listens on 8080/8443. Fixed by using `127.0.0.1:8080`. This matches evdev/hubitat-modern-dashboard's own `hubLoginUri()` (`http://127.0.0.1:8080`), confirmed by reading their actual source.
- The **cloud** dashboard link returned AWS API Gateway's generic `{"message":"Missing Authentication Token"}` (its standard "no matching route" response) — caused by the link pointing at the bare root `/` instead of `/dashboard`. evdev's own dashboard-link builder always uses `/dashboard`, never a bare-root link, even though its `mappings` block maps both. Fixed by switching both dashboard links and the `mappings` entry to `/dashboard`.
- **No device ever showed a toggle button, even though 141 devices loaded.** Maker API's `/devices/all` returns `attributes` as a flat object keyed by name (`{"switch":"off"}`), not an array of `{name, currentValue}` objects — the test page's `getAttr()` assumed the array shape, so every lookup silently returned `undefined` and no device was ever detected as having a `switch`. Fixed by reading `device.attributes[name]` directly.

If the device list still fails after these fixes, the most likely remaining culprit is the Maker API App ID/token being wrong.

## Trade-offs of this approach

**Wrapping Maker API (this spike)**
- Reuses Maker API's JSON and command shapes — the production dashboard's frontend already speaks them
- Much less Groovy to write and maintain
- Requires Maker API to be installed and configured separately (two apps, not one)
- Inherits Maker API's **one-argument-per-command** limit
- Extra HTTP round-trip per request (localhost, so cheap, but not free)

**Reimplementing device access natively** (what [evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard) does)
- One app, no Maker API dependency, direct in-process device access
- Can dispatch multi-argument commands that Maker API's URL shape can't express
- Uses Hubitat's capability-bucketed device pickers, which don't map cleanly onto a "any device, any tile type" dashboard
- Substantially more Groovy to write and keep working

There's a middle path worth remembering: native device access, but serialize the JSON to *match* Maker API's shape anyway. That drops the Maker API dependency and the one-argument ceiling while keeping frontend compatibility — at the cost of writing that serialization yourself. Not attempted here; wrapping is the smaller first step.

## Known limits (inherited from the platform, not from this spike)

These apply to *any* on-hub dashboard, including this one — they're documented in evdev's project too and were confirmed by reading its source:

- **Hubitat Cloud caps responses at roughly 128 KB.** A large device list can exceed this. Local URL has no such cap.
- **File Manager caps files at 124 KB.** Any real UI would need to be split across multiple files and served from there — this spike sidesteps that entirely by keeping its test page small enough to embed directly in the Groovy source, which a real dashboard could not do.
- **Real-time WebSocket updates are local-only.** Hubitat's cloud proxy doesn't expose `eventsocket`. (The production dashboard already has and handles this same limitation.)
- **Don't serve binary images through Hubitat Cloud** — it corrupts them. Base64-encode and decode server-side, or host externally.
- **Security is the URL.** Anyone with the dashboard link can control the exposed devices — the same trust model as Maker API's own URLs. There's no per-user identity here, unlike Cloudflare Access in front of the production dashboard.

## Status

**Core mechanism confirmed on a real hub: the app proxied Maker API and listed 141 real devices.** A compile error, a root-relative-URL bug, a self-call wrong-port bug, a cloud-link wrong-path bug, and a Maker API attributes-shape bug (no toggle buttons ever rendered) were found and fixed along the way (see commit history). Still to confirm: toggling a device and the cloud dashboard link, with the latest fixes applied.

## Credits

Groovy platform patterns (internal self-hosted HTTP calls, defensive response-body reading) were adapted from [evdev/hubitat-modern-dashboard](https://github.com/evdev/hubitat-modern-dashboard), Apache 2.0 — see [NOTICE](NOTICE). That project takes a different architectural approach (native device access, no Maker API) and is worth reading if this direction gets built out further.
