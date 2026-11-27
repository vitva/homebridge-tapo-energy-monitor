# homebridge-tapo-energy-monitor

Homebridge 2 plugin for importing Tapo energy history through the TP-Link cloud. The Homebridge host does not need to share a local network with the plugs.

## Current beta implementation

- **P110M cloud history:** Node.js account authentication, Thing Cloud discovery and read-only daily and monthly `/usage` requests.
- **Daily energy:** imports verified daily Wh buckets, aligned to the device's local timezone and reported local date.
- **Monthly/yearly energy:** uses the separate January-to-January monthly cloud series for month and year totals.
- **Idempotent storage:** repeated polling replaces the same date/month rather than double-counting it.
- **Persistence:** history is stored in `tapo-energy-history.json` in the Homebridge storage directory.
- **Dashboard:** displays available current power, today's energy, per-device and combined daily/monthly/yearly totals.
- **Watt CSV:** reference imports stay in `tapo-watt-imports.json` and are never mixed into cloud totals.
- **Simulation:** remains optional and isolated from real cloud readings.

The cloud collector currently supports **P110M only**. S112 and S110E are not yet supported. Current power (W) is independent of energy history and is shown only when a verified live sample is available; it is never calculated from daily Wh buckets.

## Matter test meter

With Matter enabled and Homebridge 2.5.0 or later, cloud mode registers a separate test accessory named **Tapo Energy — Облако (тест)**. It publishes imported cloud energy through Matter `ElectricalMeter`; it deliberately does not publish active power because verified live W samples are not available.

The Matter energy value is the sum of the cloud monthly history currently imported and retained by the plugin. It is **not a verified lifetime/billing counter**. On a fresh installation, the available cloud series initially covers the current calendar year. Treat this accessory as a beta presentation test, not as a billing meter. The simulation accessory remains separate and is not mixed with cloud values. When switching from simulation to cloud mode, the previous estimated meter is unregistered where Homebridge supports that operation.

Apple Home may not display every Matter Electrical Meter attribute or expose it in the Energy view. Its actual presentation must be checked on the target iOS/Home hub version; the plugin dashboard remains the source for daily, monthly and yearly history.

## Tapo account and security

Configure the Tapo email and password in plugin settings. Homebridge stores the password in plain text in `config.json`; protect that file and its backups. MFA codes are requested only when TP-Link challenges authentication and are never saved. A stable, non-secret terminal UUID is stored in Homebridge storage so UI authentication and background polling use the same client identity. Session tokens remain in memory and are not written to logs or history files.

The Tapo cloud API is unofficial/reverse-engineered and may change if TP-Link changes its private endpoints. The plugin performs read-only cloud requests: it does not send relay, power, reboot, reset or configuration commands, and it does not fall back to local-IP polling.

## Homebridge setup

1. Add the **Tapo Energy Monitor** platform.
2. Leave **Simulation mode** off and enter the Tapo account credentials to enable cloud polling.
3. Cloud history polling starts at platform launch and repeats at the configured interval (minimum 5 minutes in cloud mode).
4. Enable Matter on the same Homebridge bridge if you want to test the cloud Electrical Meter. Homebridge 2.5.0 or later is required.
5. To test without a Tapo account, enable simulation and configure at least one simulated device. Simulation values are estimates and are not mixed with cloud history.

All persistent history is written under the Homebridge storage directory returned by the Homebridge API.

## Compatibility and limitations

- Node.js 22, 24 and 26 are tested in CI.
- Homebridge 2.5.0 or later is required for the Matter Electrical Meter device type.
- P110M cloud daily/monthly history is implemented; real-account results still require verification on the target Homebridge installation.
- S112 and S110E cloud history are not implemented.
- Verified live cloud power (W) is not currently available.
- Missing/offline periods are not filled with invented values. Unverified daily date alignment is skipped.
- No npm package is published by this beta preparation.

## Development

```sh
npm install
npm test
npm run lint
```

CI runs tests and lint on Node.js 22, 24 and 26, checks Homebridge 2 loading, and installs the packed plugin in isolated Homebridge 2.5.0 runtimes.
