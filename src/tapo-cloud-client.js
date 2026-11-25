'use strict';

const { TapoCloudAuth } = require('./tapo-cloud-auth');
const { TapoThingApi } = require('./tapo-thing-api');

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
  diagnostics.push(entry);
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

  let stageStarted = Date.now();
  try {
    const host = await auth.discoverThingService(username, login.token);
    diagnostic(diagnostics, 'thing_service', 'success', stageStarted);

    stageStarted = Date.now();
    const api = (options.apiFactory || (args => new TapoThingApi(args)))({
      host,
      token: login.token,
      termId: login.termId
    });

    stageStarted = Date.now();
    const things = await api.listThings();
    const devices = things.map(normalizeThing);
    diagnostic(diagnostics, 'device_list', 'success', stageStarted, { count: devices.length });

    const candidates = things
      .map((thing, index) => ({ thing, device: devices[index] }))
      .filter(item => /P110M/i.test(item.device.model) && item.device.id);

    const readings = [];
    if (candidates.length === 0) diagnostic(diagnostics, 'usage', 'skipped', Date.now());
    for (let index = 0; index < candidates.length; index += 1) {
      const item = candidates[index];
      const usageStarted = Date.now();
      try {
        const usage = await api.getUsage(String(item.device.id));
        readings.push({ id: item.device.id, usage });
        diagnostic(diagnostics, 'usage', 'success', usageStarted, { count: index + 1 });
      } catch (error) {
        readings.push({
          id: item.device.id,
          error: 'Не удалось прочитать энергопоказания из Thing Cloud API.'
        });
        diagnostic(diagnostics, 'usage', 'failed', usageStarted, {
          code: Number.isInteger(error?.code) ? error.code : undefined,
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
    const stage = diagnostics.some(item => item.stage === 'thing_service' && item.status === 'success')
      ? 'device_list'
      : 'thing_service';
    diagnostic(diagnostics, stage, 'failed', stageStarted, {
      code: Number.isInteger(error?.code) ? error.code : undefined
    });
    return {
      ok: false,
      code: 'thing_api_error',
      authenticated: true,
      message: 'Вход в аккаунт выполнен, но получить данные Thing Cloud API не удалось.',
      detail: error?.message || 'Unknown Thing API error',
      diagnostics
    };
  }
}

module.exports = { probeTapoThingCloud, normalizeThing, diagnostic };
