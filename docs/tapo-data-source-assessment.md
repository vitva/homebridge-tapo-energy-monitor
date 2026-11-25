# Tapo data-source capability assessment

Updated: 2026-11-25 (verified against tapo 0.13.0 API docs)

## Decision

Do not treat TP-Link account login or Tapo cloud device discovery as an energy-history API. The available community cloud client documents Tapo account authentication, device discovery and generic control, but its documented energy-monitoring commands are for Kasa devices. No verified cloud endpoint has been found that returns P110M, S112 or S110E energy history.

The data collector must therefore support separate adapters and report the provenance of every value:

- `real-device-history`: history returned by the device's own energy API;
- `real-meter-counter`: cumulative counter returned by the device;
- `estimated-from-power`: locally integrated power samples;
- `unavailable`: no reading, never silently replaced with zero.

Never merge a real counter with locally integrated energy for the same interval.

## Model capability findings

| Model | Verified third-party API status | Notes |
|---|---|---|
| P110M | Confirmed in `tapo` 0.13.0: current power, hourly/daily/monthly energy history, historical power, and energy-meter data | Calls are made directly to the device over the local network; not a cloud API. Meter data is energy since device restart, not a guaranteed lifetime counter |
| S112 | Energy monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Requires a separate protocol implementation and hardware verification |
| S110E | Energy generation/usage monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Bidirectional energy semantics must be preserved; do not assume import-only meter values |

The current `tapo` 0.13.0 API docs explicitly expose `get_current_power`, `get_energy_data`, `get_energy_meter_data`, `get_energy_usage`, `get_power_data` and `get_timezone` on `PlugEnergyMonitoringHandler` for P110/P110M/P115. The 0.12.2 changelog says `get_energy_meter_data` was tested with P110M firmware 1.4.4. The library's documented device matrix does not list S112 or S110E.

## Cloud limitations

TP-Link support states that P110M energy history cannot be downloaded while the plug is offline (including Wi-Fi or cloud disconnection), even though the app can retain up to one year of history. This is strong evidence that a remote cloud-only collector cannot guarantee historical backfill for offline periods.

A TP-Link cloud library can authenticate and discover Tapo devices, but its README describes Tapo support as basic on/off control. Its documented energy commands (realtime/day/month emeter) are under Kasa device support, not Tapo.

Therefore:

1. Cloud login may be used as an optional account/device-discovery source after its security and MFA flow are implemented.
2. Energy history for P110M should initially use the supported Tapo device API when the device is reachable on the LAN.
3. Cloud discovery must not be presented as cloud energy telemetry.
4. For S112/S110E, keep readings unavailable until a model-specific response has been captured and validated.
5. When a device is offline, retain the last known reading with its timestamp and show it as stale; do not fabricate a live value.

## Recommended implementation sequence

1. Introduce a normalized adapter contract: `discover()`, `readLive()`, `readHistory(range)`, `readMeter()`.
2. Implement a P110M adapter using the established `tapo` API. Its upstream implementation is Rust with a Python (PyO3) package; the Homebridge plugin is Node.js, so the integration must explicitly choose and document a supported bridge/runtime rather than pretending there is a native Node API.
3. Add cloud account discovery as a separate optional adapter; never send account credentials to the browser or logs.
4. Add S112 and S110E only after their commands, channel mapping and import/export direction have been verified against actual device responses.
5. Keep Matter publication as a presentation layer after real and estimated sources have been separated in storage.

## Sources reviewed

- TP-Link support: P110M history cannot be downloaded while the device is offline; history retention up to one year: https://community.tp-link.com/en/smart-home/forum/topic/703462
- Tapo community API client and supported-device matrix: https://github.com/mihai-dinculescu/tapo
- P110M energy-history API capabilities: https://github.com/mihai-dinculescu/tapo/issues/645
- TP-Link cloud client: https://github.com/piekstra/tplink-cloud-api
- Tapo S112 energy-monitoring datasheet: https://static.tp-link.com/upload/product-overview/2025/202505/20250526/Tapo%20S112%28UN%291.0_Datasheet_V1.pdf
- Tapo S110E product page: https://www.tapo.com/en/product/smart-switch/tapo-s110e/


## P110M API details verified on 2026-11-25

The published `tapo` 0.13.0 API documents these methods on `PlugEnergyMonitoringHandler` (which explicitly covers P110M):

- `get_current_power()`: current power in W.
- `get_energy_data(interval, timezone)`: energy history. Intervals are hourly (inclusive date range, max 8 days), daily (start date must be first day of a quarter), and monthly (start date must be first day of a year). Returned dates are interpreted in the device timezone.
- `get_energy_meter_data()`: live voltage/current/power plus energy used since the device last restarted.
- `get_power_data(interval)`: historical power. Five-minute samples are limited to 12 hours; hourly samples to 6 days.
- `get_timezone()`: device timezone.

The upstream docs list P110M as a tested model. The changelog records a real P110M test for meter data on firmware 1.4.4. This is upstream hardware validation, not yet a test on the user's own plug.

Protocol note: recent firmware may use TPAP when Tapo's Third-Party Compatibility option is off. The upstream library added TPAP support in v0.11.1 and selects the protocol automatically. Do not tell the user to weaken this security setting as a default workaround.

Integration note: upstream provides Rust and Python (PyO3) clients, not a supported first-party Node.js wrapper. A tiny Node package claiming python-kasa API compatibility was found but is very new and has almost no adoption; it is not a sound production dependency for this plugin.
