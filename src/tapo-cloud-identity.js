'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'tapo-cloud-terminal-id';

function getStableTapoTermId(storageDirectory) {
  if (typeof storageDirectory !== 'string' || !storageDirectory.trim()) {
    throw new Error('Homebridge storage directory is required for the Tapo cloud terminal identity.');
  }
  const filePath = path.join(storageDirectory, FILE_NAME);
  try {
    const existing = fs.readFileSync(filePath, 'utf8').trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(existing)) {
      return existing;
    }
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }

  const termId = crypto.randomUUID();
  const tempPath = filePath + '.tmp';
  fs.writeFileSync(tempPath, termId + '\n', { mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  return termId;
}

module.exports = { getStableTapoTermId };
