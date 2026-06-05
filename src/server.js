const http = require('node:http');
const { loadConfig } = require('./config');
const { createApp } = require('./app');
const { TaskStore } = require('./task-store');
const { TaskService } = require('./task-service');
const { ProjectConfigStore } = require('./project-config-store');
const { createLogger } = require('./logger');

const config = loadConfig();
const logger = createLogger({
  level: config.logLevel,
  filePath: config.logToFile ? `${config.logDir}/impactserver.log` : ''
});
const store = new TaskStore({ runtimeDir: config.runtimeDir });
const projectConfigStore = new ProjectConfigStore({ configPath: config.projectConfigPath });
const taskService = new TaskService({ store, config, projectConfigStore, logger });
const app = createApp({ taskService, config, logger });

const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  logger.info('impactserver listening', {
    host: config.host,
    port: config.port,
    log_level: config.logLevel,
    log_to_file: config.logToFile,
    log_dir: config.logDir
  });
});
