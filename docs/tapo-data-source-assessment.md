# Tapo data-source capability assessment

Updated: 2026-11-25 (verified against tapo 0.13.0 API docs)

## Decision

The user requires **Tapo account/cloud access only**. The Homebridge host may be outside the dacha LAN. Do not implement local-IP polling as a fallback or prerequisite.

A newer reverse-engineered project, `piekstra/tplink-cloud-cli` (`tplc`), documents the private TP-Link v2 account API and a Tapo cloud passthrough. For Tapo, the cloud request is sent to `/api/v2/common/passthrough` with `deviceId` and a JSON-string `requestData`; the cloud relays the device protocol request and returns `responseData`. The documented examples include read-only `emeter.get_realtime`. The CLI's energy support table explicitly lists P110 (not P110M) for realtime and daily/monthly data. This establishes a plausible cloud-only route, but does not establish P110M compatibility.

The data collector must therefore support a cloud adapter and report the provenance of every value:

## Model capability findings

| Model | Verified third-party API status | Notes |
|---|---|---|
| P110M | Confirmed in `tapo` 0.13.0: current power, hourly/daily/monthly energy history, historical power, and energy-meter data | Calls are made directly to the device over the local network; not a cloud API. Meter data is energy since device restart, not a guaranteed lifetime counter |
| S112 | Energy monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Requires a separate protocol implementation and hardware verification |
| S110E | Energy generation/usage monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Bidirectional energy semantics must be preserved; do not assume import-only meter values |

The current `tapo` 0.13.0 API docs explicitly expose `get_current_power`, `get_energy_data`, `get_energy_meter_data`, `get_energy_usage`, `get_power_data` and `get_timezone` on `PlugEnergyMonitoringHandler` for P110/P110M/P115. The 0.12.2 changelog says `get_energy_meter_data` was tested with P110M firmware 1.4.4. The library's documented device matrix does not list S112 or S110E.

## Cloud-only route and limitations

The cloud path is not merely device discovery:

- TP-Link account authentication uses the v2 account API, including regional endpoint resolution, token refresh and optional MFA.
- Tapo devices can be discovered through the Tapo cloud account.
- Tapo cloud passthrough relays a device-protocol request to a device without requiring the collector to be on the same LAN.
- The documented passthrough format is `{deviceId, requestData}`, where `requestData` is a JSON-encoded string. The device's reply is returned in `result.responseData`.
- A documented read-only example is `emeter.get_realtime`. The API notes describe newer energy fields such as `power_mw`, `voltage_mv`, `current_ma`, `total_wh`, and older field names on older firmware.
- The `tplc` command's energy support table explicitly lists Tapo P110, but not P110M, S112 or S110E. Do not infer P110M support from P110.

This is a private, reverse-engineered API, not a stable official public endpoint. TP-Link may change it. Also, P110M history may not be available while the plug is offline; cloud polling cannot be assumed to backfill every offline interval.

Implementation rules:

1. Start with read-only account login and Tapo device discovery. Support MFA without putting credentials or verification codes in logs.
2. Identify the P110M by its cloud model/device metadata and retain the cloud device ID; no IP address is required.
3. Test read-only live energy via Tapo cloud passthrough. Never issue relay, reboot, reset or configuration writes.
4. Only after live response is verified, probe historical energy endpoints and confirm date granularity, timezone, units and counter semantics against the Tapo app.
5. Do not enable the P110M adapter for production aggregation until model-specific response fixtures and tests exist.
6. Keep S112/S110E unavailable until their own cloud-relayed protocol responses and import/export direction are verified.
7. When a device is offline, retain the last reading with its timestamp and mark it stale; do not fabricate a live value or backfill missing intervals with estimates.

## Current diagnostic implementation

The plugin now contains a read-only cloud probe using the Python `tplink-cloud-api` client's Tapo-only `TPLinkApi(cloud_type="tapo")` authentication and `TPLinkDeviceClient` passthrough. It discovers Tapo account devices, filters model metadata for P110M, and attempts only `emeter.get_realtime`. Credentials are passed from the custom UI to the helper through stdin; no token is persisted. MFA is handled by a second test submission with the fresh code.

This code has not yet been exercised against the user's account or P110M. The upstream cloud CLI's published energy support list still only names P110, so a returned P110M reading is not assumed. If the device is listed but its energy command fails, keep the result as unsupported until a sanitized response is examined.

## Recommended implementation sequence

1. Introduce a normalized cloud adapter contract: `authenticate()`, `discover()`, `readLive(deviceId)`, `readHistory(deviceId, range)`, `readMeter(deviceId)`.
2. Implement a read-only Tapo cloud account client with regional discovery, token refresh and MFA.
3. Implement cloud passthrough and verify P110M live energy first; capture sanitized response fixtures and unit/timezone tests.
4. Probe P110M history only after live data is confirmed; add S112/S110E only after model-specific commands and import/export direction are verified.
5. Keep Matter publication as a presentation layer after real and estimated sources have been separated in storage.

## Sources reviewed

- TP-Link support: P110M history cannot be downloaded while the device is offline; history retention up to one year: https://community.tp-link.com/en/smart-home/forum/topic/703462
- Tapo community API client and supported-device matrix: https://github.com/mihai-dinculescu/tapo
- P110M energy-history API capabilities: https://github.com/mihai-dinculescu/tapo/issues/645
- TP-Link cloud client (Tapo discovery/basic control): https://github.com/piekstra/tplink-cloud-api\n- TP-Link cloud CLI (Tapo cloud passthrough and P110 energy command reference): https://github.com/piekstra/tplink-cloud-cli\n- Reverse-engineered cloud passthrough/API notes: https://github.com/piekstra/tplink-cloud-cli/blob/main/docs/api.md
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
