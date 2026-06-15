// ==UserScript==
// @name         Zhihu Auto Expand All Answers
// @namespace    https://everxys.local/
// @version      1.1.0
// @description  自动展开知乎回答，支持可取消滚动、增量处理、底部刷新、累计滚动时长和拖动面板
// @author       everxys
// @match        https://www.zhihu.com/question/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function (global) {
  'use strict';

  const STORAGE_KEY = 'zhihu-auto-expand-settings';
  const LEGACY_KEYS = {
    position: 'zhihu-auto-expand-panel-position',
    scrollSpeed: 'zhihu-auto-expand-scroll-speed',
    intervalMs: 'zhihu-auto-expand-interval-ms',
  };
  const SETTINGS_VERSION = 2;
  const PANEL_ID = 'zhihu-auto-expand-panel';
  const SPEED_MIN = 0.5;
  const SPEED_MAX = 16;
  const INTERVAL_MIN = 200;
  const INTERVAL_MAX = 3000;
  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    scrollSpeed: 1,
    intervalMs: 700,
    panelPosition: null,
  });
  const POLICY = Object.freeze({
    bottomThresholdPx: 180,
    bottomBounceUpRatio: 0.75,
    bottomBounceDelayMs: 220,
    normalScrollSettleMs: 80,
    afterClickDelayMs: 120,
    mutationRunDelayMs: 150,
    clickRetryCooldownMs: 1500,
    maxClickAttempts: 3,
    maxBottomBounceRounds: 8,
    maxIdleRounds: 10,
  });
  const ANSWER_SELECTOR =
    '.AnswerItem, .QuestionAnswer-content, .List-item[data-za-detail-view-path-module="AnswerItem"]';
  const ANSWER_LIST_SELECTOR =
    '.QuestionAnswers-answers, .Question-mainColumn .List, .Question-mainColumn';
  const QUESTION_ROOT_SELECTOR = '.Question-main, [data-zop-question-id]';
  const EXCLUDED_SELECTOR =
    `#${PANEL_ID}, .Comments-container, .CommentList, .NestComment, .Question-sideColumn, header`;
  const CANDIDATE_SELECTOR = 'button, a, [role="button"]';
  const ANSWER_EXPAND_TEXT =
    /^(阅读全文|展开阅读全文|显示全部|展开全部|查看完整回答|继续阅读|阅读全部)$/;
  const LOAD_MORE_TEXT =
    /^(查看全部回答|点击显示全部回答|更多回答|加载更多|展开更多|查看全部\d+个?回答|还有\d+个?回答)$/;
  const TOTAL_ANSWER_COUNT_SELECTORS = [
    '.QuestionAnswers-answers .List-headerText',
    '.QuestionAnswers-answers .List-header',
    '.Question-mainColumn .List-headerText',
  ];

  function clampScrollSpeed(value) {
    if (value === null || value === undefined || value === '') return DEFAULT_SETTINGS.scrollSpeed;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return DEFAULT_SETTINGS.scrollSpeed;
    return Math.min(SPEED_MAX, Math.max(SPEED_MIN, raw));
  }

  function clampIntervalMs(value) {
    if (value === null || value === undefined || value === '') return DEFAULT_SETTINGS.intervalMs;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return DEFAULT_SETTINGS.intervalMs;
    return Math.min(INTERVAL_MAX, Math.max(INTERVAL_MIN, Math.round(raw)));
  }

  function normalizeText(text) {
    return String(text || '')
      .replace(/[\u200b\u200c\u200d\ufeff]/g, '')
      .replace(/\s+/g, '')
      .trim();
  }

  function normalizePosition(position) {
    if (!position || !Number.isFinite(position.left) || !Number.isFinite(position.top)) {
      return null;
    }
    return { left: position.left, top: position.top };
  }

  function parseTotalAnswerCount(text) {
    const match = normalizeText(text).match(/^([\d,，]+)个回答/);
    if (!match) return null;
    const count = Number(match[1].replace(/[,，]/g, ''));
    return Number.isSafeInteger(count) && count >= 0 ? count : null;
  }

  function getTotalAnswerCount() {
    for (const selector of TOTAL_ANSWER_COUNT_SELECTORS) {
      for (const element of document.querySelectorAll(selector)) {
        const count = parseTotalAnswerCount(element.textContent);
        if (count !== null) return count;
      }
    }
    return null;
  }

  function getAnswerId(answer) {
    try {
      const itemId = JSON.parse(answer?.getAttribute?.('data-zop') || '{}').itemId;
      if (itemId !== undefined && itemId !== null && String(itemId)) return String(itemId);
    } catch {}
    const href = answer?.querySelector?.('a[href*="/answer/"]')?.getAttribute?.('href') || '';
    return href.match(/\/answer\/(\d+)/)?.[1] || null;
  }

  function migrateSettings(raw, legacy = {}) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      version: SETTINGS_VERSION,
      scrollSpeed: clampScrollSpeed(source.scrollSpeed ?? legacy.scrollSpeed),
      intervalMs: clampIntervalMs(source.intervalMs ?? legacy.intervalMs),
      panelPosition: normalizePosition(source.panelPosition ?? legacy.position),
    };
  }

  function createStorageAdapter() {
    function getRaw(key) {
      try {
        if (typeof global.GM_getValue === 'function') return global.GM_getValue(key, null);
        return global.localStorage?.getItem(key) ?? null;
      } catch (error) {
        console.warn('[Zhihu Auto Expand] storage read failed:', error);
        return null;
      }
    }

    function setRaw(key, value) {
      try {
        if (typeof global.GM_setValue === 'function') {
          global.GM_setValue(key, value);
        } else {
          global.localStorage?.setItem(key, value);
        }
        return true;
      } catch (error) {
        console.warn('[Zhihu Auto Expand] storage write failed:', error);
        return false;
      }
    }

    function parse(value) {
      if (typeof value !== 'string') return value;
      try {
        return JSON.parse(value);
      } catch {
        return null;
      }
    }

    return {
      load() {
        const current = parse(getRaw(STORAGE_KEY));
        const legacy = {
          position: parse(getRaw(LEGACY_KEYS.position)),
          scrollSpeed: getRaw(LEGACY_KEYS.scrollSpeed),
          intervalMs: getRaw(LEGACY_KEYS.intervalMs),
        };
        const settings = migrateSettings(current, legacy);
        setRaw(STORAGE_KEY, JSON.stringify(settings));
        return settings;
      },
      save(settings) {
        return setRaw(STORAGE_KEY, JSON.stringify(migrateSettings(settings)));
      },
      getDebugEnabled() {
        return getRaw('zhihu-auto-expand-debug') === '1';
      },
    };
  }

  function abortError() {
    return new DOMException('Operation aborted', 'AbortError');
  }

  function throwIfAborted(signal) {
    if (signal?.aborted) throw signal.reason || abortError();
  }

  function abortableSleep(delay, signal) {
    throwIfAborted(signal);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, delay);
      signal?.addEventListener(
        'abort',
        () => {
          clearTimeout(timer);
          reject(signal.reason || abortError());
        },
        { once: true }
      );
    });
  }

  function isExcludedElement(element) {
    return Boolean(element?.closest?.(EXCLUDED_SELECTOR));
  }

  function isDisabled(element) {
    return Boolean(
      element?.disabled ||
        element?.getAttribute?.('disabled') !== null ||
        element?.getAttribute?.('aria-disabled') === 'true'
    );
  }

  function getElementText(element) {
    return normalizeText(
      element?.textContent ||
        element?.innerText ||
        element?.getAttribute?.('aria-label') ||
        ''
    );
  }

  function classifyTarget(element) {
    if (!element || isExcludedElement(element) || isDisabled(element)) return null;
    const text = getElementText(element);
    if (!text) return null;
    if (element.closest?.(ANSWER_SELECTOR) && ANSWER_EXPAND_TEXT.test(text)) return 'answer';
    if (
      element.closest?.(ANSWER_LIST_SELECTOR) &&
      !element.closest?.(ANSWER_SELECTOR) &&
      LOAD_MORE_TEXT.test(text)
    ) {
      return 'list';
    }
    return null;
  }

  function isVisible(element) {
    const rect = element?.getBoundingClientRect?.();
    if (!rect || rect.width <= 0 || rect.height <= 0) return false;
    const style = global.getComputedStyle(element);
    return style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) !== 0;
  }

  function collectAddedRoots(records) {
    const roots = [];
    for (const record of records) {
      for (const node of record.addedNodes || []) {
        if (node?.nodeType !== 1 || isExcludedElement(node)) continue;
        roots.push(node);
      }
    }
    return roots;
  }

  function getIdleDecision(input) {
    const hasProgress =
      input.clickedCount > 0 ||
      input.scrollChanged ||
      input.answerCount > input.previousAnswerCount ||
      input.scrollHeight !== input.previousScrollHeight;
    const waitForBottom =
      input.nearBottom &&
      !hasProgress &&
      input.bottomBounceRounds < POLICY.maxBottomBounceRounds;
    if (hasProgress || waitForBottom) return { idleRounds: 0, shouldPause: false, waitForBottom };
    const idleRounds = input.previousIdleRounds + 1;
    return { idleRounds, shouldPause: idleRounds >= POLICY.maxIdleRounds, waitForBottom: false };
  }

  function getNextScheduleDelay(targetInterval, elapsed) {
    return Math.max(0, targetInterval - elapsed);
  }

  const testHooks = Object.freeze({
    clampScrollSpeed,
    clampIntervalMs,
    normalizeText,
    migrateSettings,
    parseTotalAnswerCount,
    getAnswerId,
    createStorageAdapter,
    classifyTarget,
    collectAddedRoots,
    getIdleDecision,
    getNextScheduleDelay,
    abortableSleep,
    POLICY,
  });

  if (global.__ZAE_ENABLE_TEST_EXPORTS__ === true) {
    Object.defineProperty(global, '__ZAE_TEST_EXPORTS__', { value: testHooks });
    return;
  }

  const storage = createStorageAdapter();
  const settings = storage.load();

  const panel = (() => {
    let root = null;
    let style = null;
    let refs = null;
    let events = null;
    let timerDisplay = null;
    let statusText = '未开始';
    let lastRender = {};

    function formatDuration(ms) {
      const totalSeconds = Math.floor(ms / 1000);
      return [
        Math.floor(totalSeconds / 3600),
        Math.floor((totalSeconds % 3600) / 60),
        totalSeconds % 60,
      ]
        .map(value => String(value).padStart(2, '0'))
        .join(':');
    }

    function clampPosition(left, top) {
      return {
        left: Math.max(0, Math.min(left, global.innerWidth - root.offsetWidth)),
        top: Math.max(0, Math.min(top, global.innerHeight - root.offsetHeight)),
      };
    }

    function moveTo(left, top) {
      if (!root) return;
      const position = clampPosition(left, top);
      Object.assign(root.style, {
        left: `${position.left}px`,
        top: `${position.top}px`,
        right: 'auto',
        bottom: 'auto',
        transform: 'none',
      });
    }

    function keepInViewport() {
      if (!root) return;
      const rect = root.getBoundingClientRect();
      moveTo(rect.left, rect.top);
    }

    function render(snapshot) {
      if (!refs) return;
      const next = {
        state: snapshot.state,
        speed: snapshot.scrollSpeed,
        interval: snapshot.intervalMs,
        duration: formatDuration(snapshot.totalScrollMs),
        progress: `${snapshot.answerCount}/${snapshot.totalAnswerCount ?? '?'}`,
        status: statusText,
      };
      if (next.state !== lastRender.state) {
        refs.start.disabled = next.state === 'running';
        refs.pause.disabled = next.state !== 'running';
      }
      if (next.speed !== lastRender.speed) {
        refs.speedRange.value = String(next.speed);
        refs.speedValue.textContent = `${next.speed.toFixed(1)}x`;
        refs.speedPresets.forEach(button =>
          button.classList.toggle('is-active', Number(button.dataset.speed) === next.speed)
        );
      }
      if (next.interval !== lastRender.interval) {
        refs.intervalRange.value = String(next.interval);
        refs.intervalValue.textContent = `${next.interval}ms`;
        refs.intervalPresets.forEach(button =>
          button.classList.toggle('is-active', Number(button.dataset.interval) === next.interval)
        );
      }
      if (next.duration !== lastRender.duration) refs.timer.textContent = next.duration;
      if (next.progress !== lastRender.progress) refs.progress.textContent = next.progress;
      if (next.status !== lastRender.status) refs.status.textContent = next.status;
      lastRender = next;
    }

    function setStatus(text) {
      statusText = text;
      app.render();
    }

    function startTimer() {
      if (!timerDisplay) timerDisplay = setInterval(() => app.render(), 1000);
    }

    function stopTimer() {
      clearInterval(timerDisplay);
      timerDisplay = null;
      app.render();
    }

    function bindDrag() {
      let dragging = false;
      let offsetX = 0;
      let offsetY = 0;
      refs.title.addEventListener(
        'pointerdown',
        event => {
          dragging = true;
          refs.title.setPointerCapture?.(event.pointerId);
          const rect = root.getBoundingClientRect();
          offsetX = event.clientX - rect.left;
          offsetY = event.clientY - rect.top;
          moveTo(rect.left, rect.top);
          event.preventDefault();
        },
        { signal: events.signal }
      );
      refs.title.addEventListener(
        'pointermove',
        event => {
          if (dragging) moveTo(event.clientX - offsetX, event.clientY - offsetY);
        },
        { signal: events.signal }
      );
      refs.title.addEventListener(
        'pointerup',
        event => {
          if (!dragging) return;
          dragging = false;
          refs.title.releasePointerCapture?.(event.pointerId);
          const rect = root.getBoundingClientRect();
          settings.panelPosition = { left: rect.left, top: rect.top };
          storage.save(settings);
        },
        { signal: events.signal }
      );
    }

    function create() {
      if (root || !document.body) return;
      events = new AbortController();
      root = document.createElement('section');
      root.id = PANEL_ID;
      root.setAttribute('aria-label', '知乎自动展开控制');
      root.innerHTML = `
        <div class="zae-title">知乎展开</div>
        <div class="zae-status" aria-live="polite">未开始</div>
        <div class="zae-progress">已发现回答 <strong class="zae-progress-value">0/?</strong></div>
        <div class="zae-timer">累计滚动 <span class="zae-timer-value">00:00:00</span></div>
        <button type="button" class="zae-start">开始</button>
        <button type="button" class="zae-pause">暂停</button>
        <div class="zae-section">
          <label class="zae-section-head" for="zae-speed-range">
            <span>滚动速度</span><span class="zae-speed-value">1.0x</span>
          </label>
          <input id="zae-speed-range" class="zae-speed-range" type="range" min="0.5" max="16" step="0.5">
          <div class="zae-presets zae-speed-presets">
            ${[1, 2, 4, 8, 16].map(value => `<button type="button" data-speed="${value}">${value}x</button>`).join('')}
          </div>
        </div>
        <div class="zae-section">
          <label class="zae-section-head" for="zae-interval-range">
            <span>执行间隔</span><span class="zae-interval-value">700ms</span>
          </label>
          <input id="zae-interval-range" class="zae-interval-range" type="range" min="200" max="3000" step="100">
          <div class="zae-presets zae-interval-presets">
            ${[300, 700, 1200, 2000].map(value => `<button type="button" data-interval="${value}">${value}</button>`).join('')}
          </div>
        </div>`;
      style = document.createElement('style');
      style.textContent = `
        #${PANEL_ID}{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:999999;width:176px;padding:10px;border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 4px 18px rgba(0,0,0,.2);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;user-select:none}
        #${PANEL_ID} .zae-title{font-weight:700;text-align:center;margin-bottom:6px;cursor:move;touch-action:none}
        #${PANEL_ID} .zae-status,#${PANEL_ID} .zae-progress,#${PANEL_ID} .zae-timer{font-size:12px;text-align:center;margin-bottom:6px;line-height:1.4}
        #${PANEL_ID} .zae-status{color:#666;min-height:17px}#${PANEL_ID} .zae-timer{color:#333;padding:4px 6px;border-radius:6px;background:rgba(37,99,235,.08)}
        #${PANEL_ID} .zae-progress-value,#${PANEL_ID} .zae-timer-value,#${PANEL_ID} .zae-section-head span:last-child{font-weight:700;color:#2563eb}
        #${PANEL_ID} button{border:0;cursor:pointer;font-weight:600}#${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed}
        #${PANEL_ID} .zae-start,#${PANEL_ID} .zae-pause{width:100%;margin-top:6px;padding:7px 8px;border-radius:7px;font-size:12px;color:#fff}
        #${PANEL_ID} .zae-start{background:#16a34a}#${PANEL_ID} .zae-pause{background:#f59e0b}
        #${PANEL_ID} .zae-section{margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08)}
        #${PANEL_ID} .zae-section-head{display:flex;justify-content:space-between;font-size:12px;color:#333;margin-bottom:4px}
        #${PANEL_ID} input{width:100%;cursor:pointer}#${PANEL_ID} .zae-presets{display:grid;gap:4px;margin-top:6px}
        #${PANEL_ID} .zae-speed-presets{grid-template-columns:repeat(5,1fr)}#${PANEL_ID} .zae-interval-presets{grid-template-columns:repeat(4,1fr)}
        #${PANEL_ID} .zae-presets button{padding:5px 0;border-radius:6px;background:#e5e7eb;color:#374151;font-size:11px}
        #${PANEL_ID} .zae-presets button.is-active{background:#2563eb;color:#fff}`;
      document.documentElement.appendChild(style);
      document.body.appendChild(root);
      refs = {
        title: root.querySelector('.zae-title'),
        status: root.querySelector('.zae-status'),
        progress: root.querySelector('.zae-progress-value'),
        timer: root.querySelector('.zae-timer-value'),
        start: root.querySelector('.zae-start'),
        pause: root.querySelector('.zae-pause'),
        speedRange: root.querySelector('.zae-speed-range'),
        speedValue: root.querySelector('.zae-speed-value'),
        speedPresets: [...root.querySelectorAll('[data-speed]')],
        intervalRange: root.querySelector('.zae-interval-range'),
        intervalValue: root.querySelector('.zae-interval-value'),
        intervalPresets: [...root.querySelectorAll('[data-interval]')],
      };
      refs.start.addEventListener('click', () => app.start(), { signal: events.signal });
      refs.pause.addEventListener('click', () => app.pause(), { signal: events.signal });
      refs.speedRange.addEventListener('input', event => app.setScrollSpeed(event.target.value), { signal: events.signal });
      refs.intervalRange.addEventListener('input', event => app.setIntervalMs(event.target.value), { signal: events.signal });
      refs.speedPresets.forEach(button =>
        button.addEventListener('click', () => app.setScrollSpeed(button.dataset.speed), { signal: events.signal })
      );
      refs.intervalPresets.forEach(button =>
        button.addEventListener('click', () => app.setIntervalMs(button.dataset.interval), { signal: events.signal })
      );
      global.addEventListener('resize', keepInViewport, { signal: events.signal });
      bindDrag();
      if (settings.panelPosition) moveTo(settings.panelPosition.left, settings.panelPosition.top);
      else requestAnimationFrame(keepInViewport);
      lastRender = {};
      app.render();
    }

    function destroy() {
      stopTimer();
      events?.abort();
      root?.remove();
      style?.remove();
      root = style = refs = events = null;
      lastRender = {};
    }

    return { create, destroy, render, setStatus, startTimer, stopTimer, contains: node => root?.contains(node) };
  })();

  const expander = (() => {
    let pendingRoots = new Set();
    let retryElements = new Set();
    let attempts = new WeakMap();
    let completed = new WeakSet();
    let seenAnswerIds = new Set();
    let seenAnswerNodes = new WeakSet();
    let answerCount = 0;
    let needsInitialScan = true;

    function discoverAnswers(root) {
      const answers = [];
      if (root?.matches?.(ANSWER_SELECTOR)) answers.push(root);
      root?.querySelectorAll?.(ANSWER_SELECTOR).forEach(answer => answers.push(answer));
      for (const answer of answers) {
        const answerId = getAnswerId(answer);
        if (answerId && seenAnswerIds.has(answerId)) continue;
        if (!answerId && seenAnswerNodes.has(answer)) continue;
        if (answerId) seenAnswerIds.add(answerId);
        else seenAnswerNodes.add(answer);
        answerCount++;
      }
    }

    function queueRoots(roots) {
      roots.forEach(root => {
        pendingRoots.add(root);
        discoverAnswers(root);
      });
    }

    function candidateElements(root) {
      const elements = [];
      if (root?.matches?.(CANDIDATE_SELECTOR)) elements.push(root);
      root?.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(element => elements.push(element));
      return elements;
    }

    function clickCandidate(element, now) {
      if (!element || completed.has(element)) return false;
      const record = attempts.get(element);
      if (record) {
        const changed =
          !element.isConnected ||
          getElementText(element) !== record.text ||
          !classifyTarget(element);
        if (changed) {
          completed.add(element);
          return false;
        }
        if (record.count >= POLICY.maxClickAttempts || now - record.at < POLICY.clickRetryCooldownMs) {
          return false;
        }
      }
      if (!classifyTarget(element)) return false;
      if (!isVisible(element)) return false;
      try {
        element.click();
        attempts.set(element, { count: (record?.count || 0) + 1, at: now, text: getElementText(element) });
        return true;
      } catch (error) {
        console.warn('[Zhihu Auto Expand] expand click failed:', error);
        return false;
      }
    }

    function processPending(signal) {
      throwIfAborted(signal);
      if (needsInitialScan) {
        const root = document.querySelector(ANSWER_LIST_SELECTOR) || document.querySelector(QUESTION_ROOT_SELECTOR);
        if (root) pendingRoots.add(root);
        needsInitialScan = false;
      }
      retryElements.forEach(element => pendingRoots.add(element));
      retryElements.clear();
      const roots = [...pendingRoots];
      pendingRoots.clear();
      let clickedCount = 0;
      const now = Date.now();
      for (const root of roots) {
        throwIfAborted(signal);
        discoverAnswers(root);
        for (const element of candidateElements(root)) {
          if (clickCandidate(element, now)) clickedCount++;
          const record = attempts.get(element);
          if (!completed.has(element) && classifyTarget(element) && record?.count < POLICY.maxClickAttempts) {
            retryElements.add(element);
          }
        }
      }
      return clickedCount;
    }

    function reset() {
      pendingRoots = new Set();
      retryElements = new Set();
      attempts = new WeakMap();
      completed = new WeakSet();
      seenAnswerIds = new Set();
      seenAnswerNodes = new WeakSet();
      answerCount = 0;
      needsInitialScan = true;
    }

    return {
      queueRoots,
      processPending,
      reset,
      getAnswerCount: () => answerCount,
    };
  })();

  const scroller = (() => {
    let bottomBounceRounds = 0;
    const getTop = () => global.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    const getHeight = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const getViewport = () => global.innerHeight || document.documentElement.clientHeight;
    const nearBottom = () => getTop() + getViewport() >= getHeight() - POLICY.bottomThresholdPx;
    const behavior = () => 'smooth';
    const distance = () => Math.max(600, global.innerHeight * 0.8) * settings.scrollSpeed;

    async function bounce(signal) {
      const beforeHeight = getHeight();
      bottomBounceRounds++;
      const upDistance = Math.max(400, global.innerHeight * POLICY.bottomBounceUpRatio);
      throwIfAborted(signal);
      global.scrollBy({ top: -upDistance, behavior: behavior() });
      await abortableSleep(POLICY.bottomBounceDelayMs, signal);
      throwIfAborted(signal);
      global.scrollTo({ top: getHeight(), behavior: behavior() });
      await abortableSleep(POLICY.bottomBounceDelayMs, signal);
      return getHeight() > beforeHeight;
    }

    async function scrollPage(signal) {
      const beforeTop = getTop();
      const beforeHeight = getHeight();
      if (nearBottom()) await bounce(signal);
      else {
        throwIfAborted(signal);
        global.scrollBy({ top: distance(), behavior: behavior() });
        await abortableSleep(POLICY.normalScrollSettleMs, signal);
      }
      throwIfAborted(signal);
      return getTop() !== beforeTop || getHeight() !== beforeHeight;
    }

    return {
      scrollPage,
      nearBottom,
      getHeight,
      getTop,
      getBottomBounceRounds: () => bottomBounceRounds,
      resetBottomBounce: () => { bottomBounceRounds = 0; },
      reset: () => { bottomBounceRounds = 0; },
    };
  })();

  const scheduler = (() => {
    let state = 'paused';
    let scheduled = null;
    let observer = null;
    let controller = null;
    let task = null;
    let runSoonAfterTask = false;

    function valid(signal) {
      return state === 'running' && controller?.signal === signal && !signal.aborted;
    }

    function observe() {
      if (observer || !document.body) return;
      const target =
        document.querySelector(ANSWER_LIST_SELECTOR) ||
        document.querySelector(QUESTION_ROOT_SELECTOR) ||
        document.body;
      observer = new MutationObserver(records => {
        const roots = collectAddedRoots(records).filter(root => !panel.contains(root));
        if (!roots.length) return;
        expander.queueRoots(roots);
        requestSoon();
      });
      observer.observe(target, { childList: true, subtree: true });
    }

    function schedule(delay) {
      if (state !== 'running') return;
      clearTimeout(scheduled);
      scheduled = setTimeout(execute, delay);
    }

    async function execute() {
      scheduled = null;
      if (state !== 'running' || task) return;
      const startedAt = Date.now();
      const signal = controller.signal;
      task = app.runOnce(signal);
      try {
        await task;
      } finally {
        task = null;
        if (valid(signal) && !document.hidden) {
          const targetDelay = runSoonAfterTask ? POLICY.mutationRunDelayMs : settings.intervalMs;
          const delay = getNextScheduleDelay(targetDelay, Date.now() - startedAt);
          runSoonAfterTask = false;
          schedule(delay);
        }
      }
    }

    function requestSoon() {
      if (state !== 'running') return;
      if (task) {
        runSoonAfterTask = true;
        return;
      }
      schedule(POLICY.mutationRunDelayMs);
    }

    function handleVisibilityChange() {
      if (state !== 'running') return;
      if (document.hidden) {
        clearTimeout(scheduled);
        scheduled = null;
        app.renderVisibilityStatus(true);
      } else {
        app.renderVisibilityStatus(false);
        requestSoon();
      }
    }

    function start() {
      if (state === 'running') return;
      state = 'running';
      controller = new AbortController();
      observe();
      schedule(0);
    }

    function pause() {
      state = 'paused';
      clearTimeout(scheduled);
      scheduled = null;
      runSoonAfterTask = false;
      controller?.abort(abortError());
      controller = null;
      observer?.disconnect();
      observer = null;
    }

    function reschedule() {
      if (state === 'running' && !task) schedule(settings.intervalMs);
    }

    return { start, pause, requestSoon, reschedule, handleVisibilityChange, getState: () => state };
  })();

  const app = (() => {
    let idleRounds = 0;
    let previousAnswerCount = 0;
    let previousScrollHeight = 0;
    let totalAnswerCount = null;
    let totalScrollMs = 0;
    let timerStartedAt = null;
    let currentQuestionId = null;
    let destroyed = false;

    function questionId() {
      return location.pathname.match(/^\/question\/(\d+)/)?.[1] || null;
    }

    function snapshot() {
      return {
        state: scheduler.getState(),
        scrollSpeed: settings.scrollSpeed,
        intervalMs: settings.intervalMs,
        totalScrollMs:
          totalScrollMs +
          (scheduler.getState() === 'running' && timerStartedAt ? Date.now() - timerStartedAt : 0),
        answerCount: expander.getAnswerCount(),
        totalAnswerCount,
      };
    }

    function render() {
      panel.render(snapshot());
    }

    function resetPageState() {
      idleRounds = 0;
      previousAnswerCount = 0;
      previousScrollHeight = scroller.getHeight();
      expander.reset();
      scroller.reset();
      totalAnswerCount = getTotalAnswerCount();
    }

    function start() {
      if (destroyed || !questionId() || scheduler.getState() === 'running') return;
      idleRounds = 0;
      previousAnswerCount = expander.getAnswerCount();
      previousScrollHeight = scroller.getHeight();
      timerStartedAt = Date.now();
      scheduler.start();
      panel.startTimer();
      panel.setStatus('运行中');
      render();
    }

    function pause(message = '已暂停') {
      if (scheduler.getState() === 'running' && timerStartedAt) totalScrollMs += Date.now() - timerStartedAt;
      timerStartedAt = null;
      scheduler.pause();
      panel.stopTimer();
      panel.setStatus(message);
      render();
    }

    async function runOnce(signal) {
      try {
        throwIfAborted(signal);
        if (document.hidden) {
          panel.setStatus('后台标签页：等待恢复');
          return;
        }
        const clickedCount = expander.processPending(signal);
        if (clickedCount > 0) await abortableSleep(POLICY.afterClickDelayMs, signal);
        if (document.hidden) {
          panel.setStatus('后台标签页：等待恢复');
          return;
        }
        const scrollChanged = await scroller.scrollPage(signal);
        if (document.hidden) {
          panel.setStatus('后台标签页：等待恢复');
          return;
        }
        throwIfAborted(signal);
        const answerCount = expander.getAnswerCount();
        totalAnswerCount = getTotalAnswerCount() ?? totalAnswerCount;
        const scrollHeight = scroller.getHeight();
        const decision = getIdleDecision({
          clickedCount,
          scrollChanged,
          answerCount,
          previousAnswerCount,
          scrollHeight,
          previousScrollHeight,
          nearBottom: scroller.nearBottom(),
          bottomBounceRounds: scroller.getBottomBounceRounds(),
          previousIdleRounds: idleRounds,
        });
        idleRounds = decision.idleRounds;
        if (answerCount > previousAnswerCount || scrollHeight !== previousScrollHeight) {
          scroller.resetBottomBounce();
        }
        previousAnswerCount = answerCount;
        previousScrollHeight = scrollHeight;
        if (decision.waitForBottom) {
          panel.setStatus(`底部刷新中 ${scroller.getBottomBounceRounds()}/${POLICY.maxBottomBounceRounds}`);
        } else if (decision.shouldPause) {
          const completed = totalAnswerCount !== null && answerCount >= totalAnswerCount;
          pause(completed ? '已完成：已发现全部回答' : '已自动暂停：连续多轮无新回答');
        } else {
          panel.setStatus('运行中');
        }
        render();
      } catch (error) {
        if (error?.name !== 'AbortError') console.warn('[Zhihu Auto Expand] run failed:', error);
      }
    }

    function setScrollSpeed(value) {
      settings.scrollSpeed = clampScrollSpeed(value);
      storage.save(settings);
      render();
    }

    function setIntervalMs(value) {
      settings.intervalMs = clampIntervalMs(value);
      storage.save(settings);
      scheduler.reschedule();
      render();
    }

    function renderVisibilityStatus(hidden) {
      panel.setStatus(hidden ? '后台标签页：等待恢复' : '运行中');
      render();
    }

    function handleRouteChange() {
      const nextQuestionId = questionId();
      if (nextQuestionId === currentQuestionId) return;
      pause(nextQuestionId ? '已暂停：页面已切换' : '已暂停：已离开问题页');
      resetPageState();
      currentQuestionId = nextQuestionId;
      if (nextQuestionId) panel.create();
      else panel.destroy();
    }

    function exposeDebugApi() {
      if (!storage.getDebugEnabled()) return;
      const api = Object.freeze({
        start,
        pause,
        runOnce: () => scheduler.requestSoon(),
        setScrollSpeed,
        setIntervalMs,
        get snapshot() { return Object.freeze({ ...snapshot(), idleRounds, answerCount: expander.getAnswerCount() }); },
      });
      Object.defineProperty(global, 'zhihuAutoExpand', {
        value: api,
        enumerable: false,
        writable: false,
        configurable: true,
      });
    }

    function init() {
      if (!document.body) {
        setTimeout(init, 100);
        return;
      }
      currentQuestionId = questionId();
      if (currentQuestionId) panel.create();
      resetPageState();
      exposeDebugApi();
      console.log('[Zhihu Auto Expand] loaded; debug API is disabled unless zhihu-auto-expand-debug=1');
    }

    function destroy() {
      if (destroyed) return;
      destroyed = true;
      pause('已销毁');
      panel.destroy();
      try {
        delete global.zhihuAutoExpand;
      } catch {}
    }

    return {
      init,
      destroy,
      start,
      pause,
      runOnce,
      render,
      renderVisibilityStatus,
      setScrollSpeed,
      setIntervalMs,
      handleRouteChange,
    };
  })();

  const navigationEvents = new AbortController();
  for (const method of ['pushState', 'replaceState']) {
    const original = history[method];
    history[method] = function (...args) {
      const result = original.apply(this, args);
      queueMicrotask(() => app.handleRouteChange());
      return result;
    };
  }
  global.addEventListener('popstate', () => app.handleRouteChange(), { signal: navigationEvents.signal });
  document.addEventListener('visibilitychange', () => scheduler.handleVisibilityChange(), { signal: navigationEvents.signal });
  global.addEventListener('pagehide', () => {
    navigationEvents.abort();
    app.destroy();
  }, { once: true });
  app.init();
})(typeof unsafeWindow !== 'undefined' ? unsafeWindow : window);
