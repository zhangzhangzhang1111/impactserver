const http = require('node:http');
const { createWebhookClientApp, loadWebhookClientConfig } = require('./webhook-client');

const config = loadWebhookClientConfig();
const app = createWebhookClientApp({ config });
const server = http.createServer(app);

server.listen(config.port, config.host, () => {
  process.stdout.write(`impact webhook client listening on http://${config.host}:${config.port}\n`);
});
