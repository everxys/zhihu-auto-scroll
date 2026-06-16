#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const {
  AUTH_FILE,
  fileExists,
  parseArgs,
  classifyArchiveError,
  launchNativeBrowserSession,
  hydrateContextFromStorageState,
  createBrowserProfileTempDir,
} = require('./zhihu-automation');

const HELP = `
Usage:
  zhihu auth-check
  zhihu auth-check --url https://www.zhihu.com/question/286130359

Options:
  --url <url>       Zhihu page used to check auth state. Defaults to a stable question page.
  --auth <file>     Playwright storageState file. Defaults to .auth/zhihu.storageState.json.
  --channel <name>  Browser: chrome or msedge.
  --help            Show help.
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    console.log(HELP);
    return;
  }

  const authFile = path.resolve(String(args.auth || AUTH_FILE));
  if (!fileExists(authFile)) {
    throw new Error(`Missing auth state file: ${authFile}\nRun zhihu login first.`);
  }

  const browserProfileDir = createBrowserProfileTempDir('zhihu-auth-check-profile');
  const session = await launchNativeBrowserSession({
    channel: args.channel,
    url: 'about:blank',
    profileDir: browserProfileDir,
  });
  try {
    await hydrateContextFromStorageState(session.context, authFile);
    const page = session.context.pages()[0] || await session.context.newPage();
    await page.goto(String(args.url || 'https://www.zhihu.com/question/286130359'), {
      waitUntil: 'domcontentloaded',
      timeout: 60000,
    });
    await page.waitForTimeout(3000);
    const currentUrl = page.url();
    const state = await page.evaluate(() => ({
      bodyText: document.body?.innerText || '',
      hasQuestion: Boolean(document.querySelector('.QuestionHeader, .Question-main, .QuestionAnswer-content, .AnswerItem')),
      hasSignFlow: Boolean(document.querySelector('.SignFlow, .Login-content')),
    })).catch(() => ({ bodyText: '', hasQuestion: false, hasSignFlow: false }));

    if (/请求存在异常|暂时限制|40362|验证码|安全验证|人机验证|验证你是真人|异常流量/.test(state.bodyText)) {
      throw new Error(`Zhihu requires CAPTCHA or security verification. Current page: ${currentUrl}\nRun zhihu login to handle verification again.`);
    }
    if (/signin|login/i.test(currentUrl) || state.hasSignFlow || (!state.hasQuestion && /登录知乎|注册\/登录/.test(state.bodyText))) {
      throw new Error(`Auth state is expired. Current page: ${currentUrl}\nRun zhihu login again.`);
    }

    console.log(`Auth state is usable: ${authFile}`);
  } finally {
    await session.close();
    try {
      fs.rmSync(browserProfileDir, { recursive: true, force: true });
    } catch {}
  }
}

main().catch(error => {
  const classified = classifyArchiveError(error);
  console.error(classified.message);
  process.exitCode = 1;
});
