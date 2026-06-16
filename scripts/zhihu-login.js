const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('playwright');
const {
  AUTH_DIR,
  AUTH_FILE,
  LOGIN_URL,
  ensureDir,
  fileExists,
} = require('./zhihu-automation');

async function main() {
  ensureDir(AUTH_DIR);
  const browser = await chromium.launch({ headless: false });
  try {
    const contextOptions = fileExists(AUTH_FILE) ? { storageState: AUTH_FILE } : {};
    const context = await browser.newContext(contextOptions);
    const page = await context.newPage();
    await page.goto(LOGIN_URL, { waitUntil: 'domcontentloaded' });

    console.log('已打开知乎登录页。请在浏览器里手动登录。');
    console.log(`完成后回到终端按 Enter，会覆盖保存登录态到 ${AUTH_FILE}`);
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question('登录完成后按 Enter 保存：');
    } finally {
      rl.close();
    }

    await context.storageState({ path: AUTH_FILE });
    console.log(`已保存 Playwright 登录态：${AUTH_FILE}`);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
