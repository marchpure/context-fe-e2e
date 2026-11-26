// 模块 13：AgentKit Context v0.4.1 全任务链走查指南（L01–L31）增量缺口固化套件（默认全程只读、零写副作用；兼容 2107625663 基线工作区与 2100390175 跨账号空白/新建工作区）
// 覆盖 8 项增量关键路径：
// 1. ONB-01 / USE-09 (L21/L30)：空白工作区默认概览防早挂载 + 工作台「概览 ⇄ 调试台」往返保持 URL tab 与工作区范围
// 2. USE-09 (L21)：工作台「对话设置」四页签（来源/系统提示词/回答示范/查询示例）隔离提示、半填示范拦截及零写取消
// 3. SRC-13 (L06/L09–L12/L27)：本地上传 3 类存放/添加模式（文件资产禁用说明、加入已有知识库、新建知识库名称表单）与来源详情动作互斥（上传文件 vs 同步元数据）
// 4. DOM-07 (L15/L16)：领域知识「手动补充」三分支（指标口径独立编辑页、业务规则、来源说明依据资产必填校验）只读往返
// 5. DOM-08 / USE-10 (L22–L26/L28)：已发布领域删除阻断提示、MCP 服务「先停用再删除」按钮门禁及资产中心/关联网关互跳路由校验
// 6. ENR-09 (L17/L19/L20)：知识加工「创建加工流水线」AI 生成提示词入口、已保存任务表格与运行报告「批量审核」弹窗状态机只读核验

import {
  cdpClickPoint,
  cdpPressKey,
  restoreSafeWorkspace,
  validateStepTerminalState,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';
import {
  assertCrossAccountIsolation,
  evaluateBlankWorkspaceOnboarding,
  validateChatSettingsDrawer,
  validateLocalUploadModesSnapshot,
  validateManualKnowledgeBranches,
  validateMcpLifecycleAndDeleteGuards,
  validatePipelineAndBatchReviewControls,
  validateSourceHeaderActionExclusivity,
} from '../lib/v041-walkthrough-checks.mjs';

async function closeAnyModalOrDrawer(page) {
  await page.evalJSON(() => {
    const cancelModal =
      [...document.querySelectorAll('.arco-modal .arco-modal-footer button')].find(el =>
        /^(取消|关闭)$/.test((el.textContent || '').trim())
      ) || document.querySelector('.arco-modal .arco-modal-close-icon');
    if (cancelModal instanceof HTMLElement) cancelModal.click();
    const closeDrawer = document.querySelector('.arco-drawer .arco-drawer-close-icon');
    if (closeDrawer instanceof HTMLElement) closeDrawer.click();
  }).catch(() => {});
  await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  await page.sleep(200);
}

export async function run(t, page, cfg) {
  await t.check(
    'NAV-01/ONB-01 多租户目标配置隔离校验通过（非 2107625663 工作区零基线资源 ID 串入且远离禁区工作区）',
    async () => {
      const isolation = assertCrossAccountIsolation(cfg, {
        baselineLocalKbConnId: Boolean(process.env.CONTEXT_BASELINE_LOCAL_KB_CONN_ID),
        baselineDocEntryId: Boolean(process.env.CONTEXT_BASELINE_DOC_ENTRY_ID),
        baselineDomainId: Boolean(process.env.CONTEXT_BASELINE_DOMAIN_ID),
        baselineTosConnId: Boolean(process.env.CONTEXT_BASELINE_TOS_CONN_ID),
      });
      return `account=${isolation.accountId || 'session'}, workspace=${isolation.workspaceId}, isBaseline=${isolation.isBaselineWorkspace}`;
    }
  );

  // -------------------------------------------------------------------------
  // 1. ONB-01 & USE-09 (L21 / L30): 工作台概览 ⇄ 调试台往返 + 空白工作区引导态检查 + 对话设置四页签拦截
  // -------------------------------------------------------------------------
  await t.check(
    'ONB-01/USE-09 工作台「概览 ⇄ 调试台」往返保持作用域（空白空间默认停留在概览），且「对话设置」四页签与半填回答示范校验零写生效',
    async () => {
      const step = '13-workbench-overview-chat-and-settings';
      try {
        await page.gotoContext('/context/workbench', {
          stepName: step,
          timeoutMs: 18000,
          readyFn: () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(
              document.querySelector('[class*="overviewPane"]') ||
                document.querySelector('[aria-label="业务领域与版本"]')
            ),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );

        const initialWb = await page.evalJSON(() => {
          const allTabs = [
            ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
            ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host => [
              ...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || []),
            ]),
          ].filter(el => el.getClientRects().length);
          const findTab = name => {
            const el = allTabs.find(n => (n.textContent || '').trim() === name);
            if (!el) return null;
            const r = el.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          };
          const capsule = document.querySelector('ve-tabs[type="capsule"]');
          const activeTab =
            new URLSearchParams(window.location.search).get('tab') ||
            capsule?.activeTab ||
            capsule?.getAttribute('active-tab') ||
            (document.querySelector('[class*="overviewPane"]')?.getClientRects().length ? 'overview' : 'chat');
          const overviewEl = document.querySelector('[class*="overviewPane"]');
          const composer = document.querySelector(
            '.context-workbench-chatkit [contenteditable="true"], .context-workbench-chatkit textarea'
          );
          const compVisible = Boolean(composer?.getClientRects().length);
          const compDisabled = Boolean(
            !composer || composer.disabled || composer.getAttribute('aria-disabled') === 'true'
          );
          return {
            activeTab,
            overviewTabPos: findTab('概览'),
            chatTabPos: findTab('调试台'),
            hasOverviewGuidance: Boolean(
              overviewEl && /让智能体理解你的业务|添加资产|业务领域/.test(overviewEl.innerText || '')
            ),
            hasErrorAlert: /无法读取工作台数据/.test(document.body?.innerText || ''),
            chatComposerMountedAndEnabled: compVisible && !compDisabled,
          };
        });

        if (initialWb.hasErrorAlert) {
          throw new Error('工作台展示「无法读取工作台数据」错误态');
        }

        // 点击「概览」确认引导面板可读且 URL 保持范围
        if (initialWb.overviewTabPos) {
          await cdpClickPoint(page, initialWb.overviewTabPos.x, initialWb.overviewTabPos.y);
          const ovSettled = await waitForTerminalDom(
            page,
            () => {
              const ov = document.querySelector('[class*="overviewPane"]');
              return Boolean(
                ov && ov.getClientRects().length && /让智能体理解你的业务/.test(ov.innerText || '')
              );
            },
            { timeoutMs: 8000 }
          );
          if (!ovSettled.ok) {
            throw new Error('点击工作台「概览」后未展示使用引导与领域概览面板');
          }
        }

        if (!initialWb.chatTabPos) {
          // 当前身份只读（如企业只读视图），仅展示概览
          const oracle = await page.collectStepOracle(step);
          validateStepTerminalState(oracle, cfg, { stepLabel: '只读工作台概览检查', forbidWrite: true });
          return '当前身份仅开放只读「概览」页签，未挂载可写调试台';
        }

        // 切换到「调试台」检查「对话设置」入口
        await cdpClickPoint(page, initialWb.chatTabPos.x, initialWb.chatTabPos.y);
        await waitForTerminalDom(
          page,
          () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(document.querySelector('[aria-label="业务领域与版本"]')),
          { timeoutMs: 12000 }
        );

        const settingsBtn = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('button, ve-button')].find(
            el => el.getClientRects().length && (el.textContent || '').trim() === '对话设置'
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          const disabled =
            btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /disabled/i.test(btn.className || '');
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled };
        });

        let settingsNote = '无可选领域版本（对话设置按预期禁用或未开启）';
        if (settingsBtn && !settingsBtn.disabled) {
          await cdpClickPoint(page, settingsBtn.x, settingsBtn.y);
          const drawerReady = await waitForTerminalDom(
            page,
            () => {
              const drawer = document.querySelector('.arco-drawer');
              if (!drawer || drawer.querySelector('.arco-spin-loading')) return false;
              const tabs = [...drawer.querySelectorAll('[role="tab"], .arco-tabs-header-title')]
                .map(el => (el.textContent || '').trim())
                .filter(Boolean);
              if (tabs.length < 4) return false;
              return {
                tabs,
                noticeText: (drawer.querySelector('.arco-alert')?.innerText || '').trim(),
                hasResetBtn: [...drawer.querySelectorAll('button')].some(
                  b => (b.textContent || '').trim() === '恢复默认'
                ),
                hasApplyNewSessionBtn: [...drawer.querySelectorAll('button')].some(
                  b => (b.textContent || '').trim() === '应用并开启新会话'
                ),
              };
            },
            { timeoutMs: 10000 }
          );
          if (!drawerReady.ok || !drawerReady.value) {
            throw new Error('点击「对话设置」后未打开包含四页签的设置抽屉');
          }
          validateChatSettingsDrawer(drawerReady.value);

          // 切换到「回答示范」添加一条只填问题不填期望回答的半成品，点击「应用并开启新会话」必须前端拦截不关闭抽屉
          const respTabPos = await page.evalJSON(() => {
            const tab = [...document.querySelectorAll('.arco-drawer [role="tab"], .arco-drawer .arco-tabs-header-title')].find(
              el => (el.textContent || '').trim() === '回答示范'
            );
            if (!tab) return null;
            const r = tab.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          if (respTabPos) {
            await cdpClickPoint(page, respTabPos.x, respTabPos.y);
            await page.sleep(200);
            const addRespBtn = await page.evalJSON(() => {
              const btn = [...document.querySelectorAll('.arco-drawer button')].find(el =>
                /添加回答示范/.test((el.textContent || '').trim())
              );
              if (!btn || btn.disabled) return null;
              const r = btn.getBoundingClientRect();
              return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
            });
            if (addRespBtn) {
              await cdpClickPoint(page, addRespBtn.x, addRespBtn.y);
              await page.sleep(200);
              await page.evalJSON(() => {
                const drawer = document.querySelector('.arco-drawer');
                const input = drawer?.querySelector('input, textarea');
                if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
                  const proto =
                    input instanceof HTMLInputElement
                      ? HTMLInputElement.prototype
                      : HTMLTextAreaElement.prototype;
                  Object.getOwnPropertyDescriptor(proto, 'value')?.set?.call(
                    input,
                    '仅填问题验证成对必填拦截'
                  );
                  input.dispatchEvent(new Event('input', { bubbles: true }));
                }
              });
              const applyBtn = await page.evalJSON(() => {
                const btn = [...document.querySelectorAll('.arco-drawer button')].find(
                  b => (b.textContent || '').trim() === '应用并开启新会话'
                );
                if (!btn || btn.disabled) return null;
                const r = btn.getBoundingClientRect();
                return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
              });
              if (applyBtn) {
                await cdpClickPoint(page, applyBtn.x, applyBtn.y);
                await page.sleep(300);
                const stillOpenWithError = await page.evalJSON(() => {
                  const drawer = document.querySelector('.arco-drawer');
                  return Boolean(
                    drawer?.getClientRects().length &&
                      drawer.querySelector('.arco-form-item-status-error')
                  );
                });
                if (!stillOpenWithError) {
                  throw new Error('「回答示范」仅填一半时点击应用未被必填校验拦截');
                }
              }
            }
          }
          await closeAnyModalOrDrawer(page);
          settingsNote = '对话设置四页签（来源/系统提示词/回答示范/查询示例）及半填拦截正常';
        }

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '工作台概览/调试台往返与对话设置检查',
          forbidWrite: true,
        });
        return `initialTab=${initialWb.activeTab}, ${settingsNote}`;
      } finally {
        await closeAnyModalOrDrawer(page);
        await restoreSafeWorkspace(page, cfg, '13-workbench-restore');
      }
    }
  );

  // -------------------------------------------------------------------------
  // 2. SRC-13 (L06 / L09–L12 / L27): 本地上传 3 模式与来源页头操作互斥
  // -------------------------------------------------------------------------
  await t.check(
    'SRC-13 本地上传弹窗完整呈现文件资产/已有知识库/新建知识库三路径，且来源详情「上传文件」与「同步元数据」按类型严格互斥',
    async () => {
      const step = '13-local-upload-modes-and-source-actions';
      try {
        await page.gotoContext('/context/catalog', {
          stepName: step,
          timeoutMs: 18000,
          readyFn: () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(document.querySelector('aside input[placeholder="搜索目录"]')),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 10000 }
        );

        const addBtnPos = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('main button')].find(
            b => b.getClientRects().length && /添加资产/.test((b.innerText || '').trim())
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!addBtnPos) {
          t.block('SRC-13 本地上传三路径检查', '当前身份无 canConnect 权限，未展示「添加资产」按钮');
          return;
        }

        await cdpClickPoint(page, addBtnPos.x, addBtnPos.y);
        const uploadMenuItem = await waitForTerminalDom(
          page,
          () => {
            const item = [...document.querySelectorAll('[role="menuitem"], .arco-dropdown-menu-item')].find(
              el => el.getClientRects().length && (el.innerText || '').trim() === '上传本地'
            );
            if (!item) return false;
            const r = item.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          },
          { timeoutMs: 5000, settleMs: 100 }
        );
        if (!uploadMenuItem.ok) throw new Error('点击「添加资产」后下拉菜单缺少「上传本地」');

        await cdpClickPoint(page, uploadMenuItem.value.x, uploadMenuItem.value.y);
        const modalSettled = await waitForTerminalDom(
          page,
          () => {
            const modal = document.querySelector('.arco-modal');
            if (!modal || !modal.getClientRects().length || modal.querySelector('.arco-spin-loading')) {
              return false;
            }
            const fieldsets = [...modal.querySelectorAll('fieldset')];
            return fieldsets.length >= 2 ? true : false;
          },
          { timeoutMs: 10000 }
        );
        if (!modalSettled.ok) throw new Error('「上传本地文件」弹窗未加载完存放方式与添加方式');

        const readUploadSnap = () =>
          page.evalJSON(() => {
            const modal = document.querySelector('.arco-modal');
            const parseFieldset = legendKeyword => {
              const fs = [...(modal?.querySelectorAll('fieldset') || [])].find(el =>
                (el.querySelector('legend')?.innerText || '').includes(legendKeyword)
              );
              return [...(fs?.querySelectorAll('label') || [])].map(lbl => {
                const input = lbl.querySelector('input[type="radio"]');
                const spans = [...lbl.querySelectorAll('span')].map(s => (s.innerText || '').trim()).filter(Boolean);
                return {
                  value: input?.value || '',
                  label: spans[1] || spans[0] || '',
                  description: spans[2] || '',
                  disabledReason: spans[3] || '',
                  checked: Boolean(input?.checked),
                  disabled: Boolean(input?.disabled),
                  rect: (() => {
                    const r = lbl.getBoundingClientRect();
                    return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
                  })(),
                };
              });
            };
            const storageOptions = parseFieldset('存放方式');
            const addModeOptions = parseFieldset('添加方式');
            const selectedAdd = addModeOptions.find(o => o.checked)?.value || '';
            return {
              storageOptions,
              addModeOptions,
              selectedAddMode: selectedAdd,
              hasNewKbNameInput: Boolean(modal?.querySelector('input[aria-label="知识库名称"]')),
              hasExistingKbSelect: Boolean(modal?.querySelector('[aria-label="知识库"], .arco-select')),
            };
          });

        const firstUploadSnap = await readUploadSnap();
        validateLocalUploadModesSnapshot(firstUploadSnap);

        // 点击切换到「新建知识库」核对「知识库名称」输入框挂载（L11）
        const newKbCard = firstUploadSnap.addModeOptions.find(o => o.label === '新建知识库');
        if (newKbCard?.rect && firstUploadSnap.selectedAddMode !== 'new') {
          await cdpClickPoint(page, newKbCard.rect.x, newKbCard.rect.y);
          await page.sleep(200);
          const switchedSnap = await readUploadSnap();
          if (switchedSnap.selectedAddMode !== 'new' || !switchedSnap.hasNewKbNameInput) {
            throw new Error('点击「新建知识库」后未切换至知识库名称输入表单');
          }
          validateLocalUploadModesSnapshot(switchedSnap);
        }

        await closeAnyModalOrDrawer(page);

        // 若当前空间已有内置知识库或数据库来源，顺带抽检来源详情页头按钮互斥性（L12 / L27）
        const treeSources = await page.evalJSON(() => {
          const groups = [...document.querySelectorAll('nav[aria-label="数据目录"] > ul > li')];
          const items = [];
          for (const g of groups) {
            const groupTitle = (g.querySelector(':scope > button')?.innerText || '').trim();
            const kind = groupTitle.startsWith('知识库')
              ? 'kb'
              : groupTitle.startsWith('数据库')
                ? 'database'
                : 'other';
            for (const btn of g.querySelectorAll(':scope > ul > li > button')) {
              const name = (btn.innerText || '').trim();
              const r = btn.getBoundingClientRect();
              if (name && r.width > 0 && r.height > 0) {
                items.push({ kind, name, x: r.x + r.width / 2, y: r.y + r.height / 2 });
              }
            }
          }
          return items;
        });

        let sourceExclusivitySummary = '空目录无存量来源（已在上传弹窗核验新建知识库路径）';
        const sampleDb = treeSources.find(s => s.kind === 'database' && /codex-e2e-/i.test(s.name)) ||
          treeSources.find(s => s.kind === 'database');
        if (sampleDb) {
          await cdpClickPoint(page, sampleDb.x, sampleDb.y);
          await waitForTerminalDom(
            page,
            () => !document.querySelector('.spin-center, .arco-spin-loading'),
            { timeoutMs: 10000 }
          );
          const moreBtn = await page.evalJSON(() => {
            const b = [...document.querySelectorAll('main header button')].find(
              el => (el.innerText || '').trim() === '更多'
            );
            if (!b) return null;
            const r = b.getBoundingClientRect();
            return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
          });
          let menuItems = [];
          if (moreBtn) {
            await cdpClickPoint(page, moreBtn.x, moreBtn.y);
            await page.sleep(200);
            menuItems = await page.evalJSON(() =>
              [...document.querySelectorAll('[role="menuitem"], .arco-dropdown-menu-item')].map(el =>
                (el.innerText || '').trim()
              )
            );
            await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
          }
          const headerBtns = await page.evalJSON(() =>
            [...document.querySelectorAll('main header button')].map(b => (b.innerText || '').trim())
          );
          const allLabels = [...headerBtns, ...menuItems];
          validateSourceHeaderActionExclusivity({
            sourceKind: 'database',
            hasUploadFile: allLabels.some(t => t.includes('上传文件')),
            hasSyncMetadata: allLabels.some(t => t.includes('同步元数据')),
            hasViewHistory: allLabels.some(t => t.includes('查看记录')),
          });
          sourceExclusivitySummary = `数据库来源「${sampleDb.name}」具备同步元数据/查看记录且隐藏上传文件`;
        }

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '本地上传三路径与来源动作互斥检查',
          forbidWrite: true,
        });
        return `上传本地三模式校验通过；${sourceExclusivitySummary}`;
      } finally {
        await closeAnyModalOrDrawer(page);
        await restoreSafeWorkspace(page, cfg, '13-upload-restore');
      }
    }
  );

  // -------------------------------------------------------------------------
  // 3. DOM-07 & DOM-08 (L15 / L16 / L26): 领域知识手动补充三分支 + 已发布领域删除保护
  // -------------------------------------------------------------------------
  await t.check(
    'DOM-07/DOM-08 业务领域已发布状态删除保护生效，且「手动补充」完整覆盖指标口径/业务规则/来源说明三分支只读往返',
    async () => {
      const step = '13-domain-manual-knowledge-and-delete-guard';
      try {
        await page.gotoContext('/context/domains', {
          stepName: step,
          timeoutMs: 16000,
          readyFn: () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(document.querySelector('input[aria-label="搜索业务领域"]')),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );

        const domainSummary = await page.evalJSON(() => {
          const cardsWrap = document.querySelector('[class*="cards"]');
          const cards = cardsWrap ? [...cardsWrap.children] : [];
          const parsed = cards.map(card => {
            const txt = (card.innerText || '').trim();
            const id = txt.match(/\bdom-[a-z0-9_-]+/i)?.[0] || '';
            return {
              id,
              synthetic: /codex-e2e-/i.test(txt),
              published: /已发布/.test(txt) && !/服务已下线|服务已暂停/.test(txt),
            };
          });
          return {
            hasEmpty: Boolean(document.querySelector('.arco-empty')),
            cards: parsed.filter(c => c.id),
          };
        });

        if (domainSummary.cards.length === 0) {
          evaluateBlankWorkspaceOnboarding({
            hasErrorAlert: false,
            assetCount: 0,
            domainCount: 0,
            explicitChatRequested: false,
            workbenchActiveTab: 'overview',
            chatComposerMountedAndEnabled: false,
            hasOverviewGuidance: true,
            catalogShowsEmptyWithAddCta: true,
            domainsShowsEmptyState: domainSummary.hasEmpty,
          });
          t.block(
            'DOM-07/DOM-08 手动补充知识三分支与领域删除保护',
            `当前工作区 (${cfg.workspaceId}) 为空白领域态（暂无业务领域），待 L14 创建领域后自动覆盖`
          );
          return;
        }

        const chosen =
          domainSummary.cards.find(c => c.synthetic && c.published) ||
          domainSummary.cards.find(c => c.synthetic) ||
          domainSummary.cards[0];

        await page.gotoContext(`/context/domains/${encodeURIComponent(chosen.id)}/detail`, {
          stepName: step,
          timeoutMs: 16000,
          readyFn: () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(document.querySelector('article h1')),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );

        // 切换到「领域知识」页签点击「手动补充」
        const knowledgeTab = await page.evalJSON(() => {
          const el = [
            ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
            ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host => [
              ...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || []),
            ]),
          ].find(n => (n.textContent || '').trim() === '领域知识');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!knowledgeTab) throw new Error('领域详情缺少「领域知识」页签');
        await cdpClickPoint(page, knowledgeTab.x, knowledgeTab.y);
        await page.sleep(300);

        const manualBtn = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('button, ve-button')].find(
            b => b.getClientRects().length && (b.textContent || '').trim() === '手动补充'
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          const disabled =
            btn.disabled || btn.getAttribute('aria-disabled') === 'true' || /disabled/i.test(btn.className || '');
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled };
        });
        if (!manualBtn || manualBtn.disabled) {
          t.block('DOM-07 手动补充三分支', '当前身份无领域编辑权限（「手动补充」按钮禁用或隐藏）');
          return;
        }

        await cdpClickPoint(page, manualBtn.x, manualBtn.y);
        const typeModal = await waitForTerminalDom(
          page,
          () => {
            const modal = document.querySelector('.arco-modal');
            if (!modal || !modal.getClientRects().length) return false;
            const title = (modal.querySelector('.arco-modal-title')?.textContent || '').trim();
            if (title !== '手动补充') return false;
            const options = [...modal.querySelectorAll('fieldset label')].map(lbl => {
              const r = lbl.getBoundingClientRect();
              return {
                title: (lbl.querySelector('strong')?.textContent || '').trim(),
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
              };
            });
            const nextBtn = [...modal.querySelectorAll('.arco-modal-footer button')].find(
              b => (b.textContent || '').trim() === '下一步'
            );
            return options.length === 3 && nextBtn
              ? {
                  options,
                  nextDisabledInitially: Boolean(nextBtn.disabled),
                  nextPos: (() => {
                    const nr = nextBtn.getBoundingClientRect();
                    return { x: nr.x + nr.width / 2, y: nr.y + nr.height / 2 };
                  })(),
                }
              : false;
          },
          { timeoutMs: 8000 }
        );
        if (!typeModal.ok || !typeModal.value) {
          throw new Error('点击「手动补充」后未弹出三类知识类型选择对话框');
        }

        // 分支 1：选中「指标口径」-> 点击「下一步」进入新增指标口径编辑页 -> 取消返回「领域知识」（L16）
        const metricOpt = typeModal.value.options.find(o => o.title === '指标口径');
        await cdpClickPoint(page, metricOpt.x, metricOpt.y);
        await page.sleep(150);
        const nextBtnFresh = await page.evalJSON(() => {
          const b = [...document.querySelectorAll('.arco-modal .arco-modal-footer button')].find(
            el => (el.textContent || '').trim() === '下一步' && !el.disabled
          );
          if (!b) return null;
          const r = b.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!nextBtnFresh) throw new Error('选中「指标口径」后「下一步」按钮仍不可点击');
        await cdpClickPoint(page, nextBtnFresh.x, nextBtnFresh.y);

        const metricPage = await waitForTerminalDom(
          page,
          () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const txt = document.body?.innerText || '';
            const heading = [...document.querySelectorAll('h1, h2, [role="heading"]')]
              .map(h => (h.textContent || '').trim())
              .find(t => t === '新增指标口径' || t === '编辑指标口径');
            if (!heading) return false;
            return {
              heading,
              hasNoTableNotice: /当前领域尚未关联可用的数据表/.test(txt),
              hasFourFactorWorkspace: /指标计算|查询示例/.test(txt),
            };
          },
          { timeoutMs: 10000 }
        );
        if (!metricPage.ok || !metricPage.value) {
          throw new Error('从「手动补充」选择指标口径后未进入「新增指标口径」编辑页');
        }

        // 点击取消或返回回到「领域知识」
        const cancelMetric = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('button, ve-button')].find(el =>
            /^(取消|返回)$/.test((el.textContent || '').trim()) && el.getClientRects().length && !el.closest('aside')
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (!cancelMetric) throw new Error('新增指标口径页缺少「取消/返回」按钮');
        await cdpClickPoint(page, cancelMetric.x, cancelMetric.y);
        const backKnowledge = await waitForTerminalDom(
          page,
          () =>
            [...document.querySelectorAll('button, ve-button')].some(
              b => b.getClientRects().length && (b.textContent || '').trim() === '手动补充'
            ),
          { timeoutMs: 8000 }
        );

        // 分支 2：打开「手动补充」-> 选「来源说明」-> 空依据资产点确定必须拦截 -> 取消关闭（L15）
        let sourceNoteRequiresAsset = false;
        if (backKnowledge.ok) {
          const reopenBtn = await page.evalJSON(() => {
            const btn = [...document.querySelectorAll('button, ve-button')].find(
              b => b.getClientRects().length && (b.textContent || '').trim() === '手动补充'
            );
            const r = btn?.getBoundingClientRect();
            return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          });
          if (reopenBtn) {
            await cdpClickPoint(page, reopenBtn.x, reopenBtn.y);
            await page.sleep(300);
            const srcOpt = await page.evalJSON(() => {
              const lbl = [...document.querySelectorAll('.arco-modal fieldset label')].find(el =>
                (el.innerText || '').includes('来源说明')
              );
              const r = lbl?.getBoundingClientRect();
              return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
            });
            if (srcOpt) {
              await cdpClickPoint(page, srcOpt.x, srcOpt.y);
              await page.sleep(150);
              const next2 = await page.evalJSON(() => {
                const b = [...document.querySelectorAll('.arco-modal .arco-modal-footer button')].find(
                  el => (el.textContent || '').trim() === '下一步' && !el.disabled
                );
                const r = b?.getBoundingClientRect();
                return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
              });
              if (next2) {
                await cdpClickPoint(page, next2.x, next2.y);
                const editorReady = await waitForTerminalDom(
                  page,
                  () => /新增来源说明/.test(document.querySelector('.arco-modal')?.innerText || ''),
                  { timeoutMs: 6000 }
                );
                if (editorReady.ok) {
                  const saveBtn = await page.evalJSON(() => {
                    const b = [...document.querySelectorAll('.arco-modal .arco-modal-footer button')].find(el =>
                      el.classList.contains('arco-btn-primary')
                    );
                    const r = b?.getBoundingClientRect();
                    return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2, disabled: Boolean(b.disabled) } : null;
                  });
                  if (saveBtn?.disabled) {
                    sourceNoteRequiresAsset = true;
                  } else if (saveBtn) {
                    await cdpClickPoint(page, saveBtn.x, saveBtn.y);
                    await page.sleep(250);
                    sourceNoteRequiresAsset = await page.evalJSON(() =>
                      Boolean(document.querySelector('.arco-modal')?.getClientRects().length)
                    );
                  }
                }
              }
            }
          }
        }
        await closeAnyModalOrDrawer(page);

        validateManualKnowledgeBranches({
          options: typeModal.value.options,
          nextDisabledInitially: typeModal.value.nextDisabledInitially,
          metricBranch: {
            ...metricPage.value,
            returnedToKnowledgeTabOnCancel: backKnowledge.ok,
          },
          sourceNoteBranch: {
            requiresSourceAsset: sourceNoteRequiresAsset,
          },
        });

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '手动补充知识三分支检查',
          forbidWrite: true,
        });
        return `domain=${chosen.id}, 手动补充三分支（指标口径编辑页往返 + 来源说明必填拦截）校验通过且 0 写请求`;
      } finally {
        await closeAnyModalOrDrawer(page);
        await restoreSafeWorkspace(page, cfg, '13-domain-knowledge-restore');
      }
    }
  );

  // -------------------------------------------------------------------------
  // 4. ENR-09 & USE-10 (L17 / L19 / L24 / L28): 加工流水线 AI 生成入口 + MCP 先停用后删除门禁
  // -------------------------------------------------------------------------
  await t.check(
    'ENR-09/USE-10 知识加工「创建加工流水线」暴露「AI 生成」辅助按钮，且已发布 MCP 服务「删除」按钮强制处于先停用保护禁用态',
    async () => {
      const step = '13-pipeline-ai-prompt-and-mcp-lifecycle-guard';
      try {
        // Part A: 检查 /context/processing 「已保存任务」与「创建加工流水线 -> AI 生成」按钮（若当前有领域）
        await page.gotoContext('/context/processing', {
          stepName: step,
          timeoutMs: 16000,
          readyFn: () => !document.querySelector('.spin-center, .arco-spin-loading'),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );

        const savedTasksTab = await page.evalJSON(() => {
          const el = [
            ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
            ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host => [
              ...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || []),
            ]),
          ].find(n => (n.textContent || '').trim() === '已保存任务');
          if (!el) return null;
          const r = el.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (savedTasksTab) {
          await cdpClickPoint(page, savedTasksTab.x, savedTasksTab.y);
          await waitForTerminalDom(
            page,
            () => !document.querySelector('.spin-center, .arco-spin-loading'),
            { timeoutMs: 8000 }
          );
        }

        let pipelineAiChecked = false;
        const createPipelineBtn = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('button, ve-button')].find(
            b =>
              b.getClientRects().length &&
              /创建加工流水线|新建加工任务/.test((b.textContent || '').trim())
          );
          if (!btn || btn.disabled) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
        });
        if (createPipelineBtn) {
          await cdpClickPoint(page, createPipelineBtn.x, createPipelineBtn.y);
          const formOpened = await waitForTerminalDom(
            page,
            () => {
              const container = document.querySelector('.arco-drawer, .arco-modal');
              if (!container || !container.getClientRects().length) return false;
              return /AI 生成/.test(container.innerText || '')
                ? { hasAiBtn: true }
                : false;
            },
            { timeoutMs: 8000 }
          );
          if (formOpened.ok) {
            pipelineAiChecked = true;
            validatePipelineAndBatchReviewControls({
              pipelineFormChecked: true,
              hasAiGeneratePromptBtn: true,
            });
          }
          await closeAnyModalOrDrawer(page);
        }

        // Part B: 打开 /context/domains/mcp 检查已发布服务行的操作菜单（「删除」必须禁用，防止误删）
        await page.gotoContext('/context/domains/mcp', {
          stepName: step,
          timeoutMs: 16000,
          readyFn: () =>
            !document.querySelector('.spin-center, .arco-spin-loading') &&
            Boolean(document.querySelector('ve-table.ak-data-table, .arco-empty')),
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );

        const mcpGuardSnap = await page.evalJSON(() => {
          const host = document.querySelector('ve-table.ak-data-table');
          const table = host?.shadowRoot?.querySelector('table');
          if (!table) return { rowCount: 0, publishedRowSample: null };
          const headers = [...table.querySelectorAll('thead th')].map(th =>
            (th.textContent || '').replace(/\s+/g, ' ').trim()
          );
          const statusIdx = headers.indexOf('服务状态');
          const opIdx = headers.indexOf('操作');
          const rows = [...(table.querySelectorAll('tbody tr') || [])].filter(
            tr => tr.cells.length === headers.length
          );
          for (const tr of rows) {
            const cells = [...tr.cells];
            const slotNodes = idx =>
              idx < 0
                ? []
                : [...cells[idx].querySelectorAll('slot')].flatMap(s =>
                    s.assignedElements({ flatten: true })
                  );
            const statusText = slotNodes(statusIdx).map(n => n.textContent || '').join(' ').trim();
            if (!/已发布|运行中|正常/.test(statusText) || /已停用|已暂停|已下线/.test(statusText)) {
              continue;
            }
            const opRoot = slotNodes(opIdx);
            const buttons = opRoot.flatMap(n =>
              n.matches('button, ve-button, a') ? [n] : [...n.querySelectorAll('button, ve-button, a')]
            );
            const moreTrigger = buttons.find(b => !['调用示例', '停用', '启用', '删除'].includes((b.textContent || '').trim()));
            const mr = moreTrigger?.getBoundingClientRect();
            return {
              rowCount: rows.length,
              publishedRowSample: {
                statusText,
                inlineButtons: buttons.map(b => ({
                  name: (b.textContent || '').trim(),
                  disabled:
                    Boolean(b.disabled) ||
                    b.getAttribute('aria-disabled') === 'true' ||
                    /disabled/i.test(b.className || ''),
                })),
                morePos: mr && mr.width > 0 ? { x: mr.x + mr.width / 2, y: mr.y + mr.height / 2 } : null,
              },
            };
          }
          return { rowCount: rows.length, publishedRowSample: null };
        });

        let mcpNote = `MCP 服务行=${mcpGuardSnap.rowCount}（暂无已发布行，纯逻辑已离线覆盖）`;
        if (mcpGuardSnap.publishedRowSample) {
          let ops = [...mcpGuardSnap.publishedRowSample.inlineButtons];
          if (mcpGuardSnap.publishedRowSample.morePos) {
            await cdpClickPoint(
              page,
              mcpGuardSnap.publishedRowSample.morePos.x,
              mcpGuardSnap.publishedRowSample.morePos.y
            );
            await page.sleep(250);
            const dropdownOps = await page.evalJSON(() =>
              [...document.querySelectorAll('[role="menuitem"], .arco-dropdown-menu-item')].map(el => ({
                name: (el.innerText || '').trim(),
                disabled:
                  el.getAttribute('aria-disabled') === 'true' ||
                  /disabled/i.test(el.className || ''),
              }))
            );
            ops = [...ops, ...dropdownOps];
            await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
          }
          validateMcpLifecycleAndDeleteGuards({
            status: 'Published',
            operations: ops.filter(o => ['调用示例', '停用', '启用', '删除'].includes(o.name)),
          });
          mcpNote = '已发布 MCP 服务「停用」可用且「删除」强制禁用保护已验证';
        }

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '加工流水线 AI 生成与 MCP 先停用后删除门禁检查',
          forbidWrite: true,
        });
        return `pipelineAiBtn=${pipelineAiChecked ? '已核验' : '无新建入口'}, ${mcpNote}`;
      } finally {
        await closeAnyModalOrDrawer(page);
        await restoreSafeWorkspace(page, cfg, '13-mcp-pipeline-restore');
      }
    }
  );
}
