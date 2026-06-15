const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests',
  webServer: {
    command: 'node tests/smoke-server.js',
    url: 'http://127.0.0.1:51999/question/123',
    reuseExistingServer: true,
  },
});
