const fs = require('node:fs/promises');
const path = require('node:path');

const LEVELS = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

function createLogger({
  level = 'info',
  stdout = process.stdout,
  filePath = '',
  now = () => new Date()
} = {}) {
  const threshold = LEVELS[String(level).toLowerCase()] || LEVELS.info;

  function write(levelName, message, context = {}) {
    if (LEVELS[levelName] < threshold) return Promise.resolve(false);
    const entry = {
      timestamp: now().toISOString(),
      level: levelName,
      message,
      ...serializeContext(context)
    };
    const line = `${JSON.stringify(entry)}\n`;
    if (stdout && typeof stdout.write === 'function') {
      stdout.write(line);
    }
    if (!filePath) return Promise.resolve(true);
    return fs.mkdir(path.dirname(filePath), { recursive: true })
      .then(() => fs.appendFile(filePath, line))
      .then(() => true)
      .catch((error) => {
        if (stdout && typeof stdout.write === 'function') {
          stdout.write(`${JSON.stringify({
            timestamp: now().toISOString(),
            level: 'error',
            message: 'logger file write failed',
            log_file: filePath,
            error: serializeError(error)
          })}\n`);
        }
        return false;
      });
  }

  return {
    debug: (message, context) => write('debug', message, context),
    info: (message, context) => write('info', message, context),
    warn: (message, context) => write('warn', message, context),
    error: (message, context) => write('error', message, context)
  };
}

function createNoopLogger() {
  return {
    debug: () => Promise.resolve(false),
    info: () => Promise.resolve(false),
    warn: () => Promise.resolve(false),
    error: () => Promise.resolve(false)
  };
}

function serializeContext(context = {}) {
  const serialized = {};
  for (const [key, value] of Object.entries(context || {})) {
    serialized[key] = serializeValue(value);
  }
  return serialized;
}

function serializeValue(value) {
  if (value instanceof Error) return serializeError(value);
  if (Array.isArray(value)) return value.map(serializeValue);
  if (!value || typeof value !== 'object') return value;
  const result = {};
  for (const [key, nested] of Object.entries(value)) {
    result[key] = serializeValue(nested);
  }
  return result;
}

function serializeError(error) {
  return {
    name: error.name,
    message: error.message,
    stack: error.stack
  };
}

module.exports = {
  createLogger,
  createNoopLogger,
  serializeError
};
