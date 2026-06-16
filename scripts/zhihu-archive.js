const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');
const {
  AUTH_DIR,
  AUTH_FILE,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  ensureDir,
  fileExists,
  parseQuestionUrl,
  questionIdFromUrl,
  defaultArchivePath,
  toPositiveInt,
  toOptionalNumber,
  injectUserscript,
  configureAndStart,
  waitForAutomationDone,
  normalizeCookiesForSingleFile,
  getLocalStorageEntries,
  writeJson,
  writeSingleFileBootstrap,
  runSingleFile,
} = require('./zhihu-automation');

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const { href: url, id: questionId } = parseQuestionUrl(args.url);
  const authFile = path.resolve(String(args.auth || AUTH_FILE));
  if (!fileExists(authFile)) {
    throw new Error(`缺少登录态文件：${authFile}\n请先运行 npm run zhihu:login`);
  }

  const headless = !args.headed && !args.debug;
  const timeoutMs = toPositiveInt(args['timeout-ms'], DEFAULT_TIMEOUT_MS);
  const settleMs = toPositiveInt(args['settle-ms'], DEFAULT_SETTLE_MS);
  const expandComments = args.comments === true || args['expand-comments'] === true;
  const scrollSpeed = toOptionalNumber(args.speed);
  const intervalMs = toOptionalNumber(args.interval);
  const output = path.resolve(String(args.output || defaultArchivePath(questionId)));
  ensureDir(path.dirname(output));
  ensureDir(AUTH_DIR);

  const browser = await chromium.launch({ headless });
  const context = await browser.newContext({
    storageState: authFile,
    viewport: { width: 1280, height: 900 },
  });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    if (questionIdFromUrl(page.url()) !== questionId) {
      throw new Error(`打开目标问题页失败，当前页面是 ${page.url()}。登录态可能已失效，请重新运行 npm run zhihu:login`);
    }
    await injectUserscript(page);
    await configureAndStart(page, { expandComments, scrollSpeed, intervalMs });
    const snapshot = await waitForAutomationDone(page, { timeoutMs, settleMs });
    console.log(`Playwright 自动展开完成：已发现 ${snapshot.answerCount}/${snapshot.totalAnswerCount ?? '?'} 个回答`);

    const storageState = await context.storageState();
    const cookiesFile = path.join(AUTH_DIR, `zhihu.singlefile.cookies.${process.pid}.json`);
    const bootstrapFile = path.join(AUTH_DIR, `zhihu.singlefile.bootstrap.${process.pid}.js`);
    writeJson(cookiesFile, normalizeCookiesForSingleFile(storageState.cookies || []));
    writeSingleFileBootstrap(bootstrapFile, {
      expandComments,
      scrollSpeed,
      intervalMs,
      timeoutMs,
      settleMs,
      localStorage: getLocalStorageEntries(storageState, new URL(url).origin),
    });

    try {
      await runSingleFile({
        url,
        output,
        cookiesFile,
        bootstrapFile,
        headless,
        debug: args.debug === true,
        timeoutMs,
      });
    } finally {
      fs.rmSync(cookiesFile, { force: true });
      fs.rmSync(bootstrapFile, { force: true });
    }
  } finally {
    await browser.close();
  }

  console.log(`已保存归档：${output}`);
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
