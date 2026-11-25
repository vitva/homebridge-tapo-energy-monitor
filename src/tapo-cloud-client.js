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

async function probeTapoThingCloud(options = {}) {
  const username = typeof options.username === 'string' ? options.username.trim() : '';
  const password = typeof options.password === 'string' ? options.password : '';
  const mfaCode = typeof options.mfaCode === 'string' ? options.mfaCode.trim() : '';
  if (!username || !password) {
    return { ok: false, code: 'credentials_required', message: 'Укажите email и пароль аккаунта Tapo.' };
  }

  const auth = options.auth || new TapoCloudAuth(options.authOptions);
  const login = await auth.login({ username, password, mfaCode });
  if (!login.ok) return login;

  try {
    const host = await auth.discoverThingService(username, login.token);
    const api = (options.apiFactory || (args => new TapoThingApi(args)))({
      host,
      token: login.token,
      termId: login.termId
    });
    const things = await api.listThings();
    const devices = things.map(normalizeThing);
    const candidates = things
      .map((thing, index) => ({ thing, device: devices[index] }))
      .filter(item => /P110M/i.test(item.device.model) && item.device.id);

    const readings = [];
    for (const item of candidates) {
      try {
        const usage = await api.getUsage(String(item.device.id));
        readings.push({ id: item.device.id, usage });
      } catch {
        readings.push({
          id: item.device.id,
          error: 'Не удалось прочитать энергопоказания из Thing Cloud API.'
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
      message: 'Авторизация и обнаружение устройств через Tapo Thing Cloud API выполнены. Отправлялись только запросы чтения.'
    };
  } catch (error) {
    return {
      ok: false,
      code: 'thing_api_error',
      authenticated: true,
      message: 'Вход в аккаунт выполнен, но получить данные Thing Cloud API не удалось.',
      detail: error?.message || 'Unknown Thing API error'
    };
  }
}

module.exports = { probeTapoThingCloud, normalizeThing };
