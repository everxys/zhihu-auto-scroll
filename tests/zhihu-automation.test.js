const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  parseArgs,
  parseQuestionUrl,
  questionIdFromUrl,
  timestampForFilename,
  defaultArchivePath,
  normalizeCookiesForSingleFile,
  getLocalStorageEntries,
} = require('../scripts/zhihu-automation');

test('parses archive command arguments', () => {
  assert.deepEqual(parseArgs(['--url', 'https://www.zhihu.com/question/123', '--headed', '--speed=4']), {
    url: 'https://www.zhihu.com/question/123',
    headed: true,
    speed: '4',
  });
});

test('accepts only zhihu question URLs', () => {
  assert.deepEqual(parseQuestionUrl('https://www.zhihu.com/question/123?sort=created'), {
    href: 'https://www.zhihu.com/question/123?sort=created',
    id: '123',
  });
  assert.equal(questionIdFromUrl('https://www.zhihu.com/question/456/answer/789'), '456');
  assert.throws(() => parseQuestionUrl('https://example.com/question/123'), /只支持/);
  assert.throws(() => parseQuestionUrl('https://www.zhihu.com/people/example'), /问题页/);
});

test('builds safe default archive filenames', () => {
  const date = new Date('2026-06-16T12:34:56.789Z');
  assert.equal(timestampForFilename(date), '2026-06-16T12-34-56Z');
  assert.equal(
    path.basename(defaultArchivePath('123', date)),
    'zhihu-question-123-2026-06-16T12-34-56Z.html'
  );
});

test('converts Playwright storage state for SingleFile inputs', () => {
  const cookies = normalizeCookiesForSingleFile([{
    name: 'z_c0',
    value: 'token',
    domain: '.zhihu.com',
    path: '/',
    expires: -1,
    httpOnly: true,
    secure: true,
    sameSite: 'None',
  }]);
  assert.deepEqual(cookies, [{
    name: 'z_c0',
    value: 'token',
    domain: '.zhihu.com',
    path: '/',
    secure: true,
    httpOnly: true,
    sameSite: 'None',
  }]);

  const state = {
    origins: [{
      origin: 'https://www.zhihu.com',
      localStorage: [{ name: 'theme', value: 'dark' }],
    }],
  };
  assert.deepEqual(getLocalStorageEntries(state, 'https://www.zhihu.com'), [{ name: 'theme', value: 'dark' }]);
  assert.deepEqual(getLocalStorageEntries(state, 'https://zhuanlan.zhihu.com'), []);
});
