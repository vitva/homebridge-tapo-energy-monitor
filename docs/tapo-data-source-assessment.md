# Tapo data-source capability assessment

Updated: 2026-11-25 (verified against tapo 0.13.0 API docs)

## Decision

The user requires **Tapo account/cloud access only**. The Homebridge host may be outside the dacha LAN. Do not implement local-IP polling as a fallback or prerequisite.

A separate reverse-engineered project, `yude/tplink-tapo-power-grafana-cloud`, documents the newer Tapo Thing Cloud API used for P110M. It authenticates through the TP-Link account API, resolves the Thing API service endpoint, lists devices with `GET /v2/things`, and reads energy through `GET /v1/things/{thingName}/usage`. Its documentation describes current usage and hourly/daily/monthly history in that response. This gives the plugin a concrete cloud-only P110M route to test. It remains unofficial and has not yet been verified against the user's account.

The older `piekstra/tplink-cloud-cli` passthrough route is a separate alternative, and its published energy support table explicitly lists P110 but not P110M. It is not the primary P110M route.

The data collector must therefore support a cloud adapter and report the provenance of every value:

## Model capability findings

| Model | Verified third-party API status | Notes |
|---|---|---|
| P110M | Confirmed in `tapo` 0.13.0: current power, hourly/daily/monthly energy history, historical power, and energy-meter data | Calls are made directly to the device over the local network; not a cloud API. Meter data is energy since device restart, not a guaranteed lifetime counter |
| S112 | Energy monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Requires a separate protocol implementation and hardware verification |
| S110E | Energy generation/usage monitoring is a documented product feature; no support entry was found in the reviewed `tapo` library device matrix | Bidirectional energy semantics must be preserved; do not assume import-only meter values |

The current `tapo` 0.13.0 API docs explicitly expose `get_current_power`, `get_energy_data`, `get_energy_meter_data`, `get_energy_usage`, `get_power_data` and `get_timezone` on `PlugEnergyMonitoringHandler` for P110/P110M/P115. The 0.12.2 changelog says `get_energy_meter_data` was tested with P110M firmware 1.4.4. The library's documented device matrix does not list S112 or S110E.

## Cloud-only route and limitations

The current P110M candidate is the newer Tapo Thing Cloud API, not the older device passthrough endpoint:

- TP-Link account authentication uses the v2 account API.
- The authenticated account resolves the Thing API service URL through `getAppServiceUrlByCloudUserName`.
- Devices are listed with the paginated `GET /v2/things` endpoint.
- Energy data is requested with the read-only `GET /v1/things/{thingName}/usage` endpoint.
- The published reverse-engineered implementation documents current usage plus hourly, daily and monthly history in this response.
- Thing API requests use the TP-Link Thing API authorization headers and a TP-Link Cloud Server CA trust anchor. The implementation must verify TLS, restrict the host suffix to `-app-server.iot.i.tplinkcloud.com`, and reject redirects.
- This path requires internet access only; it does not discover private LAN IP addresses or fall back to local polling.

The older `/api/v2/common/passthrough` route remains a separate possible route for older devices, but is not the primary P110M implementation.

This is a private, reverse-engineered API, not a stable official public endpoint. TP-Link may change it. P110M history may not be available while the plug is offline, so cloud polling cannot be assumed to backfill every offline interval.

## Current diagnostic implementation

The plugin now:
1. Authenticates with the Tapo account using the Python `tplink-cloud-api` client.
2. Resolves the Thing API service endpoint.
3. Lists devices through `/v2/things`.
4. Finds P110M devices by cloud model metadata.
5. Requests only `GET /v1/things/{thingName}/usage` and displays the returned usage JSON in the Homebridge UI.

The helper uses a pinned TP-Link Cloud Server CA for Thing API TLS verification, validates the Thing API hostname, disables redirects for Thing API GET requests, and has no LAN fallback. It sends no relay, power, reboot, reset, or configuration commands. Credentials are passed from the UI to the helper over stdin; tokens are not persisted. The certificate is sourced from the public research implementation at https://github.com/yude/tplink-tapo-power-grafana-cloud (certificate data only; no source implementation is copied).

This code has not yet been exercised against the user's TP-Link account or P110M. A successful login and P110M discovery are not enough: the returned usage response must be checked for current power, history structure, units, time zone, and counter semantics before enabling production aggregation.

## Recommended implementation sequence

1. Verify the Thing Cloud `/usage` response against the user's P110M and capture a sanitized fixture.
2. Normalize live power, current-day/month totals, lifetime counter semantics, history buckets, units and device timezone.
3. Add authenticated scheduled cloud polling and token/MFA session renewal without persisting passwords or exposing tokens.
4. Integrate only verified real fields into a separate real-data store; retain estimated values as a distinct series.
5. Investigate S112 and S110E independently, preserving import/export direction for S110E.
6. Keep Matter publication as a presentation layer after real and estimated sources have been separated in storage.

## Sources reviewed

- Tapo Thing Cloud API research implementation and documented `/usage` endpoint: https://github.com/yude/tplink-tapo-power-grafana-cloud
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
