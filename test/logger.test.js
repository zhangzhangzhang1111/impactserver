const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { createLogger } = require('../src/logger');

test('logger filters by level and writes structured JSON lines', async () => {
  const writes = [];
  const logger = createLogger({
    level: 'warn',
    stdout: { write: (line) => writes.push(line) },
    now: () => new Date('2026-06-05T08:00:00.000Z')
  });

  logger.info('task queued', { task_id: 'task_1' });
  logger.warn('task stalled', { task_id: 'task_1', stage: 'DIFF_PARSE' });

  assert.equal(writes.length, 1);
  const entry = JSON.parse(writes[0]);
  assert.equal(entry.timestamp, '2026-06-05T08:00:00.000Z');
  assert.equal(entry.level, 'warn');
  assert.equal(entry.message, 'task stalled');
  assert.equal(entry.task_id, 'task_1');
  assert.equal(entry.stage, 'DIFF_PARSE');
});

test('logger records error message and stack fields', () => {
  const writes = [];
  const logger = createLogger({
    level: 'debug',
    stdout: { write: (line) => writes.push(line) },
    now: () => new Date('2026-06-05T08:00:00.000Z')
  });
  const error = new Error('analysis failed');

  logger.error('task failed', { task_id: 'task_2', error });

  const entry = JSON.parse(writes[0]);
  assert.equal(entry.level, 'error');
  assert.equal(entry.message, 'task failed');
  assert.equal(entry.error.message, 'analysis failed');
  assert.match(entry.error.stack, /analysis failed/);
});

test('logger can append JSON lines to a configured log file', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'impactserver-logger-'));
  const logFile = path.join(root, 'impactserver.log');
  const logger = createLogger({
    level: 'info',
    filePath: logFile,
    stdout: null,
    now: () => new Date('2026-06-05T08:00:00.000Z')
  });

  await logger.info('server started', { host: '127.0.0.1', port: 3000 });

  const raw = await fs.readFile(logFile, 'utf8');
  const entry = JSON.parse(raw.trim());
  assert.equal(entry.message, 'server started');
  assert.equal(entry.host, '127.0.0.1');
  assert.equal(entry.port, 3000);
});
