const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  PACKAGE_DIR,
  ROOT_DIR,
  DEFAULT_TIMEOUT_MS,
  parseArgs,
  parseQuestionUrl,
  questionIdFromUrl,
  parseQuestionUrlsFromFile,
  timestampForFilename,
  safeTitleForFilename,
  cleanArchiveTitle,
  defaultArchivePath,
  formatBytes,
  formatAutomationProgress,
  classifyArchiveError,
  toPositiveInt,
  normalizeBrowserChannel,
  browserChannelLabel,
  zhihuContextOptions,
  hydrateContextFromStorageState,
  savePageWithSingleFile,
} = require('../scripts/zhihu-automation');

test('keeps package assets separate from the runtime working directory', () => {
  assert.equal(PACKAGE_DIR, path.join(__dirname, '..'));
  assert.equal(ROOT_DIR, process.cwd());
});

test('parses archive command arguments', () => {
  assert.deepEqual(parseArgs(['--url', 'https://www.zhihu.com/question/123', '--headed', '--speed=4']), {
    url: 'https://www.zhihu.com/question/123',
    headed: true,
    speed: '4',
  });
});

test('normalizes browser channel options for CLI launches', () => {
  assert.equal(normalizeBrowserChannel(undefined), null);
  assert.equal(normalizeBrowserChannel('Chrome'), 'chrome');
  assert.equal(normalizeBrowserChannel('msedge'), 'msedge');
  assert.equal(normalizeBrowserChannel('chromium'), 'chromium');
  assert.equal(browserChannelLabel('chrome'), 'Google Chrome');
  assert.throws(() => normalizeBrowserChannel('firefox'), /Unsupported/);
});

test('builds zhihu browser context defaults', () => {
  assert.deepEqual(zhihuContextOptions({ storageState: 'state.json' }), {
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN',
    timezoneId: 'Asia/Shanghai',
    extraHTTPHeaders: {
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    storageState: 'state.json',
  });
});

test('accepts only zhihu question URLs', () => {
  assert.deepEqual(parseQuestionUrl('https://www.zhihu.com/question/123?sort=created'), {
    href: 'https://www.zhihu.com/question/123?sort=created',
    id: '123',
  });
  assert.deepEqual(parseQuestionUrl('https://www.zhihu.com/question/33028679/answer/1962058612538081786'), {
    href: 'https://www.zhihu.com/question/33028679',
    id: '33028679',
  });
  assert.equal(questionIdFromUrl('https://www.zhihu.com/question/456/answer/789'), '456');
  assert.throws(() => parseQuestionUrl('https://example.com/question/123'), /Only/);
  assert.throws(() => parseQuestionUrl('https://www.zhihu.com/people/example'), /question URLs/);
});

test('builds safe default archive filenames', () => {
  const date = new Date('2026-06-16T12:34:56.789Z');
  assert.equal(timestampForFilename(date), '2026-06-16T12-34-56Z');
  assert.equal(safeTitleForFilename(' 问题 / 标题：A? B '), '问题-标题-A-B');
  assert.equal(cleanArchiveTitle('(81 封私信 / 9 条消息) 你见过哪些令人拍案叫绝的科幻设定 - 知乎'), '你见过哪些令人拍案叫绝的科幻设定');
  assert.equal(
    path.basename(defaultArchivePath('123', date)),
    '123.html'
  );
  assert.equal(
    path.basename(defaultArchivePath('123', date, '如何看待知乎自动展开？ - 知乎')),
    '如何看待知乎自动展开.html'
  );
  assert.equal(
    path.basename(defaultArchivePath('286130359', date, '(81 封私信 / 9 条消息) 你见过哪些令人拍案叫绝的科幻设定 - 知乎')),
    '你见过哪些令人拍案叫绝的科幻设定.html'
  );
});

test('reads batch question URL files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-urls-'));
  const file = path.join(dir, 'questions.txt');
  fs.writeFileSync(file, '# comment\n\nhttps://www.zhihu.com/question/123\nhttps://www.zhihu.com/question/456?sort=created\n');
  assert.deepEqual(parseQuestionUrlsFromFile(file), [
    { href: 'https://www.zhihu.com/question/123', id: '123' },
    { href: 'https://www.zhihu.com/question/456?sort=created', id: '456' },
  ]);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('formats archive summary values and classifies common failures', () => {
  assert.equal(formatBytes(512), '512 B');
  assert.equal(formatBytes(2048), '2.00 KB');
  assert.equal(formatAutomationProgress({ answerCount: 1, totalAnswerCount: 502 }), '1/502');
  assert.equal(formatAutomationProgress({ answerCount: 3, totalAnswerCount: null }), '3/?');
  assert.equal(classifyArchiveError(new Error('登录态失效')).code, 'auth-expired');
  assert.equal(classifyArchiveError(new Error('Timed out waiting for SingleFile')).code, 'singlefile-timeout');
  assert.equal(classifyArchiveError(new Error('安全验证')).code, 'anti-bot');
});

test('uses no archive timeout by default', () => {
  assert.equal(DEFAULT_TIMEOUT_MS, 0);
  assert.equal(toPositiveInt(undefined, DEFAULT_TIMEOUT_MS), 0);
  assert.equal(toPositiveInt('0', 123), 0);
});

test('hydrates native browser context from saved storage state', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-state-'));
  const file = path.join(dir, 'state.json');
  fs.writeFileSync(file, JSON.stringify({
    cookies: [{ name: 'z_c0', value: 'token', domain: '.zhihu.com', path: '/', expires: 1790000000 }],
    origins: [],
  }));
  const calls = [];
  await hydrateContextFromStorageState({
    async addCookies(cookies) {
      calls.push(cookies);
    },
  }, file);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0].name, 'z_c0');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('saves static SingleFile output with scripts blocked', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihu-singlefile-'));
  const output = path.join(dir, 'archive.html');
  const exposed = {};
  let capturedOptions = null;
  const page = {
    async exposeFunction(name, callback) {
      exposed[name] = callback;
    },
    async evaluate(callback, value) {
      if (value?.singleFileOptions) {
        capturedOptions = value.singleFileOptions;
        await exposed[value.bindingName]('<html><body>saved</body></html>');
        return { contentLength: 30 };
      }
      return undefined;
    },
  };

  const result = await savePageWithSingleFile(page, output, {
    singleFileOptions: {
      blockScripts: false,
      insertMetaCSP: false,
    },
  });

  assert.equal(capturedOptions.blockScripts, true);
  assert.equal(capturedOptions.insertMetaCSP, true);
  assert.equal(fs.readFileSync(output, 'utf8'), '<html><body>saved</body></html>');
  assert.equal(result.contentLength, 30);
  fs.rmSync(dir, { recursive: true, force: true });
});
