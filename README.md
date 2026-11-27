# homebridge-tapo-energy-monitor

Homebridge 2 plugin for collecting Tapo energy history through the TP-Link cloud. The Homebridge host does not need to share a local network with the plugs.

## Current implementation

- **P110M cloud history:** Node.js account authentication, Thing Cloud discovery and read-only daily `/usage` requests.
- **Energy units:** Tapo daily history values are Wh. The plugin stores per-device daily values and reads the separate January-to-January monthly history for authoritative month/year totals.
- **Idempotent updates:** polling the same date again replaces that day's value; it never adds the same cloud record twice.
- **Date safety:** daily requests are quarter-aligned in the device timezone. A response is imported only when the final bucket date matches Tapo's reported local date.
- **Persistence:** history is stored in `tapo-energy-history.json` in the Homebridge storage directory.
- **Simulation:** remains optional and separate. Simulated power samples are estimates and are not mixed into real cloud totals.
- **Watt CSV:** reference imports remain separate in `tapo-watt-imports.json`; they are not added to live cloud totals.

The current cloud polling implementation supports **P110M only**. S112 and S110E remain unavailable until their cloud-relayed energy data formats are verified. Current power (W) is a separate measurement and is not derived from daily energy buckets. Cloud mode does not currently publish a real-data Matter meter; the existing Matter Electrical Meter is simulation-only.

## Cloud account and security

Configure the Tapo email and password in the plugin settings. Homebridge stores the password in plain text in `config.json`; protect that file and its backups. MFA codes are entered only when TP-Link requests them and are never saved. Session tokens are held in memory and refreshed/re-authenticated as needed; they are not written to logs or history files.

The cloud API is unofficial/reverse-engineered and may change if TP-Link changes its private endpoints. The plugin performs read-only cloud requests and does not send relay, power, reboot, reset or configuration commands. It does not fall back to local-IP polling.

## Dashboard

The Homebridge UI shows:
- current combined power when a live power sample is available;
- today's energy using the device's local calendar date;
- per-device daily history totals and authoritative monthly/yearly totals;
- combined daily, monthly and yearly Wh/kWh totals.

If cloud date alignment cannot be verified, that response is skipped rather than inserted under a guessed date. Missing/offline periods are not filled with invented values.

## Matter

Homebridge 2.5.0 or later is required for the dedicated Matter `ElectricalMeter` device type. The current Matter accessory is named **Tapo Energy — Расчётная** and is registered only in simulation mode. It publishes estimated active power and cumulative estimated energy; it is not a billing meter. Cloud history integration and Apple's Energy-tab presentation are separate tasks.

## Homebridge setup

1. Add the **Tapo Energy Monitor** platform.
2. Leave **Simulation mode** off and enter the Tapo account credentials to enable cloud polling.
3. Cloud history is refreshed at the configured polling interval (minimum 5 minutes). The first cloud read starts when the platform launches.
4. To test the prototype without a Tapo account, enable simulation and add at least one simulated device. Simulation is not used when cloud mode is active.

All persistent history is written under the Homebridge storage directory returned by the Homebridge API.

## Planned device support

- P110M — cloud daily history implemented; verify against the real Homebridge host and Watt export before release.
- S112 — not yet supported by the cloud history collector.
- S110E — not yet supported by the cloud history collector.

## Development

```sh
npm install
npm test
npm run lint
```

CI tests Node.js 22, 24 and 26, checks Homebridge 2 loading, and builds an isolated package. Do not publish an npm release until real-account polling and the resulting daily/monthly/yearly totals have been verified on the target Homebridge installation.
