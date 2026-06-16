const { test, expect } = require('@playwright/test');

test('panel controls, scoped clicks, cancellation, settings and SPA lifecycle', async ({ page }) => {
  const errors = [];
  page.on('console', message => {
    if (message.type() === 'error') errors.push(message.text());
  });
  page.on('pageerror', error => errors.push(error.message));

  await page.goto('http://127.0.0.1:51999/question/123');
  const panel = page.locator('#zhihu-auto-expand-panel');
  await expect(panel).toBeVisible();
  await expect(panel).toHaveClass(/is-collapsed/);
  await expect(panel.locator('.zae-open-panel')).toBeVisible();
  await panel.locator('.zae-open-panel').click();
  await expect(panel).not.toHaveClass(/is-collapsed/);
  await expect(panel.locator('.zae-status')).toHaveText('未开始');

  await panel.locator('.zae-speed-range').fill('16');
  await panel.locator('.zae-interval-range').fill('200');
  await expect(panel.locator('.zae-speed-value')).toHaveText('16.0x');
  await expect(panel.locator('.zae-interval-value')).toHaveText('200ms');
  await expect(panel.locator('.zae-comment-toggle')).toHaveText('展开评论：关');
  await panel.locator('.zae-comment-toggle').click();
  await expect(panel.locator('.zae-comment-toggle')).toHaveText('展开评论：开');

  await page.evaluate(() => {
    window.smoke.progressHistory = [];
    const progress = document.querySelector('.zae-progress-value');
    new MutationObserver(() => window.smoke.progressHistory.push(progress.textContent))
      .observe(progress, { childList: true, characterData: true, subtree: true });
  });
  await panel.locator('.zae-start').click();
  await expect.poll(() => page.evaluate(() => window.smoke), { timeout: 12000 }).toMatchObject({
    answerClicks: 2,
    loadClicks: 1,
    decoyClicks: 0,
    floatingCommentClicks: 0,
    bottomCommentClicks: 3,
    knownModalCommentClicks: 0,
    unknownModalCommentClicks: 1,
    closedModalComments: 1,
    initialCommentAttempts: 2,
    replyExpandClicks: 2,
  });
  await expect(panel.locator('.zae-progress-value')).toHaveText('2/3');
  expect(await page.evaluate(() => window.smoke.progressHistory)).toEqual(expect.arrayContaining(['1/3', '2/3']));
  const scriptScrollBehaviors = await page.evaluate(() => window.smoke.scrollBehaviors.filter(Boolean));
  expect(scriptScrollBehaviors.length).toBeGreaterThan(0);
  expect(scriptScrollBehaviors.every(value => value === 'smooth')).toBe(true);

  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: true, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.locator('.zae-status')).toHaveText('后台标签页：等待恢复');
  await page.waitForTimeout(500);
  await expect(panel.locator('.zae-pause')).toBeEnabled();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { value: false, configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(panel.locator('.zae-status')).toHaveText('运行中');

  await panel.locator('.zae-pause').click();
  await expect(panel.locator('.zae-status')).toHaveText('已暂停');
  const pausedAt = await page.evaluate(() => scrollY);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => scrollY)).toBe(pausedAt);

  await page.evaluate(() => scrollTo(0, document.documentElement.scrollHeight));
  await panel.locator('.zae-start').click();
  await page.waitForTimeout(100);
  await panel.locator('.zae-pause').click();
  await page.waitForTimeout(600);
  const bounceSettledAt = await page.evaluate(() => scrollY);
  await page.waitForTimeout(400);
  expect(await page.evaluate(() => scrollY)).toBe(bounceSettledAt);

  const box = await panel.locator('.zae-title').boundingBox();
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(40, 40);
  await page.mouse.up();
  await page.reload();
  await expect(page.locator('#zhihu-auto-expand-panel')).toBeVisible();
  await expect(page.locator('#zhihu-auto-expand-panel')).not.toHaveClass(/is-collapsed/);
  const restored = await page.locator('#zhihu-auto-expand-panel').boundingBox();
  expect(restored.x).toBeLessThan(80);
  expect(restored.y).toBeLessThan(80);
  await expect(page.locator('.zae-speed-value')).toHaveText('16.0x');
  await expect(page.locator('.zae-interval-value')).toHaveText('200ms');
  await expect(page.locator('.zae-comment-toggle')).toHaveText('展开评论：开');
  await page.locator('.zae-hide-panel').click();
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveClass(/is-collapsed/);
  await page.reload();
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveClass(/is-collapsed/);
  const collapsedButton = page.locator('.zae-open-panel');
  const collapsedBox = await collapsedButton.boundingBox();
  await page.mouse.move(collapsedBox.x + collapsedBox.width / 2, collapsedBox.y + collapsedBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(280, 72);
  await page.mouse.up();
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveClass(/is-collapsed/);
  const draggedBox = await page.locator('#zhihu-auto-expand-panel').boundingBox();
  expect(draggedBox.x).toBeGreaterThan(220);
  await page.reload();
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveClass(/is-collapsed/);
  const restoredCollapsedBox = await page.locator('#zhihu-auto-expand-panel').boundingBox();
  expect(restoredCollapsedBox.x).toBeGreaterThan(220);
  await page.locator('.zae-open-panel').click();
  await expect(page.locator('#zhihu-auto-expand-panel')).not.toHaveClass(/is-collapsed/);

  await page.setViewportSize({ width: 320, height: 480 });
  await expect.poll(async () => {
    const constrained = await page.locator('#zhihu-auto-expand-panel').boundingBox();
    return {
      left: constrained.x >= 0,
      top: constrained.y >= 0,
      right: constrained.x + constrained.width <= 320,
      bottom: constrained.y + constrained.height <= 480,
    };
  }).toEqual({ left: true, top: true, right: true, bottom: true });

  await page.evaluate(() => history.pushState({}, '', '/question/456'));
  await expect(page.locator('.zae-status')).toHaveText('已暂停：页面已切换');
  await page.evaluate(() => history.pushState({}, '', '/people/example'));
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('comment mode avoids repeated full action scans on long pages', async ({ page }) => {
  await page.goto('http://127.0.0.1:51999/question/123');
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

  const panel = page.locator('#zhihu-auto-expand-panel');
  await panel.locator('.zae-open-panel').click();
  await panel.locator('.zae-comment-toggle').click();
  await panel.locator('.zae-start').click();
  await page.waitForTimeout(1300);
  await panel.locator('.zae-pause').click();

  const probe = await page.evaluate(() => window.perfProbe);
  expect(probe.documentActionQueries).toBe(0);
  expect(probe.broadActionQueries).toBeLessThanOrEqual(2);
});

test('comment mode closes delayed comment dialogs on the next run', async ({ page }) => {
  await page.goto('http://127.0.0.1:51999/question/123');
  const panel = page.locator('#zhihu-auto-expand-panel');
  await panel.locator('.zae-open-panel').click();
  await panel.locator('.zae-comment-toggle').click();
  await page.evaluate(() => {
    const dialog = document.createElement('div');
    dialog.className = 'Modal-wrapper';
    dialog.innerHTML = '<button type="button" aria-label="关闭">关闭</button><div class="Modal-content">28 条评论 默认最新</div>';
    dialog.querySelector('button').addEventListener('click', () => dialog.remove());
    document.body.appendChild(dialog);
  });

  await panel.locator('.zae-start').click();
  await expect(page.locator('.Modal-wrapper')).toHaveCount(0);
  await panel.locator('.zae-pause').click();
});
