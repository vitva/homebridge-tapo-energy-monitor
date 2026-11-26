'use strict';

function splitCsvLine(line) {
  const fields = [];
  let value = '';
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    if (char === '"') {
      if (quoted && line[i + 1] === '"') { value += '"'; i += 1; }
      else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      fields.push(value); value = '';
    } else value += char;
  }
  if (quoted) throw new Error('CSV contains an unterminated quoted field.');
  fields.push(value);
  return fields;
}

function parseWattCsv(csv) {
  if (typeof csv !== 'string' || !csv.trim()) throw new Error('CSV file is empty.');
  if (Buffer.byteLength(csv, 'utf8') > 1024 * 1024) throw new Error('CSV file exceeds the 1 MB limit.');
  const lines = csv.replace(/^\uFEFF/, '').split(/\r?\n/).filter(line => line.trim());
  const header = splitCsvLine(lines.shift()).map(value => value.trim());
  if (header.length < 2 || header[0] !== 'Date' || header[1] !== 'Consumption (Wh)') {
    throw new Error('Unsupported CSV header. Expected Date,Consumption (Wh),Runtime (Minute).');
  }
  const runtimeIndex = header.indexOf('Runtime (Minute)');
  const seen = new Set();
  const records = lines.map((line, index) => {
    const fields = splitCsvLine(line);
    const match = /^(\d{4}-\d{2}-\d{2}) /.exec(fields[0] || '');
    const date = match && match[1];
    const consumptionWh = Number(fields[1]);
    const runtimeMinutes = runtimeIndex >= 0 && fields[runtimeIndex] !== '' ? Number(fields[runtimeIndex]) : null;
    if (!date || Number.isNaN(Date.parse(date + 'T00:00:00Z')) ||
        !Number.isFinite(consumptionWh) || consumptionWh < 0 ||
        (runtimeMinutes !== null && (!Number.isFinite(runtimeMinutes) || runtimeMinutes < 0))) {
      throw new Error('Invalid date or numeric value on CSV line ' + (index + 2) + '.');
    }
    if (seen.has(date)) throw new Error('Duplicate daily record for ' + date + '.');
    seen.add(date);
    return { date, consumptionWh, runtimeMinutes, sourceTimestamp: fields[0] };
  }).sort((a, b) => a.date.localeCompare(b.date));
  if (!records.length) throw new Error('CSV contains no daily records.');
  const totalWh = records.reduce((sum, item) => sum + item.consumptionWh, 0);
  const daily = {};
  const monthly = {};
  const yearly = {};
  for (const item of records) {
    daily[item.date] = item.consumptionWh;
    const month = item.date.slice(0, 7);
    const year = item.date.slice(0, 4);
    monthly[month] = (monthly[month] || 0) + item.consumptionWh;
    yearly[year] = (yearly[year] || 0) + item.consumptionWh;
  }
  return { records, totalWh, daily, monthly, yearly, recordCount: records.length };
}

module.exports = { parseWattCsv };
