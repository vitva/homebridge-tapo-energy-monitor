'use strict';

const fs = require('fs');
const path = require('path');

class EnergyStore {
  constructor(directory, log) {
    this.directory = directory;
    this.filePath = path.join(directory, 'tapo-energy-history.json');
    this.log = log;
    this.state = { version: 1, devices: {}, totals: { daily: {}, monthly: {}, yearly: {} } };
    fs.mkdirSync(directory, { recursive: true });
    this.load();
  }

  load() {
    try {
      if (fs.existsSync(this.filePath)) {
        const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (parsed && parsed.version === 1 && parsed.devices && parsed.totals) this.state = parsed;
        else this.log.warn('Energy history has an unsupported format; starting with an empty history.');
      }
    } catch (error) {
      this.log.error('Could not read energy history: %s', error.message);
    }
  }

  recordPower(deviceId, powerW, timestamp = Date.now()) {
    if (!Number.isFinite(powerW) || powerW < 0) return;
    const previous = this.state.devices[deviceId];
    if (previous && Number.isFinite(previous.powerW) && Number.isFinite(previous.timestamp) && timestamp > previous.timestamp) {
      const elapsedMs = Math.min(timestamp - previous.timestamp, 6 * 60 * 60 * 1000);
      const energyWh = ((previous.powerW + powerW) / 2) * elapsedMs / 3600000;
      this.addEnergy(new Date(timestamp), energyWh);
      if (!previous.energyWh) previous.energyWh = 0;
      previous.energyWh += energyWh;
    }
    this.state.devices[deviceId] = {
      ...(previous || {}),
      powerW,
      timestamp,
      energyWh: previous?.energyWh || 0
    };
    this.save();
  }

  addEnergy(date, energyWh) {
    // Use the Homebridge host's local calendar date, not UTC, for daily buckets.
    const year = String(date.getFullYear());
    const month = year + '-' + String(date.getMonth() + 1).padStart(2, '0');
    const day = month + '-' + String(date.getDate()).padStart(2, '0');
    for (const [period, key] of [['daily', day], ['monthly', month], ['yearly', year]]) {
      this.state.totals[period][key] = (this.state.totals[period][key] || 0) + energyWh;
    }
  }

  getSummary() {
    return JSON.parse(JSON.stringify(this.state));
  }

  save() {
    const tempPath = this.filePath + '.tmp';
    try {
      fs.writeFileSync(tempPath, JSON.stringify(this.state, null, 2));
      fs.renameSync(tempPath, this.filePath);
    } catch (error) {
      this.log.error('Could not save energy history: %s', error.message);
      try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) { /* best effort */ }
    }
  }
}

module.exports = { EnergyStore };
