'use strict';

const { TapoCloudAuth } = require('./tapo-cloud-auth');
const { TapoThingApi, validateThingHost } = require('./tapo-thing-api');
const {
  buildDailyUsageRange,
  buildQuarterStartTimestamp,
  buildYearlyUsageRange,
  normalizeDailyEnergyHistory,
  normalizeMonthlyEnergyHistory,
  findUnverifiedDailyTailStart
} = require('./tapo-cloud-client');

class TapoCloudEnergyMonitor {
  constructor(options = {}) {
    this.username = options.username;
    this.password = options.password;
    this.log = options.log || { info() {}, warn() {} };
    this.auth = options.auth || new TapoCloudAuth({ termId: options.termId });
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
    if (!this.api) {
      await this.connect();
    } else {
      await this.refreshSession();
      await this.refreshDevices();
    }
    store.setActiveDevices(this.devices.map(device => device.id));
    let importedDevices = 0;
    for (const device of this.devices) {
      const info = this.deviceInfo.get(device.id) || { region: 'UTC', host: device.host };
      let dailyRawRecords = [];
      let dailyKeptRecords = [];
      let dailyAlignment = 'not_checked';
      let invalidFromDate = null;
      let monthlyRecords = [];
      // Read monthly first to validate the current month's daily tail.
      // Store it after daily import because recordDailyEnergy invalidates the cached month.
      let monthlyHistory = null;
      try {
        const monthlyRange = buildYearlyUsageRange(info.region);
        const monthlyUsage = await this.api.getUsage(device.id, info.host, monthlyRange);
        monthlyHistory = normalizeMonthlyEnergyHistory(monthlyUsage, info.region);
        if (!monthlyHistory.ok) {
          this.log.warn('Tapo monthly energy history format was not recognized for %s.', device.name);
          monthlyHistory = null;
        }
      } catch (error) {
        this.log.warn('Could not read Tapo monthly energy history for %s: %s', device.name, error.message);
      }

      const range = buildDailyUsageRange(info.region);
      range.start_timestamp = buildQuarterStartTimestamp(info.region, range.end_timestamp - 1);
      const usage = await this.api.getUsage(device.id, info.host, range);
      const history = normalizeDailyEnergyHistory(usage, info.region);
      if (!history.ok) {
        this.log.warn('Tapo daily energy history format was not recognized for %s.', device.name);
      } else if (history.meta.lastRecordMatchesLocalDate !== true) {
        dailyAlignment = 'unverified';
        dailyRawRecords = history.records;
        this.log.warn('Tapo history date alignment is not verified for %s; last cloud date=%s, normalized last date=%s, returned daily records=%s; daily records were not imported.',
          device.name, history.meta.localDate || '—', history.meta.lastDate || '—', history.records.length);
      } else {
        dailyAlignment = 'verified';
        dailyRawRecords = history.records;
        invalidFromDate = findUnverifiedDailyTailStart(
          history.records, monthlyHistory?.records || []
        );
        const records = invalidFromDate
          ? history.records.filter(record => record.date < invalidFromDate)
          : history.records;
        dailyKeptRecords = records;
        store.recordDailyEnergy(device.id, records, {
          name: device.name,
          model: device.model,
          timeZone: info.region,
          latestDate: history.meta.lastDate,
          invalidFromDate
        });
        if (invalidFromDate) {
          this.log.warn('Tapo daily history for %s is stale from %s: monthly Wh exceeds daily sum; trailing zero buckets were excluded.',
            device.name, invalidFromDate);
        }
        importedDevices += 1;
      }

      if (monthlyHistory) {
        monthlyRecords = monthlyHistory.records;
        store.recordMonthlyEnergy(device.id, monthlyHistory.records, {
          name: device.name,
          model: device.model,
          timeZone: info.region
        });
      }
      const sumWh = records => records.reduce((sum, record) => sum + record.value, 0);
      this.log.info('[TAPO CLOUD DATA] %s | daily %s: %s/%s records, %s/%s Wh, range %s..%s; monthly %s records, %s Wh; stale from %s.',
        device.name,
        dailyAlignment,
        dailyKeptRecords.length,
        dailyRawRecords.length,
        sumWh(dailyKeptRecords).toFixed(2),
        sumWh(dailyRawRecords).toFixed(2),
        dailyKeptRecords[0]?.date || '—',
        dailyKeptRecords.at(-1)?.date || '—',
        monthlyRecords.length,
        sumWh(monthlyRecords).toFixed(2),
        invalidFromDate || 'no');
    }
    const summary = store.getSummary();
    const region = this.devices.length
      ? this.deviceInfo.get(this.devices[0].id)?.region || 'UTC'
      : 'UTC';
    const currentParts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
      timeZone: region, year: 'numeric', month: '2-digit'
    }).formatToParts(new Date()).filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]));
    const monthKey = currentParts.year + '-' + currentParts.month;
    this.log.info('[TAPO CLOUD DATA] combined store: %s active devices; %s daily dates; %s monthly periods; %s month %s Wh; %s year %s Wh (%s).',
      this.devices.length,
      Object.keys(summary.totals.daily || {}).length,
      Object.keys(summary.totals.monthly || {}).length,
      monthKey,
      Number(summary.totals.monthly?.[monthKey] || 0).toFixed(2),
      currentParts.year,
      Number(summary.totals.yearly?.[currentParts.year] || 0).toFixed(2),
      region);
    return { deviceCount: this.devices.length, importedDevices };
  }
}

module.exports = { TapoCloudEnergyMonitor };
