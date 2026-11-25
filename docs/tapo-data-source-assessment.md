# Tapo data-source capability assessment

Updated: 2026-11-25

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
| P110M | Energy history and live meter APIs are implemented in the community `tapo` Rust/Python library | Calls are made to the device over its local network, not a proven cloud history endpoint |
| S112 | Energy monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Requires a separate protocol implementation and hardware verification |
| S110E | Energy generation/usage monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Bidirectional energy semantics must be preserved; do not assume import-only meter values |

The community `tapo` project documents `get_energy_data`, `get_power_data` and `get_energy_meter_data` for P110/P110M/P115. Its published support matrix does not list S112 or S110E as supported energy-monitoring devices.

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
2. Implement and test the P110M adapter against the established Tapo API, keeping local-network transport explicit.
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
