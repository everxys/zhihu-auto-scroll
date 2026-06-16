// ==UserScript==
// @name         Zhihu Auto Expand All Answers
// @namespace    https://everxys.local/
// @version      1.4.0
// @description  自动展开知乎回答和评论回复，支持可取消滚动、增量处理、底部刷新、累计滚动时长和拖动面板
// @author       everxys
// @match        https://www.zhihu.com/question/*
// @run-at       document-idle
// @grant        none
// ==/UserScript==

(function (global) {
  'use strict';

  const STORAGE_KEY = 'zhihu-auto-expand-settings';
  const SETTINGS_VERSION = 4;
  const PANEL_ID = 'zhihu-auto-expand-panel';
  const SPEED_MIN = 0.5;
  const SPEED_MAX = 16;
  const INTERVAL_MIN = 200;
  const INTERVAL_MAX = 3000;
  const DEFAULT_SETTINGS = Object.freeze({
    version: SETTINGS_VERSION,
    scrollSpeed: 1,
    intervalMs: 700,
    expandComments: false,
    panelExpanded: false,
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
    maxCommentClickAttempts: 8,
    commentAppendDelayMs: 500,
    scrollSettleDelayMs: 140,
    scrollSettleTimeoutMs: 1800,
    progressStepDelayMs: 80,
    maxBottomBounceRounds: 8,
    maxIdleRounds: 10,
  });
  const ANSWER_SELECTOR =
    '.AnswerItem, .QuestionAnswer-content, .List-item[data-za-detail-view-path-module="AnswerItem"]';
  const ANSWER_LIST_SELECTOR =
    '.QuestionAnswers-answers, .Question-mainColumn .List, .Question-mainColumn';
  const QUESTION_ROOT_SELECTOR = '.Question-main, [data-zop-question-id]';
  const EXCLUDED_SELECTOR =
    `#${PANEL_ID}, .Question-sideColumn, header`;
  const CANDIDATE_SELECTOR = 'button, a, [role="button"]';
  const ANSWER_ACTIONS_SELECTOR = '.ContentItem-actions';
  const COMMENT_CONTAINER_SELECTOR =
    '.Comments-container, .CommentList, .CommentItem, .CommentItemV2, [class*="CommentItem"]';
  // Zhihu's comment popup can expose only `.Modal-content`, without role/aria-modal on the visible node.
  const DIALOG_SELECTOR =
    '[role="dialog"], .Modal, .Modal-wrapper, .ModalWrap, .ModalDialog, .Modal-content, [class*="Modal-content"], [class*="Modal"][aria-modal="true"]';
  const DIALOG_CLOSE_SELECTOR =
    'button[aria-label="关闭"], button[aria-label="Close"], .Modal-closeButton, .Modal-close, [class*="ModalClose"], [class*="Modal-close"]';
  const ANSWER_EXPAND_TEXT =
    /^(阅读全文|展开阅读全文|显示全部|展开全部|查看完整回答|继续阅读|阅读全部)$/;
  const LOAD_MORE_TEXT =
    /^(查看全部回答|点击显示全部回答|更多回答|加载更多|展开更多|查看全部\d+个?回答|还有\d+个?回答)$/;
  const OPEN_COMMENT_TEXT = /^(打开)?\d+条评论$/;
  const EXPAND_REPLY_TEXT = /^展开其他\d+条回复$/;
  const COMMENT_DIALOG_TEXT = /评论/;
  const AUTH_DIALOG_TEXT = /登录|注册|验证码|扫码|手机|密码/;
  const AUTH_DIALOG_CLASS = /signFlow|Login|login|Captcha|captcha/i;
  const DIALOG_TRIGGER_MARKER = /modal|dialog/i;
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

  function migrateSettings(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    return {
      version: SETTINGS_VERSION,
      scrollSpeed: clampScrollSpeed(source.scrollSpeed),
      intervalMs: clampIntervalMs(source.intervalMs),
      expandComments: source.expandComments === true,
      // Default collapsed on first install; once the user opens it, localStorage keeps that choice.
      panelExpanded: source.panelExpanded === true,
      panelPosition: normalizePosition(source.panelPosition),
    };
  }

  function createStorageAdapter() {
    function getRaw(key) {
      try {
        return global.localStorage?.getItem(key) ?? null;
      } catch (error) {
        console.warn('[Zhihu Auto Expand] storage read failed:', error);
        return null;
      }
    }

    function setRaw(key, value) {
      try {
        global.localStorage?.setItem(key, value);
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
        const settings = migrateSettings(current);
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

  function isBottomAnswerCommentTarget(element) {
    const answer = element?.closest?.(ANSWER_SELECTOR);
    const actions = element?.closest?.(ANSWER_ACTIONS_SELECTOR);
    if (!answer || !actions) return false;
    let current = actions;
    while (current && current !== answer) {
      const position = global.getComputedStyle(current).position;
      if (position === 'fixed' || position === 'sticky') return false;
      current = current.parentElement;
    }
    const answerRect = answer.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const inViewport = actionsRect.bottom > 0 && actionsRect.top < global.innerHeight;
    return inViewport && Math.abs(answerRect.bottom - actionsRect.bottom) <= 48;
  }

  function controlsDialog(element) {
    const ids = [
      element?.getAttribute?.('aria-controls'),
      element?.getAttribute?.('aria-owns'),
    ].filter(Boolean);
    return ids.some(id => {
      const target = global.document?.getElementById?.(id);
      return target?.matches?.(DIALOG_SELECTOR);
    });
  }

  function hasDialogTriggerMarker(element) {
    const attrNames = [
      'class',
      'id',
      'data-modal',
      'data-dialog',
      'data-popup',
      'data-testid',
      'data-za-detail-view-element_name',
      'data-za-extra-module',
    ];
    for (const name of attrNames) {
      if (DIALOG_TRIGGER_MARKER.test(String(element?.getAttribute?.(name) || ''))) return true;
    }
    const className = element?.className?.baseVal ?? element?.className;
    return DIALOG_TRIGGER_MARKER.test(String(className || ''));
  }

  function isKnownDialogCommentTrigger(element) {
    const popup = normalizeText(element?.getAttribute?.('aria-haspopup') || '').toLowerCase();
    return (
      popup === 'dialog' ||
      popup === 'true' ||
      controlsDialog(element) ||
      hasDialogTriggerMarker(element)
    );
  }

  function classifyTarget(element, options = {}) {
    if (!element || isExcludedElement(element) || isDisabled(element)) return null;
    const text = getElementText(element);
    if (!text) return null;
    if (
      options.expandComments &&
      element.closest?.(COMMENT_CONTAINER_SELECTOR) &&
      EXPAND_REPLY_TEXT.test(text)
    ) {
      return 'comment-reply';
    }
    if (
      options.expandComments &&
      OPEN_COMMENT_TEXT.test(text) &&
      isBottomAnswerCommentTarget(element) &&
      !isKnownDialogCommentTrigger(element)
    ) {
      return 'comment-entry';
    }
    if (
      !element.closest?.(COMMENT_CONTAINER_SELECTOR) &&
      element.closest?.(ANSWER_SELECTOR) &&
      ANSWER_EXPAND_TEXT.test(text)
    ) {
      return 'answer';
    }
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
    isBottomAnswerCommentTarget,
    isKnownDialogCommentTrigger,
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
    let progressDisplay = null;
    let displayedAnswerCount = null;
    let targetAnswerCount = 0;
    let progressTotal = '?';
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

    function updateProgress(answerCount, totalAnswerCount) {
      targetAnswerCount = answerCount;
      progressTotal = totalAnswerCount ?? '?';
      if (displayedAnswerCount === null || answerCount < displayedAnswerCount) {
        clearTimeout(progressDisplay);
        progressDisplay = null;
        displayedAnswerCount = answerCount;
      }
      refs.progress.textContent = `${displayedAnswerCount}/${progressTotal}`;
      if (displayedAnswerCount >= targetAnswerCount || progressDisplay) return;
      progressDisplay = setTimeout(function advanceProgress() {
        progressDisplay = null;
        if (!refs || displayedAnswerCount >= targetAnswerCount) return;
        displayedAnswerCount++;
        refs.progress.textContent = `${displayedAnswerCount}/${progressTotal}`;
        if (displayedAnswerCount < targetAnswerCount) {
          progressDisplay = setTimeout(advanceProgress, POLICY.progressStepDelayMs);
        }
      }, POLICY.progressStepDelayMs);
    }

    function render(snapshot) {
      if (!refs) return;
      const next = {
        state: snapshot.state,
        speed: snapshot.scrollSpeed,
        interval: snapshot.intervalMs,
        expandComments: snapshot.expandComments,
        panelExpanded: snapshot.panelExpanded,
        duration: formatDuration(snapshot.totalScrollMs),
        status: statusText,
      };
      if (next.panelExpanded !== lastRender.panelExpanded) {
        root.classList.toggle('is-collapsed', !next.panelExpanded);
        refs.openPanel.setAttribute('aria-expanded', String(next.panelExpanded));
        refs.hidePanel.setAttribute('aria-expanded', String(next.panelExpanded));
        keepInViewport();
        requestAnimationFrame(keepInViewport);
      }
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
      if (next.expandComments !== lastRender.expandComments) {
        refs.commentToggle.setAttribute('aria-pressed', String(next.expandComments));
        refs.commentToggle.textContent = next.expandComments ? '展开评论：开' : '展开评论：关';
        refs.commentToggle.classList.toggle('is-active', next.expandComments);
      }
      if (next.duration !== lastRender.duration) refs.timer.textContent = next.duration;
      updateProgress(snapshot.answerCount, snapshot.totalAnswerCount);
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

    function bindDragHandle(handle, options = {}) {
      let dragging = false;
      let pointerDown = false;
      let offsetX = 0;
      let offsetY = 0;
      let startX = 0;
      let startY = 0;
      handle.addEventListener(
        'pointerdown',
        event => {
          if (options.ignoreButtonTarget && event.target?.closest?.('button')) return;
          pointerDown = true;
          dragging = false;
          startX = event.clientX;
          startY = event.clientY;
          handle.setPointerCapture?.(event.pointerId);
          const rect = root.getBoundingClientRect();
          offsetX = event.clientX - rect.left;
          offsetY = event.clientY - rect.top;
          moveTo(rect.left, rect.top);
        },
        { signal: events.signal }
      );
      handle.addEventListener(
        'pointermove',
        event => {
          if (!pointerDown) return;
          if (!dragging && Math.hypot(event.clientX - startX, event.clientY - startY) < 4) return;
          dragging = true;
          if (dragging) moveTo(event.clientX - offsetX, event.clientY - offsetY);
          event.preventDefault();
        },
        { signal: events.signal }
      );
      handle.addEventListener(
        'pointerup',
        event => {
          if (!pointerDown) return;
          pointerDown = false;
          handle.releasePointerCapture?.(event.pointerId);
          if (!dragging) return;
          dragging = false;
          const rect = root.getBoundingClientRect();
          settings.panelPosition = { left: rect.left, top: rect.top };
          storage.save(settings);
          options.onDragged?.();
          event.preventDefault();
        },
        { signal: events.signal }
      );
    }

    function bindDrag() {
      let suppressOpenClick = false;
      let suppressOpenClickTimer = null;
      bindDragHandle(refs.title, { ignoreButtonTarget: true });
      bindDragHandle(refs.openPanel, {
        onDragged: () => {
          suppressOpenClick = true;
          clearTimeout(suppressOpenClickTimer);
          suppressOpenClickTimer = setTimeout(() => {
            suppressOpenClick = false;
            suppressOpenClickTimer = null;
          }, 0);
        },
      });
      refs.openPanel.addEventListener('click', event => {
        if (!suppressOpenClick) return;
        suppressOpenClick = false;
        clearTimeout(suppressOpenClickTimer);
        suppressOpenClickTimer = null;
        event.preventDefault();
        event.stopImmediatePropagation();
      }, { signal: events.signal, capture: true });
    }

    function panelTemplate() {
      return `
        <button type="button" class="zae-open-panel" aria-label="打开知乎展开面板" aria-expanded="false">展</button>
        <div class="zae-panel-body">
          <div class="zae-title">
            <span>知乎展开</span>
            <button type="button" class="zae-hide-panel" aria-label="隐藏知乎展开面板" aria-expanded="true">隐藏</button>
          </div>
          <div class="zae-status" aria-live="polite">未开始</div>
          <div class="zae-progress">已发现回答 <strong class="zae-progress-value">0/?</strong></div>
          <div class="zae-timer">累计滚动 <span class="zae-timer-value">00:00:00</span></div>
          <button type="button" class="zae-start">开始</button>
          <button type="button" class="zae-pause">暂停</button>
          <button type="button" class="zae-comment-toggle" aria-pressed="false">展开评论：关</button>
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
          </div>
        </div>`;
    }

    function panelStyles() {
      return `
        #${PANEL_ID}{position:fixed;right:16px;top:50%;transform:translateY(-50%);z-index:999999;width:176px;padding:10px;border-radius:12px;background:rgba(255,255,255,.96);box-shadow:0 4px 18px rgba(0,0,0,.2);font:13px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#111;user-select:none}
        #${PANEL_ID}.is-collapsed{width:auto;padding:0;border-radius:999px;background:transparent;box-shadow:none}
        #${PANEL_ID}.is-collapsed .zae-panel-body{display:none}
        #${PANEL_ID} .zae-open-panel{display:none;width:44px;height:44px;border-radius:999px;background:#2563eb;color:#fff;box-shadow:0 4px 18px rgba(0,0,0,.22);font-size:16px;touch-action:none}
        #${PANEL_ID}.is-collapsed .zae-open-panel{display:block}
        #${PANEL_ID} .zae-title{display:flex;align-items:center;justify-content:space-between;font-weight:700;margin-bottom:6px;cursor:move;touch-action:none}
        #${PANEL_ID} .zae-hide-panel{padding:3px 6px;border-radius:6px;background:#f3f4f6;color:#4b5563;font-size:11px}
        #${PANEL_ID} .zae-status,#${PANEL_ID} .zae-progress,#${PANEL_ID} .zae-timer{font-size:12px;text-align:center;margin-bottom:6px;line-height:1.4}
        #${PANEL_ID} .zae-status{color:#666;min-height:17px}#${PANEL_ID} .zae-timer{color:#333;padding:4px 6px;border-radius:6px;background:rgba(37,99,235,.08)}
        #${PANEL_ID} .zae-progress-value,#${PANEL_ID} .zae-timer-value,#${PANEL_ID} .zae-section-head span:last-child{font-weight:700;color:#2563eb}
        #${PANEL_ID} button{border:0;cursor:pointer;font-weight:600}#${PANEL_ID} button:disabled{opacity:.45;cursor:not-allowed}
        #${PANEL_ID} .zae-start,#${PANEL_ID} .zae-pause{width:100%;margin-top:6px;padding:7px 8px;border-radius:7px;font-size:12px;color:#fff}
        #${PANEL_ID} .zae-start{background:#16a34a}#${PANEL_ID} .zae-pause{background:#f59e0b}
        #${PANEL_ID} .zae-comment-toggle{width:100%;margin-top:6px;padding:7px 8px;border-radius:7px;font-size:12px;background:#e5e7eb;color:#374151}
        #${PANEL_ID} .zae-comment-toggle.is-active{background:#2563eb;color:#fff}
        #${PANEL_ID} .zae-section{margin-top:10px;padding-top:8px;border-top:1px solid rgba(0,0,0,.08)}
        #${PANEL_ID} .zae-section-head{display:flex;justify-content:space-between;font-size:12px;color:#333;margin-bottom:4px}
        #${PANEL_ID} input{width:100%;cursor:pointer}#${PANEL_ID} .zae-presets{display:grid;gap:4px;margin-top:6px}
        #${PANEL_ID} .zae-speed-presets{grid-template-columns:repeat(5,1fr)}#${PANEL_ID} .zae-interval-presets{grid-template-columns:repeat(4,1fr)}
        #${PANEL_ID} .zae-presets button{padding:5px 0;border-radius:6px;background:#e5e7eb;color:#374151;font-size:11px}
        #${PANEL_ID} .zae-presets button.is-active{background:#2563eb;color:#fff}`;
    }

    function create() {
      if (root || !document.body) return;
      events = new AbortController();
      root = document.createElement('section');
      root.id = PANEL_ID;
      root.setAttribute('aria-label', '知乎自动展开控制');
      root.innerHTML = panelTemplate();
      style = document.createElement('style');
      style.textContent = panelStyles();
      document.documentElement.appendChild(style);
      document.body.appendChild(root);
      refs = {
        openPanel: root.querySelector('.zae-open-panel'),
        hidePanel: root.querySelector('.zae-hide-panel'),
        title: root.querySelector('.zae-title'),
        status: root.querySelector('.zae-status'),
        progress: root.querySelector('.zae-progress-value'),
        timer: root.querySelector('.zae-timer-value'),
        start: root.querySelector('.zae-start'),
        pause: root.querySelector('.zae-pause'),
        commentToggle: root.querySelector('.zae-comment-toggle'),
        speedRange: root.querySelector('.zae-speed-range'),
        speedValue: root.querySelector('.zae-speed-value'),
        speedPresets: [...root.querySelectorAll('[data-speed]')],
        intervalRange: root.querySelector('.zae-interval-range'),
        intervalValue: root.querySelector('.zae-interval-value'),
        intervalPresets: [...root.querySelectorAll('[data-interval]')],
      };
      refs.openPanel.addEventListener('click', () => app.setPanelExpanded(true), { signal: events.signal });
      refs.hidePanel.addEventListener('click', () => app.setPanelExpanded(false), { signal: events.signal });
      refs.start.addEventListener('click', () => app.start(), { signal: events.signal });
      refs.pause.addEventListener('click', () => app.pause(), { signal: events.signal });
      refs.commentToggle.addEventListener('click', () => app.toggleExpandComments(), { signal: events.signal });
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
      clearTimeout(progressDisplay);
      progressDisplay = null;
      displayedAnswerCount = null;
      targetAnswerCount = 0;
      progressTotal = '?';
      events?.abort();
      root?.remove();
      style?.remove();
      root = style = refs = events = null;
      lastRender = {};
    }

    return { create, destroy, render, setStatus, startTimer, stopTimer, contains: node => root?.contains(node) };
  })();

  const clickClassifier = Object.freeze({
    typeOf(element) {
      return classifyTarget(element, { expandComments: settings.expandComments });
    },
    maxAttempts(type) {
      return type === 'comment-entry' ? POLICY.maxCommentClickAttempts : POLICY.maxClickAttempts;
    },
    isCommentType(type) {
      return type === 'comment-entry' || type === 'comment-reply';
    },
  });

  const expander = (() => {
    let pendingRoots = new Set();
    let retryElements = new Set();
    let attempts = new WeakMap();
    let completed = new WeakSet();
    let pendingCommentEntries = new Set();
    let knownDialogs = new WeakSet();
    let recentlyClickedCommentEntries = new Set();
    let seenAnswerIds = new Set();
    let seenAnswerNodes = new WeakSet();
    let observedCommentActions = new WeakSet();
    let scannedCommentActionRoots = new WeakSet();
    let visibleCommentActions = new Set();
    let commentActionObserver = null;
    let answerCount = 0;
    let needsInitialScan = true;

    function getCommentActionObserver() {
      if (commentActionObserver || typeof global.IntersectionObserver !== 'function') return commentActionObserver;
      commentActionObserver = new global.IntersectionObserver(entries => {
        entries.forEach(entry => {
          if (entry.isIntersecting) visibleCommentActions.add(entry.target);
          else visibleCommentActions.delete(entry.target);
        });
      }, { root: null, rootMargin: '120px 0px 120px 0px', threshold: 0 });
      return commentActionObserver;
    }

    function observeCommentActions(root) {
      if (!root) return;
      if (root.matches?.(CANDIDATE_SELECTOR) && !root.matches?.(ANSWER_ACTIONS_SELECTOR)) return;
      if (scannedCommentActionRoots.has(root)) return;
      scannedCommentActionRoots.add(root);
      const actions = [];
      if (root.matches?.(ANSWER_ACTIONS_SELECTOR)) actions.push(root);
      root.querySelectorAll?.(ANSWER_ACTIONS_SELECTOR).forEach(actionsRoot => actions.push(actionsRoot));
      actions.forEach(actionsRoot => {
        if (observedCommentActions.has(actionsRoot) || !actionsRoot.closest?.(ANSWER_SELECTOR)) return;
        observedCommentActions.add(actionsRoot);
        const observer = getCommentActionObserver();
        if (observer) observer.observe(actionsRoot);
        else visibleCommentActions.add(actionsRoot);
      });
    }

    function discoverAnswers(root) {
      const answers = [];
      if (root?.matches?.(ANSWER_SELECTOR)) answers.push(root);
      root?.querySelectorAll?.(ANSWER_SELECTOR).forEach(answer => answers.push(answer));
      observeCommentActions(root);
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

    function forEachCandidate(root, callback) {
      if (root?.matches?.(CANDIDATE_SELECTOR)) callback(root);
      root?.querySelectorAll?.(CANDIDATE_SELECTOR).forEach(callback);
    }

    function queueVisibleCommentEntries() {
      if (!settings.expandComments) return;
      visibleCommentActions.forEach(actions => {
        if (!actions.isConnected) {
          visibleCommentActions.delete(actions);
          return;
        }
        pendingRoots.add(actions);
      });
    }

    function isCommentEntryOpen(element) {
      const answer = element?.closest?.(ANSWER_SELECTOR);
      const scope = answer?.closest?.('.List-item') || answer;
      return Boolean(
        scope?.querySelector?.(COMMENT_CONTAINER_SELECTOR) ||
        getElementText(element).includes('收起评论')
      );
    }

    function getOpenDialogs() {
      return [...document.querySelectorAll(DIALOG_SELECTOR)].filter(isVisible);
    }

    function rememberOpenDialogs() {
      getOpenDialogs().forEach(dialog => knownDialogs.add(dialog));
    }

    function isCommentDialog(dialog) {
      return COMMENT_DIALOG_TEXT.test(getElementText(dialog));
    }

    function isAuthDialog(dialog) {
      return (
        AUTH_DIALOG_CLASS.test(String(dialog?.className || '')) ||
        AUTH_DIALOG_TEXT.test(getElementText(dialog))
      );
    }

    function firstUsableCloseButton(elements) {
      return elements.find(button => isVisible(button) && !isDisabled(button));
    }

    function findDialogCloseButton(dialog) {
      const scopedCloseButton = firstUsableCloseButton(
        [...(dialog.querySelectorAll?.(DIALOG_CLOSE_SELECTOR) || [])]
      );
      if (scopedCloseButton) return scopedCloseButton;
      // In the current Zhihu comment modal, the close button is a sibling of `.Modal-content`.
      return firstUsableCloseButton([...document.querySelectorAll(DIALOG_CLOSE_SELECTOR)]);
    }

    function closeDialog(dialog) {
      const closeButton = findDialogCloseButton(dialog);
      if (closeButton) {
        closeButton.click();
        return true;
      }
      document.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape',
        code: 'Escape',
        keyCode: 27,
        bubbles: true,
        cancelable: true,
      }));
      return true;
    }

    function closeUnexpectedCommentDialogs() {
      let closedCount = 0;
      let blockedByAuth = false;
      const hasRecentCommentEntry = recentlyClickedCommentEntries.size > 0;
      for (const dialog of getOpenDialogs()) {
        if (knownDialogs.has(dialog)) continue;
        if (isAuthDialog(dialog)) {
          blockedByAuth = true;
          continue;
        }
        if (!hasRecentCommentEntry && !isCommentDialog(dialog)) continue;
        if (closeDialog(dialog)) closedCount++;
      }
      if (closedCount > 0 || blockedByAuth) {
        recentlyClickedCommentEntries.forEach(element => {
          pendingCommentEntries.delete(element);
          retryElements.delete(element);
          completed.add(element);
          attempts.delete(element);
        });
      }
      recentlyClickedCommentEntries.clear();
      return closedCount;
    }

    function clickCandidate(element, now, getTargetType) {
      if (!element || completed.has(element)) return null;
      const record = attempts.get(element);
      if (record) {
        if (isCommentEntryOpen(element)) {
          pendingCommentEntries.delete(element);
          completed.add(element);
          return null;
        }
        const changed =
          !element.isConnected ||
          getElementText(element) !== record.text ||
          (record.type !== 'comment-entry' && !getTargetType(element));
        if (changed) {
          pendingCommentEntries.delete(element);
          completed.add(element);
          return null;
        }
        const maxAttempts = clickClassifier.maxAttempts(record.type);
        if (record.count >= maxAttempts || now - record.at < POLICY.clickRetryCooldownMs) {
          if (record.count >= maxAttempts) pendingCommentEntries.delete(element);
          return null;
        }
      }
      const type = getTargetType(element);
      if (!type) return null;
      if (!isVisible(element)) return null;
      try {
        if (type === 'comment-entry') rememberOpenDialogs();
        element.click();
        attempts.set(element, { count: (record?.count || 0) + 1, at: now, text: getElementText(element), type });
        if (type === 'comment-entry') {
          pendingCommentEntries.add(element);
          recentlyClickedCommentEntries.add(element);
        }
        return type;
      } catch (error) {
        console.warn('[Zhihu Auto Expand] expand click failed:', error);
        return null;
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
      pendingCommentEntries.forEach(element => pendingRoots.add(element));
      retryElements.clear();
      const roots = [...pendingRoots];
      pendingRoots.clear();
      let clickedCount = 0;
      let commentClicked = false;
      let clickedCommentEntryThisRun = false;
      const now = Date.now();
      const targetCache = new WeakMap();
      const getTargetType = element => {
        if (targetCache.has(element)) return targetCache.get(element);
        const type = clickClassifier.typeOf(element);
        targetCache.set(element, type);
        return type;
      };
      for (const root of roots) {
        throwIfAborted(signal);
        discoverAnswers(root);
        forEachCandidate(root, element => {
          if (getTargetType(element) === 'comment-entry' && clickedCommentEntryThisRun) {
            retryElements.add(element);
            return;
          }
          const clickedType = clickCandidate(element, now, getTargetType);
          if (clickedType) {
            clickedCount++;
            if (clickedType === 'comment-entry') clickedCommentEntryThisRun = true;
            if (clickClassifier.isCommentType(clickedType)) commentClicked = true;
          }
          const record = attempts.get(element);
          const maxAttempts = clickClassifier.maxAttempts(record?.type);
          if (!completed.has(element) && getTargetType(element) && record?.count < maxAttempts) {
            retryElements.add(element);
          }
        });
      }
      return { clickedCount, commentClicked };
    }

    function reset() {
      pendingRoots = new Set();
      retryElements = new Set();
      attempts = new WeakMap();
      completed = new WeakSet();
      pendingCommentEntries = new Set();
      knownDialogs = new WeakSet();
      recentlyClickedCommentEntries = new Set();
      seenAnswerIds = new Set();
      seenAnswerNodes = new WeakSet();
      commentActionObserver?.disconnect();
      commentActionObserver = null;
      observedCommentActions = new WeakSet();
      scannedCommentActionRoots = new WeakSet();
      visibleCommentActions = new Set();
      answerCount = 0;
      needsInitialScan = true;
    }

    return {
      queueRoots,
      queueVisibleCommentEntries,
      closeUnexpectedCommentDialogs,
      processPending,
      reset,
      getAnswerCount: () => answerCount,
      hasPendingCommentEntry: () => pendingCommentEntries.size > 0,
      clearPendingCommentEntries: () => pendingCommentEntries.clear(),
    };
  })();

  const scroller = (() => {
    let bottomBounceRounds = 0;
    const getTop = () => global.scrollY || document.documentElement.scrollTop || document.body.scrollTop || 0;
    const getHeight = () => Math.max(document.documentElement.scrollHeight, document.body.scrollHeight);
    const getViewport = () => global.innerHeight || document.documentElement.clientHeight;
    const nearBottom = () => getTop() + getViewport() >= getHeight() - POLICY.bottomThresholdPx;
    const behavior = () => 'smooth';
    const distance = () => {
      const requested = Math.max(600, global.innerHeight * 0.8) * settings.scrollSpeed;
      return settings.expandComments ? Math.min(requested, global.innerHeight * 0.65) : requested;
    };

    function waitForScrollSettle(signal) {
      if (!settings.expandComments) return abortableSleep(POLICY.normalScrollSettleMs, signal);
      throwIfAborted(signal);
      return new Promise((resolve, reject) => {
        let settleTimer = null;
        const timeoutTimer = setTimeout(finish, POLICY.scrollSettleTimeoutMs);
        function finish() {
          clearTimeout(settleTimer);
          clearTimeout(timeoutTimer);
          global.removeEventListener('scroll', onScroll);
          signal?.removeEventListener('abort', onAbort);
          resolve();
        }
        function onScroll() {
          clearTimeout(settleTimer);
          settleTimer = setTimeout(finish, POLICY.scrollSettleDelayMs);
        }
        function onAbort() {
          clearTimeout(settleTimer);
          clearTimeout(timeoutTimer);
          global.removeEventListener('scroll', onScroll);
          reject(signal.reason || abortError());
        }
        global.addEventListener('scroll', onScroll, { passive: true });
        signal?.addEventListener('abort', onAbort, { once: true });
        settleTimer = setTimeout(finish, POLICY.scrollSettleDelayMs);
      });
    }

    async function bounce(signal) {
      const beforeHeight = getHeight();
      bottomBounceRounds++;
      const upDistance = Math.max(400, global.innerHeight * POLICY.bottomBounceUpRatio);
      throwIfAborted(signal);
      global.scrollBy({ top: -upDistance, behavior: behavior() });
      await waitForScrollSettle(signal);
      await abortableSleep(POLICY.bottomBounceDelayMs, signal);
      throwIfAborted(signal);
      global.scrollTo({ top: getHeight(), behavior: behavior() });
      await waitForScrollSettle(signal);
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
        await waitForScrollSettle(signal);
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
        expandComments: settings.expandComments,
        panelExpanded: settings.panelExpanded,
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
        expander.queueVisibleCommentEntries();
        const { clickedCount, commentClicked } = expander.processPending(signal);
        if (clickedCount > 0) await abortableSleep(POLICY.afterClickDelayMs, signal);
        if (commentClicked) expander.closeUnexpectedCommentDialogs();
        if (document.hidden) {
          panel.setStatus('后台标签页：等待恢复');
          return;
        }
        const scrollChanged = commentClicked || expander.hasPendingCommentEntry()
          ? (
              await abortableSleep(POLICY.commentAppendDelayMs, signal),
              expander.closeUnexpectedCommentDialogs(),
              false
            )
          : await scroller.scrollPage(signal);
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

    function toggleExpandComments() {
      settings.expandComments = !settings.expandComments;
      storage.save(settings);
      if (settings.expandComments) {
        const root = document.querySelector(ANSWER_LIST_SELECTOR) || document.querySelector(QUESTION_ROOT_SELECTOR);
        if (root) expander.queueRoots([root]);
        scheduler.requestSoon();
      } else {
        expander.clearPendingCommentEntries();
      }
      render();
    }

    function setPanelExpanded(expanded) {
      settings.panelExpanded = expanded === true;
      storage.save(settings);
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

    function shouldExposeDebugApi() {
      return storage.getDebugEnabled() || global.__ZAE_AUTOMATION__ === true;
    }

    function exposeDebugApi() {
      if (!shouldExposeDebugApi()) return;
      const api = Object.freeze({
        start,
        pause,
        runOnce: () => scheduler.requestSoon(),
        setScrollSpeed,
        setIntervalMs,
        toggleExpandComments,
        setPanelExpanded,
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
      toggleExpandComments,
      setPanelExpanded,
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
