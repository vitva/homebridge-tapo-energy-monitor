# homebridge-tapo-energy-monitor

A separate Homebridge plugin project for local Tapo energy monitoring and combined consumption history.

## Current status — 0.2.0 Matter prototype

**Energy aggregation is still simulation-only.** A separate read-only Tapo cloud diagnostic is now available in the custom UI; its P110M result is not yet connected to the history aggregator. The prototype:
- registers a Homebridge dynamic platform;
- provides a custom Homebridge UI dashboard with combined power, per-device readings, and daily/monthly/yearly estimates;
- accepts multiple simulated devices with unique IDs, names, model labels, and power values;
- stores data locally in `tapo-energy-history.json`;
- aggregates estimated Wh per device and for the combined group;
- optionally publishes one virtual Matter Electrical Sensor with the combined **estimated** active power and cumulative estimated energy.

The Matter sensor is deliberately named **Tapo Energy — Расчётная**. It does not pretend to be a real electricity meter. The real-counter Matter sensor is not published until the physical Tapo adapter can supply verified cumulative counters. This prevents real and estimated values from being mixed or represented as real measurements.

### Matter requirements and limitations

- Homebridge 2.2.0 or later, with Matter enabled on the bridge hosting this platform.
- Apple Home on iOS/tvOS 27 or later for the current energy-monitoring interface. Apple has changed the Energy view across releases; bridged-device visibility may require iOS/tvOS 27.3 or later.
- Pair the Matter-enabled Homebridge bridge using its **Matter** pairing code, not its HAP QR code.
- The plugin publishes both live active power and the cumulative-energy Matter attribute. **Apple Home may show live W without exposing the lifetime kWh value or daily/monthly/yearly history in its UI.** Those display details must be checked on the actual Apple Home version and hub. The plugin's own dashboard retains the full local history.
- Apple Home's per-device historical usage charts are a separate feature and may depend on a supported utility account; they are not created merely by publishing Matter energy attributes.
- If Matter is not enabled on the bridge, the plugin continues its local dashboard and logs why the Matter sensor was skipped.

Matter power is sent in milliwatts (mW); cumulative energy is sent in milliwatt-hours (mWh). The local dashboard continues to show watts (W) and watt-hours (Wh).

## Data-source architecture decision

The required transport is **TP-Link Tapo account/cloud only**. The plugin must not require the Homebridge server to share a LAN with the dacha devices, and it must not fall back to direct-IP/local polling.

The P110M route now targets the newer Tapo Thing Cloud API: account authentication, service discovery, Thing device listing, and the read-only `GET /v1/things/{thingName}/usage` endpoint. This is distinct from the older device passthrough API and is a better fit for current P110M firmware. The response and historical fields still need verification against the user's account.

The implementation plan is therefore:
- authenticate to the TP-Link/Tapo account and discover devices through the Tapo cloud;
- use cloud passthrough for read-only live power and, if verified, history/counter queries;
- test P110M first; do not assume P110 support automatically means P110M support;
- keep S112 and S110E readings unavailable until their cloud-relayed model-specific responses are verified;
- store credentials/tokens server-side only; never expose them to the browser or logs;
- label every value by source (cloud device history, cloud meter counter, estimated from power, or unavailable);
- never fill missing/offline periods with invented values or mix real and estimated values.

The cloud route is unofficial/reverse-engineered and may change if TP-Link changes its private API. P110M history is not guaranteed to be available while the plug is offline.

### Tapo cloud diagnostic (read-only)

The custom Homebridge UI includes a **Проверка облака TP-Link Tapo** panel. It:
- logs in to the Tapo cloud only (no Kasa login, device IP or dacha LAN access);
- supports an email MFA code when TP-Link requests one;
- lists devices returned by the Tapo cloud account;
- discovers devices through the Tapo Thing API and requests the read-only `/usage` resource for discovered P110M devices;
- never sends relay, power, reboot, reset or configuration commands.

The email, password and MFA code are submitted to the local Homebridge UI server over its plugin request channel, passed to the helper over stdin, and are not written to plugin settings or logs. The cloud session token is held only in the short-lived diagnostic process and is not persisted. Thing API TLS verification uses the TP-Link Cloud Server CA; redirects and unexpected Thing API hostnames are rejected.

The helper requires Python 3.10+ and the optional dependency in `requirements-cloud.txt`. Create a virtual environment inside the Homebridge container, install the requirements there, then set **Python executable for Tapo cloud** in the plugin settings to that environment's Python path:

```sh
python3 -m venv /path/to/tapo-cloud-venv
/path/to/tapo-cloud-venv/bin/pip install -r /path/to/homebridge-tapo-energy-monitor/requirements-cloud.txt
```

For example, the configured executable would be `/path/to/tapo-cloud-venv/bin/python`. The venv and package must exist in the same container/filesystem where Homebridge runs.

This is a connectivity diagnostic, not production polling. A successful login and device listing do not prove that the P110M `/usage` response contains valid current power and history. The returned structure must be checked for units, time zone, and counter semantics before wiring it into the store.

## Planned physical devices

- Tapo P110M
- Tapo S112
- Tapo S110E

Local protocol support and device-specific history APIs remain to be implemented and verified against hardware. When verified real counters are available, they will be exposed separately from estimates; they will not be added twice to the same total.

## Development

```sh
npm install
npm test
npm run lint
```

Add the **Tapo Energy Monitor** platform in Homebridge UI. Keep **Simulation mode** enabled. In **Simulated devices**, add one row per test device. IDs must be unique and stable across restarts.

To test Matter export, enable Matter for the Homebridge bridge that hosts this platform and leave **Publish Matter energy sensor** enabled. Do not pair the HAP code when testing this Matter sensor.

## Data and calculation

The store keeps the latest power sample, lifetime estimated Wh, and daily/monthly/yearly estimated Wh for each device, plus combined totals. Energy is estimated by trapezoidal integration between adjacent power samples. Gaps longer than six hours are capped to avoid huge estimates after downtime. An interval is assigned to the local calendar date of its ending sample.

This is an estimation prototype, not a billing meter. No measurements are collected while Homebridge is stopped.
