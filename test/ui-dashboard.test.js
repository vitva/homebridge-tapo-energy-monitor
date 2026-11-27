'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function createElement() {
  return {
    children: [],
    childNodes: [],
    hidden: false,
    disabled: false,
    value: '',
    textContent: '',
    className: '',
    style: {},
    files: [],
    addEventListener() {},
    append(...items) {
      this.children.push(...items);
      this.childNodes = this.children;
    },
    replaceChildren(...items) {
      this.children = [...items];
      this.childNodes = this.children;
    },
    focus() {}
  };
}

async function renderDashboard(data) {
  const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  const script = html.match(/<script>([\\s\\S]*?)<\\/script>/);
  assert.ok(script, 'dashboard script must exist');

  const elements = new Map();
  const document = {
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, createElement());
      return elements.get(id);
    },
    createElement() {
      return createElement();
    }
  };
  const listeners = new Map();
  const homebridge = {
    async getPluginConfig() { return []; },
    showSchemaForm() {},
    addEventListener(name, callback) { listeners.set(name, callback); },
    async request(route) {
      if (route === '/summary') return { available: true, updatedAt: 0, data };
      if (route === '/watt-imports') return { individual: null, aggregate: null };
      throw new Error('Unexpected route: ' + route);
    }
  };
  vm.runInNewContext(script[1], {
    document,
    homebridge,
    window: { setInterval() {} },
    Intl,
    Date,
    Map,
    Set,
    Object,
    Number,
    String,
    Array,
    JSON,
    Promise,
    Error
  });
  await listeners.get('ready')();
  return elements;
}

test('renders the latest common verified day and independent monthly/yearly cloud totals', async () => {
  const devices = {};
  for (let index = 1; index <= 4; index += 1) {
    devices['p110m-' + index] = {
      id: 'p110m-' + index,
      name: 'Plug ' + index,
      model: 'P110M',
      source: 'tapo_cloud',
      active: true,
      latestDate: '2026-11-27',
      energyWh: 12000,
      totals: {
        daily: { '2026-10-30': 100, '2026-10-31': 200 },
        monthly: { '2026-11': 3000 },
        yearly: { '2026': 12000 }
      }
    };
  }
  const elements = await renderDashboard({
    devices,
    totals: {
      daily: { '2026-10-30': 400, '2026-10-31': 800 },
      monthly: { '2026-11': 12000 },
      yearly: { '2026': 48000 }
    }
  });

  assert.equal(elements.get('today-label').textContent, 'Latest verified day · combined (2026-10-31)');
  assert.equal(elements.get('today').textContent, '0.8 kWh');
  assert.equal(elements.get('month').textContent, '12 kWh');
  assert.equal(elements.get('year').textContent, '48 kWh');
  assert.equal(elements.get('count').textContent, '4 active');
});

test('renders monthly/yearly cloud values even when no verified daily bucket remains', async () => {
  const devices = {};
  for (let index = 1; index <= 4; index += 1) {
    devices['p110m-' + index] = {
      id: 'p110m-' + index,
      source: 'tapo_cloud',
      active: true,
      latestDate: '2026-11-27',
      energyWh: 12000,
      totals: { daily: {}, monthly: { '2026-11': 3000 }, yearly: { '2026': 12000 } }
    };
  }
  const elements = await renderDashboard({
    devices,
    totals: { daily: {}, monthly: { '2026-11': 12000 }, yearly: { '2026': 48000 } }
  });

  assert.equal(elements.get('today').textContent, '—');
  assert.equal(elements.get('month').textContent, '12 kWh');
  assert.equal(elements.get('year').textContent, '48 kWh');
  assert.equal(elements.get('count').textContent, '4 active');
});

test('initializes cloud dashboard state before reading it', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'homebridge-ui', 'public', 'index.html'), 'utf8');
  const refreshStart = html.indexOf('async function refresh()');
  const initStart = html.indexOf('async function init()', refreshStart);
  assert.ok(refreshStart >= 0 && initStart > refreshStart, 'dashboard refresh function must exist');
  const refresh = html.slice(refreshStart, initStart);
  const activeDevices = refresh.indexOf('const activeDevices =');
  const cloudHistory = refresh.indexOf('const cloudHistory =');
  const primaryCloudDevice = refresh.indexOf('const primaryCloudDevice =');
  const todayWh = refresh.indexOf('const todayWh =');
  assert.ok(activeDevices >= 0 && activeDevices < primaryCloudDevice,
    'activeDevices must be initialized before primaryCloudDevice reads it');
  assert.ok(cloudHistory >= 0 && cloudHistory < todayWh,
    'cloudHistory must be initialized before todayWh reads it');
  assert.ok(refresh.includes('latestCommonDate'),
    'cloud dashboard must fall back to the latest date complete across active devices');
  const monthKey = refresh.indexOf('const monthKey =');
  const monthRender = refresh.indexOf("byId('month').textContent");
  assert.ok(monthKey >= 0 && monthKey < monthRender,
    'reporting period keys must be initialized before monthly values render');
  assert.ok(refresh.includes("byId('month').textContent") && refresh.includes("byId('year').textContent"),
    'cloud dashboard must expose monthly and yearly totals without requiring a daily bucket');
  assert.ok(html.includes('id="month"') && html.includes('id="year"'),
    'monthly and yearly summary cards must exist');
});
