const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT_DIR = path.join(__dirname, '..');
const AUTH_DIR = path.join(ROOT_DIR, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'zhihu.storageState.json');
const ARCHIVES_DIR = path.join(ROOT_DIR, 'archives');
const USER_SCRIPT_FILE = path.join(ROOT_DIR, 'zhihu-auto-scroll.js');
const SINGLE_FILE_BIN = path.join(ROOT_DIR, 'node_modules', 'single-file-cli', 'single-file-node.js');
const LOGIN_URL = 'https://www.zhihu.com/signin?next=%2F';
const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000;
const DEFAULT_SETTLE_MS = 1500;

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index++) {
    const token = argv[index];
    if (!token.startsWith('--')) {
      if (!args._) args._ = [];
      args._.push(token);
      continue;
    }
    const raw = token.slice(2);
    const equalsAt = raw.indexOf('=');
    if (equalsAt >= 0) {
      args[raw.slice(0, equalsAt)] = raw.slice(equalsAt + 1);
      continue;
    }
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) {
      args[raw] = true;
      continue;
    }
    args[raw] = next;
    index++;
  }
  return args;
}

function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function fileExists(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

function parseQuestionUrl(value) {
  if (!value) throw new Error('缺少 --url，例如 npm run zhihu:archive -- --url https://www.zhihu.com/question/123');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`不是有效 URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhihu.com') {
    throw new Error('只支持 https://www.zhihu.com/question/... 问题页 URL');
  }
  const id = questionIdFromUrl(url.href);
  if (!id) throw new Error('只支持知乎问题页 URL，例如 https://www.zhihu.com/question/123');
  return { href: url.href, id };
}

function questionIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/^\/question\/(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
}

function defaultArchivePath(questionId, date = new Date()) {
  return path.join(ARCHIVES_DIR, `zhihu-question-${questionId}-${timestampForFilename(date)}.html`);
}

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : fallback;
}

function toOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

async function injectUserscript(page) {
  await page.evaluate(() => {
    window.__ZAE_AUTOMATION__ = true;
  });
  await page.addScriptTag({ path: USER_SCRIPT_FILE });
  await page.waitForFunction(
    () => window.zhihuAutoExpand && typeof window.zhihuAutoExpand.start === 'function',
    null,
    { timeout: 15000 }
  );
}

async function configureAndStart(page, options = {}) {
  await page.evaluate(({ expandComments, scrollSpeed, intervalMs }) => {
    const api = window.zhihuAutoExpand;
    if (!api) throw new Error('zhihuAutoExpand automation API is not available');
    if (scrollSpeed !== undefined) api.setScrollSpeed(scrollSpeed);
    if (intervalMs !== undefined) api.setIntervalMs(intervalMs);
    if (expandComments !== undefined && api.snapshot.expandComments !== expandComments) {
      api.toggleExpandComments();
    }
    api.start();
  }, {
    expandComments: options.expandComments,
    scrollSpeed: options.scrollSpeed,
    intervalMs: options.intervalMs,
  });
}

async function waitForAutomationDone(page, options = {}) {
  const timeoutMs = toPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS);
  await page.waitForFunction(
    () => window.zhihuAutoExpand?.snapshot?.state === 'running',
    null,
    { timeout: 5000 }
  ).catch(() => {});
  await page.waitForFunction(
    () => window.zhihuAutoExpand?.snapshot?.state === 'paused',
    null,
    { timeout: timeoutMs }
  );
  await page.waitForTimeout(toPositiveInt(options.settleMs, DEFAULT_SETTLE_MS));
  return page.evaluate(() => window.zhihuAutoExpand.snapshot);
}

function normalizeCookiesForSingleFile(cookies) {
  return cookies.map(cookie => {
    const result = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path || '/',
      secure: Boolean(cookie.secure),
      httpOnly: Boolean(cookie.httpOnly),
      sameSite: cookie.sameSite,
    };
    if (Number.isFinite(cookie.expires) && cookie.expires > 0) result.expires = cookie.expires;
    return result;
  });
}

function getLocalStorageEntries(storageState, origin) {
  const matched = storageState.origins?.find(entry => entry.origin === origin);
  return matched?.localStorage || [];
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeSingleFileBootstrap(file, options = {}) {
  ensureDir(path.dirname(file));
  const config = {
    expandComments: options.expandComments,
    scrollSpeed: options.scrollSpeed,
    intervalMs: options.intervalMs,
    timeoutMs: toPositiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS),
    settleMs: toPositiveInt(options.settleMs, DEFAULT_SETTLE_MS),
    localStorage: options.localStorage || [],
  };
  const source = `
(() => {
  const config = ${JSON.stringify(config)};
  globalThis.__ZAE_AUTOMATION__ = true;
  for (const entry of config.localStorage) {
    try {
      localStorage.setItem(entry.name, entry.value);
    } catch {}
  }
  const singlefile = globalThis.singlefile;
  const originalGetPageData = singlefile && singlefile.getPageData && singlefile.getPageData.bind(singlefile);
  if (!originalGetPageData) return;
  singlefile.getPageData = async options => {
    await waitFor(() => globalThis.zhihuAutoExpand && typeof globalThis.zhihuAutoExpand.start === "function", 15000);
    const api = globalThis.zhihuAutoExpand;
    if (config.scrollSpeed !== undefined) api.setScrollSpeed(config.scrollSpeed);
    if (config.intervalMs !== undefined) api.setIntervalMs(config.intervalMs);
    if (config.expandComments !== undefined && api.snapshot.expandComments !== config.expandComments) {
      api.toggleExpandComments();
    }
    api.start();
    await waitFor(() => api.snapshot.state === "running", 5000).catch(() => {});
    await waitFor(() => api.snapshot.state === "paused", config.timeoutMs);
    await sleep(config.settleMs);
    return originalGetPageData(options);
  };

  function sleep(delay) {
    return new Promise(resolve => setTimeout(resolve, delay));
  }

  function waitFor(predicate, timeout) {
    const startedAt = Date.now();
    return new Promise((resolve, reject) => {
      const timer = setInterval(() => {
        try {
          if (predicate()) {
            clearInterval(timer);
            resolve();
          } else if (Date.now() - startedAt > timeout) {
            clearInterval(timer);
            reject(new Error("Timed out waiting for Zhihu automation"));
          }
        } catch (error) {
          clearInterval(timer);
          reject(error);
        }
      }, 250);
    });
  }
})();
`;
  fs.writeFileSync(file, source.trimStart());
}

function runSingleFile(options) {
  return new Promise((resolve, reject) => {
    const args = [
      SINGLE_FILE_BIN,
      options.url,
      options.output,
      '--browser-cookies-file',
      options.cookiesFile,
      '--browser-script',
      options.bootstrapFile,
      '--browser-script',
      USER_SCRIPT_FILE,
      `--browser-headless=${options.headless !== false}`,
      '--browser-load-max-time',
      String(toPositiveInt(options.loadTimeoutMs, 120000)),
      '--browser-capture-max-time',
      String(toPositiveInt(options.captureTimeoutMs, options.timeoutMs || DEFAULT_TIMEOUT_MS)),
      '--browser-wait-until',
      'networkAlmostIdle',
      '--block-scripts=false',
    ];
    if (options.debug) args.push('--browser-debug=true');

    const child = spawn(process.execPath, args, {
      cwd: ROOT_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        const error = new Error(`SingleFile 保存失败，退出码 ${code}${stderr ? `: ${stderr.trim()}` : ''}`);
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      }
    });
  });
}

module.exports = {
  ROOT_DIR,
  AUTH_DIR,
  AUTH_FILE,
  ARCHIVES_DIR,
  LOGIN_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SETTLE_MS,
  parseArgs,
  ensureDir,
  fileExists,
  parseQuestionUrl,
  questionIdFromUrl,
  timestampForFilename,
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
};
