const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

function loadHooks(localStorage = new MapStorage()) {
  const context = {
    __ZAE_ENABLE_TEST_EXPORTS__: true,
    console,
    DOMException,
    localStorage,
    setTimeout,
    clearTimeout,
    innerHeight: 720,
    getComputedStyle: element => ({
      display: 'block',
      visibility: 'visible',
      opacity: '1',
      position: element?.testPosition || 'static',
    }),
  };
  context.window = context;
  const source = fs.readFileSync(path.join(__dirname, '..', 'zhihu-auto-scroll.js'), 'utf8');
  vm.runInNewContext(source, context);
  return { hooks: context.__ZAE_TEST_EXPORTS__, context };
}

class MapStorage {
  constructor(values = {}) {
    this.values = new Map(Object.entries(values));
  }
  getItem(key) {
    return this.values.get(key) ?? null;
  }
  setItem(key, value) {
    this.values.set(key, String(value));
  }
}

function element({ text, answer = false, list = false, excluded = false, disabled = false } = {}) {
  return {
    nodeType: 1,
    textContent: text,
    disabled,
    getAttribute(name) {
      if (name === 'aria-disabled') return disabled ? 'true' : null;
      return null;
    },
    closest(selector) {
      if (selector.includes('#zhihu-auto-expand-panel') && excluded) return this;
      if (selector.includes('.AnswerItem') && answer) return this;
      if (selector.includes('.QuestionAnswers-answers') && list) return this;
      return null;
    },
  };
}

test('clamps settings and normalizes text', () => {
  const { hooks } = loadHooks();
  assert.equal(hooks.clampScrollSpeed('99'), 16);
  assert.equal(hooks.clampScrollSpeed('bad'), 1);
  assert.equal(hooks.clampIntervalMs(101), 200);
  assert.equal(hooks.clampIntervalMs(1444.6), 1445);
  assert.equal(hooks.normalizeText(' 阅读\u200b 全文 \n'), '阅读全文');
  assert.equal(hooks.parseTotalAnswerCount('502 个回答'), 502);
  assert.equal(hooks.parseTotalAnswerCount('1,234 个回答 默认排序'), 1234);
  assert.equal(hooks.parseTotalAnswerCount('查看剩余 3 条回答'), null);
});

test('extracts stable answer ids for progress deduplication', () => {
  const { hooks } = loadHooks();
  assert.equal(hooks.getAnswerId({
    getAttribute: name => name === 'data-zop' ? '{"itemId":"14204568"}' : null,
  }), '14204568');
  assert.equal(hooks.getAnswerId({
    getAttribute: () => null,
    querySelector: () => ({ getAttribute: () => '/question/1/answer/9988' }),
  }), '9988');
});

test('migrates settings and rejects damaged values', () => {
  const { hooks } = loadHooks();
  const migrated = hooks.migrateSettings({
    scrollSpeed: '8',
    intervalMs: '1200',
    expandComments: true,
    panelExpanded: true,
    position: { left: 12, top: 34 },
    panelPosition: { left: 56, top: 78 },
  });
  assert.deepEqual(JSON.parse(JSON.stringify(migrated)), {
    version: 4,
    scrollSpeed: 8,
    intervalMs: 1200,
    expandComments: true,
    panelExpanded: true,
    panelPosition: { left: 56, top: 78 },
  });
  const damaged = hooks.migrateSettings({ scrollSpeed: 'x', panelPosition: { left: 'x' } });
  assert.equal(damaged.scrollSpeed, 1);
  assert.equal(damaged.panelExpanded, false);
  assert.equal(damaged.panelPosition, null);
});

test('storage adapter survives unavailable storage', () => {
  const throwingStorage = {
    getItem() { throw new Error('disabled'); },
    setItem() { throw new Error('disabled'); },
  };
  const { hooks } = loadHooks(throwingStorage);
  const settings = hooks.createStorageAdapter().load();
  assert.equal(settings.scrollSpeed, 1);
  assert.equal(settings.intervalMs, 700);
  assert.equal(settings.panelExpanded, false);
});

test('matches answer and list targets only inside their allowed containers', () => {
  const { hooks } = loadHooks();
  assert.equal(hooks.classifyTarget(element({ text: '阅读全文', answer: true, list: true })), 'answer');
  assert.equal(hooks.classifyTarget(element({ text: '加载更多', list: true })), 'list');
  assert.equal(hooks.classifyTarget(element({ text: '显示全部', list: true })), null);
  assert.equal(hooks.classifyTarget(element({ text: '阅读全文', answer: true, excluded: true })), null);
  assert.equal(hooks.classifyTarget(element({ text: '阅读全文', answer: true, disabled: true })), null);
  assert.equal(hooks.classifyTarget(element({ text: '阅读全文' })), null);
});

test('matches comments only when enabled, at the answer bottom, or inside comments', () => {
  const { hooks } = loadHooks();
  const answer = { getBoundingClientRect: () => ({ bottom: 500 }) };
  const bottomActions = { getBoundingClientRect: () => ({ top: 440, bottom: 480 }) };
  const floatingActions = { testPosition: 'fixed', getBoundingClientRect: () => ({ top: 440, bottom: 480 }) };
  const offscreenActions = { getBoundingClientRect: () => ({ top: 900, bottom: 940 }) };
  const commentButton = actions => ({
    textContent: '打开 40 条评论',
    getAttribute: () => null,
    closest(selector) {
      if (selector.includes('.AnswerItem')) return answer;
      if (selector.includes('.ContentItem-actions')) return actions;
      return null;
    },
  });
  const dialogButton = {
    ...commentButton(bottomActions),
    getAttribute(name) {
      return name === 'aria-haspopup' ? 'dialog' : null;
    },
  };
  const replyButton = {
    textContent: '展开其他 4 条回复',
    getAttribute: () => null,
    closest(selector) {
      return selector.includes('.Comments-container') ? this : null;
    },
  };
  assert.equal(hooks.classifyTarget(commentButton(bottomActions)), null);
  assert.equal(hooks.classifyTarget(commentButton(bottomActions), { expandComments: true }), 'comment-entry');
  assert.equal(hooks.classifyTarget(commentButton(floatingActions), { expandComments: true }), null);
  assert.equal(hooks.classifyTarget(commentButton(offscreenActions), { expandComments: true }), null);
  assert.equal(hooks.isKnownDialogCommentTrigger(dialogButton), true);
  assert.equal(hooks.classifyTarget(dialogButton, { expandComments: true }), null);
  assert.equal(hooks.classifyTarget(replyButton, { expandComments: true }), 'comment-reply');
});

test('incremental mutation collection ignores panel changes and returns only added roots', () => {
  const { hooks } = loadHooks();
  const answer = element({ answer: true });
  const panelChild = element({ excluded: true });
  const textNode = { nodeType: 3 };
  const roots = hooks.collectAddedRoots([{ addedNodes: [answer, panelChild, textNode] }]);
  assert.equal(roots.length, 1);
  assert.equal(roots[0], answer);
});

test('idle decision treats newly discovered answers as progress', () => {
  const { hooks } = loadHooks();
  const progress = hooks.getIdleDecision({
    clickedCount: 0,
    scrollChanged: false,
    answerCount: 3,
    previousAnswerCount: 2,
    scrollHeight: 1000,
    previousScrollHeight: 1000,
    nearBottom: true,
    bottomBounceRounds: 8,
    previousIdleRounds: 9,
  });
  assert.equal(progress.shouldPause, false);
  assert.equal(progress.idleRounds, 0);
});

test('scheduler interval is measured from the previous run start', () => {
  const { hooks } = loadHooks();
  assert.equal(hooks.getNextScheduleDelay(200, 80), 120);
  assert.equal(hooks.getNextScheduleDelay(200, 200), 0);
  assert.equal(hooks.getNextScheduleDelay(200, 650), 0);
});

test('abortable waits stop immediately when paused or superseded', async () => {
  const { hooks } = loadHooks();
  const controller = new AbortController();
  const wait = hooks.abortableSleep(1000, controller.signal);
  controller.abort(new DOMException('paused', 'AbortError'));
  await assert.rejects(wait, error => error.name === 'AbortError');
});
