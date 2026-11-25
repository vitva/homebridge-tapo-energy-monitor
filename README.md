# homebridge-tapo-energy-monitor

A separate Homebridge plugin project for local Tapo energy monitoring and combined consumption history.

## Current status — 0.2.0 Matter prototype

**Simulation only. Real Tapo communication is not implemented.** The prototype:
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

TP-Link account login and Tapo cloud device discovery are not the same as cloud energy telemetry. The reviewed cloud client documents Tapo discovery/basic control, but no verified Tapo cloud energy-history endpoint for P110M, S112 or S110E. TP-Link support also confirms that P110M history cannot be downloaded while the device is offline.

The implementation plan is therefore:
- use account/cloud discovery only as an optional device-inventory source;
- retrieve P110M live values and history through its supported device API when reachable on the LAN;
- keep S112 and S110E unsupported for real readings until their model-specific API responses are verified;
- label every value by source (real device history, real meter counter, estimated from power, or unavailable);
- never fill missing/offline periods with invented values or mix real counters with estimates.

See [the data-source capability assessment](docs/tapo-data-source-assessment.md) for the evidence and adapter plan.

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
