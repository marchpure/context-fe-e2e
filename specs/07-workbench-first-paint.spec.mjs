// 模块 07：工作台首屏红线（CTX-013）、真实点击「调试台」等待可选版本/可用模型/输入区、空输入防提交及历史对话/网络健康检查

import {
  KNOWN_FIXTURES,
  assertOrderedBoxes,
  cdpClickPoint,
  cdpPressKey,
  restoreSafeWorkspace,
  validateStepTerminalState,
  validateWorkbenchReadyView,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';

async function readWorkbenchChatDom(page) {
  return page.evalJSON(() => {
    const activeTabEl = document.querySelector(
      '.arco-tabs-header-title-active, [role="tab"][aria-selected="true"]'
    );
    const chatTabActive = (activeTabEl?.textContent || '').trim() === '调试台';
    const hasSpin = Boolean(
      document.querySelector('.console-content-wrapper-v2 .arco-spin-loading, .spin-center')
    );

    const readSelect = ariaLabel => {
      const el = document.querySelector(`[aria-label="${ariaLabel}"]`);
      if (!el) return { visible: false, width: 0, height: 0, text: '', disabled: true };
      const root = el.closest('.arco-select') || el;
      const r = root.getBoundingClientRect();
      const disabled =
        el.getAttribute('aria-disabled') === 'true' ||
        root.classList.contains('arco-select-disabled') ||
        Boolean(el.disabled);
      return {
        visible: r.width > 0 && r.height > 0,
        x: r.x + r.width / 2,
        y: r.y + r.height / 2,
        width: Math.round(r.width),
        height: Math.round(r.height),
        text: (root.innerText || root.textContent || '').replace(/\s+/g, ' ').trim(),
        disabled,
      };
    };

    const composerEl =
      document.querySelector('.context-workbench-chatkit [data-chatkit-composer-rich-text-area] [contenteditable="true"]') ||
      document.querySelector('.context-workbench-chatkit .chatkit-composer-rich-text-area [contenteditable="true"]') ||
      document.querySelector('.context-workbench-chatkit textarea');
    const cr = composerEl?.getBoundingClientRect();
    const composerDisabled = Boolean(
      !composerEl ||
        composerEl.disabled ||
        composerEl.getAttribute('aria-disabled') === 'true'
    );

    const bodyText = (document.querySelector('.console-content-wrapper-v2')?.innerText || '').slice(
      0,
      1500
    );

    return {
      chatTabActive,
      hasSpin,
      domainPicker: readSelect('业务领域与版本'),
      modelPicker: readSelect('模型'),
      composer: composerEl
        ? {
            visible: Boolean(cr && cr.width > 0 && cr.height > 0),
            x: cr ? cr.x + cr.width / 2 : 0,
            y: cr ? cr.y + cr.height / 2 : 0,
            width: Math.round(cr?.width || 0),
            height: Math.round(cr?.height || 0),
            value: (composerEl.value ?? composerEl.innerText ?? '').replace(/\u200b/g, ''),
            disabled: composerDisabled,
          }
        : { visible: false, width: 0, height: 0, value: '', disabled: true },
      bodyText,
    };
  });
}

async function inspectSelectPopupOptions(page, pickerCenter) {
  await cdpClickPoint(page, pickerCenter.x, pickerCenter.y);
  const popup = await waitForTerminalDom(
    page,
    () => {
      const options = [...document.querySelectorAll('.arco-select-popup .arco-select-option')].filter(
        el => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && r.height > 0;
        }
      );
      if (options.length === 0) return false;
      return options.map(el => ({
        text: (el.textContent || '').trim(),
        disabled:
          el.getAttribute('aria-disabled') === 'true' ||
          el.classList.contains('arco-select-option-disabled'),
      }));
    },
    { timeoutMs: 6000, settleMs: 100 }
  );
  await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  await page.sleep(150);
  return popup.ok && Array.isArray(popup.value) ? popup.value : [];
}

export async function run(t, page, cfg) {
  let chatReady = false;

  await t.checkKnownBug(
    'CTX-013',
    `工作台 (/context/workbench) 首屏在 ${cfg.slo.pageFirstContentMaxMs}ms 红线内收敛且「概览 / 调试台」胶囊页签顺序尺寸有效`,
    async () => {
      const step = '07-workbench-first-paint';
      const nav = await page.gotoContext('/context/workbench', {
        stepName: step,
        timeoutMs: 20000,
        readyFn: () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const tabs = [...document.querySelectorAll('[role="tab"], .arco-tabs-header-title')].filter(
            el => {
              const txt = (el.textContent || '').trim();
              const r = el.getBoundingClientRect();
              return (txt === '概览' || txt === '调试台') && r.width > 20 && r.height > 18;
            }
          );
          if (tabs.length < 2) return false;
          const visible = el => Boolean(el?.getClientRects().length);
          const overview = document.querySelector('[class*="overviewPane"]');
          const hasOverview = visible(overview) && /让智能体理解你的业务|无法读取工作台数据/.test(
            overview.innerText || ''
          );
          const editor = document.querySelector(
            '.context-workbench-chatkit [contenteditable="true"], .context-workbench-chatkit textarea'
          );
          const domainPicker = document.querySelector('[aria-label="业务领域与版本"]');
          const hasChat = visible(editor) && visible(domainPicker?.closest('.arco-select') || domainPicker);
          const hasCoreBody = hasOverview || hasChat;
          return hasCoreBody ? { firstTabs: tabs.length } : false;
        },
      });

      await waitForTerminalDom(
        page,
        () => !document.querySelector('.spin-center, .arco-spin-loading'),
        { timeoutMs: 8000 }
      );
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '工作台首屏渲染',
        forbidWrite: true,
      });

      if (/无法读取工作台数据/.test(oracle.visibleText)) {
        throw new Error('工作台首屏展示「无法读取工作台数据，请重试。」错误态');
      }

      const capsuleTabs = await page.evalJSON(() =>
        [...document.querySelectorAll('[role="tab"], .arco-tabs-header-title')]
          .map(el => {
            const r = el.getBoundingClientRect();
            return { label: (el.textContent || '').trim(), x: r.x, y: r.y, width: r.width, height: r.height };
          })
          .filter(x => x.label === '概览' || x.label === '调试台')
      );
      assertOrderedBoxes(capsuleTabs, ['概览', '调试台'], {
        axis: 'x',
        contextLabel: '工作台顶部胶囊页签',
      });

      if (!nav.settledOk || nav.firstContentMs > cfg.slo.pageFirstContentMaxMs) {
        // Exact CTX-013 symptom
        throw new Error(
          `工作台首屏渲染耗时超标: 实测=${nav.firstContentMs}ms (红线 <= ${cfg.slo.pageFirstContentMaxMs}ms)`
        );
      }
      return `工作台首屏达标: ${nav.firstContentMs}ms (APIs=${oracle.records.length})`;
    }
  );

  await t.check(
    '工作台真实点击「调试台」页签并等待可选领域版本、可用模型与输入区完全就绪',
    async () => {
      const step = '07-workbench-click-chat-ready';
      page.setStep(step);

      const chatTab = await page.evalJSON(() => {
        const el = [...document.querySelectorAll('[role="tab"], .arco-tabs-header-title')].find(
          node => (node.textContent || '').trim() === '调试台'
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      });
      if (!chatTab) {
        throw new Error('工作台缺少「调试台」胶囊页签入口');
      }

      await cdpClickPoint(page, chatTab.x, chatTab.y);

      const settled = await waitForTerminalDom(
        page,
        () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const domPicker = document.querySelector('[aria-label="业务领域与版本"]');
          const modPicker = document.querySelector('[aria-label="模型"]');
          if (!domPicker || !modPicker) return false;
          const domTxt = (domPicker.innerText || domPicker.textContent || '').trim();
          const modTxt = (modPicker.innerText || modPicker.textContent || '').trim();
          if (/加载领域/.test(domTxt) || /加载模型/.test(modTxt)) return false;
          return true;
        },
        { timeoutMs: 16000 }
      );

      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '切换调试台等待模型与领域版本就绪',
        forbidWrite: true,
      });
      if (!settled.ok) {
        throw new Error('点击「调试台」后领域或模型选择器持续处于加载态超时');
      }

      const state = await readWorkbenchChatDom(page);
      if (
        cfg.workspaceId !== KNOWN_FIXTURES.workspaceId &&
        state.domainPicker.disabled &&
        /选择领域版本/.test(state.domainPicker.text)
      ) {
        t.block(
          '工作台真实点击「调试台」页签并等待可选领域版本、可用模型与输入区完全就绪',
          `工作区 ${cfg.workspaceId} 无已发布或可调试草稿领域，调试台输入区按预期禁用`
        );
        return;
      }

      const readySummary = validateWorkbenchReadyView(state);

      // 展开「业务领域与版本」下拉框确认真实可选版本项（如 codex-e2e-r4-domain-1125 · v1.0.2）
      const domainOptions = await inspectSelectPopupOptions(page, state.domainPicker);
      const enabledDomainOptions = domainOptions.filter(o => !o.disabled);
      if (enabledDomainOptions.length === 0) {
        throw new Error('点击「业务领域与版本」下拉框未展示任何可选的领域版本项');
      }
      if (cfg.workspaceId === KNOWN_FIXTURES.workspaceId) {
        const hasR4Option = enabledDomainOptions.some(o =>
          o.text.includes(KNOWN_FIXTURES.r4Domain.domainName)
        );
        if (!hasR4Option) {
          throw new Error(
            `调试台领域版本下拉列表缺少 ${KNOWN_FIXTURES.r4Domain.domainName}（实际: ${enabledDomainOptions.map(o => o.text).join(' | ')}）`
          );
        }
      }

      // 展开「模型」下拉框确认至少 1 个可用工具调用模型
      const modelOptions = await inspectSelectPopupOptions(page, state.modelPicker);
      const usableModels = modelOptions.filter(o => !o.disabled);
      if (usableModels.length === 0) {
        throw new Error('点击「模型」下拉框未发现任何可用（非 disabled）的 Context 模型');
      }

      const afterPopupOracle = await page.collectStepOracle(step);
      validateStepTerminalState(afterPopupOracle, cfg, {
        stepLabel: '调试台展开版本与模型下拉选项核验',
        forbidWrite: true,
      });

      chatReady = true;
      return `domain="${readySummary.selectedDomain}" (可选=${enabledDomainOptions.length}), model="${readySummary.selectedModel}" (可用=${usableModels.length}), composer=${readySummary.composerSize}`;
    }
  );

  await t.check(
    '调试台空输入状态下无法提交，聚焦按回车后不产生任何对话消息或会话/流式请求',
    async () => {
      if (!chatReady) {
        t.block(
          '调试台空输入状态下无法提交，聚焦按回车后不产生任何对话消息或会话/流式请求',
          '前置调试台输入区未就绪，跳过空输入防提交检查'
        );
        return;
      }

      const step = '07-workbench-empty-submit-guard';
      page.setStep(step);

      const beforeState = await readWorkbenchChatDom(page);
      if (beforeState.composer.value.trim() !== '') {
        throw new Error('新调试台输入区已有文字，无法安全验证空内容提交');
      }

      await cdpClickPoint(page, beforeState.composer.x, beforeState.composer.y);
      await cdpPressKey(page, 'Enter', 'Enter', 13);
      await page.sleep(600);

      const afterCheck = await page.evalJSON(() => {
        const root = document.querySelector('.context-workbench-chatkit') || document.body;
        const sendButton = root.querySelector('button[data-chatkit-composer-send-button]');
        return {
          hasEnabledSendOnEmpty: Boolean(sendButton &&
            !sendButton.disabled && sendButton.getAttribute('aria-disabled') !== 'true'),
          isStreaming: sendButton?.getAttribute('aria-label') === 'stop',
        };
      });

      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '调试台空输入防提交校验',
        forbidWrite: true,
      });

      if (afterCheck.hasEnabledSendOnEmpty) {
        throw new Error('调试台输入为空时发送按钮仍处于可点击启用状态');
      }
      if (afterCheck.isStreaming) {
        throw new Error('调试台输入为空按回车后意外进入了流式生成状态');
      }
      if (oracle.records.length > 0) {
        throw new Error(
          `调试台空输入按回车后意外发出了后端请求: ${oracle.records.map(r => r.action).join(', ')}`
        );
      }

      return '空输入按回车零请求发出，未进入发送流式态';
    }
  );

  await t.check(
    '调试台真实点击「历史对话」浮层正常加载历史记录或空态，全链路网络终态无挂起零报错',
    async () => {
      if (!chatReady) {
        t.block(
          '调试台真实点击「历史对话」浮层正常加载历史记录或空态，全链路网络终态无挂起零报错',
          '前置调试台未就绪，跳过历史对话浮层检查'
        );
        return;
      }

      const step = '07-workbench-history-and-network';
      page.setStep(step);

      try {
        const toolbarInfo = await page.evalJSON(() => {
          const newBtn = document.querySelector('button[aria-label="新对话"]');
          const histBtn = document.querySelector('button[aria-label="历史对话"]');
          const taskBtn = document.querySelector('button[aria-label="任务面板"]');
          const box = el => {
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
          };
          return {
            newBtn: box(newBtn),
            histBtn: box(histBtn),
            taskBtn: box(taskBtn),
          };
        });

        if (
          !toolbarInfo?.histBtn ||
          !(toolbarInfo.histBtn.width > 16 && toolbarInfo.histBtn.height > 16) ||
          !toolbarInfo?.newBtn ||
          !toolbarInfo?.taskBtn
        ) {
          throw new Error('调试台右上角工具栏缺少「新对话 / 历史对话 / 任务面板」按钮');
        }

        // 真实点击「历史对话」按钮（严禁点击列表内的「删除对话」图标按钮）
        await cdpClickPoint(page, toolbarInfo.histBtn.x, toolbarInfo.histBtn.y);

        const popSettled = await waitForTerminalDom(
          page,
          () => {
            const pop = document.querySelector('.arco-popover-content, .arco-trigger-popup');
            if (!pop) return false;
            const r = pop.getBoundingClientRect();
            if (!(r.width >= 160 && r.height >= 50)) return false;
            const txt = (pop.innerText || '').trim();
            if (/正在加载/.test(txt)) return false;
            if (/加载失败，重试/.test(txt)) return { loadError: true, text: txt };
            const items = [...pop.querySelectorAll('.arco-list-item')].map(li =>
              (li.innerText || '').replace(/\s+/g, ' ').trim()
            );
            const isEmpty = /暂无历史对话/.test(txt);
            return items.length > 0 || isEmpty
              ? {
                  loadError: false,
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                  itemCount: items.length,
                  isEmpty,
                  firstSample: items[0] || '',
                }
              : false;
          },
          { timeoutMs: 12000 }
        );

        await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
        await page.sleep(200);

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '调试台历史对话浮层加载',
          requiredActions: [/ChatSessions|Sessions/i],
          forbidWrite: true,
        });

        if (!popSettled.ok || !popSettled.value) {
          throw new Error('点击「历史对话」后浮层未弹出或持续停留在「正在加载…」');
        }
        if (popSettled.value.loadError) {
          throw new Error('「历史对话」浮层显示「加载失败，重试」错误态');
        }

        return popSettled.value.itemCount > 0
          ? `popover=${popSettled.value.width}x${popSettled.value.height}, sessions=${popSettled.value.itemCount} (首条: ${popSettled.value.firstSample.slice(0, 60)})`
          : `popover=${popSettled.value.width}x${popSettled.value.height}, 正常展示「暂无历史对话」`;
      } finally {
        await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
        await restoreSafeWorkspace(page, cfg, '07-workbench-restore');
      }
    }
  );
}
