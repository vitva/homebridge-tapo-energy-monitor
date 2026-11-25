'use strict';

const path = require('node:path');
const { spawn } = require('node:child_process');

const MAX_OUTPUT = 1024 * 1024;

function runTapoCloudProbe(options = {}) {
  const executable = typeof options.pythonExecutable === 'string' && options.pythonExecutable.trim()
    ? options.pythonExecutable.trim()
    : 'python3';
  const spawnProcess = options.spawn || spawn;
  const scriptPath = path.join(__dirname, '..', 'helpers', 'tapo_cloud_probe.py');
  const timeoutMs = Math.max(10000, Math.min(90000, Number(options.timeoutMs) || 45000));

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(executable, [scriptPath], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      });
    } catch {
      reject(new Error('Не удалось запустить Python. Проверьте Python 3.10+ в контейнере Homebridge.'));
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error('Проверка облака Tapo превысила лимит времени (45 секунд).'));
    }, timeoutMs);

    child.stdout.on('data', chunk => {
      stdout += chunk.toString('utf8');
      if (stdout.length > MAX_OUTPUT) {
        child.kill('SIGKILL');
        finish(new Error('Ответ диагностического модуля слишком большой.'));
      }
    });
    child.stderr.on('data', chunk => {
      if (stderr.length < 4096) stderr += chunk.toString('utf8').slice(0, 4096 - stderr.length);
    });
    child.on('error', error => {
      if (error && error.code === 'ENOENT') {
        finish(new Error('Python не найден. Установите Python 3.10+ в контейнер Homebridge.'));
      } else {
        finish(new Error('Не удалось запустить диагностический модуль Python.'));
      }
    });
    child.on('close', code => {
      if (settled) return;
      let result;
      try {
        result = JSON.parse(stdout);
      } catch {
        finish(new Error(code === 0
          ? 'Диагностический модуль вернул некорректный ответ.'
          : 'Диагностический модуль завершился с ошибкой. Проверьте Python и установку зависимости tplink-cloud-api.'));
        return;
      }
      if (!result || typeof result !== 'object') {
        finish(new Error('Диагностический модуль вернул пустой ответ.'));
        return;
      }
      finish(null, result);
    });

    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({
      username: options.username,
      password: options.password,
      mfaCode: options.mfaCode || ''
    }));
  });
}

module.exports = { runTapoCloudProbe };
