# Sykerö Tuya Lights

Pebble watchapp for controlling Tuya / Smart Life smart lights (on/off,
brightness, colour temperature) directly from the watch. No separate Android
companion app — the watchapp's phone-side JavaScript (PKJS) calls the **Tuya
Cloud OpenAPI** itself, and credentials are entered on the Clay config page.

Part of the Sykerö ecosystem (see the `pebble-timetracking` superrepo). Design
and plan: `docs/superpowers/{specs,plans}/2026-06-15-pebble-tuya-lights-*` in the
superrepo.

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

- **List window:** your lights with on/off + brightness%. Select a light to open it.
- **Control window:** SELECT toggles power; UP/DOWN adjust brightness; **hold
  SELECT** switches UP/DOWN to colour temperature (lights that support it).

## Build / test

- Build: `pebble build` (PKJS bundles `js-sha256` for HMAC signing + Clay).
- Unit tests: `npm test` (Jest — signing, token, lights logic).

RGB colour and scenes are out of scope for the initial version.

## Support

Questions, feedback or bug reports: <pebble.tuyalights@sykero.fi>
