#!/usr/bin/env node
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const os = require('node:os');
const path = require('node:path');
const {
  AUTH_DIR,
  AUTH_FILE,
  LOGIN_URL,
  ensureDir,
  parseArgs,
  writeText,
  launchNativeBrowserSession,
} = require('./zhihu-automation');

const HELP = `
Usage:
  zhihu login
  zhihu login --channel chrome

Options:
  --channel <name>   Login browser: chrome or msedge. Defaults to system Chrome, then Edge.
  --help             Show help.
`.trim();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    console.log(HELP);
    return;
  }
  if (args.channel === 'chromium') {
    throw new Error('Zhihu blocks Playwright Chromium login. Use zhihu login or zhihu login --channel chrome/msedge.');
  }

  ensureDir(AUTH_DIR);
  const session = await launchNativeBrowserSession({
    channel: args.channel ? String(args.channel).toLowerCase() : null,
    url: LOGIN_URL,
  });
  try {
    console.log(`Opened the Zhihu login page in ${session.label}. Log in manually in the browser.`);
    console.log('This is a normal browser window, not a Playwright-controlled login page, to avoid Zhihu login API error 10001.');
    console.log(`After login, return to this terminal and press Enter. Auth state will be saved to ${AUTH_FILE}`);
    const rl = readline.createInterface({ input, output });
    try {
      await rl.question('Press Enter after login to save auth state: ');
    } finally {
      rl.close();
    }

    await session.context.storageState({ path: AUTH_FILE });
    writeText(path.join(AUTH_DIR, 'zhihu-login-profile.txt'), `${session.profileDir}${os.EOL}`);
    console.log(`Saved Playwright auth state: ${AUTH_FILE}`);
  } finally {
    await session.close();
  }
}

main().catch(error => {
  console.error(error.message || error);
  process.exitCode = 1;
});
