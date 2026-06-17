const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const PACKAGE_DIR = path.join(__dirname, '..');
const ROOT_DIR = process.cwd();
const AUTH_DIR = path.join(ROOT_DIR, '.auth');
const AUTH_FILE = path.join(AUTH_DIR, 'zhihu.storageState.json');
const ARCHIVES_DIR = path.join(ROOT_DIR, 'archives');
const TEST_RESULTS_DIR = path.join(ROOT_DIR, 'test-results');
const USER_SCRIPT_FILE = path.join(PACKAGE_DIR, 'zhihu-auto-scroll.js');
const SINGLE_FILE_SCRIPT_FILE = path.join(PACKAGE_DIR, 'node_modules', 'single-file-cli', 'lib', 'single-file-script.js');
const LOGIN_URL = 'https://www.zhihu.com/signin?next=%2F';
const DEFAULT_TIMEOUT_MS = 0;
const DEFAULT_SETTLE_MS = 1500;
const SINGLE_FILE_WRITE_CHUNK_SIZE = 1024 * 1024;
const DEFAULT_VIEWPORT = { width: 1280, height: 900 };
const SYSTEM_BROWSER_CHANNELS = ['chrome', 'msedge'];
const DISABLE_BACKGROUND_THROTTLING_ARGS = [
  '--disable-background-timer-throttling',
  '--disable-backgrounding-occluded-windows',
  '--disable-renderer-backgrounding',
  '--disable-features=CalculateNativeWinOcclusion',
];
const BROWSER_CANDIDATES = {
  chrome: [
    ['LOCALAPPDATA', 'Google\\Chrome\\Application\\chrome.exe'],
    ['PROGRAMFILES', 'Google\\Chrome\\Application\\chrome.exe'],
    ['PROGRAMFILES(X86)', 'Google\\Chrome\\Application\\chrome.exe'],
  ],
  msedge: [
    ['PROGRAMFILES(X86)', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['PROGRAMFILES', 'Microsoft\\Edge\\Application\\msedge.exe'],
    ['LOCALAPPDATA', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ],
};
let singleFileScriptSourcePromise = null;

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
  if (!value) throw new Error('Missing --url, for example: zhihu archive --url https://www.zhihu.com/question/123');
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`Invalid URL: ${value}`);
  }
  if (url.protocol !== 'https:' || url.hostname !== 'www.zhihu.com') {
    throw new Error('Only https://www.zhihu.com/question/... question URLs are supported.');
  }
  const id = questionIdFromUrl(url.href);
  if (!id) throw new Error('Only Zhihu question URLs are supported, for example: https://www.zhihu.com/question/123');
  url.pathname = `/question/${id}`;
  return { href: url.href, id };
}

function questionIdFromUrl(value) {
  try {
    return new URL(value).pathname.match(/^\/question\/(\d+)/)?.[1] || null;
  } catch {
    return null;
  }
}

function parseQuestionUrlsFromFile(file) {
  const source = fs.readFileSync(file, 'utf8');
  return source
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !line.startsWith('#'))
    .map(line => parseQuestionUrl(line));
}

function timestampForFilename(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z').replace(/[:.]/g, '-');
}

function safeTitleForFilename(value, maxLength = 80) {
  const normalized = String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[\\/:*?"<>|：？]/g, '-')
    .replace(/[\u0000-\u001f]/g, '')
    .replace(/[\s-]+/g, '-')
    .replace(/^-|-$/g, '');
  return normalized.slice(0, maxLength).replace(/-+$/g, '');
}

function cleanArchiveTitle(value) {
  return String(value || '')
    .replace(/\s+-\s+知乎$/, '')
    .replace(/^知乎\s+-\s+/, '')
    .replace(/^\(\s*\d+\s*封私信\s*(?:\/|｜|-)?\s*\d+\s*条消息\s*\)\s*/, '')
    .trim();
}

function defaultArchivePath(questionId, date = new Date(), title = '') {
  const safeTitle = safeTitleForFilename(cleanArchiveTitle(title) || questionId || 'zhihu-archive');
  return path.join(ARCHIVES_DIR, `${safeTitle}.html`);
}

function toPositiveInt(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.round(parsed) : fallback;
}

function toOptionalNumber(value) {
  if (value === undefined || value === null || value === '') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function normalizeBrowserChannel(value) {
  if (value === undefined || value === null || value === '' || value === true) return null;
  const channel = String(value).trim().toLowerCase();
  if (channel === 'chromium') return 'chromium';
  if (SYSTEM_BROWSER_CHANNELS.includes(channel)) return channel;
  throw new Error('Unsupported browser channel. Supported values: chrome, msedge, chromium.');
}

function browserChannelLabel(channel) {
  if (channel === 'chrome') return 'Google Chrome';
  if (channel === 'msedge') return 'Microsoft Edge';
  return 'Playwright Chromium';
}

function resolveBrowserExecutable(channel) {
  const normalized = normalizeBrowserChannel(channel);
  if (normalized === 'chromium') {
    throw new Error('Native browser sessions only support chrome or msedge.');
  }
  const channels = normalized ? [normalized] : SYSTEM_BROWSER_CHANNELS;
  for (const candidate of channels) {
    for (const [envName, suffix] of BROWSER_CANDIDATES[candidate]) {
      const base = process.env[envName];
      if (!base) continue;
      const executable = path.join(base, suffix);
      if (fileExists(executable)) return { channel: candidate, executable, label: browserChannelLabel(candidate) };
    }
  }
  throw new Error('No local Chrome or Edge installation was found. Install one and try again.');
}

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

async function waitForCdpEndpoint(port, timeoutMs = 15000) {
  const startedAt = Date.now();
  const endpoint = `http://127.0.0.1:${port}/json/version`;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(endpoint);
      if (response.ok) {
        const data = await response.json();
        if (data.webSocketDebuggerUrl) return data.webSocketDebuggerUrl;
      }
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('The browser DevTools endpoint did not start in time.');
}

function loginProfileDir(channel = 'chrome') {
  const normalized = normalizeBrowserChannel(channel) || 'chrome';
  if (normalized === 'chromium') throw new Error('Login profiles only support chrome or msedge.');
  return path.join(AUTH_DIR, `zhihu-login-${normalized}-profile`);
}

function createBrowserProfileTempDir(prefix = 'zhihu-browser-profile') {
  ensureDir(AUTH_DIR);
  return fs.mkdtempSync(path.join(AUTH_DIR, `${prefix}.${timestampForFilename()}.`));
}

async function launchNativeBrowserSession(options = {}) {
  const selected = resolveBrowserExecutable(options.channel);
  const port = await getFreePort();
  const profileDir = options.profileDir || loginProfileDir(selected.channel);
  ensureDir(profileDir);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-popup-blocking',
    ...DISABLE_BACKGROUND_THROTTLING_ARGS,
  ];
  if (options.url) {
    args.push('--new-window', options.url);
  } else {
    args.push('about:blank');
  }
  const child = spawn(selected.executable, args, {
    detached: false,
    stdio: 'ignore',
  });
  const wsEndpoint = await waitForCdpEndpoint(port);
  const browser = await require('playwright').chromium.connectOverCDP(wsEndpoint);
  return {
    ...selected,
    profileDir,
    browser,
    child,
    context: browser.contexts()[0],
    async close() {
      await browser.close().catch(() => {});
      if (!child.killed) child.kill();
    },
  };
}

async function launchDesktopBrowser(options = {}) {
  const requested = normalizeBrowserChannel(options.channel);
  const candidates = requested
    ? [requested]
    : (options.preferSystem ? [...SYSTEM_BROWSER_CHANNELS, 'chromium'] : ['chromium']);
  let lastError = null;
  for (const channel of candidates) {
    try {
      const launchOptions = { headless: options.headless !== false };
      if (channel !== 'chromium') launchOptions.channel = channel;
      const browser = await require('playwright').chromium.launch(launchOptions);
      return { browser, channel, label: browserChannelLabel(channel) };
    } catch (error) {
      lastError = error;
      if (requested) break;
    }
  }
  throw lastError || new Error('Unable to launch a browser.');
}

function zhihuContextOptions(options = {}) {
  const result = {
    viewport: DEFAULT_VIEWPORT,
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
  };
  if (options.storageState) result.storageState = options.storageState;
  return result;
}

async function injectUserscript(page) {
  const source = fs.readFileSync(USER_SCRIPT_FILE, 'utf8');
  await page.evaluate(scriptSource => {
    window.__ZAE_AUTOMATION__ = true;
    window.eval(scriptSource);
  }, source);
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
  let progressTimer = null;
  let progressInFlight = false;
  const progressIntervalMs = toPositiveInt(options.progressIntervalMs, 3000);
  const readProgress = async force => {
    if (progressInFlight || typeof options.onProgress !== 'function') return;
    progressInFlight = true;
    try {
      const snapshot = await page.evaluate(() => window.zhihuAutoExpand?.snapshot || null);
      if (snapshot) options.onProgress(snapshot, { force: force === true });
    } catch {
      // The page can be closing while debug artifacts are captured.
    } finally {
      progressInFlight = false;
    }
  };
  await page.waitForFunction(
    () => window.zhihuAutoExpand?.snapshot?.completionStatus === 'running',
    null,
    { timeout: 5000 }
  ).catch(() => {});
  await readProgress(true);
  if (typeof options.onProgress === 'function') {
    progressTimer = setInterval(() => {
      readProgress(false);
    }, progressIntervalMs);
  }
  try {
    await page.waitForFunction(
      () => {
        const status = window.zhihuAutoExpand?.snapshot?.completionStatus;
        return status && status !== 'running' && status !== 'paused';
      },
      null,
      { timeout: timeoutMs }
    );
    await readProgress(true);
    await page.waitForTimeout(toPositiveInt(options.settleMs, DEFAULT_SETTLE_MS));
    const snapshot = await page.evaluate(() => window.zhihuAutoExpand.snapshot);
    if (typeof options.onProgress === 'function') options.onProgress(snapshot, { force: true });
    return snapshot;
  } finally {
    if (progressTimer) clearInterval(progressTimer);
  }
}

function defaultDebugDir(date = new Date()) {
  return path.join(TEST_RESULTS_DIR, `zhihu-archive-${timestampForFilename(date)}`);
}

function formatBytes(value) {
  if (!Number.isFinite(value) || value < 0) return 'unknown';
  if (value < 1024) return `${value} B`;
  const units = ['KB', 'MB', 'GB'];
  let size = value / 1024;
  for (const unit of units) {
    if (size < 1024 || unit === 'GB') return `${size.toFixed(size >= 10 ? 1 : 2)} ${unit}`;
    size /= 1024;
  }
  return `${value} B`;
}

function formatAutomationProgress(snapshot = {}) {
  const answerCount = Number.isFinite(snapshot.answerCount) ? snapshot.answerCount : 0;
  const totalAnswerCount = Number.isFinite(snapshot.totalAnswerCount) ? snapshot.totalAnswerCount : '?';
  return `${answerCount}/${totalAnswerCount}`;
}

function classifyArchiveError(error, details = {}) {
  const currentUrl = String(details.url || details.currentUrl || '');
  const message = String(error?.message || error || '');
  const combined = `${currentUrl}\n${message}\n${error?.stderr || ''}`;
  if (/captcha|验证|安全验证|人机|unusual traffic|verify|请求存在异常|暂时限制|40362/i.test(combined)) {
    return {
      code: 'anti-bot',
      message: 'Zhihu triggered CAPTCHA or anti-bot verification. Use --headed or --debug and handle it manually.',
    };
  }
  if (/signin|login|登录|z_c0|storageState/i.test(combined)) {
    return {
      code: 'auth-expired',
      message: 'Auth state is unavailable or expired. Run zhihu login again.',
    };
  }
  if (/waitForAutomationDone|Zhihu automation|page\.waitForFunction/i.test(combined)) {
    return {
      code: 'automation-timeout',
      message: 'Page automation timed out. Increase --timeout-ms, omit --timeout-ms for no limit, or use --debug-dir to inspect screenshots and console logs.',
    };
  }
  if (/SingleFile|browser-capture-max-time|Timed out|timeout|超时/i.test(combined)) {
    return {
      code: 'singlefile-timeout',
      message: 'SingleFile save timed out. Increase --timeout-ms, omit --timeout-ms for no limit, or use --debug-dir to inspect stdout/stderr.',
    };
  }
  return {
    code: 'error',
    message: message || 'Archive failed for an unknown reason.',
  };
}

async function hydrateContextFromStorageState(context, storageStateFile = AUTH_FILE) {
  const storageState = JSON.parse(fs.readFileSync(storageStateFile, 'utf8'));
  if (Array.isArray(storageState.cookies) && storageState.cookies.length > 0) {
    await context.addCookies(storageState.cookies);
  }
  for (const originState of storageState.origins || []) {
    if (!originState.origin || !Array.isArray(originState.localStorage) || originState.localStorage.length === 0) {
      continue;
    }
    const page = await context.newPage();
    try {
      await page.goto(originState.origin, { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.evaluate(entries => {
        for (const entry of entries) {
          try {
            localStorage.setItem(entry.name, entry.value);
          } catch {}
        }
      }, originState.localStorage);
    } finally {
      await page.close().catch(() => {});
    }
  }
  return storageState;
}

function writeJson(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(file, value) {
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, String(value || ''));
}

async function loadSingleFileScriptSource() {
  if (!singleFileScriptSourcePromise) {
    singleFileScriptSourcePromise = import(pathToFileURL(SINGLE_FILE_SCRIPT_FILE).href)
      .then(module => module.getScriptSource({}));
  }
  return singleFileScriptSourcePromise;
}

async function savePageWithSingleFile(page, output, options = {}) {
  ensureDir(path.dirname(output));
  const tempOutput = `${output}.tmp-${process.pid}-${Date.now()}`;
  const bindingName = `__zhihuWriteSingleFileChunk_${process.pid}_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  fs.writeFileSync(tempOutput, '');
  await page.exposeFunction('__singleFileFetch', async requestJson => {
    const request = JSON.parse(requestJson);
    try {
      const response = await fetch(request.url);
      const data = Buffer.from(await response.arrayBuffer()).toString('base64');
      await page.evaluate(({ requestId, result }) => {
        globalThis.__singleFileResolveFetch(requestId, result);
      }, {
        requestId: request.requestId,
        result: {
          status: response.status,
          headers: Array.from(response.headers.entries()),
          data,
        },
      });
    } catch (error) {
      await page.evaluate(({ requestId, result }) => {
        globalThis.__singleFileRejectFetch(requestId, result);
      }, {
        requestId: request.requestId,
        result: {
          error: error?.message || String(error),
        },
      });
    }
  });
  await page.exposeFunction(bindingName, chunk => {
    fs.appendFileSync(tempOutput, chunk);
  });
  try {
    const source = await loadSingleFileScriptSource();
    await page.evaluate(scriptSource => {
      if (!globalThis.singlefile?.getPageData) {
        globalThis.eval(scriptSource);
      }
    }, source);
    const result = await page.evaluate(async ({ bindingName, chunkSize, singleFileOptions }) => {
      const pageData = await globalThis.singlefile.getPageData(singleFileOptions);
      let content = pageData.content;
      if (content instanceof Uint8Array) {
        content = new TextDecoder().decode(content);
      }
      if (typeof content !== 'string') content = String(content || '');
      for (let index = 0; index < content.length; index += chunkSize) {
        await globalThis[bindingName](content.slice(index, index + chunkSize));
      }
      return { contentLength: content.length };
    }, {
      bindingName,
      chunkSize: SINGLE_FILE_WRITE_CHUNK_SIZE,
      singleFileOptions: {
        loadDeferredImages: true,
        loadDeferredImagesMaxIdleTime: 1500,
        compressHTML: true,
        removeHiddenElements: true,
        removeUnusedStyles: true,
        removeUnusedFonts: true,
        removeAlternativeFonts: true,
        removeAlternativeMedias: true,
        removeAlternativeImages: true,
        removeNoScriptTags: true,
        groupDuplicateImages: true,
        ...(options.singleFileOptions || {}),
        blockScripts: true,
        insertMetaCSP: true,
      },
    });
    fs.rmSync(output, { force: true });
    fs.renameSync(tempOutput, output);
    return { stdout: '', stderr: '', ...result };
  } catch (error) {
    fs.rmSync(tempOutput, { force: true });
    throw error;
  }
}

module.exports = {
  PACKAGE_DIR,
  ROOT_DIR,
  AUTH_DIR,
  AUTH_FILE,
  ARCHIVES_DIR,
  TEST_RESULTS_DIR,
  LOGIN_URL,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_SETTLE_MS,
  DEFAULT_VIEWPORT,
  SINGLE_FILE_WRITE_CHUNK_SIZE,
  parseArgs,
  ensureDir,
  fileExists,
  parseQuestionUrl,
  questionIdFromUrl,
  parseQuestionUrlsFromFile,
  timestampForFilename,
  safeTitleForFilename,
  cleanArchiveTitle,
  defaultArchivePath,
  toPositiveInt,
  toOptionalNumber,
  normalizeBrowserChannel,
  browserChannelLabel,
  resolveBrowserExecutable,
  loginProfileDir,
  createBrowserProfileTempDir,
  launchNativeBrowserSession,
  launchDesktopBrowser,
  zhihuContextOptions,
  injectUserscript,
  configureAndStart,
  waitForAutomationDone,
  defaultDebugDir,
  formatBytes,
  formatAutomationProgress,
  classifyArchiveError,
  hydrateContextFromStorageState,
  writeJson,
  writeText,
  loadSingleFileScriptSource,
  savePageWithSingleFile,
};
