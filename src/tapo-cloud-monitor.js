'use strict';

const { TapoCloudAuth } = require('./tapo-cloud-auth');
const { TapoThingApi, validateThingHost } = require('./tapo-thing-api');
const {
  buildDailyUsageRange,
  buildQuarterStartTimestamp,
  buildYearlyUsageRange,
  normalizeDailyEnergyHistory,
  normalizeMonthlyEnergyHistory
} = require('./tapo-cloud-client');

class TapoCloudEnergyMonitor {
  constructor(options = {}) {
    this.username = options.username;
    this.password = options.password;
    this.log = options.log || { info() {}, warn() {} };
    this.auth = options.auth || new TapoCloudAuth();
    this.apiFactory = options.apiFactory || (args => new TapoThingApi(args));
    this.api = null;
    this.session = null;
    this.devices = [];
    this.deviceInfo = new Map();
    this.lastRefreshAt = 0;
  }

  async connect() {
    const login = await this.auth.login({
      username: this.username,
      password: this.password
    });
    if (!login.ok) throw new Error(login.message || 'Tapo cloud authentication failed.');
    this.session = login;
    this.lastRefreshAt = Date.now();
    const host = await this.auth.discoverThingService(this.username, login.token);
    this.api = this.apiFactory({ host, token: login.token, termId: login.termId });
    await this.refreshDevices();
  }

  async refreshSession() {
    if (!this.session || Date.now() - this.lastRefreshAt < 30 * 60 * 1000) return;
    let refreshed = null;
    if (this.session.refreshToken) {
      try {
        refreshed = await this.auth.refresh(this.session.refreshToken);
      } catch {
        refreshed = null;
      }
    }
    if (!refreshed || !refreshed.ok) {
      const login = await this.auth.login({ username: this.username, password: this.password });
      if (!login.ok) throw new Error(login.message || 'Tapo cloud re-authentication failed.');
      this.session = login;
      const host = await this.auth.discoverThingService(this.username, login.token);
      this.api = this.apiFactory({ host, token: login.token, termId: login.termId });
    } else {
      this.session = refreshed;
      this.api = this.apiFactory({
        host: this.api.host,
        token: refreshed.token,
        termId: refreshed.termId
      });
    }
    this.lastRefreshAt = Date.now();
  }

  async refreshDevices() {
    const things = await this.api.listThings();
    this.devices = things.map(thing => {
      const model = String(thing.model || thing.deviceModel || '');
      return {
        id: thing.thingName || thing.deviceId || null,
        name: thing.nickname || thing.alias || model || 'Без имени',
        model,
        host: validateThingHost(thing.appServerUrlV2 || thing.appServerUrl || this.api.host)
      };
    }).filter(device => device.id && /P110M/i.test(device.model));

    for (const device of this.devices) {
      if (this.deviceInfo.has(device.id)) continue;
      let region = null;
      try {
        const settings = await this.api.getThingResource(device.id, 'settings', device.host);
        if (typeof settings?.region === 'string') {
          try {
            new Intl.DateTimeFormat('en-US', { timeZone: settings.region }).format(0);
            region = settings.region;
          } catch { /* use UTC when device timezone is unavailable */ }
        }
      } catch (error) {
        this.log.warn('Could not read Tapo device timezone for %s: %s', device.name, error.message);
      }
      this.deviceInfo.set(device.id, { region: region || 'UTC', host: device.host });
    }
  }

  async poll(store) {
    if (!this.api) await this.connect();
    await this.refreshSession();
    await this.refreshDevices();
    store.setActiveDevices(this.devices.map(device => device.id));
    let importedDevices = 0;
    for (const device of this.devices) {
      const info = this.deviceInfo.get(device.id) || { region: 'UTC', host: device.host };
      const range = buildDailyUsageRange(info.region);
      range.start_timestamp = buildQuarterStartTimestamp(info.region, range.end_timestamp - 1);
      const usage = await this.api.getUsage(device.id, info.host, range);
      const history = normalizeDailyEnergyHistory(usage, info.region);
      if (!history.ok) {
        this.log.warn('Tapo daily energy history format was not recognized for %s.', device.name);
      } else if (history.meta.lastRecordMatchesLocalDate !== true) {
        this.log.warn('Tapo history date alignment is not verified for %s; daily records were not imported.', device.name);
      } else {
        store.recordDailyEnergy(device.id, history.records, {
          name: device.name,
          model: device.model,
          timeZone: info.region,
          latestDate: history.meta.lastDate
        });
        importedDevices += 1;
      }

      try {
        const monthlyRange = buildYearlyUsageRange(info.region);
        const monthlyUsage = await this.api.getUsage(device.id, info.host, monthlyRange);
        const monthlyHistory = normalizeMonthlyEnergyHistory(monthlyUsage, info.region);
        if (monthlyHistory.ok) {
          store.recordMonthlyEnergy(device.id, monthlyHistory.records, {
            name: device.name,
            model: device.model,
            timeZone: info.region
          });
        } else {
          this.log.warn('Tapo monthly energy history format was not recognized for %s.', device.name);
        }
      } catch (error) {
        this.log.warn('Could not read Tapo monthly energy history for %s: %s', device.name, error.message);
      }
    }
    return { deviceCount: this.devices.length, importedDevices };
  }
}

module.exports = { TapoCloudEnergyMonitor };
