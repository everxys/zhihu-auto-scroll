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
  await expect(panel.locator('.zae-status')).toHaveText('未开始');

  await panel.locator('.zae-speed-range').fill('8');
  await panel.locator('.zae-interval-range').fill('300');
  await expect(panel.locator('.zae-speed-value')).toHaveText('8.0x');
  await expect(panel.locator('.zae-interval-value')).toHaveText('300ms');

  await panel.locator('.zae-start').click();
  await expect.poll(() => page.evaluate(() => window.smoke)).toMatchObject({
    answerClicks: 2,
    loadClicks: 1,
    decoyClicks: 0,
  });
  await expect(panel.locator('.zae-progress-value')).toHaveText('2/3');
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
  const restored = await page.locator('#zhihu-auto-expand-panel').boundingBox();
  expect(restored.x).toBeLessThan(80);
  expect(restored.y).toBeLessThan(80);
  await expect(page.locator('.zae-speed-value')).toHaveText('8.0x');
  await expect(page.locator('.zae-interval-value')).toHaveText('300ms');

  await page.setViewportSize({ width: 320, height: 480 });
  const constrained = await page.locator('#zhihu-auto-expand-panel').boundingBox();
  expect(constrained.x).toBeGreaterThanOrEqual(0);
  expect(constrained.y).toBeGreaterThanOrEqual(0);
  expect(constrained.x + constrained.width).toBeLessThanOrEqual(320);
  expect(constrained.y + constrained.height).toBeLessThanOrEqual(480);

  await page.evaluate(() => history.pushState({}, '', '/question/456'));
  await expect(page.locator('.zae-status')).toHaveText('已暂停：页面已切换');
  await page.evaluate(() => history.pushState({}, '', '/people/example'));
  await expect(page.locator('#zhihu-auto-expand-panel')).toHaveCount(0);
  expect(errors).toEqual([]);
});
