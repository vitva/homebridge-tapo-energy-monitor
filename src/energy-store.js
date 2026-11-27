'use strict';

const fs = require('fs');
const path = require('path');

function emptyTotals() {
  return { daily: {}, monthly: {}, yearly: {} };
}

class EnergyStore {
  constructor(directory, log) {
    this.directory = directory;
    this.filePath = path.join(directory, 'tapo-energy-history.json');
    this.log = log;
    this.state = { version: 2, devices: {}, totals: emptyTotals() };
    fs.mkdirSync(directory, { recursive: true });
    this.load();
  }

  load() {
    try {
      if (!fs.existsSync(this.filePath)) return;
      const parsed = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
      if (!parsed || ![1, 2].includes(parsed.version) || !parsed.devices || !parsed.totals) {
        this.log.warn('Energy history has an unsupported format; starting with an empty history.');
        return;
      }
      this.state = {
        version: 2,
        devices: parsed.devices,
        totals: {
          daily: parsed.totals.daily || {},
          monthly: parsed.totals.monthly || {},
          yearly: parsed.totals.yearly || {}
        }
      };
      for (const device of Object.values(this.state.devices)) {
        device.totals = device.totals || emptyTotals();
        device.energyByDay = device.energyByDay || {};
        device.energyByMonth = device.energyByMonth || {};
        device.energyWh = Number.isFinite(device.energyWh) ? device.energyWh : 0;
      }
    } catch (error) {
      this.log.error('Could not read energy history: %s', error.message);
    }
  }

  setActiveDevices(deviceIds) {
    const activeIds = new Set(deviceIds);
    for (const [deviceId, device] of Object.entries(this.state.devices)) {
      device.active = activeIds.has(deviceId);
    }
    this.save();
  }

  recordPower(deviceId, powerW, timestamp = Date.now(), metadata = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim()) return;
    if (!Number.isFinite(powerW) || powerW < 0 || !Number.isFinite(timestamp)) return;

    const previous = this.state.devices[deviceId] || { energyWh: 0, totals: emptyTotals() };
    let energyWh = 0;
    if (Number.isFinite(previous.powerW) && Number.isFinite(previous.timestamp) && timestamp > previous.timestamp) {
      const elapsedMs = Math.min(timestamp - previous.timestamp, 6 * 60 * 60 * 1000);
      energyWh = ((previous.powerW + powerW) / 2) * elapsedMs / 3600000;
      this.addEnergy(new Date(timestamp), energyWh, this.state.totals);
      this.addEnergy(new Date(timestamp), energyWh, previous.totals);
    }

    this.state.devices[deviceId] = {
      ...previous,
      id: deviceId,
      active: true,
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : (previous.name || deviceId),
      model: typeof metadata.model === 'string' ? metadata.model : (previous.model || ''),
      powerW,
      timestamp,
      energyWh: previous.energyWh + energyWh,
      totals: previous.totals
    };
    this.save();
  }

  recordDailyEnergy(deviceId, records, metadata = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim() || !Array.isArray(records)) return;
    const previous = this.state.devices[deviceId] || { energyWh: 0, totals: emptyTotals(), energyByDay: {}, energyByMonth: {} };
    const energyByDay = { ...(previous.energyByDay || {}) };
    let accepted = 0;
    for (const record of records) {
      if (!record || typeof record.date !== 'string' ||
          !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
          !Number.isFinite(record.value) || record.value < 0) continue;
      energyByDay[record.date] = record.value;
      accepted += 1;
    }
    if (!accepted) return;
    const energyByMonth = { ...(previous.energyByMonth || {}) };
    // The daily endpoint covers the current quarter. Its latest day lets us
    // invalidate only that month's cached aggregate until a fresh monthly
    // snapshot arrives; older monthly totals remain authoritative.
    if (typeof metadata.latestDate === 'string' &&
        /^\d{4}-\d{2}-\d{2}$/.test(metadata.latestDate)) {
      delete energyByMonth[metadata.latestDate.slice(0, 7)];
    }
    this.state.devices[deviceId] = {
      ...previous,
      id: deviceId,
      active: true,
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : (previous.name || deviceId),
      model: typeof metadata.model === 'string' ? metadata.model : (previous.model || ''),
      source: 'tapo_cloud',
      timeZone: typeof metadata.timeZone === 'string' ? metadata.timeZone : (previous.timeZone || 'UTC'),
      latestDate: typeof metadata.latestDate === 'string' ? metadata.latestDate : (previous.latestDate || null),
      energyByDay,
      energyByMonth
    };
    this.rebuildCloudTotals();
    this.save();
  }

  recordMonthlyEnergy(deviceId, records, metadata = {}) {
    if (typeof deviceId !== 'string' || !deviceId.trim() || !Array.isArray(records)) return;
    const previous = this.state.devices[deviceId] || { energyWh: 0, totals: emptyTotals(), energyByDay: {}, energyByMonth: {} };
    const energyByMonth = { ...(previous.energyByMonth || {}) };
    let accepted = 0;
    for (const record of records) {
      if (!record || typeof record.month !== 'string' ||
          !/^\d{4}-(?:0[1-9]|1[0-2])$/.test(record.month) ||
          !Number.isFinite(record.value) || record.value < 0) continue;
      energyByMonth[record.month] = record.value;
      accepted += 1;
    }
    if (!accepted) return;
    this.state.devices[deviceId] = {
      ...previous,
      id: deviceId,
      active: true,
      name: typeof metadata.name === 'string' && metadata.name.trim() ? metadata.name.trim() : (previous.name || deviceId),
      model: typeof metadata.model === 'string' ? metadata.model : (previous.model || ''),
      source: 'tapo_cloud',
      timeZone: typeof metadata.timeZone === 'string' ? metadata.timeZone : (previous.timeZone || 'UTC'),
      energyByMonth
    };
    this.rebuildCloudTotals();
    this.save();
  }

  rebuildCloudTotals() {
    const totals = emptyTotals();
    for (const device of Object.values(this.state.devices)) {
      if (!device || device.source !== 'tapo_cloud') continue;
      const daily = emptyTotals();
      const dailyMonthly = {};
      for (const [date, value] of Object.entries(device.energyByDay || {})) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(value) || value < 0) continue;
        const [year, month] = date.split('-');
        daily.daily[date] = value;
        const monthKey = year + '-' + month;
        dailyMonthly[monthKey] = (dailyMonthly[monthKey] || 0) + value;
        totals.daily[date] = (totals.daily[date] || 0) + value;
      }
      const monthly = { ...dailyMonthly, ...(device.energyByMonth || {}) };
      const yearly = {};
      for (const [monthKey, value] of Object.entries(monthly)) {
        if (!/^\d{4}-(?:0[1-9]|1[0-2])$/.test(monthKey) || !Number.isFinite(value) || value < 0) continue;
        const year = monthKey.slice(0, 4);
        yearly[year] = (yearly[year] || 0) + value;
        totals.monthly[monthKey] = (totals.monthly[monthKey] || 0) + value;
      }
      for (const [year, value] of Object.entries(yearly)) {
        totals.yearly[year] = (totals.yearly[year] || 0) + value;
      }
      device.totals = { daily: daily.daily, monthly, yearly };
      device.energyWh = Object.values(monthly).reduce((sum, value) => sum + value, 0);
    }
    this.state.totals = totals;
  }

  addEnergy(date, energyWh, totals) {
    // Use the Homebridge host's local calendar date for reporting buckets.
    const year = String(date.getFullYear());
    const month = year + '-' + String(date.getMonth() + 1).padStart(2, '0');
    const day = month + '-' + String(date.getDate()).padStart(2, '0');
    for (const [period, key] of [['daily', day], ['monthly', month], ['yearly', year]]) {
      totals[period][key] = (totals[period][key] || 0) + energyWh;
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
