#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const {
  AUTH_FILE,
  DEFAULT_SETTLE_MS,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  ensureDir,
  fileExists,
  parseQuestionUrl,
  parseQuestionUrlsFromFile,
  questionIdFromUrl,
  defaultArchivePath,
  cleanArchiveTitle,
  toPositiveInt,
  toOptionalNumber,
  injectUserscript,
  configureAndStart,
  waitForAutomationDone,
  writeText,
  savePageWithSingleFile,
  defaultDebugDir,
  formatBytes,
  formatAutomationProgress,
  classifyArchiveError,
  launchNativeBrowserSession,
  zhihuContextOptions,
  hydrateContextFromStorageState,
  createBrowserProfileTempDir,
} = require('./zhihu-automation');

const HELP = `
Usage:
  zhihu archive --url https://www.zhihu.com/question/123
  zhihu archive --urls-file questions.txt

Options:
  --url <url>             Archive one Zhihu question page.
  --urls-file <file>      Batch archive. One Zhihu question URL per line; blank lines and # comments are ignored.
  --output <path>         HTML file for one URL; output directory for batch mode. Defaults to archives/.
  --headed                Run Playwright and SingleFile in visible browser windows.
  --debug                 Enable headed/debug mode and write debug artifacts by default.
  --debug-dir <dir>       Save console, screenshot, and SingleFile stdout/stderr artifacts.
  --comments              Open and expand comments.
  --open-comments         Alias for --comments.
  --timeout-ms <ms>       Timeout for page automation and SingleFile capture. Default: off.
  --settle-ms <ms>        Stable wait after page automation completes. Default: 1500.
  --progress-interval-ms <ms>  Progress log interval while scrolling. Default: 3000.
  --speed <number>        Set userscript scroll speed.
  --interval <ms>         Set userscript run interval.
  --auth <file>           Playwright storageState file. Defaults to .auth/zhihu.storageState.json.
  --channel <name>        Browser: chrome or msedge.
  --help                  Show help.
`.trim();

function printHelp() {
  console.log(HELP);
}

function timestamp() {
  return new Date().toLocaleTimeString('zh-CN', { hour12: false });
}

function log(message) {
  console.log(`[${timestamp()}] ${message}`);
}

function logPreamble(message) {
  console.log(message);
}

function logError(message) {
  console.error(`[${timestamp()}] ${message}`);
}

function stage(text) {
  log(text);
}

function formatTimeout(value) {
  return value > 0 ? String(value) : 'off';
}

function isEnabledFlag(value) {
  if (value === true) return true;
  if (value === false || value === undefined || value === null) return false;
  return /^(1|true|yes|on)$/i.test(String(value).trim());
}

function normalizeTitle(value) {
  return cleanArchiveTitle(value);
}

function resolveTargets(args) {
  if (args.url && args['urls-file']) {
    throw new Error('Use either --url or --urls-file, not both.');
  }
  if (args['urls-file']) {
    const urlsFile = path.resolve(String(args['urls-file']));
    const targets = parseQuestionUrlsFromFile(urlsFile);
    if (targets.length === 0) throw new Error(`URL file is empty: ${urlsFile}`);
    return targets;
  }
  return [parseQuestionUrl(args.url)];
}

function resolveOutput(questionId, title, args, multiple) {
  if (!args.output) return defaultArchivePath(questionId, new Date(), title);
  const output = path.resolve(String(args.output));
  if (!multiple) return output;
  if (path.extname(output).toLowerCase() === '.html') {
    throw new Error('--output must be a directory in batch mode, not a single .html file.');
  }
  return path.join(output, path.basename(defaultArchivePath(questionId, new Date(), title)));
}

function createProgressReporter() {
  const printedProgress = new Set();
  return (snapshot, meta = {}) => {
    const progress = formatAutomationProgress(snapshot);
    if (printedProgress.has(progress)) return;
    printedProgress.add(progress);
    const idle = Number.isFinite(snapshot.idleRounds) && snapshot.idleRounds > 0
      ? `, idle rounds: ${snapshot.idleRounds}`
      : '';
    log(`Progress: ${progress}${idle}`);
  };
}

function printArchiveContext(target, options) {
  logPreamble(`Task: question ${target.id}`);
  logPreamble(`URL: ${target.href}`);
  logPreamble(`Options: comments=${options.expandComments ? 'on' : 'off'}, timeout-ms=${formatTimeout(options.timeoutMs)}, settle-ms=${options.settleMs}, progress-interval-ms=${options.progressIntervalMs}`);
  logPreamble(`Options: auth=${options.authFile}, debug=${options.debug ? 'on' : 'off'}`);
  if (options.scrollSpeed !== undefined) logPreamble(`Options: speed=${options.scrollSpeed}`);
  if (options.intervalMs !== undefined) logPreamble(`Options: interval=${options.intervalMs}`);
  if (options.args.output) logPreamble(`Options: output=${options.args.output}`);
  if (options.debugDir) logPreamble(`Options: debug-dir=${options.debugDir}`);
}

async function captureDebugArtifacts(debugDir, page, consoleLines, singleFileResult, error) {
  if (!debugDir) return;
  ensureDir(debugDir);
  writeText(path.join(debugDir, 'console.log'), `${consoleLines.join('\n')}\n`);
  writeText(path.join(debugDir, 'singlefile.stdout.log'), singleFileResult?.stdout || error?.stdout || '');
  writeText(path.join(debugDir, 'singlefile.stderr.log'), singleFileResult?.stderr || error?.stderr || '');
  if (error) writeText(path.join(debugDir, 'error.txt'), `${error.stack || error.message || error}\n`);
  if (page && !page.isClosed()) {
    await page.screenshot({ path: path.join(debugDir, 'screenshot.png'), fullPage: true }).catch(() => {});
  }
}

async function assertUsableQuestionPage(page, questionId) {
  const currentUrl = page.url();
  const state = await page.evaluate(() => ({
    bodyText: document.body?.innerText || '',
    hasQuestion: Boolean(document.querySelector('.QuestionHeader, .Question-main, .QuestionAnswer-content, .AnswerItem')),
    hasSignFlow: Boolean(document.querySelector('.SignFlow, .Login-content')),
  })).catch(() => ({ bodyText: '', hasQuestion: false, hasSignFlow: false }));
  if (/验证码|安全验证|人机验证|验证你是真人|异常流量|请求存在异常|暂时限制|40362/.test(state.bodyText)) {
    throw new Error(`Zhihu CAPTCHA or anti-bot verification is required. Current page: ${currentUrl}`);
  }
  if (/signin|login/i.test(currentUrl) || state.hasSignFlow || (!state.hasQuestion && /登录知乎|注册\/登录/.test(state.bodyText))) {
    throw new Error(`Auth state is expired. Current page: ${currentUrl}`);
  }
  if (questionIdFromUrl(currentUrl) !== questionId) {
    throw new Error(`Failed to open the target question page. Current page: ${currentUrl}`);
  }
}

async function runArchiveJob(browser, target, options) {
  const consoleLines = [];
  let context = null;
  let ownsContext = true;
  let page = null;
  let singleFileResult = null;
  let output = null;
  const startedAt = Date.now();
  let saveStartedAt = 0;
  try {
    printArchiveContext(target, options);
    stage('1/6 Open page');
    if (options.context) {
      context = options.context;
      ownsContext = false;
    } else {
      context = await browser.newContext(zhihuContextOptions({ storageState: options.authFile }));
    }
    page = await context.newPage();
    page.on('console', message => {
      consoleLines.push(`${message.type()}: ${message.text()}`);
    });
    page.on('pageerror', error => {
      consoleLines.push(`pageerror: ${error.message}`);
    });

    await page.goto(target.href, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await assertUsableQuestionPage(page, target.id);

    stage('2/6 Inject userscript');
    await injectUserscript(page);

    stage(options.expandComments ? '3/6 Scroll, expand answers, and open comments' : '3/6 Scroll and expand answers');
    await configureAndStart(page, {
      expandComments: options.expandComments,
      scrollSpeed: options.scrollSpeed,
      intervalMs: options.intervalMs,
    });
    const snapshot = await waitForAutomationDone(page, {
      timeoutMs: options.timeoutMs,
      settleMs: options.settleMs,
      onProgress: createProgressReporter(),
      progressIntervalMs: options.progressIntervalMs,
    });
    if (snapshot.completionStatus === 'auth-blocked') {
      throw new Error(`Zhihu requires login or verification: ${snapshot.completionReason || 'auth-blocked'}`);
    }
    if (snapshot.completionStatus === 'error') {
      throw new Error(`Page script failed: ${snapshot.completionReason || 'error'}`);
    }

    const pageTitle = normalizeTitle(await page.title().catch(() => ''));
    output = resolveOutput(target.id, pageTitle, options.args, options.multiple);
    ensureDir(path.dirname(output));

    stage('4/6 Prepare output');

    stage(`5/6 Save current page with SingleFile: ${output}`);
    saveStartedAt = Date.now();
    singleFileResult = await savePageWithSingleFile(page, output, {
      output,
      timeoutMs: options.timeoutMs,
    });
    const saveMs = Date.now() - saveStartedAt;

    stage('6/6 Done');
    const fileSize = fs.statSync(output).size;
    const summary = {
      ok: true,
      output,
      answerCount: snapshot.answerCount,
      totalAnswerCount: snapshot.totalAnswerCount,
      completionStatus: snapshot.completionStatus,
      completionReason: snapshot.completionReason,
      fileSize,
      saveMs,
      totalMs: Date.now() - startedAt,
    };
    printSummary(summary);
    await captureDebugArtifacts(options.debugDir, page, consoleLines, singleFileResult, null);
    return summary;
  } catch (error) {
    const classified = classifyArchiveError(error, { currentUrl: page?.url() });
    const wrapped = Object.assign(error, { archiveCode: classified.code, archiveMessage: classified.message });
    await captureDebugArtifacts(options.debugDir, page, consoleLines, singleFileResult, wrapped);
    logError(`Failed: ${classified.message}`);
    return { ok: false, url: target.href, code: classified.code, message: classified.message };
  } finally {
    if (ownsContext) await context?.close().catch(() => {});
    else await page?.close().catch(() => {});
  }
}

function printSummary(summary) {
  const total = summary.totalAnswerCount ?? '?';
  log('Summary:');
  log(`- Answers: ${summary.answerCount}/${total}`);
  log(`- Completion reason: ${summary.completionStatus} (${summary.completionReason})`);
  log(`- File size: ${formatBytes(summary.fileSize)}`);
  log(`- Save time: ${(summary.saveMs / 1000).toFixed(1)}s`);
  log(`- Total time: ${(summary.totalMs / 1000).toFixed(1)}s`);
  log(`- Output file: ${summary.output}`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === true || args.h === true) {
    printHelp();
    return;
  }

  const targets = resolveTargets(args);
  const authFile = path.resolve(String(args.auth || AUTH_FILE));
  if (!fileExists(authFile)) {
    throw new Error(`Missing auth state file: ${authFile}\nRun zhihu login first.`);
  }

  const debug = args.debug === true;
  const multiple = targets.length > 1;
  const debugRoot = args['debug-dir']
    ? path.resolve(args['debug-dir'] === true ? defaultDebugDir() : String(args['debug-dir']))
    : (debug ? defaultDebugDir() : null);
  if (debugRoot) ensureDir(debugRoot);

  const browserProfileDir = createBrowserProfileTempDir('zhihu-archive-profile');
  const launched = await launchNativeBrowserSession({
    channel: args.channel,
    url: 'about:blank',
    profileDir: browserProfileDir,
  });
  const { browser, context } = launched;
  logPreamble(`Browser: ${launched.label}`);
  logPreamble(`Target count: ${targets.length}`);
  await hydrateContextFromStorageState(context, authFile);
  const options = {
    args,
    authFile,
    multiple,
    context,
    debug,
    expandComments: isEnabledFlag(args.comments) || isEnabledFlag(args['expand-comments']) || isEnabledFlag(args['open-comments']),
    scrollSpeed: toOptionalNumber(args.speed),
    intervalMs: toOptionalNumber(args.interval),
    progressIntervalMs: toPositiveInt(args['progress-interval-ms'], 3000),
    timeoutMs: toPositiveInt(args['timeout-ms'], DEFAULT_TIMEOUT_MS),
    settleMs: toPositiveInt(args['settle-ms'], DEFAULT_SETTLE_MS),
  };

  try {
    const results = [];
    for (let index = 0; index < targets.length; index++) {
      const target = targets[index];
      const jobDebugDir = debugRoot
        ? path.join(debugRoot, multiple ? `question-${target.id}-${index + 1}` : '')
        : null;
      results.push(await runArchiveJob(browser, target, {
        ...options,
        debugDir: jobDebugDir,
      }));
    }
    const failed = results.filter(result => !result.ok);
    if (multiple) {
      log(`Batch archive complete: succeeded ${results.length - failed.length}, failed ${failed.length}`);
    }
    if (failed.length > 0) process.exitCode = 1;
  } finally {
    await launched.close();
    try {
      fs.rmSync(browserProfileDir, { recursive: true, force: true });
    } catch {}
  }
}

if (require.main === module) {
  main().catch(error => {
    const classified = classifyArchiveError(error);
    logError(classified.message);
    process.exitCode = 1;
  });
}

module.exports = {
  createProgressReporter,
  isEnabledFlag,
};
