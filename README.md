# Sykerö Tuya Lights

Pebble watchapp for controlling Tuya / Smart Life smart lights (on/off,
brightness, colour temperature) directly from the watch. No separate Android
companion app — the watchapp's phone-side JavaScript (PKJS) calls the **Tuya
Cloud OpenAPI** itself, and credentials are entered on the Clay config page.

Part of the [Sykerö Software](https://github.com/Sykero-Software) ecosystem.

**[Install from the Pebble appstore →](https://apps.repebble.com/tuya-lights_dfc4441530f946c895d73257)**

## Why cloud (not local LAN)

Tuya's official app exposes no API for third-party apps to drive it, so the app
talks to Tuya's cloud directly. Cloud control also works across network
segments (e.g. lights isolated on their own VLAN) since neither side needs to
reach the other on the LAN — only the internet. Each user supplies their own
Tuya developer credentials (see setup); there is no shared backend.

## One-time setup — get your Tuya credentials

You need a free **Tuya IoT / Developer Platform** cloud project linked to the
same Smart Life account your lights are paired to.

1. Go to <https://iot.tuya.com> (Tuya Developer Platform) and sign up / log in.
2. **Cloud → Development → Create Cloud Project.**
   - Development Method: **Smart Home**.
   - **Data Center:** pick the region your Smart Life account is registered in
     (e.g. *Central Europe* for the EU). This MUST match, or no devices appear.
   - On create you are shown the **Access ID / Client ID** and **Access Secret /
     Client Secret** — these go into the watchapp config.
3. Make sure the project has the **IoT Core** and **Authorization** API products
   authorized (Project → *Service API* / *Authorize API Products*; free tier).
4. **Link your Smart Life account:** Project → **Devices → Link App Account →
   Add App Account**, then in the Smart Life phone app go to **Me → Scan** and
   scan the QR code. Your lights then appear under **Devices → All Devices**.

## Configure the watchapp

1. Install the `.pbw` (CloudPebble or sideload).
2. Phone Core app → **Tuya Lights → Settings** (the Clay page).
3. Paste **Access ID**, **Access Secret**, choose the matching **Data Center**,
   then **Save**.
4. Open Tuya Lights on the watch — the light list fetches automatically.

## Controls

- **List window:** your lights with on/off + brightness%. Offline lights are greyed
  out and inert. By default a **short SELECT toggles that light** directly and **hold
  SELECT opens its control window**; with the "Tap in list toggles the light" setting
  off, a short SELECT opens the control window instead.
- **Control window:** SELECT toggles power; UP/DOWN adjust brightness; **hold
  SELECT** switches UP/DOWN to colour temperature (on lights that support it).

### Behavior settings (Clay config page)

- **Tap in list toggles the light** (default on) — short tap toggles, hold opens the
  control window; off = tap opens the control window.
- **Close the app after toggling** (default off) — returns to the watchface once the
  phone confirms the cloud command (a "Switching…" screen shows meanwhile).
- **Devices & scenes** — the ordered list of lights/scenes to show on the watch
  (reorder with ▲/▼). This order is the source of truth: the watch mirrors it,
  and re-saving a new order reorders the watch list on the next refresh.
- **Auto-organize list** (default off) — when on, recently used entries rise to the
  top and offline lights sink to the bottom, overriding the configured order.
- **Auto-refresh while open** (default off) — state is always fetched on open; this
  also re-polls while the app stays open (more data/battery).
- **Return to watchface when idle** (default 15 s) — closes back to the watchface
  after that long with no button press.

## Development with JailBee

This project is developed extensively using [JailBee](https://jailbee.gisgro.io/)
for isolated development environments. With JailBee and its Linux/Incus
prerequisites installed, run from this repository on the **host**:

```sh
jailbee init
jailbee base build          # one-time toolchain image; rebuild after SDK changes
jailbee new dev
jailbee tmux dev
```

Development normally happens with Claude Code inside the container. Before
creating it, enable `agents.claude.enabled` and `agents.claude.autostart`
in your host's `~/.config/jailbee/global.yaml`; `jailbee tmux dev` then attaches to
the session running Claude. Ask Claude to make changes and run the project's
builds and tests.

The committed [configuration](.jailbee/config.yaml) and
[installer](.jailbee/install.d/45-pebble-sdk.sh) provide Node.js 24,
pebble-tool 5.1.2, Pebble SDK 4.44 and a headless emulator; no parent
repository is required. Building the image installs the SDK under the
[Pebble developer terms](https://developer.repebble.com/legal/sdk-license/index.html).
Keep personal agent/IDE settings and credentials in JailBee's host-local config.
Commit inside the container, then run `jailbee git pull dev` on the host;
publish from the host, not the container.

## Build / test

- Build: `pebble build` (PKJS bundles `js-sha256` for HMAC signing + Clay).
- Unit tests: `npm test` (Jest — signing, token, lights logic).
- Watch-side list ordering (pure C core):
  `gcc -I src/c tests/test_row_order.c src/c/row_order.c -o /tmp/t && /tmp/t`.

RGB colour and scenes are out of scope for the initial version.

## Support

Questions, feedback or bug reports: <pebble.tuyalights@sykero.fi>

Browse all Sykerö Software apps on the Pebble appstore:
<https://apps.repebble.com/apps/dev/syker-software_9f6c9c6e9ce88af6a0db953e>
