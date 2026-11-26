# Homebridge verification readiness

This file tracks the current state against the Homebridge Verified Plugins criteria (requirements last checked 2026-11-25).

Official criteria: https://github.com/homebridge/homebridge/wiki/Verified-Plugins
Request process: https://github.com/homebridge/plugins

## Criteria

| Requirement | Current state | Evidence / remaining work |
|---|---|---|
| Dynamic platform | Pass | Registers one dynamic platform from `index.js`. |
| Distinct functionality from existing verified plugins | Pending | The intended differentiator is TP-Link Tapo account/cloud energy history for P110M, S112 and S110E. Production cloud telemetry and aggregation must be implemented and demonstrated before review. |
| Public GitHub repository with issues enabled | Pass | Repository is public and Issues are enabled. |
| npm package published | Pending | Do not publish until explicitly approved by the maintainer and the production feature is ready. |
| GitHub release for every published version | Pending | Create a tagged GitHub release with release notes for each npm version. |
| Node.js supported LTS versions 22, 24, 26 | Pass in CI | Matrix tests all three versions, including package build on Node 26. |
| Successful installation | CI pass | CI installs dependencies and packs the plugin. Verify clean install from npm after first approved publication. |
| Does not start unless configured | Pass | Simulation defaults off; empty simulated-device list leaves the platform idle. Regression tests cover both cases. |
| No host-modifying postinstall scripts | Pass | No install/postinstall lifecycle script is defined. |
| No TTY or non-standard startup parameters | Pass by design | Uses the standard Homebridge dynamic platform and plugin UI. |
| Homebridge Plugin Settings GUI | Pass | Ships `config.schema.json`, custom UI entry point and UI server. |
| No analytics or tracking | Pass by inspection | No analytics integration is present. |
| Persistent files inside Homebridge storage | Pass | Energy history uses `api.user.storagePath()`; external data-directory override removed. |
| Errors caught and logged | Partial | Main sampling, Matter registration and cloud diagnostic failures are caught. Safe stage diagnostics and mocked auth/MFA tests exist; live rate-limit, cloud outage, UI server startup and restart/shutdown paths remain to be tested. |

## Blocking work before requesting verification

1. Integrate the Node.js Tapo cloud client into production polling and validate it against a real account.
2. Validate P110M response fields, units, timezone, historical bucket semantics and offline behavior against a real account.
3. Implement S112 and S110E only after their cloud data contracts are verified; clearly report unsupported models.
4. Connect verified cloud readings to the aggregator while keeping measured and estimated totals separate.
5. Add integration tests for login failures, optional MFA challenges and invalid codes, rate limits, cloud outages, malformed responses and graceful restart/shutdown. Current tests are mocked and do not constitute a live TP-Link account check.
6. Confirm the plugin offers distinct functionality from existing verified energy-monitoring plugins.
7. Publish an approved npm version, create its matching GitHub release and release notes, then open the verification request issue in homebridge/plugins.

## Release discipline

- Never add a Verified By Homebridge badge before approval.
- Never claim verification based only on CI.
- Never publish an npm version without explicit maintainer approval.
