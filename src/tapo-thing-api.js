'use strict';

const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const tls = require('node:tls');

const THING_SUFFIXES = [
  '-app-server.iot.i.tplinkcloud.com',
  '-app-server.iot.i.tplinknbu.com'
];
const DEFAULT_APP = 'TP-Link_Tapo_Android';
const DEFAULT_VERSION = '3.13.818';
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function validateThingHost(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new Error('TP-Link returned an invalid Thing API host.');
  }
  const host = parsed.hostname.toLowerCase();
  const suffix = THING_SUFFIXES.find(item => host.endsWith(item));
  const prefix = suffix ? host.slice(0, -suffix.length) : '';
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password ||
      parsed.port || parsed.pathname !== '/' || parsed.search || parsed.hash ||
      !prefix || !/^[a-z0-9-]+$/.test(prefix)) {
    throw new Error('TP-Link returned an invalid Thing API host.');
  }
  return 'https://' + host;
}

function classifyThingError(error) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const status = Number.isInteger(error?.statusCode) ? error.statusCode : undefined;
  if (status) return { errorCode: 'HTTP_' + status, httpStatus: status, reason: 'Сервер Thing API вернул HTTP ' + status + '.' };
  if (Number.isInteger(error?.code)) return { errorCode: 'TAPO_API_ERROR', reason: 'Thing API вернул код ошибки ' + error.code + '.' };
  if (code === 'ETIMEDOUT' || /timed out|timeout/i.test(error?.message || '')) return { errorCode: 'ETIMEDOUT', reason: 'Истекло время ожидания ответа Thing API.' };
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { errorCode: code, reason: 'Не удалось найти адрес сервера Thing API (DNS).' };
  if (code === 'ECONNRESET' || code === 'EPIPE') return { errorCode: code, reason: 'Сервер или сеть неожиданно разорвали соединение.' };
  if (code === 'ECONNREFUSED') return { errorCode: code, reason: 'Соединение с сервером Thing API отклонено.' };
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH' || code === 'ENETDOWN') return { errorCode: code, reason: 'Сетевой маршрут до сервера Thing API недоступен.' };
  if (/CERT_|TLS|SSL|UNABLE_TO_VERIFY|UNABLE_TO_GET_ISSUER|SELF_SIGNED/i.test(code)) return { errorCode: code, reason: 'Ошибка TLS: сертификат сервера не прошёл проверку.' };
  if (/response is too large/i.test(error?.message || '')) return { errorCode: 'RESPONSE_TOO_LARGE', reason: 'Ответ сервера превышает допустимый размер.' };
  return { errorCode: code && /^[A-Z0-9_]{1,64}$/.test(code) ? code : 'NETWORK_ERROR', reason: 'Не удалось завершить запрос к Thing API.' };
}

function cloudApiError(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    throw new Error('TP-Link returned an invalid Thing API response.');
  }
  const rawCode = payload.error_code ?? payload.errorCode ?? 0;
  const code = Number(rawCode);
  if (!Number.isFinite(code)) throw new Error('TP-Link returned an invalid Thing API response.');
  if (code !== 0) {
    const error = new Error('TP-Link Thing API error (' + code + ').');
    error.code = code;
    throw error;
  }
  return payload;
}

function requestJson(url, options = {}) {
  const request = options.request || https.request;
  const caPath = options.caPath || path.join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem');
  const ca = [...tls.rootCertificates, fs.readFileSync(caPath)];
  const timeoutMs = Math.max(5000, Math.min(60000, Number(options.timeoutMs) || 20000));

  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: options.method || 'GET',
      headers: {
        ...(options.headers || {}),
        ...(typeof options.body === 'string' ? { 'Content-Length': Buffer.byteLength(options.body) } : {})
      },
      ca,
      rejectUnauthorized: true,
      timeout: timeoutMs
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new Error('TP-Link Thing API redirect was rejected.'));
        return;
      }
      let body = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        body += chunk;
        if (Buffer.byteLength(body, 'utf8') > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('TP-Link Thing API response is too large.'));
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          const error = new Error('TP-Link Thing API returned HTTP ' + response.statusCode + '.');
          error.statusCode = response.statusCode;
          error.code = 'HTTP_' + response.statusCode;
          reject(error);
          return;
        }
        try {
          resolve(cloudApiError(JSON.parse(body)));
        } catch (error) {
          reject(error);
        }
      });
    });
    req.on('timeout', () => {
      const error = new Error('TP-Link Thing API request timed out.');
      error.code = 'ETIMEDOUT';
      req.destroy(error);
    });
    req.on('error', error => reject(error));
    req.end(options.body);
  });
}

class TapoThingApi {
  constructor(options = {}) {
    this.host = validateThingHost(options.host);
    if (typeof options.token !== 'string' || !options.token.trim()) {
      throw new Error('A Tapo cloud session token is required.');
    }
    this.token = options.token;
    this.termId = typeof options.termId === 'string' ? options.termId : '';
    this.appName = options.appName || DEFAULT_APP;
    this.appVersion = options.appVersion || DEFAULT_VERSION;
    this.request = options.request || https.request;
    this.caPath = options.caPath;
    this.timeoutMs = options.timeoutMs;
  }

  get headers() {
    return {
      Authorization: 'ut|' + this.token,
      'app-cid': 'app:' + this.appName + ':' + this.termId,
      'x-app-name': this.appName,
      'x-app-version': this.appVersion,
      'x-term-id': this.termId,
      'x-ospf': 'Android 15',
      'x-net-type': 'wifi',
      'x-strict': '0',
      'x-locale': 'en_US',
      'x-app-brand': 'TPLINK',
      Accept: 'application/json',
      'Content-Type': 'application/json; charset=UTF-8',
      'User-Agent': this.appName + '/' + this.appVersion + '(Homebridge/;Android 15)'
    };
  }

  async getJson(url) {
    return requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: this.headers
    });
  }

  async listThings(options = {}) {
    const pageSize = Math.max(1, Math.min(100, Number(options.pageSize) || 100));
    const maxPages = Math.max(1, Math.min(100, Number(options.maxPages) || 100));
    const things = [];
    for (let page = 0; page < maxPages; page += 1) {
      const url = new URL('/v2/things', this.host);
      url.searchParams.set('page', String(page));
      url.searchParams.set('pageSize', String(pageSize));
      url.searchParams.set('includeKasaShareDevices', 'false');
      url.searchParams.set('includePcDevice', 'false');
      url.searchParams.set('includeMatterDevice', 'false');
      url.searchParams.set('includeExternalVendorDeviceInfo', 'false');
      const payload = await this.getJson(url);
      const items = Array.isArray(payload.data) ? payload.data : [];
      things.push(...items);
      const total = Number(payload.total) || 0;
      if (items.length < pageSize || (total > 0 && things.length >= total)) return things;
    }
    throw new Error('TP-Link Thing API pagination limit reached.');
  }

  validateThingName(thingName) {
    if (typeof thingName !== 'string' || !thingName.trim() || thingName.length > 512) {
      throw new Error('A valid Thing device identifier is required.');
    }
    return encodeURIComponent(thingName);
  }

  async getThingResource(thingName, resource, thingHost = this.host) {
    if (!['details', 'rt-info', 'settings'].includes(resource)) {
      throw new Error('Unsupported read-only Thing resource.');
    }
    const host = validateThingHost(thingHost);
    const url = new URL('/v1/things/' + this.validateThingName(thingName) + '/' + resource, host);
    const payload = await this.getJson(url);
    return payload.data ?? payload;
  }

  async getShadows(thingName, thingHost = this.host, matter = false) {
    const host = validateThingHost(thingHost);
    const url = new URL(matter ? '/v1/things/matter/shadows' : '/v1/things/shadows', host);
    url.searchParams.set('thingNames', thingName);
    const payload = await this.getJson(url);
    return payload.data ?? payload;
  }

  async getModel(modelId, thingHost = this.host) {
    if (typeof modelId !== 'string' || !modelId.trim() || modelId.length > 512) {
      throw new Error('A valid Thing model identifier is required.');
    }
    const host = validateThingHost(thingHost);
    const url = new URL('/v1/things/models/' + encodeURIComponent(modelId), host);
    const payload = await this.getJson(url);
    return payload.data ?? payload;
  }

  async getUsage(thingName, thingHost = this.host, range = {}) {
    const host = validateThingHost(thingHost);
    const startTimestamp = Number(range.start_timestamp);
    const endTimestamp = Number(range.end_timestamp);
    const interval = Number(range.interval);
    if (!Number.isSafeInteger(startTimestamp) || !Number.isSafeInteger(endTimestamp) ||
        endTimestamp <= startTimestamp || !Number.isSafeInteger(interval) || interval < 1 || interval > 43200) {
      throw new Error('A valid Tapo energy history time range is required.');
    }
    const url = new URL('/v1/things/' + this.validateThingName(thingName) + '/usage', host);
    const body = JSON.stringify({
      method: 'get_energy_data',
      params: {
        end_timestamp: endTimestamp,
        interval,
        start_timestamp: startTimestamp
      }
    });
    const payload = await requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
      body
    });
    return payload.data ?? payload;
  }

  async getDeviceUsage(thingName, thingHost = this.host) {
    const host = validateThingHost(thingHost);
    const url = new URL('/v1/things/' + this.validateThingName(thingName) + '/usage', host);
    const body = JSON.stringify({ method: 'get_device_usage', params: {} });
    const payload = await requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
      body
    });
    return payload.data ?? payload;
  }

  async getPowerData(thingName, thingHost = this.host, range = {}) {
    const host = validateThingHost(thingHost);
    const startTimestamp = Number(range.start_timestamp);
    const endTimestamp = Number(range.end_timestamp);
    const interval = Number(range.interval);
    const maxPoints = interval === 5 ? 144 : interval === 60 ? 144 : 0;
    if (!Number.isSafeInteger(startTimestamp) || !Number.isSafeInteger(endTimestamp) ||
        endTimestamp <= startTimestamp || !maxPoints ||
        endTimestamp - startTimestamp > interval * 60 * maxPoints) {
      throw new Error('A valid bounded Tapo power history time range is required.');
    }
    const url = new URL('/v1/things/' + this.validateThingName(thingName) + '/usage', host);
    const body = JSON.stringify({
      method: 'get_power_data',
      params: {
        end_timestamp: endTimestamp,
        interval,
        start_timestamp: startTimestamp
      }
    });
    const payload = await requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
      body
    });
    return payload.data ?? payload;
  }

  async getEnergyUsage(thingName, thingHost = this.host) {
    const host = validateThingHost(thingHost);
    const url = new URL('/v1/things/' + this.validateThingName(thingName) + '/usage', host);
    const body = JSON.stringify({ method: 'get_energy_usage', params: {} });
    const payload = await requestJson(url, {
      request: this.request,
      caPath: this.caPath,
      timeoutMs: this.timeoutMs,
      headers: { ...this.headers, 'Content-Type': 'application/json' },
      method: 'POST',
      body
    });
    return payload.data ?? payload;
  }
}

module.exports = { TapoThingApi, validateThingHost, cloudApiError, classifyThingError };
