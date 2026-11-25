# homebridge-tapo-energy-monitor

A separate Homebridge plugin project for collecting local energy data from TP-Link Tapo devices and building combined consumption history.

## Current status — 0.1.0 prototype

**Simulation only. Real Tapo communication is not implemented.** The current prototype:
- registers a Homebridge platform;
- provides graphical settings in the Homebridge UI;
- simulates one power reading source;
- stores locally integrated energy estimates in `tapo-energy-history.json`;
- aggregates estimates by day, month, and year.

No physical Tapo devices are contacted, and no HomeKit energy-history feature is claimed.

## Planned device scope

- Tapo P110M
- Tapo S112
- Tapo S110E

The actual local protocol, supported history endpoints, and device-specific capabilities still need to be implemented and verified. Hardware testing will be required.

## Automated checks\n\nThe repository runs unit tests and JavaScript syntax checks on Node.js 18, 20, and 22 for pushes and pull requests. Run them locally with `npm test` and `npm run lint`.\n\n## Install for development

```sh
npm install
npm link
```

Add the **Tapo Energy Monitor** platform in Homebridge UI. Keep Simulation mode enabled for this prototype.

## Notes

The first storage implementation is JSON-based and intentionally small. It estimates energy from adjacent power samples using trapezoidal integration; an interval is currently assigned to the date of its ending sample. This is a prototype limitation, not billing-grade metering.
