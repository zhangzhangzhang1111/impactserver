const path = require('node:path');

function loadConfig(env = process.env, cwd = process.cwd()) {
  return {
    host: env.IMPACT_HOST || '127.0.0.1',
    port: Number(env.IMPACT_PORT || 3000),
    apiToken: env.IMPACT_API_TOKEN || '',
    runtimeDir: path.resolve(cwd, env.IMPACT_RUNTIME_DIR || 'runtime'),
    reportsDir: path.resolve(cwd, env.IMPACT_REPORTS_DIR || 'reports'),
    logLevel: env.IMPACT_LOG_LEVEL || 'info',
    logDir: path.resolve(cwd, env.IMPACT_LOG_DIR || path.join(env.IMPACT_RUNTIME_DIR || 'runtime', 'logs')),
    logToFile: env.IMPACT_LOG_TO_FILE === 'true',
    workspaceDir: path.resolve(cwd, env.IMPACT_WORKSPACE_DIR || 'workspaces'),
    gitCacheDir: path.resolve(cwd, env.IMPACT_GIT_CACHE_DIR || 'git-cache'),
    allowedCloneUrlPatterns: parseList(env.IMPACT_ALLOWED_CLONE_URL_PATTERNS),
    projectConfigPath: path.resolve(cwd, env.IMPACT_PROJECT_CONFIG || 'config/projects.json'),
    retainWorkspaces: env.IMPACT_RETAIN_WORKSPACES === 'true',
    retentionDays: Number(env.IMPACT_REPORT_RETENTION_DAYS || 30),
    protectedBranchRetentionDays: Number(env.IMPACT_PROTECTED_BRANCH_RETENTION_DAYS || 180),
    autoRunTasks: env.IMPACT_AUTO_RUN_TASKS !== 'false',
    workerConcurrency: Number(env.IMPACT_WORKER_CONCURRENCY || 1),
    taskTimeoutMs: Number(env.IMPACT_TASK_TIMEOUT_MS || 0),
    ai: {
      enabled: env.IMPACT_AI_ENABLED === 'true',
      provider: env.IMPACT_AI_PROVIDER || '',
      baseUrl: env.IMPACT_AI_BASE_URL || '',
      apiKey: env.IMPACT_AI_API_KEY || '',
      model: env.IMPACT_AI_MODEL || 'default',
      timeoutMs: Number(env.IMPACT_AI_TIMEOUT_MS || 60000),
      maxRetries: Number(env.IMPACT_AI_MAX_RETRIES || 2),
      maxOutputTokens: Number(env.IMPACT_AI_MAX_OUTPUT_TOKENS || 0),
      anthropicVersion: env.IMPACT_AI_ANTHROPIC_VERSION || '2023-06-01'
    }
  };
}

function parseList(value) {
  return String(value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

module.exports = { loadConfig, parseList };
