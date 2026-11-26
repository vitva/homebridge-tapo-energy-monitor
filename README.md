# homebridge-tapo-energy-monitor

A Homebridge 2 Matter platform for Tapo energy monitoring and combined consumption history. The required transport is TP-Link Tapo cloud; the plugin does not require the Homebridge host to share a LAN with the devices.

## Current status — 0.2.0 Matter prototype

**Energy aggregation is still simulation-only.** A separate read-only Tapo cloud diagnostic is now available in the custom UI; its P110M result is not yet connected to the history aggregator. The prototype:
- registers a Homebridge dynamic platform;
- provides a custom Homebridge UI dashboard with combined power, per-device readings, and daily/monthly/yearly estimates;
- accepts multiple simulated devices with unique IDs, names, model labels, and power values;
- stores data locally in `tapo-energy-history.json`;
- aggregates estimated Wh per device and for the combined group;
- optionally publishes one virtual Matter **Electrical Meter** with the combined **estimated** active power and cumulative estimated imported energy.

The Matter accessory is deliberately named **Tapo Energy — Расчётная**. It uses the dedicated Matter Electrical Meter device type, but its readings are still estimates and it does not claim to be a calibrated/billing meter. A separate real-data meter will only be published after the physical Tapo adapter can supply verified cumulative counters. This prevents real and estimated values from being mixed or represented as real measurements.

### Matter requirements and limitations

- Homebridge 2.5.0 or later, with Matter enabled on the bridge hosting this platform. Homebridge 2.5.0 exposes the dedicated `ElectricalMeter` device type.
- Apple Home on iOS/tvOS 27 or later for the current energy-monitoring interface. Apple has changed the Energy view across releases; bridged-device visibility may require iOS/tvOS 27.3 or later.
- Pair the Matter-enabled Homebridge bridge using its **Matter** pairing code, not its HAP QR code.
- The plugin publishes the Electrical Meter device type with live active power and cumulative imported-energy attributes. **Apple Home may show live W without exposing the lifetime kWh value or daily/monthly/yearly history in its UI.** Those display details must be checked on the actual Apple Home version and hub. The plugin's own dashboard retains the full local history.
- Apple Home's per-device historical usage charts are a separate feature and may depend on a supported utility account; they are not created merely by publishing Matter energy attributes.
- If Matter is not enabled, or the Homebridge version does not expose `ElectricalMeter`, the plugin continues its local dashboard and logs why the Matter meter was skipped.

Matter power is sent in milliwatts (mW); cumulative energy is sent in milliwatt-hours (mWh). The local dashboard continues to show watts (W) and watt-hours (Wh).

## Data-source architecture decision

The required transport is **TP-Link Tapo account/cloud only**. The plugin must not require the Homebridge server to share a LAN with the dacha devices, and it must not fall back to direct-IP/local polling.

The P110M route now targets the newer Tapo Thing Cloud API: account authentication, service discovery, Thing device listing, and the read-only `GET /v1/things/{thingName}/usage` endpoint. This is distinct from the older device passthrough API and is a better fit for current P110M firmware. The response and historical fields still need verification against the user's account.

The implementation plan is therefore:
- authenticate to the TP-Link/Tapo account and discover devices through the Tapo cloud;
- use the Tapo Thing Cloud `/usage` endpoint for read-only live power and history;
- test P110M first; do not assume P110 support automatically means P110M support;
- keep S112 and S110E readings unavailable until their cloud-relayed model-specific responses are verified;
- store the Tapo email and password in the Homebridge platform config for reuse after restarts; the password is plain text in `config.json`, so protect that file and its backups;
- never write credentials, MFA codes or session tokens to plugin logs or diagnostic reports; keep session tokens in memory only;
- label every value by source (cloud device history, cloud meter counter, estimated from power, or unavailable);
- never fill missing/offline periods with invented values or mix real and estimated values.

The cloud route is unofficial/reverse-engineered and may change if TP-Link changes its private API. P110M history is not guaranteed to be available while the plug is offline.

### Tapo cloud diagnostic (read-only)

The custom Homebridge UI includes a **Проверка облака TP-Link Tapo** panel with two selectable transports: **Python (reference implementation)** and **Node.js (experimental)**. Both use the Tapo cloud only; the Node.js option implements Tapo V2 account authentication directly and does not require Python. It:
- logs in to the Tapo cloud only (no Kasa login, device IP or dacha LAN access);
- requests an email MFA code only when TP-Link actually challenges the login; the code field stays hidden otherwise;
- displays a safe stage report (status, elapsed time and numeric API error code) without passwords, MFA codes or session tokens; the Node.js transport separates regional server discovery from account authentication, while the Python library reports login as one combined stage;
- lists devices returned by the Tapo cloud account;
- discovers devices through the Tapo Thing API and requests the read-only `/usage` resource for discovered P110M devices;
- never sends relay, power, reboot, reset or configuration commands.

The Tapo email and password are saved in the platform configuration (`config.json`) after a completed cloud check and are prefilled the next time the settings UI opens. If TP-Link requests MFA, the first attempt keeps the settings session open; the one-time MFA code is never saved. The password is stored in plain text by Homebridge, so protect `config.json`, its backups and access to the Homebridge UI. Credentials are submitted to the local Homebridge UI server over its plugin request channel and are never written to plugin logs or diagnostic reports. The Python transport passes credentials to its helper over stdin; the experimental Node.js transport keeps them in the in-memory request flow. The cloud session token is held only for the short-lived diagnostic request and is not persisted. Thing API TLS verification uses the TP-Link Cloud Server CA; redirects and unexpected Thing API hostnames are rejected.

The Python reference transport requires Python 3.10+ and the optional dependency in `requirements-cloud.txt`. Create a virtual environment inside the Homebridge container, install the requirements there, then set **Python executable for Tapo cloud** in the plugin settings to that environment's Python path. The experimental Node.js transport does not require this Python environment:

```sh
python3 -m venv /path/to/tapo-cloud-venv
/path/to/tapo-cloud-venv/bin/pip install -r /path/to/homebridge-tapo-energy-monitor/requirements-cloud.txt
```

For example, the configured executable would be `/path/to/tapo-cloud-venv/bin/python`. The venv and package must exist in the same container/filesystem where Homebridge runs.

This is a connectivity diagnostic, not production polling. A successful login and device listing do not prove that the P110M `/usage` response contains valid current power and history. The Node.js client currently returns the vendor payload without interpreting it; test fixtures are deliberately synthetic and do not describe the real TP-Link schema. The returned structure must be captured from a real account and checked for field names, units, time zone, historical bucket semantics, and counter behavior before wiring it into the store.

### Watt CSV reference imports

The custom UI can import a Watt daily-history CSV as either an **individual device** reference set or an **all-devices aggregate** reference set. These imports are stored separately in `tapo-watt-imports.json`; they do not alter the live energy store, simulation values, or Matter meter. Re-importing a category replaces that reference set rather than adding duplicate rows. The importer validates dates, non-negative Wh values and duplicate days, and calculates daily/monthly/yearly totals.

The date bucket deliberately uses the calendar date printed at the start of Watt's `Date` field, rather than converting its timestamp to the Homebridge host timezone. This preserves Watt's exported daily label (for example, `2026-10-26 21:00:00 +0000`) and avoids shifting a daily total into the next date. The `Runtime (Minute)` column is retained but is not used in energy calculations.

Individual and aggregate imports are comparison/reference data only. The aggregate must never be added to the individual-device total; doing so would double-count. These files are useful as regression fixtures when validating the future cloud-history parser.

## Planned physical devices

- Tapo P110M
- Tapo S112
- Tapo S110E

P110M cloud discovery and the read-only `/usage` diagnostic are implemented; scheduled aggregation remains unconnected until its returned values are verified. S112 and S110E cloud support remains unimplemented. When verified real counters are available, they will be exposed separately from estimates; they will not be added twice to the same total.

## Homebridge setup and safe defaults

Add the **Tapo Energy Monitor** platform in Homebridge UI. The platform is idle by default: **Simulation mode** is off and no demo devices are created automatically. It does not start polling or publish a Matter accessory until simulation is explicitly enabled and at least one device row is configured. For a test run, enable **Simulation mode** and add one row per test device. IDs must be unique and stable across restarts.

All persistent history is written under the Homebridge storage directory returned by the Homebridge API. There is no custom external data-directory setting.

## Compatibility and verification preparation

- Homebridge 2.5.0 or later; this is the minimum required for the dedicated Matter Electrical Meter type.
- Node.js 22, 24, and 26 are tested in CI.
- The package declares `supports-matter` because it registers a Matter Electrical Meter directly and does not publish HAP accessories.
- No install or post-install script modifies the Homebridge host.
- No analytics or telemetry is included.
- GitHub issues are enabled and the source is public.

The plugin is **not yet ready to submit for Verified By Homebridge review**: production cloud polling and verified real-device energy aggregation are not implemented, and the current Tapo cloud check still uses an optional Python helper. The verification request also requires an npm-published release and release notes. Do not describe the plugin as verified or submit a request until those gaps are closed.

## Development

```sh
npm install
npm test
npm run lint
```

To test Matter export, use Homebridge 2.5.0 or later, enable Matter for the bridge that hosts this platform, and leave **Publish Matter Electrical Meter** enabled. The prototype registers `api.matter.deviceTypes.ElectricalMeter` and deliberately does not downgrade to `ElectricalSensor` on older versions. Do not pair the HAP code when testing this Matter sensor.

## Data and calculation

The store keeps the latest power sample, lifetime estimated Wh, and daily/monthly/yearly estimated Wh for each device, plus combined totals. Energy is estimated by trapezoidal integration between adjacent power samples. Gaps longer than six hours are capped to avoid huge estimates after downtime. An interval is assigned to the local calendar date of its ending sample.

This is an estimation prototype, not a billing meter. No measurements are collected while Homebridge is stopped.
