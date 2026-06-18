const { test, expect } = require('@playwright/test');

async function gotoQuestion(page) {
  await page.addInitScript(() => localStorage.setItem('zhihu-auto-expand-debug', '1'));
  await page.goto('http://127.0.0.1:51999/question/123');
  await page.waitForFunction(() => window.zhihuAutoExpand?.snapshot);
}

async function configureApi(page, options = {}) {
  await page.evaluate(({ expandComments, intervalMs, scrollSpeed }) => {
    const api = window.zhihuAutoExpand;
    if (!api) throw new Error('zhihuAutoExpand API is not available');
    if (scrollSpeed !== undefined) api.setScrollSpeed(scrollSpeed);
    if (intervalMs !== undefined) api.setIntervalMs(intervalMs);
    if (expandComments !== undefined && api.snapshot.expandComments !== expandComments) {
      api.toggleExpandComments();
    }
  }, options);
}

async function startApi(page) {
  await page.evaluate(() => window.zhihuAutoExpand.start());
}

async function pauseApi(page) {
  await page.evaluate(() => window.zhihuAutoExpand.pause());
}

test('automation API drives scrolling without rendering panel controls', async ({ page }) => {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  await gotoQuestion(page);
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveCount(0);
  await expect(page.locator('.zae-open-panel')).toHaveCount(0);
  await page.evaluate(() => document.querySelector('[data-unknown-modal-comment]')?.remove());
  await configureApi(page, { scrollSpeed: 16, intervalMs: 200, expandComments: true });
  await startApi(page);

  await expect.poll(() => page.evaluate(() => window.smoke), { timeout: 12000 }).toMatchObject({
    answerClicks: 2,
    loadClicks: 1,
    decoyClicks: 0,
    floatingCommentClicks: 0,
    bottomCommentClicks: 2,
    unknownModalCommentClicks: 0,
    closedModalComments: 0,
    initialCommentAttempts: 1,
    replyExpandClicks: 2,
    moreCommentClicks: 1,
  });
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot)).toMatchObject({
    answerCount: 2,
    totalAnswerCount: 3,
    scrollSpeed: 16,
    intervalMs: 200,
    expandComments: true,
  });
  const scriptScrollBehaviors = await page.evaluate(() => window.smoke.scrollBehaviors.filter(Boolean));
  expect(scriptScrollBehaviors.length).toBeGreaterThan(0);
  expect(scriptScrollBehaviors.every(value => value === 'smooth')).toBe(true);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot.status)).toBe('后台标签页：等待恢复');
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot.status)).toBe('运行中');

  await pauseApi(page);
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot.status)).toBe('已暂停');
  const pausedAt = await page.evaluate(() => scrollY);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => scrollY)).toBe(pausedAt);

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await startApi(page);
  await page.waitForTimeout(100);
  await pauseApi(page);
  await page.waitForTimeout(600);
  const bounceSettledAt = await page.evaluate(() => scrollY);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => scrollY)).toBe(bounceSettledAt);

  await page.reload();
  await page.waitForFunction(() => window.zhihuAutoExpand?.snapshot);
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot)).toMatchObject({
    scrollSpeed: 16,
    intervalMs: 200,
    expandComments: true,
  });

  await page.evaluate(() => history.pushState({}, '', '/question/456'));
  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot.status)).toBe('已暂停：页面已切换');
  await page.evaluate(() => history.pushState({}, '', '/people/example'));
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('comment entry closes delayed modal and keeps scrolling', async ({ page }) => {
  await gotoQuestion(page);
  await page.evaluate(() => {
    document.querySelector('[data-bottom-comment]')?.remove();
    document.querySelector('[data-floating-comment]')?.remove();
  });
  await configureApi(page, { scrollSpeed: 16, intervalMs: 200, expandComments: true });
  await startApi(page);

  await expect.poll(() => page.evaluate(() => window.smoke), { timeout: 12000 }).toMatchObject({
    unknownModalCommentClicks: 1,
    closedModalComments: 1,
    modalReplyExpandClicks: 0,
    modalMoreCommentClicks: 0,
    loadClicks: 1,
    bottomCommentClicks: 1,
  });
  await expect(page.locator('.Modal-content')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => scrollY), { timeout: 12000 }).toBeGreaterThan(0);
  await page.waitForTimeout(2200);
  expect(await page.evaluate(() => window.smoke.unknownModalCommentClicks)).toBe(1);
  await pauseApi(page);
});

test('auth dialog opened from a comment entry blocks instead of being treated as comments', async ({ page }) => {
  await gotoQuestion(page);
  await page.evaluate(() => {
    const list = document.querySelector('.QuestionAnswers-answers');
    list.innerHTML = `
      <div class="List-header"><h4 class="List-headerText"><span>1 个回答</span></h4></div>
      <article class="AnswerItem" data-zop='{"itemId":"auth-answer"}'>
        <div class="ContentItem-actions"><button data-auth-comment>9条评论</button></div>
      </article>`;
    document.querySelector('[data-auth-comment]').addEventListener('click', () => {
      if (document.querySelector('[data-auth-dialog]')) return;
      setTimeout(() => {
        const dialog = document.createElement('section');
        dialog.setAttribute('role', 'dialog');
        dialog.className = 'Login-content';
        dialog.dataset.authDialog = '1';
        dialog.innerHTML = '<button type="button" aria-label="关闭">关闭</button><p>登录后继续，验证码验证</p>';
        dialog.querySelector('button').addEventListener('click', () => dialog.remove());
        document.body.appendChild(dialog);
      }, 100);
    });
  });
  await configureApi(page, { scrollSpeed: 16, intervalMs: 200, expandComments: true });
  await startApi(page);

  await expect.poll(() => page.evaluate(() => window.zhihuAutoExpand.snapshot), { timeout: 12000 }).toMatchObject({
    completionStatus: 'auth-blocked',
    completionReason: 'auth-dialog',
  });
  await expect(page.locator('[data-auth-dialog]')).toHaveCount(1);
});

test('comment mode avoids repeated full action scans on long pages', async ({ page }) => {
  await gotoQuestion(page);
  await page.evaluate(() => {
    const list = document.querySelector('.QuestionAnswers-answers');
    for (let i = 0; i < 100; i++) {
      const answer = document.createElement('article');
      answer.className = 'AnswerItem';
      answer.dataset.zop = JSON.stringify({ itemId: `bulk-${i}` });
      answer.innerHTML = `
        <button>阅读全文</button>
        <div class="ContentItem-actions"><button>打开 ${i + 1} 条评论</button></div>`;
      list.appendChild(answer);
    }
  });
  await page.evaluate(() => {
    window.perfProbe = { documentActionQueries: 0, broadActionQueries: 0 };
    const documentQuerySelectorAll = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function patchedDocumentQuerySelectorAll(selector) {
      if (selector === '.ContentItem-actions') window.perfProbe.documentActionQueries++;
      return documentQuerySelectorAll.call(this, selector);
    };
    const elementQuerySelectorAll = Element.prototype.querySelectorAll;
    Element.prototype.querySelectorAll = function patchedElementQuerySelectorAll(selector) {
      if (selector === '.ContentItem-actions' && !this.matches?.('.ContentItem-actions')) {
        window.perfProbe.broadActionQueries++;
      }
      return elementQuerySelectorAll.call(this, selector);
    };
  });

  await configureApi(page, { expandComments: true });
  await startApi(page);
  await page.waitForTimeout(1300);
  await pauseApi(page);

  const probe = await page.evaluate(() => window.perfProbe);
  expect(probe.documentActionQueries).toBe(0);
  expect(probe.broadActionQueries).toBeLessThanOrEqual(4);
});
