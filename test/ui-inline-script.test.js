'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function readUiScript() {
  const file = path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html');
  const html = fs.readFileSync(file, 'utf8');
  const match = html.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(match, 'custom UI script block must exist');
  return { file, html, source: match[1] };
}

class FakeElement {
  constructor() {
    this.value = '';
    this.hidden = false;
    this.disabled = false;
    this.files = [];
    this.childNodes = [];
    this.style = {};
    this.handlers = {};
    this.className = '';
    this.textContent = '';
  }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  append(...nodes) { this.childNodes.push(...nodes); }
  replaceChildren(...nodes) { this.childNodes = [...nodes]; }
  focus() {}
}

async function runUi({ initialConfig = [], cloudResult }) {
  const elements = new Map();
  const getElement = id => {
    if (!elements.has(id)) elements.set(id, new FakeElement());
    return elements.get(id);
  };
  getElement('tapo-email').value = 'user@example.com';
  getElement('tapo-password').value = 'test-password-value';

  let config = structuredClone(initialConfig);
  const calls = [];
  const listeners = {};
  const homebridge = {
    async getPluginConfig() {
      calls.push('getPluginConfig');
      return structuredClone(config);
    },
    async updatePluginConfig(next) {
      calls.push('updatePluginConfig');
      config = structuredClone(next);
    },
    async savePluginConfig() { calls.push('savePluginConfig'); },
    async request(route) {
      if (route === '/summary') return { available: false, message: 'No history' };
      if (route === '/watt-imports') return { individual: null, aggregate: null };
      if (route === '/tapo-cloud-test') {
        calls.push('tapo-cloud-test');
        return cloudResult;
      }
      throw new Error('Unexpected route: ' + route);
    },
    showSchemaForm() {},
    addEventListener(name, callback) { listeners[name] = callback; }
  };
  const { file, source } = readUiScript();
  vm.runInNewContext(source, {
    document: {
      getElementById: getElement,
      createElement: () => new FakeElement()
    },
    homebridge,
    window: { setInterval() {} },
    console,
    Date,
    Map,
    Object,
    Number,
    String,
    JSON
  }, { filename: file });

  await listeners.ready();
  await getElement('tapo-test').handlers.click();
  return { config, calls, elements };
}

test('Homebridge custom UI inline script parses successfully', () => {
  const { file, source } = readUiScript();
  assert.doesNotThrow(() => new vm.Script(source, { filename: file }));
});

test('custom UI contains no Python transport or runtime setting', () => {
  const { html } = readUiScript();
  assert.doesNotMatch(html, /python|tapo-transport|tapoCloudPython/i);
});

test('saves login and password before sending cloud auth request, including MFA challenge', async () => {
  const { config, calls, elements } = await runUi({
    cloudResult: {
      ok: false,
      authenticated: false,
      code: 'mfa_required',
      message: 'TP-Link requested MFA',
      diagnostics: []
    }
  });

  const updateIndex = calls.indexOf('updatePluginConfig');
  const saveIndex = calls.indexOf('savePluginConfig');
  const authIndex = calls.indexOf('tapo-cloud-test');
  assert.ok(updateIndex >= 0, 'credentials must be written to plugin config');
  assert.ok(saveIndex > updateIndex, 'plugin config must be saved after update');
  assert.ok(authIndex > saveIndex, 'credentials must be saved before cloud authentication');
  const platform = config.find(item => item.platform === 'TapoEnergyMonitor');
  assert.equal(platform.tapoCloudUsername, 'user@example.com');
  assert.equal(platform.tapoCloudPassword, 'test-password-value');
  assert.equal(elements.get('tapo-mfa-wrap').hidden, false);
  assert.match(elements.get('tapo-test-status').textContent, /логин и пароль подтверждены в config.json/);
  assert.equal(elements.get('tapo-password').value, 'test-password-value');
});

test('reports successful account authentication separately from a later Thing API failure', async () => {
  const { elements } = await runUi({
    cloudResult: {
      ok: false,
      authenticated: true,
      code: 'thing_api_error',
      message: 'Thing API unavailable',
      diagnostics: [{ stage: 'authentication', status: 'success', durationMs: 100 }]
    }
  });

  assert.match(elements.get('tapo-test-status').textContent, /Авторизация в TP-Link выполнена/);
  assert.match(elements.get('tapo-test-result').childNodes[0].textContent, /Вход выполнен, но проверка Thing Cloud API завершилась ошибкой/);
});
