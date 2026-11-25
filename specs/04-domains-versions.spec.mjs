// 模块 04：业务领域列表、新建弹窗空提交零写拦截、已发布版本实际快照明细（CTX-014）、R1/R2 源修订对照与首次发布首步检查（CTX-012）

import {
  KNOWN_FIXTURES,
  assertOrderedBoxes,
  cdpClickPoint,
  cdpPressKey,
  restoreSafeWorkspace,
  validatePublishedVersionComparison,
  validateStepTerminalState,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';

async function closeOpenDrawer(page) {
  const closePos = await page.evalJSON(() => {
    const closeEl =
      document.querySelector('.arco-drawer .arco-drawer-close-icon') ||
      document.querySelector('.arco-drawer button[aria-label*=" close" i]');
    if (!closeEl) return null;
    const r = closeEl.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (closePos) {
    await cdpClickPoint(page, closePos.x, closePos.y);
  } else {
    await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  }
  await waitForTerminalDom(page, () => !document.querySelector('.arco-drawer'), {
    timeoutMs: 6000,
    settleMs: 100,
  });
}

async function closeOpenModal(page) {
  const cancelPos = await page.evalJSON(() => {
    const modal = document.querySelector('.arco-modal');
    if (!modal) return null;
    const cancelBtn =
      [...modal.querySelectorAll('.arco-modal-footer button')].find(el =>
        /^(取消|关闭)$/.test((el.textContent || '').trim())
      ) || modal.querySelector('.arco-modal-close-icon');
    if (!cancelBtn) return null;
    const r = cancelBtn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (cancelPos) {
    await cdpClickPoint(page, cancelPos.x, cancelPos.y);
  } else {
    await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  }
  await waitForTerminalDom(page, () => !document.querySelector('.arco-modal'), {
    timeoutMs: 6000,
    settleMs: 100,
  });
}

export async function readVersionDrawerSnapshot(page, versionStr, refundEntryId) {
  const verBtn = await page.evalJSON(`(() => {
    const target = ${JSON.stringify(versionStr)};
    const btn = [...document.querySelectorAll('table tbody button, table tbody a')].find(
      el => (el.textContent || '').trim() === target
    );
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`);
  if (!verBtn) {
    throw new Error(`版本表格中未找到可点击的版本号「${versionStr}」按钮`);
  }

  await cdpClickPoint(page, verBtn.x, verBtn.y);
  const opened = await waitForTerminalDom(
    page,
    `(() => {
      const drawer = document.querySelector('.arco-drawer');
      if (!drawer) return false;
      if (drawer.querySelector('.arco-spin-loading')) return false;
      const title = (drawer.querySelector('.arco-drawer-header')?.innerText || '').trim();
      if (!title.includes(${JSON.stringify(`版本 ${versionStr}`)}) || !title.includes('发布范围')) return false;
      const r = drawer.getBoundingClientRect();
      if (!(r.width >= 360 && r.height >= 200)) return false;
      const rows = [...drawer.querySelectorAll('table tbody tr')].filter(
        tr => !tr.querySelector('.arco-empty') && !/暂未提供此版本的发布范围明细/.test(tr.innerText || '')
      );
      return {
        title,
        width: Math.round(r.width),
        height: Math.round(r.height),
        hasEmptyHint: /暂未提供此版本的发布范围明细/.test(drawer.innerText || ''),
        rowCount: rows.length,
        rows: rows.map(tr => [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim())),
      };
    })()`,
    { timeoutMs: 10000 }
  );

  if (!opened.ok || !opened.value) {
    await closeOpenDrawer(page);
    throw new Error(`点击版本「${versionStr}」后未成功打开「发布范围」抽屉`);
  }

  const snap = opened.value;
  const refundRow = refundEntryId
    ? snap.rows.find(cells => cells.some(c => c.includes(refundEntryId)))
    : null;
  await closeOpenDrawer(page);

  return {
    ...snap,
    refundRevision: refundRow ? refundRow[refundRow.length - 1] : null,
    refundType: refundRow ? refundRow[1] : null,
  };
}

export async function run(t, page, cfg) {
  let listedDomains = [];

  await t.check(
    '业务领域列表终态加载完成、搜索框与领域卡片尺寸有效且保持 workspaceId 与 project',
    async () => {
      const step = '04-domain-list';
      const nav = await page.gotoContext('/context/domains', {
        stepName: step,
        readyFn: () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const searchInput = document.querySelector('input[aria-label="搜索业务领域"]');
          const hasListOrEmpty = Boolean(
            document.querySelector('[class*="cards"]') ||
              document.querySelector('.arco-empty') ||
              document.querySelector('.arco-alert')
          );
          return searchInput && hasListOrEmpty ? true : false;
        },
      });
      const settled = await waitForTerminalDom(
        page,
        () => !document.querySelector('.spin-center, .arco-spin-loading'),
        { timeoutMs: 10000 }
      );
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '业务领域列表',
        requiredActions: [/List.*Domains/i],
        forbidWrite: true,
      });
      if (!nav.settledOk || !settled.ok) {
        throw new Error(`业务领域列表加载超时或存在持续 loading (${nav.firstContentMs}ms)`);
      }

      const listMeta = await page.evalJSON(() => {
        if (/业务领域加载失败/.test(document.body?.innerText || '')) {
          return { loadError: true };
        }
        const search = document.querySelector('input[aria-label="搜索业务领域"]');
        const sr = search?.getBoundingClientRect();
        const cardsWrap = document.querySelector('[class*="cards"]');
        const cards = cardsWrap ? [...cardsWrap.children] : [];
        const cardItems = cards.map(card => {
          const r = card.getBoundingClientRect();
          const txt = (card.innerText || '').trim();
          const idMatch = txt.match(/\bdom-[a-z0-9_-]+/i);
          return {
            width: Math.round(r.width),
            height: Math.round(r.height),
            domainId: idMatch ? idMatch[0] : null,
            unpublished: /未发布/.test(txt),
            textSample: txt.slice(0, 120),
          };
        });
        return {
          loadError: false,
          searchWidth: Math.round(sr?.width || 0),
          searchHeight: Math.round(sr?.height || 0),
          hasEmpty: Boolean(document.querySelector('.arco-empty')),
          cardItems,
        };
      });

      if (listMeta?.loadError) {
        throw new Error('业务领域列表展示「业务领域加载失败，请重试。」错误态');
      }
      if (!(listMeta.searchWidth >= 160 && listMeta.searchHeight >= 24)) {
        throw new Error(
          `业务领域搜索框尺寸无效: ${listMeta.searchWidth}x${listMeta.searchHeight}`
        );
      }
      if (cfg.workspaceId === KNOWN_FIXTURES.workspaceId && listMeta.cardItems.length === 0) {
        throw new Error('回归工作区 800e2e0a… 业务领域卡片列表为空，缺少已创建的合成测试领域');
      }
      const badCard = listMeta.cardItems.find(c => !(c.width >= 200 && c.height >= 80));
      if (badCard) {
        throw new Error(`领域卡片尺寸异常: ${badCard.width}x${badCard.height} (${badCard.textSample})`);
      }
      listedDomains = listMeta.cardItems;
      return `firstContent=${nav.firstContentMs}ms, cards=${listMeta.cardItems.length}, APIs=${oracle.records.length}`;
    }
  );

  await t.check(
    '创建业务领域弹窗空提交及未选查询资产时必填拦截生效，关闭后零写接口发出',
    async () => {
      const step = '04-create-domain-empty-submit';
      page.setStep(step);

      const btnInfo = await page.evalJSON(() => {
        const btn = [...document.querySelectorAll('button')].find(
          el => (el.textContent || '').trim() === '创建业务领域'
        );
        if (!btn) return { found: false };
        const r = btn.getBoundingClientRect();
        const disabled =
          btn.disabled ||
          btn.getAttribute('aria-disabled') === 'true' ||
          /disabled/i.test(String(btn.className || ''));
        return {
          found: true,
          disabled,
          x: r.x + r.width / 2,
          y: r.y + r.height / 2,
          width: r.width,
          height: r.height,
        };
      });

      if (!btnInfo?.found || !(btnInfo.width > 20 && btnInfo.height > 18)) {
        throw new Error('业务领域页缺少有效尺寸的「创建业务领域」按钮入口');
      }
      if (btnInfo.disabled) {
        t.block(
          '创建业务领域弹窗空提交及未选查询资产时必填拦截生效，关闭后零写接口发出',
          '当前登录身份无领域编辑权限（创建业务领域按钮禁用），无法打开弹窗核验表单拦截'
        );
        return;
      }

      try {
        await cdpClickPoint(page, btnInfo.x, btnInfo.y);

        const modalReady = await waitForTerminalDom(
          page,
          () => {
            const modal = document.querySelector('.arco-modal');
            if (!modal) return false;
            if (modal.querySelector('.arco-spin-loading')) return false;
            const r = modal.getBoundingClientRect();
            const title = (modal.querySelector('.arco-modal-title')?.textContent || '').trim();
            const okBtn = [...modal.querySelectorAll('.arco-modal-footer button')].find(b =>
              b.classList.contains('arco-btn-primary')
            );
            if (title !== '创建业务领域' || !okBtn) return false;
            const okRect = okBtn.getBoundingClientRect();
            return r.width >= 500 && r.height >= 300 && okRect.width > 0
              ? {
                  modalWidth: Math.round(r.width),
                  modalHeight: Math.round(r.height),
                  okX: okRect.x + okRect.width / 2,
                  okY: okRect.y + okRect.height / 2,
                }
              : false;
          },
          { timeoutMs: 14000 }
        );

        if (!modalReady.ok || !modalReady.value) {
          throw new Error('点击「创建业务领域」后弹窗未就绪或候选资产选择器持续 loading');
        }

        // 1. 全空状态点击「确定」：三个必填项（名称、场景说明、查询范围）必须全部拦截
        await cdpClickPoint(page, modalReady.value.okX, modalReady.value.okY);
        const emptyErrors = await waitForTerminalDom(
          page,
          () => {
            const modal = document.querySelector('.arco-modal');
            if (!modal) return false;
            const txt = modal.innerText || '';
            const hasNameErr = /请输入领域名称/.test(txt);
            const hasDescErr = /请输入场景说明/.test(txt);
            const hasScopeErr = /请至少选择一项资产/.test(txt);
            return hasNameErr && hasDescErr && hasScopeErr ? true : false;
          },
          { timeoutMs: 5000, settleMs: 150 }
        );
        if (!emptyErrors.ok) {
          throw new Error('空表单点击确定后未完整展示名称/场景说明/查询范围三条内联必填提示');
        }

        // 2. 仅填入本地临时文本但保持 0 资产勾选再点「确定」：仍须被「请至少选择一项资产」阻断且弹窗不关闭
        await page.evalJSON(() => {
          const modal = document.querySelector('.arco-modal');
          if (!modal) return;
          const nameInput = modal.querySelector('input[placeholder*="经营分析"], input');
          const descInput = modal.querySelector('textarea');
          if (nameInput) {
            Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
              nameInput,
              'codex-e2e-readonly-validate'
            );
            nameInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
          if (descInput) {
            Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set?.call(
              descInput,
              '仅验证未选资产时的前端必填阻断，不提交创建'
            );
            descInput.dispatchEvent(new Event('input', { bubbles: true }));
          }
        });
        await cdpClickPoint(page, modalReady.value.okX, modalReady.value.okY);
        await page.sleep(400);

        const stillBlocked = await page.evalJSON(() => {
          const modal = document.querySelector('.arco-modal');
          if (!modal) return { open: false, hasScopeErr: false };
          return {
            open: true,
            hasScopeErr: /请至少选择一项资产/.test(modal.innerText || ''),
          };
        });
        if (!stillBlocked.open || !stillBlocked.hasScopeErr) {
          throw new Error('未选择任何查询资产时点击确定未被「请至少选择一项资产」阻断');
        }

        await closeOpenModal(page);
        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '创建业务领域弹窗空提交拦截',
          forbidWrite: true,
        });

        return `modal=${modalReady.value.modalWidth}x${modalReady.value.modalHeight}, 必填拦截生效且 0 写请求`;
      } finally {
        await closeOpenModal(page).catch(() => {});
      }
    }
  );

  const primaryDomainId =
    cfg.workspaceId === KNOWN_FIXTURES.workspaceId
      ? KNOWN_FIXTURES.r4Domain.domainId
      : cfg.baselineDomainId;

  let detailLoadedOk = false;
  await t.check(
    '业务领域详情页五页签顺序尺寸正确且终态无持续 loading',
    async () => {
      const step = '04-domain-detail';
      const nav = await page.gotoContext(
        `/context/domains/${encodeURIComponent(primaryDomainId)}/detail`,
        {
          stepName: step,
          readyFn: () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const txt = document.body?.innerText || '';
            if (/业务领域不存在或已删除/.test(txt)) return 'NOT_FOUND';
            const tabs = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ];
            return tabs.length >= 5 ? 'READY' : false;
          },
        }
      );

      const settled = await waitForTerminalDom(
        page,
        () => !document.querySelector('.spin-center, .arco-spin-loading'),
        { timeoutMs: 10000 }
      );
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '业务领域详情首屏',
        requiredActions: [/Get.*Domain/i],
        forbidWrite: true,
      });

      if (nav.settledValue === 'NOT_FOUND') {
        t.block(
          '业务领域详情页五页签顺序尺寸正确且终态无持续 loading',
          `目标测试领域 ${primaryDomainId} 在当前工作区不存在或已删除`
        );
        return;
      }
      if (!nav.settledOk || !settled.ok) {
        throw new Error(`领域详情页加载超时或存在持续 loading (${nav.firstContentMs}ms)`);
      }

      const tabs = await page.evalJSON(() =>
        [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ]
          .map(el => {
            const r = el.getBoundingClientRect();
            return {
              label: (el.textContent || '').trim(),
              x: r.x,
              y: r.y,
              width: r.width,
              height: r.height,
            };
          })
          .filter(t => t.width > 0 && t.height > 0)
      );
      assertOrderedBoxes(tabs, ['领域知识', '加工任务', '知识模型', 'MCP 服务', '工具配置', '权限管控'], {
        axis: 'x',
        contextLabel: '领域详情五页签',
      });

      detailLoadedOk = true;
      return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
    }
  );

  await t.check(
    '已发布版本快照抽屉展示真实冻结条目或资产范围明细（非空明细提示）',
    async () => {
      if (!detailLoadedOk) {
        t.block(
          '已发布版本快照抽屉展示真实冻结条目或资产范围明细（非空明细提示）',
          `前置领域详情 ${primaryDomainId} 未就绪，无法进入MCP 服务页签`
        );
        return;
      }

      const step = '04-domain-version-snapshot';
      page.setStep(step);

      const tabBox = await page.evalJSON(() => {
        const el = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].find(
          node => (node.textContent || '').trim() === 'MCP 服务'
        );
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
      });
      if (!tabBox) {
        throw new Error('领域详情缺少可点击的「MCP 服务」页签入口');
      }

      await cdpClickPoint(page, tabBox.x, tabBox.y);
      const versionsReady = await waitForTerminalDom(
        page,
        () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          if (/无法加载发布版本/.test(document.body?.innerText || '')) return { loadError: true };
          const table = document.querySelector('table');
          if (!table) return false;
          const rows = [...table.querySelectorAll('tbody tr')].map(tr =>
            [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim())
          );
          return { loadError: false, rows };
        },
        { timeoutMs: 12000 }
      );

      const oracleAfterList = await page.collectStepOracle(step);
      validateStepTerminalState(oracleAfterList, cfg, {
        stepLabel: 'MCP 服务列表加载',
        forbidWrite: true,
      });

      if (!versionsReady.ok || !versionsReady.value) {
        throw new Error('切换「MCP 服务」后版本列表超时未收敛');
      }
      if (versionsReady.value.loadError) {
        throw new Error('「MCP 服务」展示「无法加载发布版本」错误提示');
      }

      const releaseRows = versionsReady.value.rows.filter(
        cells => cells.length >= 3 && cells[0] && cells[0] !== '草稿' && !/尚无发布版本/.test(cells[0])
      );
      if (releaseRows.length === 0) {
        t.block(
          '已发布版本快照抽屉展示真实冻结条目或资产范围明细（非空明细提示）',
          `领域 ${primaryDomainId} 当前尚无已发布版本，无法打开版本快照抽屉`
        );
        return;
      }

      const firstVersion = releaseRows[0][0];
      const snap = await readVersionDrawerSnapshot(page, firstVersion, null);
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: `查看版本 ${firstVersion} 快照抽屉`,
        forbidWrite: true,
      });

      if (snap.hasEmptyHint || snap.rowCount === 0) {
        // Exact CTX-014 symptom
        throw new Error(
          `版本 ${firstVersion} 冻结范围明细为空（抽屉显示「暂未提供此版本的发布范围明细」或无冻结条目）`
        );
      }

      return `version=${firstVersion}, drawer=${snap.width}x${snap.height}, frozenRows=${snap.rowCount}`;
    }
  );

  await t.check(
    '回归对照领域 codex-e2e-r4-domain-1125 的 R2(1.0.2) 与 R1(1.0.1) 排序、发布时间及源修订冻结严格一致',
    async () => {
      if (cfg.workspaceId !== KNOWN_FIXTURES.workspaceId) {
        t.block(
          '回归对照领域 codex-e2e-r4-domain-1125 的 R2(1.0.2) 与 R1(1.0.1) 排序、发布时间及源修订冻结严格一致',
          `当前工作区 ${cfg.workspaceId} 非回归基线工作区 ${KNOWN_FIXTURES.workspaceId}，跳过固定 R1/R2 fixture 核验`
        );
        return;
      }

      const step = '04-r1-r2-frozen-revisions';
      const { domainId, domainName, refundEntryId } = KNOWN_FIXTURES.r4Domain;
      const nav = await page.gotoContext(`/context/domains/${encodeURIComponent(domainId)}/detail`, {
        stepName: step,
        readyFn: () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const txt = document.body?.innerText || '';
          if (/业务领域不存在或已删除/.test(txt)) return 'NOT_FOUND';
          return txt.includes(domainName) ? 'READY' : false;
        },
      });
      if (nav.settledValue === 'NOT_FOUND') {
        t.block(
          '回归对照领域 codex-e2e-r4-domain-1125 的 R2(1.0.2) 与 R1(1.0.1) 排序、发布时间及源修订冻结严格一致',
          `回归对照领域 ${domainName} (${domainId}) 在当前环境不存在`
        );
        return;
      }
      if (!nav.settledOk) {
        throw new Error(`对照领域 ${domainName} 详情加载超时 (${nav.firstContentMs}ms)`);
      }

      const headerAndTab = await page.evalJSON(() => {
        const tab = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].find(
          el => (el.textContent || '').trim() === 'MCP 服务'
        );
        const r = tab?.getBoundingClientRect();
        const headerEl =
          document.querySelector('[class*="detail-header"], header') ||
          document.querySelector('.console-content-wrapper-v2')?.firstElementChild;
        return {
          headerText: (headerEl?.innerText || '').slice(0, 300),
          tabPos: tab && r && r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null,
        };
      });
      if (!headerAndTab?.tabPos) {
        throw new Error(`对照领域 ${domainName} 缺少「MCP 服务」页签入口`);
      }

      await cdpClickPoint(page, headerAndTab.tabPos.x, headerAndTab.tabPos.y);
      const tableSettled = await waitForTerminalDom(
        page,
        () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const trs = [...document.querySelectorAll('table tbody tr')];
          if (trs.length === 0) return false;
          const parsed = trs
            .map(tr => {
              const tds = [...tr.querySelectorAll('td')].map(td => (td.textContent || '').trim());
              return {
                version: tds[0] || '',
                scopeSummary: tds[1] || '',
                status: tds[2] || '',
                publisher: tds[3] || '',
                publishedAt: tds[4] || '',
              };
            })
            .filter(r => r.version && r.version !== '草稿');
          return parsed.length >= 2 ? parsed : false;
        },
        { timeoutMs: 12000 }
      );
      if (!tableSettled.ok || !Array.isArray(tableSettled.value)) {
        throw new Error(`对照领域 ${domainName} 版本列表未加载出 R1/R2 两条已发布版本记录`);
      }

      const r1Snap = await readVersionDrawerSnapshot(page, '1.0.1', refundEntryId);
      const r2Snap = await readVersionDrawerSnapshot(page, '1.0.2', refundEntryId);

      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: 'R1/R2 源修订冻结对照',
        requiredActions: [/Get.*Domain/i],
        forbidWrite: true,
      });

      const verdict = validatePublishedVersionComparison({
        headerText: headerAndTab.headerText,
        rows: tableSettled.value,
        r1RefundRevision: r1Snap.refundRevision,
        r1FrozenCount: r1Snap.rowCount,
        r2RefundRevision: r2Snap.refundRevision,
        r2FrozenCount: r2Snap.rowCount,
      });

      return `${verdict}（R1 发布于 ${tableSettled.value.find(r => r.version === '1.0.1')?.publishedAt}，R2 发布于 ${tableSettled.value.find(r => r.version === '1.0.2')?.publishedAt}）`;
    }
  );

  await t.checkKnownBug(
    'CTX-012',
    '首次发布弹窗首步不展示当前未生效的冗余网关/服务名/认证可编辑项且取消零写请求',
    async () => {
      const candidateId =
        listedDomains.find(d => d.unpublished && d.domainId)?.domainId || cfg.baselineDomainId;
      const step = '04-publish-modal-first-step';

      try {
        const nav = await page.gotoContext(
          `/context/domains/${encodeURIComponent(candidateId)}/detail`,
          {
            stepName: step,
            readyFn: () => {
              if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
              return /工具配置|业务领域不存在/.test(document.body?.innerText || '');
            },
          }
        );
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 8000 }
        );
        if (!nav.settledOk || /业务领域不存在/.test(nav.bodySample || '')) {
          t.block(
            '首次发布弹窗首步不展示当前未生效的冗余网关/服务名/认证可编辑项且取消零写请求',
            `候选未发布领域 ${candidateId} 不可读，缺少可打开发布弹窗的前置对象`
          );
          return;
        }

        const pubBtn = await page.evalJSON(() => {
          const headerBtns = [...document.querySelectorAll('button')].filter(
            el => (el.textContent || '').trim() === '发布'
          );
          const btn = headerBtns[0];
          if (!btn) return { found: false };
          const r = btn.getBoundingClientRect();
          const disabled =
            btn.disabled ||
            btn.getAttribute('aria-disabled') === 'true' ||
            /disabled/i.test(String(btn.className || ''));
          const isAlreadyPublished = /当前发布|已发布/.test(
            (document.querySelector('.console-content-wrapper-v2')?.innerText || '').slice(0, 400)
          );
          return {
            found: true,
            disabled,
            isAlreadyPublished,
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            width: r.width,
            height: r.height,
          };
        });

        if (!pubBtn?.found || !(pubBtn.width > 16 && pubBtn.height > 16)) {
          throw new Error(`领域 ${candidateId} 详情页缺少「发布」按钮入口`);
        }
        if (pubBtn.disabled || pubBtn.isAlreadyPublished) {
          t.block(
            '首次发布弹窗首步不展示当前未生效的冗余网关/服务名/认证可编辑项且取消零写请求',
            `候选领域 ${candidateId} 当前处于已发布或禁发态（disabled=${pubBtn.disabled}），跳过首次发布弹窗首步只读核验以避免改动线上状态`
          );
          return;
        }

        // 仅打开弹窗检视第一步表单，绝不点击「下一步」或「确认发布」
        await cdpClickPoint(page, pubBtn.x, pubBtn.y);
        const modalSettled = await waitForTerminalDom(
          page,
          () => {
            const modal = document.querySelector('.arco-modal');
            if (!modal) return false;
            if (modal.querySelector('.arco-spin-loading')) return false;
            if (/正在检查发布配置/.test(modal.innerText || '')) return false;
            const r = modal.getBoundingClientRect();
            return r.width >= 400 && r.height >= 200
              ? {
                  width: Math.round(r.width),
                  height: Math.round(r.height),
                  text: (modal.innerText || '').slice(0, 2000),
                  hasEditableServiceName: Boolean(
                    [...modal.querySelectorAll('.arco-form-item')].find(
                      item =>
                        /服务名称/.test(item.innerText || '') &&
                        item.querySelector('input:not([disabled])')
                    )
                  ),
                  hasGatewayField: /网关实例/.test(modal.innerText || ''),
                  hasAuthEdit: /入站认证/.test(modal.innerText || ''),
                }
              : false;
          },
          { timeoutMs: 12000 }
        );

        await closeOpenModal(page);
        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '打开发布弹窗首步只读检视',
          forbidWrite: true,
        });

        if (!modalSettled.ok || !modalSettled.value) {
          throw new Error('点击「发布」后发布弹窗未就绪或持续处于「正在检查发布配置…」');
        }

        if (
          modalSettled.value.hasEditableServiceName &&
          modalSettled.value.hasGatewayField &&
          modalSettled.value.hasAuthEdit
        ) {
          // Exact CTX-012 symptom
          throw new Error(
            '首次发布弹窗第一步仍展示网关/服务名/认证可编辑项（冗余网关/认证编辑项）'
          );
        }

        return `modal=${modalSettled.value.width}x${modalSettled.value.height}，直接进入范围与版本核对且关闭零写请求`;
      } finally {
        await closeOpenModal(page).catch(() => {});
        await restoreSafeWorkspace(page, cfg, '04-restore-safe-ws');
      }
    }
  );
}
