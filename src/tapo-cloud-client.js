'use strict';

const { TapoCloudAuth } = require('./tapo-cloud-auth');
const { TapoThingApi, classifyThingError } = require('./tapo-thing-api');

function normalizeThing(thing) {
  const model = String(thing?.model || thing?.deviceModel || '');
  return {
    id: thing?.thingName || thing?.deviceId || null,
    name: thing?.nickname || thing?.alias || model || 'Без имени',
    model,
    status: thing?.status ?? null,
    category: thing?.category || thing?.deviceType || null
  };
}

function diagnostic(diagnostics, stage, status, startedAt, details = {}) {
  const entry = {
    stage,
    status,
    durationMs: Math.max(0, Date.now() - startedAt)
  };
  if (Number.isInteger(details.code)) entry.code = details.code;
  if (Number.isInteger(details.count)) entry.count = details.count;
  if (typeof details.errorCode === 'string') entry.errorCode = details.errorCode;
  if (Number.isInteger(details.httpStatus)) entry.httpStatus = details.httpStatus;
  if (typeof details.reason === 'string') entry.reason = details.reason.slice(0, 500);
  if (typeof details.timeZone === 'string') entry.timeZone = details.timeZone;
  diagnostics.push(entry);
}

function buildDailyUsageRange(region, now = Date.now(), days = 60) {
  let timeZone = typeof region === 'string' && region.trim() ? region.trim() : 'UTC';
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
    formatter.format(new Date(now));
  } catch {
    timeZone = 'UTC';
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hourCycle: 'h23'
    });
  }

  const partsOf = value => Object.fromEntries(
    formatter.formatToParts(value)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  const localNow = partsOf(new Date(now));
  const localMidnightUtc = Date.UTC(localNow.year, localNow.month - 1, localNow.day);
  const startDate = new Date(localMidnightUtc - days * 86400000);
  const endDate = new Date(localMidnightUtc + 86400000);

  const toLocalMidnight = date => {
    const target = date.getTime();
    let guess = target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = partsOf(new Date(guess));
      const representedAsUtc = Date.UTC(
        local.year, local.month - 1, local.day,
        local.hour, local.minute, local.second
      );
      guess = target - (representedAsUtc - guess);
    }
    return Math.floor(guess / 1000);
  };

  return {
    start_timestamp: toLocalMidnight(startDate),
    end_timestamp: toLocalMidnight(endDate),
    interval: 1440
  };
}


function buildQuarterStartTimestamp(region, endTimestamp) {
  const timeZone = typeof region === 'string' && region.trim() ? region.trim() : 'UTC';
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
  });
  const parts = Object.fromEntries(formatter.formatToParts(new Date(endTimestamp * 1000))
    .filter(part => part.type !== 'literal')
    .map(part => [part.type, Number(part.value)]));
  const quarterMonth = Math.floor((parts.month - 1) / 3) * 3;
  const target = Date.UTC(parts.year, quarterMonth, 1);
  let guess = target;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const local = Object.fromEntries(formatter.formatToParts(new Date(guess))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)]));
    const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day,
      local.hour, local.minute, local.second);
    guess = target - (representedAsUtc - guess);
  }
  return Math.floor(guess / 1000);
}


function buildYearlyUsageRange(region, now = Date.now()) {
  let timeZone = typeof region === 'string' && region.trim() ? region.trim() : 'UTC';
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
    formatter.format(new Date(now));
  } catch {
    timeZone = 'UTC';
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23'
    });
  }
  const partsOf = value => Object.fromEntries(formatter.formatToParts(value)
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  const localNow = partsOf(new Date(now));
  const toLocalMidnight = target => {
    let guess = target;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const local = partsOf(new Date(guess));
      const representedAsUtc = Date.UTC(local.year, local.month - 1, local.day,
        local.hour, local.minute, local.second);
      guess = target - (representedAsUtc - guess);
    }
    return Math.floor(guess / 1000);
  };
  return {
    start_timestamp: toLocalMidnight(Date.UTC(localNow.year, 0, 1)),
    end_timestamp: toLocalMidnight(Date.UTC(localNow.year + 1, 0, 1)),
    interval: 43200
  };
}

function normalizeMonthlyEnergyHistory(payload, timeZone = 'UTC') {
  const energyData = payload && typeof payload === 'object' ? payload.energy_data : null;
  if (!energyData || typeof energyData !== 'object' || !Array.isArray(energyData.data) ||
      !Number.isInteger(energyData.start_timestamp) || energyData.interval !== 43200 ||
      !energyData.data.every(value => Number.isFinite(value) && value >= 0)) {
    return { ok: false, reason: 'Ответ не соответствует формату месячной истории energy_data.' };
  }
  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC',
      year: 'numeric', month: '2-digit', day: '2-digit'
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: 'UTC', year: 'numeric', month: '2-digit', day: '2-digit'
    });
  }
  const startParts = Object.fromEntries(formatter.formatToParts(new Date(energyData.start_timestamp * 1000))
    .filter(part => part.type !== 'literal').map(part => [part.type, Number(part.value)]));
  if (startParts.month !== 1 || startParts.day !== 1) {
    return { ok: false, reason: 'Месячная история Tapo должна начинаться с 1 января.' };
  }
  const records = energyData.data.map((value, index) => ({
    month: startParts.year + '-' + String(index + 1).padStart(2, '0'),
    value
  }));
  return {
    ok: true,
    records,
    meta: {
      count: records.length,
      year: startParts.year,
      firstMonth: records[0]?.month || null,
      lastMonth: records.at(-1)?.month || null,
      valueUnit: 'Wh',
      timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC'
    }
  };
}

function findUnverifiedDailyTailStart(records, monthlyRecords) {
  if (!Array.isArray(records) || !Array.isArray(monthlyRecords)) return null;
  const monthlyByMonth = new Map(monthlyRecords
    .filter(record => record && typeof record.month === 'string' &&
      /^\d{4}-(?:0[1-9]|1[0-2])$/.test(record.month) &&
      Number.isFinite(record.value) && record.value > 0)
    .map(record => [record.month, record.value]));
  const recordsByMonth = new Map();
  for (const record of records) {
    if (!record || typeof record.date !== 'string' ||
        !/^\d{4}-\d{2}-\d{2}$/.test(record.date) ||
        !Number.isFinite(record.value) || record.value < 0) continue;
    const month = record.date.slice(0, 7);
    if (!recordsByMonth.has(month)) recordsByMonth.set(month, []);
    recordsByMonth.get(month).push(record);
  }
  const invalidStarts = [];
  for (const [month, monthRecords] of recordsByMonth) {
    const monthlyValue = monthlyByMonth.get(month);
    if (!Number.isFinite(monthlyValue)) continue;
    const dailySum = monthRecords.reduce((sum, record) => sum + record.value, 0);
    if (monthlyValue <= dailySum) continue;
    let lastNonZero = -1;
    for (let index = monthRecords.length - 1; index >= 0; index -= 1) {
      if (monthRecords[index].value > 0) {
        lastNonZero = index;
        break;
      }
    }
    const firstTrailingZero = lastNonZero + 1;
    if (firstTrailingZero < monthRecords.length) {
      invalidStarts.push(monthRecords[firstTrailingZero].date);
    }
  }
  return invalidStarts.sort()[0] || null;
}

function normalizeDailyEnergyHistory(payload, timeZone = 'UTC') {
  const energyData = payload && typeof payload === 'object' ? payload.energy_data : null;
  if (!energyData || typeof energyData !== 'object' || !Array.isArray(energyData.data) ||
      !Number.isInteger(energyData.end_timestamp) || energyData.interval !== 1440 ||
      !energyData.data.every(value => Number.isFinite(value) && value >= 0)) {
    return { ok: false, reason: 'Ответ не соответствует формату дневной истории energy_data.' };
  }

  let formatter;
  try {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  } catch {
    formatter = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'UTC',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    });
  }

  const endParts = Object.fromEntries(
    formatter.formatToParts(new Date(energyData.end_timestamp * 1000))
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, Number(part.value)])
  );
  const endBoundary = Date.UTC(endParts.year, endParts.month - 1, endParts.day);
  const localTime = typeof energyData.local_time === 'string' &&
    /^\d{4}-\d{2}-\d{2}(?:[ T]\d{2}:\d{2}:\d{2})?$/.test(energyData.local_time)
    ? energyData.local_time
    : null;
  const localDate = localTime ? localTime.slice(0, 10) : null;
  const localDateEpoch = localDate ? Date.parse(localDate + 'T00:00:00Z') : null;
  const localDateOffset = localDateEpoch === null ? null : localDateEpoch - endBoundary;
  // Tapo may return the end boundary during the current local day, or at
  // the next local midnight. In either case the last bucket is localDate.
  // Older partial responses remain anchored to their returned end_timestamp.
  const lastRecordDay = localDateOffset === 0 || localDateOffset === -86400000
    ? localDateEpoch
    : endBoundary - 86400000;
  const records = energyData.data.map((value, index) => {
    const day = new Date(lastRecordDay - (energyData.data.length - 1 - index) * 86400000);
    return { date: day.toISOString().slice(0, 10), value };
  });
  const requestedDays = Number.isInteger(energyData.start_timestamp)
    ? Math.round((energyData.end_timestamp - energyData.start_timestamp) / 86400)
    : null;
  const endBoundaryDate = new Date(endBoundary).toISOString().slice(0, 10);
  const lastRecordDate = records.at(-1)?.date || null;
  const lastRecordMatchesLocalDate = localDate ? localDate === lastRecordDate : null;

  return {
    ok: true,
    records,
    meta: {
      count: records.length,
      firstDate: records[0]?.date || null,
      lastDate: lastRecordDate,
      requestedDays,
      returnedDays: records.length,
      rangeMismatch: requestedDays !== null && requestedDays !== records.length,
      dateBasis: 'end_timestamp',
      valueUnit: 'Wh',
      timeZone: typeof timeZone === 'string' && timeZone ? timeZone : 'UTC',
      localTime,
      localDate,
      endBoundaryDate,
      lastRecordMatchesLocalDate,
      startTimestamp: energyData.start_timestamp ?? null,
      endTimestamp: energyData.end_timestamp,
      interval: energyData.interval,
      alignmentVerified: Boolean(localDate && lastRecordDate === localDate)
    }
  };
}

function findElectricalCandidates(payload) {
  const candidates = [];
  const electricalKey = /(?:^|[_-])(power|watt|watts|current|current_ma|current_a|voltage|voltage_mv|voltage_v|load)(?:$|[_-])/i;
  let visited = 0;
  const visit = (value, path = '', depth = 0, insideCandidate = false) => {
    if (depth > 10 || value === null || typeof value !== 'object' || visited > 2000 ||
        candidates.length >= 20) return;
    if (Array.isArray(value)) {
      for (let index = 0; index < Math.min(value.length, 100); index += 1) {
        visit(value[index], path + '[' + index + ']', depth + 1, insideCandidate);
      }
      return;
    }
    for (const [key, child] of Object.entries(value)) {
      visited += 1;
      const childPath = path ? path + '.' + key : key;
      const matched = insideCandidate || electricalKey.test(key);
      if (matched && (typeof child === 'number' || typeof child === 'boolean' ||
          (typeof child === 'string' && child.length <= 48))) {
        candidates.push(childPath + '=' + JSON.stringify(child));
      } else if (child && typeof child === 'object') {
        visit(child, childPath, depth + 1, matched);
      }
      if (visited > 2000 || candidates.length >= 20) break;
    }
  };
  visit(payload);
  return candidates;
}

function summarizeCloudResource(kind, payload) {
  if (!payload || typeof payload !== 'object') return 'Ответ получен; структура не распознана.';
  if (kind === 'shadows' || kind === 'matter_shadows') {
    const shadows = Array.isArray(payload.shadows) ? payload.shadows : [];
    const reported = shadows[0]?.state?.reported;
    const fields = reported && typeof reported === 'object' ? Object.keys(reported).slice(0, 30) : [];
    const electrical = findElectricalCandidates(payload);
    return (fields.length ? 'Поля reported: ' + fields.join(', ') : 'reported-состояние не найдено.') +
      '; электрические кандидаты: ' + (electrical.join(', ') || 'не найдены');
  }
  if (kind === 'rt-info') {
    const fields = Object.keys(payload).slice(0, 30);
    const electrical = findElectricalCandidates(payload);
    return 'Поля rt-info: ' + fields.join(', ') +
      '; электрические кандидаты: ' + (electrical.join(', ') || 'не найдены');
  }
  if (kind === 'model') {
    const services = new Set();
    const properties = new Set();
    const visit = (value, parent = '', depth = 0) => {
      if (depth > 12 || value === null || typeof value !== 'object') return;
      if (Array.isArray(value)) {
        for (const item of value.slice(0, 500)) visit(item, parent, depth + 1);
        return;
      }
      for (const [key, child] of Object.entries(value)) {
        if (typeof child === 'string' && /^(serviceId|service_id)$/i.test(key)) services.add(child);
        if (typeof child === 'string' && /^(propertyId|property_id|propertyName)$/i.test(key)) properties.add(child);
        if (typeof child === 'string' && key === 'name' && /service/i.test(parent)) services.add(child);
        if (typeof child === 'string' && key === 'name' && /propert/i.test(parent)) properties.add(child);
        if (child && typeof child === 'object') visit(child, key, depth + 1);
      }
    };
    visit(payload);
    return 'Сервисы: ' + (Array.from(services).slice(0, 30).join(', ') || 'не найдены') +
      '; свойства: ' + (Array.from(properties).slice(0, 30).join(', ') || 'не найдены');
  }
  return 'Поля ответа: ' + Object.keys(payload).slice(0, 30).join(', ');
}

async function probeReadOnlyCloudResources(api, item, host, diagnostics, index) {
  let deviceRegion = null;
  const checks = [
    ['cloud_details', () => api.getThingResource(String(item.device.id), 'details', host), 'details'],
    ['cloud_rt_info', () => api.getThingResource(String(item.device.id), 'rt-info', host), 'rt-info'],
    ['cloud_settings', () => api.getThingResource(String(item.device.id), 'settings', host), 'settings'],
    ['cloud_shadows', () => api.getShadows(String(item.device.id), host, false), 'shadows'],
    ['cloud_matter_shadows', () => api.getShadows(String(item.device.id), host, true), 'matter_shadows']
  ];
  if (item.thing.thingModelId && typeof api.getModel === 'function') {
    checks.push(['cloud_model', () => api.getModel(String(item.thing.thingModelId), host), 'model']);
  }
  for (const [stage, request, kind] of checks) {
    if (typeof request !== 'function') continue;
    const started = Date.now();
    try {
      const payload = await request();
      const reportedRegion = kind === 'settings' && typeof payload?.region === 'string'
        ? payload.region.trim().slice(0, 100)
        : '';
      if (reportedRegion) {
        try {
          new Intl.DateTimeFormat('en-US', { timeZone: reportedRegion }).format(0);
          deviceRegion = reportedRegion;
        } catch {
          deviceRegion = null;
        }
      }
      diagnostic(diagnostics, stage, 'success', started, {
        count: index + 1,
        reason: kind === 'settings'
          ? summarizeCloudResource(kind, payload) + (deviceRegion
            ? '; region=' + deviceRegion
            : reportedRegion
              ? '; region=' + reportedRegion + ' (невалидный часовой пояс; UTC fallback)'
              : '; region не найден')
          : summarizeCloudResource(kind, payload)
      });
    } catch (error) {
      const failure = classifyThingError(error);
      diagnostic(diagnostics, stage, 'failed', started, {
        count: index + 1,
        errorCode: failure.errorCode,
        httpStatus: failure.httpStatus,
        reason: failure.reason
      });
    }
  }
  return deviceRegion;
}

async function probeTapoThingCloud(options = {}) {
  const diagnostics = [];
  const username = typeof options.username === 'string' ? options.username.trim() : '';
  const password = typeof options.password === 'string' ? options.password : '';
  const mfaCode = typeof options.mfaCode === 'string' ? options.mfaCode.trim() : '';
  if (!username || !password) {
    return {
      ok: false,
      code: 'credentials_required',
      message: 'Укажите email и пароль аккаунта Tapo.',
      diagnostics
    };
  }

  const auth = options.auth || new TapoCloudAuth({
    ...options.authOptions,
    onDiagnostic: event => diagnostics.push(event)
  });
  const authStarted = Date.now();
  const beforeAuthDiagnostics = diagnostics.length;
  const login = await auth.login({ username, password, mfaCode });
  if (diagnostics.length === beforeAuthDiagnostics) {
    diagnostic(diagnostics, 'authentication', login.ok ? 'success' :
      (login.code === 'mfa_required' ? 'required' : 'failed'), authStarted);
  }
  if (!login.ok) return { ...login, diagnostics };

  let stage = 'thing_service';
  let stageStarted = Date.now();
  try {
    const host = await auth.discoverThingService(username, login.token);
    diagnostic(diagnostics, stage, 'success', stageStarted);

    stage = 'device_list';
    stageStarted = Date.now();
    const api = (options.apiFactory || (args => new TapoThingApi(args)))({
      host,
      token: login.token,
      termId: login.termId
    });
    const things = await api.listThings();
    const devices = things.map(normalizeThing);
    diagnostic(diagnostics, 'device_list', 'success', stageStarted, { count: devices.length });

    const candidates = things
      .map((thing, index) => ({ thing, device: devices[index] }))
      .filter(item => /P110M/i.test(item.device.model) && item.device.id);

    const readings = [];
    const sumEnergyWh = values => values.reduce((sum, value) => {
      const numeric = Number(value);
      return sum + (Number.isFinite(numeric) && numeric >= 0 ? numeric : 0);
    }, 0);
    if (candidates.length === 0) diagnostic(diagnostics, 'usage', 'skipped', Date.now());
    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      const usageHost = item.thing.appServerUrlV2 || item.thing.appServerUrl || host;
      let deviceRegion = null;
      if (typeof api.getThingResource === 'function' && typeof api.getShadows === 'function') {
        deviceRegion = await probeReadOnlyCloudResources(api, item, usageHost, diagnostics, index + 1);
      }
      const usageRange = buildDailyUsageRange(deviceRegion);
      usageRange.start_timestamp = buildQuarterStartTimestamp(deviceRegion || 'UTC', usageRange.end_timestamp - 1);
      const usageStarted = Date.now();
      try {
        const usage = await api.getUsage(String(item.device.id), usageHost, usageRange);
        const history = normalizeDailyEnergyHistory(usage, deviceRegion || 'UTC');
        if (history.ok) {
          history.meta.timeZoneKnown = Boolean(deviceRegion);
          history.meta.timeZoneSource = deviceRegion ? 'device_settings' : 'UTC_fallback';
        }
        const reading = { id: item.device.id, usage };
        if (history.ok) reading.history = history;
        readings.push(reading);
        diagnostic(diagnostics, 'usage', 'success', usageStarted, { count: index + 1 });
        const formatStarted = Date.now();
        diagnostic(diagnostics, 'usage_format', history.ok ? 'success' : 'failed', formatStarted, {
          count: index + 1,
          reason: history.ok
            ? 'Распознано точек: ' + history.meta.count + '; даты: ' +
              (history.meta.firstDate || '—') + ' — ' + (history.meta.lastDate || '—') +
              '; region=' + (deviceRegion || 'не найден; использован UTC') +
              '; start=' + history.meta.startTimestamp + '; end=' + history.meta.endTimestamp +
              '; запрошено точек=' + history.meta.requestedDays +
              '; получено=' + history.meta.returnedDays
            : history.reason
        });
        if (history.ok) {
          const countersStarted = Date.now();
          const energyUsage = usage?.energy_usage?.energy_usage || usage?.energy_usage || {};
          const month = (history.meta.localDate || history.meta.lastDate || '').slice(0, 7);
          const monthRecords = history.records.filter(record => record.date.slice(0, 7) === month);
          const lastRecord = history.records.at(-1);
          const lastNonZeroIndex = history.records.slice().reverse().findIndex(record => record.value > 0);
          const trailingZeroBuckets = lastNonZeroIndex < 0 ? history.records.length : lastNonZeroIndex;
          const lastNonZero = history.records.filter(record => record.value > 0).at(-1);
          diagnostic(diagnostics, 'usage_counters', 'success', countersStarted, {
            count: index + 1,
            reason: 'today=' + (energyUsage.today_energy_mwh ?? '—') + ' mWh' +
              '; month=' + (energyUsage.month_energy_mwh ?? '—') + ' mWh' +
              '; сумма месяца=' + sumEnergyWh(monthRecords.map(record => record.value)) + ' Wh (' + (month || '—') + ')' +
              '; последний bucket=' + (lastRecord?.value ?? '—') + ' Wh' +
              '; последний ненулевой=' + (lastNonZero ? lastNonZero.date + ':' + lastNonZero.value + ' Wh' : 'нет') +
              '; нулей в конце=' + trailingZeroBuckets
          });
        }

        if (history.ok && deviceRegion) {
          const compareStarted = Date.now();
          const comparisonRange = buildDailyUsageRange(deviceRegion);
          if (comparisonRange.start_timestamp !== usageRange.start_timestamp) {
            try {
              const comparisonUsage = await api.getUsage(String(item.device.id), usageHost, comparisonRange);
              const primaryEnergy = usage?.energy_data && typeof usage.energy_data === 'object'
                ? usage.energy_data : {};
              const comparisonEnergy = comparisonUsage?.energy_data && typeof comparisonUsage.energy_data === 'object'
                ? comparisonUsage.energy_data : {};
              const primaryValues = Array.isArray(primaryEnergy.data) ? primaryEnergy.data : [];
              const comparisonValues = Array.isArray(comparisonEnergy.data) ? comparisonEnergy.data : [];
              const comparisonHistory = normalizeDailyEnergyHistory(comparisonUsage, deviceRegion);
              const comparisonRecordsByDate = new Map(comparisonHistory.ok
                ? comparisonHistory.records.map(record => [record.date, record.value])
                : []);
              const overlap = history.records.flatMap(record => {
                if (!comparisonRecordsByDate.has(record.date)) return [];
                return [{
                  date: record.date,
                  primary: record.value,
                  comparison: comparisonRecordsByDate.get(record.date)
                }];
              });
              const overlapPrimarySum = overlap.reduce((sum, record) => sum + record.primary, 0);
              const overlapComparisonSum = overlap.reduce((sum, record) => sum + record.comparison, 0);
              const overlapMismatches = overlap.filter(record => record.primary !== record.comparison).length;
              const overlapRange = overlap.length
                ? overlap[0].date + ' — ' + overlap.at(-1).date
                : 'нет общих дат';
              const sameCount = primaryValues.length === comparisonValues.length;
              const sameSequence = sameCount && primaryValues.every((value, valueIndex) => value === comparisonValues[valueIndex]);
              let bestOffset = 0;
              let bestNonZeroMatches = -1;
              let bestNonZeroCompared = 0;
              for (let offset = -7; offset <= 7; offset += 1) {
                let matches = 0;
                let compared = 0;
                for (let primaryIndex = 0; primaryIndex < primaryValues.length; primaryIndex += 1) {
                  const comparisonIndex = primaryIndex + offset;
                  if (comparisonIndex < 0 || comparisonIndex >= comparisonValues.length) continue;
                  const left = primaryValues[primaryIndex];
                  const right = comparisonValues[comparisonIndex];
                  if (left !== 0 || right !== 0) {
                    compared += 1;
                    if (left === right) matches += 1;
                  }
                }
                if (matches > bestNonZeroMatches ||
                    (matches === bestNonZeroMatches && Math.abs(offset) < Math.abs(bestOffset))) {
                  bestOffset = offset;
                  bestNonZeroMatches = matches;
                  bestNonZeroCompared = compared;
                }
              }
              const sample = values => ({
                first: values.slice(0, 5),
                last: values.slice(-5)
              });
              const primarySample = sample(primaryValues);
              const comparisonSample = sample(comparisonValues);
              const returnedMeta = value => [
                Number.isInteger(value.start_timestamp) ? value.start_timestamp : '—',
                Number.isInteger(value.end_timestamp) ? value.end_timestamp : '—',
                typeof value.local_time === 'string' ? value.local_time.slice(0, 19) : '—'
              ];
              const primaryMeta = returnedMeta(primaryEnergy);
              const comparisonMeta = returnedMeta(comparisonEnergy);
              diagnostic(diagnostics, 'usage_range_compare', 'success', compareStarted, {
                count: index + 1,
                reason: 'Диапазоны: основной квартальный start/end/local=' + primaryMeta.join('/') +
                  '; контрольный 60-дневный=' + comparisonMeta.join('/') +
                  '; запрошено start=' + usageRange.start_timestamp + '/' + comparisonRange.start_timestamp +
                  ', end=' + usageRange.end_timestamp +
                  '; точек=' + primaryValues.length + '/' + comparisonValues.length +
                  '; суммы полных ответов=' + sumEnergyWh(primaryValues) + '/' + sumEnergyWh(comparisonValues) + ' Wh' +
                  '; пересечение дат=' + overlapRange + ' (' + overlap.length + ')' +
                  '; суммы пересечения (квартал/контроль)=' + overlapPrimarySum + '/' + overlapComparisonSum + ' Wh' +
                  '; разница пересечения=' + (overlapComparisonSum - overlapPrimarySum) + ' Wh' +
                  '; различий по дням=' + overlapMismatches +
                  '; совпадение массивов=' + (sameSequence ? 'полное' : 'нет') +
                  '; лучший сдвиг=' + bestOffset + ' (ненулевые совпадения=' +
                  Math.max(0, bestNonZeroMatches) + '/' + bestNonZeroCompared + ')' +
                  '; samples=' + JSON.stringify(primarySample) + '/' + JSON.stringify(comparisonSample) +
                  '; единицы не подтверждены.'
              });
            } catch (error) {
              const failure = classifyThingError(error);
              diagnostic(diagnostics, 'usage_range_compare', 'failed', compareStarted, {
                count: index + 1,
                errorCode: failure.errorCode,
                httpStatus: failure.httpStatus,
                reason: 'Не удалось выполнить дополнительный read-only запрос контрольного диапазона 60 дней: ' + failure.reason
              });
            }
          } else {
            diagnostic(diagnostics, 'usage_range_compare', 'skipped', compareStarted, {
              count: index + 1,
              reason: 'Контрольный 60-дневный диапазон совпал с основным квартальным диапазоном.'
            });
          }
        }
      } catch (error) {
        const failure = classifyThingError(error);
        readings.push({
          id: item.device.id,
          error: 'Не удалось прочитать энергопоказания из Thing Cloud API.',
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
          reason: failure.reason
        });
        diagnostic(diagnostics, 'usage', 'failed', usageStarted, {
          code: Number.isInteger(error?.code) ? error.code : undefined,
          errorCode: failure.errorCode,
          httpStatus: failure.httpStatus,
          reason: failure.reason,
          count: index + 1
        });
      }
    }

    return {
      ok: true,
      cloud: 'tapo-thing-api',
      authenticated: true,
      deviceCount: devices.length,
      devices,
      p110mCount: candidates.length,
      readings,
      diagnostics,
      message: 'Авторизация и обнаружение устройств через Tapo Thing Cloud API выполнены. Отправлялись только запросы чтения.'
    };
  } catch (error) {
    diagnostic(diagnostics, stage, 'failed', stageStarted, {
      code: Number.isInteger(error?.code) ? error.code : undefined
    });
    return {
      ok: false,
      code: 'thing_api_error',
      authenticated: true,
      message: 'Вход в аккаунт выполнен, но получить данные Thing Cloud API не удалось.',
      detail: 'Проверьте этап диагностики выше и повторите проверку.',
      diagnostics
    };
  }
}

module.exports = { probeTapoThingCloud, normalizeThing, diagnostic, buildDailyUsageRange, buildQuarterStartTimestamp, buildYearlyUsageRange, normalizeDailyEnergyHistory, normalizeMonthlyEnergyHistory, findUnverifiedDailyTailStart };
