'use strict';

const { Tapo } = require('tapo-lan');

function normalizePrivateIpv4(value) {
  const ip = typeof value === 'string' ? value.trim() : '';
  const parts = ip.split('.');
  if (parts.length !== 4 || parts.some(part => !/^\d{1,3}$/.test(part) || Number(part) > 255)) return null;
  const [a, b] = parts.map(Number);
  if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 169 && b === 254)) return ip;
  return null;
}

class TapoLocalPowerMonitor {
  constructor(options = {}) {
    this.username = options.username;
    this.password = options.password;
    this.log = options.log || { info() {}, warn() {} };
    if (!this.username || !this.password) throw new Error('Tapo account credentials are required for local power polling.');
    this.client = typeof options.clientFactory === 'function'
      ? options.clientFactory({ user: this.username, pass: this.password })
      : new Tapo({ user: this.username, pass: this.password });
    this.connections = new Map();
    this.missingIpLogged = new Set();
  }

  async poll(devices, deviceInfo, store, nowMs = Date.now()) {
    const candidates = (Array.isArray(devices) ? devices : [])
      .filter(device => device && device.id && /P110M/i.test(String(device.model || '')));
    const results = await Promise.all(candidates.map(async device => {
      const info = deviceInfo instanceof Map ? deviceInfo.get(device.id) || {} : {};
      const ip = normalizePrivateIpv4(info.ip);
      if (!ip) {
        store.clearPower(device.id);
        if (!this.missingIpLogged.has(device.id)) {
          this.log.info('Local Tapo power is waiting for a private LAN address for %s.', device.name || device.id);
          this.missingIpLogged.add(device.id);
        }
        const previous = this.connections.get(device.id);
        if (previous) {
          this.client.devices?.delete?.(device.id);
          this.connections.delete(device.id);
        }
        return { id: device.id, status: 'no_ip' };
      }
      this.missingIpLogged.delete(device.id);

      let connection = this.connections.get(device.id);
      if (!connection || connection.ip !== ip) {
        this.client.devices?.delete?.(device.id);
        connection = { ip, device: null, authBlocked: false, lastErrorAt: 0 };
        this.connections.set(device.id, connection);
      }
      if (connection.authBlocked) {
        store.clearPower(device.id);
        return { id: device.id, status: 'auth_blocked' };
      }

      try {
        if (!connection.device) {
          connection.device = await this.client.connect(ip, { name: device.id });
          if (!/^P110M(?:$|[^A-Z0-9])/i.test(String(connection.device.model || ''))) {
            throw new Error('Local device model did not match P110M.');
          }
          this.log.info('Local Tapo power reader connected to %s.', device.name || device.id);
        }
        // P110M reliably exposes current_power through get_energy_usage (mW).
        const reading = await connection.device.getEnergyUsage();
        const currentPowerMilliW = Number(reading?.currentPower);
        const powerW = currentPowerMilliW / 1000;
        if (!Number.isFinite(powerW) || powerW < 0 || powerW > 5000) {
          throw new Error('Tapo local power response did not contain a valid Watt value.');
        }
        store.updatePower(device.id, powerW, nowMs, { name: device.name, model: device.model });
        connection.lastErrorAt = 0;
        return { id: device.id, status: 'ok', powerW };
      } catch (error) {
        if (error && error.kind === 'auth') connection.authBlocked = true;
        store.clearPower(device.id);
        if (nowMs - connection.lastErrorAt >= 15 * 60 * 1000) {
          this.log.warn('Could not read local Tapo power for %s: %s', device.name || device.id, error.message);
          connection.lastErrorAt = nowMs;
        }
        return { id: device.id, status: connection.authBlocked ? 'auth_blocked' : 'failed' };
      }
    }));
    const available = results.filter(result => result.status === 'ok').length;
    if (available !== candidates.length) {
      // Never publish a partial aggregate as if it represented the whole account.
      for (const device of candidates) store.clearPower(device.id);
    }
    return { deviceCount: candidates.length, available, unavailable: results.length - available };
  }

  stop() {
    this.connections.clear();
    this.missingIpLogged.clear();
    if (this.client && this.client.devices && typeof this.client.devices.clear === 'function') this.client.devices.clear();
  }
}

module.exports = { TapoLocalPowerMonitor, normalizePrivateIpv4 };
