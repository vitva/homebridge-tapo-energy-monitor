# homebridge-tapo-energy-monitor

A separate Homebridge plugin project for local Tapo energy monitoring and combined consumption history.

## Current status — 0.1.0 multi-device simulator

**Simulation only. Real Tapo communication is not implemented.** The current prototype:
- registers a Homebridge dynamic platform;
- provides a custom Homebridge UI dashboard with combined power, per-device readings, and daily/monthly/yearly estimates;
- exposes the graphical platform settings below the dashboard;
- accepts multiple simulated devices with unique IDs, names, model labels, and power values;
- stores data locally in `tapo-energy-history.json`;
- aggregates estimated Wh per device and for the combined group.

The dashboard reads the local JSON history file from the Homebridge host. It refreshes every 15 seconds while the plugin settings screen is open. The simulator does not contact physical devices. It does not create HomeKit energy-history records or claim that Apple Home displays accumulated kWh.

## Planned physical devices

- Tapo P110M
- Tapo S112
- Tapo S110E

Local protocol support and device-specific history APIs remain to be implemented and verified against hardware.

## Development

```sh
npm install
npm test
npm run lint
```

Add the **Tapo Energy Monitor** platform in Homebridge UI. Keep **Simulation mode** enabled. In **Simulated devices**, add one row per test device. IDs must be unique and stable across restarts.

## Data and calculation

The store keeps the latest power sample, lifetime estimated Wh, and daily/monthly/yearly estimated Wh for each device, plus combined totals. Energy is estimated by trapezoidal integration between adjacent power samples. Gaps longer than six hours are capped to avoid huge estimates after downtime. An interval is assigned to the local calendar date of its ending sample.

This is an estimation prototype, not a billing meter. No measurements are collected while Homebridge is stopped.
