'use strict';

const https = require('node:https');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const TAPO_HOST = 'https://n-wap.i.tplinkcloud.com';
const APP_TYPE = 'TP-Link_Tapo_Android';
const APP_VERSION = '3.4.451';
const ACCESS_KEY = '4d11b6b9d5ea4d19a829adbb9714b057';
const SECRET_KEY = '6ed7d97f3e73467f8a5bab90b577ba4c';
const SIGNING_TIMESTAMP = '9999999999';
const MAX_RESPONSE_BYTES = 1024 * 1024;
const TP_LINK_CA_PATH = path.join(__dirname, '..', 'helpers', 'tplink-cloud-server-ca.pem');
const PATHS = {
  accountStatus: '/api/v2/account/getAccountStatusAndUrl',
  login: '/api/v2/account/login',
  mfa: '/api/v2/account/checkMFACodeAndLogin',
  refresh: '/api/v2/account/refreshToken'
};

function validateCloudBase(raw) {
  let parsed;
  try {
    parsed = new URL(String(raw || ''));
  } catch {
    throw new Error('TP-Link returned an invalid cloud server address.');
  }
  const host = parsed.hostname.toLowerCase();
  if (parsed.protocol !== 'https:' || !host.endsWith('.tplinkcloud.com') ||
      parsed.username || parsed.password || parsed.port ||
      (parsed.pathname !== '/' && parsed.pathname !== '') || parsed.search || parsed.hash) {
    throw new Error('TP-Link returned an invalid cloud server address.');
  }
  return 'https://' + host;
}

function signBody(bodyJson, urlPath, nonce = crypto.randomUUID()) {
  const contentMd5 = crypto.createHash('md5').update(bodyJson, 'utf8').digest('base64');
  const signatureInput = [contentMd5, SIGNING_TIMESTAMP, nonce, urlPath].join('\n');
  const signature = crypto.createHmac('sha1', SECRET_KEY).update(signatureInput, 'utf8').digest('hex');
  return {
    'Content-MD5': contentMd5,
    'X-Authorization': 'Timestamp=' + SIGNING_TIMESTAMP +
      ', Nonce=' + nonce + ', AccessKey=' + ACCESS_KEY + ', Signature=' + signature
  };
}

function postJson(url, bodyJson, headers, options = {}) {
  const request = options.request || https.request;
  const timeoutMs = Math.max(5000, Math.min(60000, Number(options.timeoutMs) || 15000));
  return new Promise((resolve, reject) => {
    const req = request(url, {
      method: 'POST',
      headers: {
        'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 14; Pixel Build/UP1A)',
        'Content-Type': 'application/json;charset=UTF-8',
        'Content-Length': Buffer.byteLength(bodyJson),
        ...headers
      },
      timeout: timeoutMs,
      ca: options.ca || fs.readFileSync(options.caPath || TP_LINK_CA_PATH),
      rejectUnauthorized: true
    }, response => {
      if (response.statusCode >= 300 && response.statusCode < 400) {
        response.resume();
        reject(new Error('TP-Link cloud redirect was rejected.'));
        return;
      }
      let raw = '';
      response.setEncoding('utf8');
      response.on('data', chunk => {
        raw += chunk;
        if (Buffer.byteLength(raw, 'utf8') > MAX_RESPONSE_BYTES) {
          req.destroy(new Error('TP-Link cloud response is too large.'));
        }
      });
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error('TP-Link cloud returned HTTP ' + response.statusCode + '.'));
          return;
        }
        try {
          const payload = JSON.parse(raw);
          if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
            throw new Error('invalid response');
          }
          const code = Number(payload.error_code);
          if (!Number.isFinite(code)) throw new Error('invalid response');
          resolve(payload);
        } catch {
          reject(new Error('TP-Link cloud returned an invalid response.'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('TP-Link cloud request timed out.')));
    req.on('error', () => reject(new Error('Could not complete a secure request to TP-Link cloud.')));
    req.end(bodyJson);
  });
}

class TapoCloudAuth {
  constructor(options = {}) {
    this.request = options.request || https.request;
    this.timeoutMs = options.timeoutMs;
    this.termId = options.termId || crypto.randomUUID();
    this.host = TAPO_HOST;
    this.query = {
      appName: APP_TYPE,
      appVer: APP_VERSION,
      netType: 'wifi',
      termID: this.termId,
      ospf: 'Android 14',
      brand: 'TPLINK',
      locale: 'en_US',
      model: 'Pixel',
      termName: 'Pixel',
      termMeta: 'Pixel'
    };
  }

  async post(base, route, body, token) {
    const bodyJson = JSON.stringify(body);
    const params = new URLSearchParams(this.query);
    if (token) params.set('token', token);
    const url = new URL(route + '?' + params.toString(), validateCloudBase(base));
    const headers = signBody(bodyJson, route);
    return postJson(url, bodyJson, headers, {
      request: this.request,
      timeoutMs: this.timeoutMs
    });
  }

  async login(options = {}) {
    const username = typeof options.username === 'string' ? options.username.trim() : '';
    const password = typeof options.password === 'string' ? options.password : '';
    const mfaCode = typeof options.mfaCode === 'string' ? options.mfaCode.trim() : '';
    if (!username || !password) {
      return { ok: false, code: 'credentials_required', message: 'Укажите email и пароль аккаунта Tapo.' };
    }
    if (username.length > 320 || password.length > 2048 || mfaCode.length > 32) {
      return { ok: false, code: 'invalid_input', message: 'Проверьте длину введённых данных.' };
    }

    try {
      const status = await this.post(TAPO_HOST, PATHS.accountStatus, {
        appType: APP_TYPE,
        cloudUserName: username
      });
      if (Number(status.error_code) !== 0) {
        return { ok: false, code: 'cloud_error', message: 'Не удалось определить региональный сервер TP-Link.' };
      }
      const regionalHost = validateCloudBase(status.result?.appServerUrl || TAPO_HOST);
      this.host = regionalHost;
      const loginBody = {
        appType: APP_TYPE,
        appVersion: APP_VERSION,
        cloudPassword: password,
        cloudUserName: username,
        platform: 'Android',
        refreshTokenNeeded: true,
        supportBindAccount: false,
        terminalUUID: this.termId,
        terminalName: 'Pixel',
        terminalMeta: 'Pixel'
      };
      const login = await this.post(regionalHost, PATHS.login, loginBody);
      const loginCode = Number(login.error_code);
      if (loginCode === -20677) {
        if (!mfaCode) {
          return { ok: false, code: 'mfa_required', message: 'TP-Link запросил код подтверждения. Введите свежий код из письма.' };
        }
        const verified = await this.post(regionalHost, PATHS.mfa, {
          appType: APP_TYPE,
          cloudPassword: password,
          cloudUserName: username,
          code: mfaCode,
          terminalUUID: this.termId
        });
        if (Number(verified.error_code) !== 0) {
          return { ok: false, code: 'mfa_failed', message: 'TP-Link не принял код подтверждения. Проверьте код и повторите попытку.' };
        }
        return this.authResult(verified.result, regionalHost);
      }
      if (loginCode === -20601 || loginCode === -20675) {
        return { ok: false, code: 'auth_failed', message: 'TP-Link отклонил логин или пароль. Проверьте данные аккаунта.' };
      }
      if (loginCode !== 0) {
        return { ok: false, code: 'cloud_error', message: 'TP-Link не завершил авторизацию (код ' + loginCode + ').' };
      }
      return this.authResult(login.result, regionalHost);
    } catch {
      return { ok: false, code: 'cloud_error', message: 'Не удалось безопасно подключиться к облаку TP-Link.' };
    }
  }

  authResult(result, host) {
    if (!result || typeof result.token !== 'string' || !result.token) {
      return { ok: false, code: 'login_failed', message: 'TP-Link не вернул токен облачной сессии.' };
    }
    return {
      ok: true,
      authenticated: true,
      host,
      termId: this.termId,
      token: result.token,
      refreshToken: typeof result.refreshToken === 'string' ? result.refreshToken : null
    };
  }

  async refresh(refreshToken) {
    if (typeof refreshToken !== 'string' || !refreshToken) {
      throw new Error('A Tapo refresh token is required.');
    }
    const response = await this.post(this.host, PATHS.refresh, {
      appType: APP_TYPE,
      refreshToken,
      terminalUUID: this.termId
    });
    const code = Number(response.error_code);
    if (code === -20655) throw new Error('Tapo refresh token expired; full login is required.');
    if (code !== 0) throw new Error('TP-Link cloud token refresh failed (code ' + code + ').');
    return this.authResult(response.result, this.host);
  }
}

module.exports = { TapoCloudAuth, validateCloudBase, signBody };
