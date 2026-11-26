// 模块 01：侧边栏真实点击、冷/热启动工作区与 project 连续性、独立直开页返回及旧连接兼容重定向（CTX-006）

import {
  KNOWN_FIXTURES,
  assertOrderedBoxes,
  cdpClickPoint,
  evaluateSidebarTargetSafety,
  restoreSafeWorkspace,
  validateStepTerminalState,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';
import { assertLegacyDatabaseRedirectView } from '../lib/regression-checks.mjs';

async function ensureContextSidebarExpanded(page) {
  const expandBtn = await page.evalJSON(() => {
    const btn = document.querySelector('aside button[aria-label="展开侧边导航"]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (expandBtn) {
    await cdpClickPoint(page, expandBtn.x, expandBtn.y);
    await page.sleep(300);
  }

  const submenuState = await page.evalJSON(() => {
    const aside = document.querySelector('aside');
    if (!aside) return { hasAside: false, itemsVisible: false, contextHeader: null };
    const leaves = [...aside.querySelectorAll('a, li, [role="menuitem"], span, div')].filter(el => {
      const txt = (el.textContent || '').trim();
      const r = el.getBoundingClientRect();
      return (txt === '工作台' || txt === '知识管理' || txt === '业务领域') && r.width > 16 && r.height > 14;
    });
    if (leaves.length >= 3) {
      return { hasAside: true, itemsVisible: true, contextHeader: null };
    }
    const ctxNode = [...aside.querySelectorAll('[role="menuitem"], div, span')].find(el => {
      const txt = (el.textContent || '').trim();
      const r = el.getBoundingClientRect();
      return txt === 'Context' && r.width > 16 && r.height > 14 && r.height < 64;
    });
    if (!ctxNode) return { hasAside: true, itemsVisible: false, contextHeader: null };
    const r = ctxNode.getBoundingClientRect();
    return {
      hasAside: true,
      itemsVisible: false,
      contextHeader: { x: r.x + r.width / 2, y: r.y + r.height / 2 },
    };
  });

  if (submenuState?.hasAside && !submenuState.itemsVisible && submenuState.contextHeader) {
    await cdpClickPoint(page, submenuState.contextHeader.x, submenuState.contextHeader.y);
    await page.sleep(350);
  }
}

async function inspectSidebarState(page, targetLabel) {
  await ensureContextSidebarExpanded(page);
  return page.evalJSON(`(() => {
    const label = ${JSON.stringify(targetLabel)};
    const aside = document.querySelector('aside');
    if (!aside) return { hasAside: false, target: { found: false, label }, menuBoxes: [] };

    const topArea = aside.querySelector('[class*="sidebarTop"]') || aside.firstElementChild;
    const scopeBannerText = (topArea?.innerText || '').trim();

    const pickMenuNode = expected => {
      const candidates = [...aside.querySelectorAll('a, [role="menuitem"], li')].filter(el => {
        const txt = (el.innerText || el.textContent || '').trim();
        if (txt !== expected) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.height <= 64;
      });
      // 取最内层可点击菜单项，避免命中外层 SubMenu ul/li 容器
      candidates.sort((a, b) => a.querySelectorAll('*').length - b.querySelectorAll('*').length);
      return candidates[0] || null;
    };

    const menuBoxes = ['工作台', '知识管理', '业务领域']
      .map(name => {
        const el = pickMenuNode(name);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        return { label: name, x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .filter(Boolean);

    const el = pickMenuNode(label);
    if (!el) {
      return { hasAside: true, scopeBannerText, menuBoxes, target: { found: false, label, scopeBannerText } };
    }
    const r = el.getBoundingClientRect();
    const anchor = el.tagName === 'A' ? el : el.closest('a') || el.querySelector('a');
    const href = anchor?.getAttribute('href') || el.getAttribute('data-path') || '';
    const disabled =
      el.getAttribute('aria-disabled') === 'true' ||
      /disabled/i.test(String(el.className || ''));
    const style = window.getComputedStyle(el);
    const visible = style.display !== 'none' && style.visibility !== 'hidden' && r.width > 0 && r.height > 0;

    return {
      hasAside: true,
      scopeBannerText,
      menuBoxes,
      target: {
        found: true,
        label,
        visible,
        disabled,
        href,
        scopeBannerText,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      },
    };
  })()`);
}

async function clickSidebarSafely(page, cfg, label, stepName, readyPredicate, requiredActions = []) {
  const sidebar = await inspectSidebarState(page, label);
  if (!sidebar?.hasAside) {
    throw new Error(`页面未渲染左侧导航栏 <aside>，无法执行「${label}」真实点击`);
  }
  assertOrderedBoxes(sidebar.menuBoxes, ['工作台', '知识管理', '业务领域'], {
    axis: 'y',
    contextLabel: 'Context 侧栏导航',
  });

  const safety = evaluateSidebarTargetSafety(sidebar.target, cfg);
  if (!safety.safe) {
    // 命中禁区或不可点时立即终止本步，绝不继续点击
    throw new Error(safety.reason);
  }

  page.setStep(stepName);
  await cdpClickPoint(page, safety.centerX, safety.centerY);

  const settled = await waitForTerminalDom(page, readyPredicate, { timeoutMs: 16000 });
  const oracle = await page.collectStepOracle(stepName);

  try {
    validateStepTerminalState(oracle, cfg, {
      stepLabel: `侧栏点击「${label}」`,
      requiredActions,
      forbidWrite: true,
    });
    if (!settled.ok) {
      throw new Error(
        `侧栏点击「${label}」后在 16s 内未收敛至目标终态视图 (href=${oracle.href})`
      );
    }
    return { settled, oracle };
  } finally {
    if (oracle.forbiddenWorkspaceHit || !oracle.urlWorkspaceOk || !oracle.urlProjectOk) {
      await restoreSafeWorkspace(page, cfg, `${stepName}:restore`);
    }
  }
}

export async function run(t, page, cfg) {
  let coldDomainId =
    cfg.workspaceId === KNOWN_FIXTURES.workspaceId
      ? KNOWN_FIXTURES.r4Domain.domainId
      : cfg.baselineDomainId;

  if (!coldDomainId) {
    await page.gotoContext('/context/domains', {
      stepName: '01-discover-domain-for-cold-nav',
      timeoutMs: 14000,
    });
    await waitForTerminalDom(page, () => !document.querySelector('.spin-center, .arco-spin-loading'), {
      timeoutMs: 8000,
    });
    coldDomainId = await page.evalJSON(() => {
      const cardsWrap = document.querySelector('[class*="cards"]');
      const cards = cardsWrap ? [...cardsWrap.children] : [];
      const parsed = cards
        .map(card => {
          const txt = (card.innerText || '').trim();
          const m = txt.match(/\bdom-[a-z0-9_-]+/i);
          return m ? { id: m[0], synthetic: /codex-e2e-/i.test(txt) } : null;
        })
        .filter(Boolean);
      return (parsed.find(item => item.synthetic) || parsed[0])?.id || '';
    });
  }

  await t.check(
    '冷启动深链进入领域详情后侧栏顺序尺寸有效，真实点击侧栏「工作台」保持 workspaceId 与 project（防冷启动串空间）',
    async () => {
      if (!coldDomainId) {
        t.block(
          '冷启动深链进入领域详情后侧栏顺序尺寸有效，真实点击侧栏「工作台」保持 workspaceId 与 project',
          `当前工作区 (${cfg.workspaceId}) 暂无业务领域且未配置 CONTEXT_BASELINE_DOMAIN_ID（空白工作区在热态侧栏与模块 13 覆盖）`
        );
        return;
      }
      const coldStep = '01-cold-domain-detail';
      const coldNav = await page.gotoContext(
        `/context/domains/${encodeURIComponent(coldDomainId)}/detail`,
        {
          stepName: coldStep,
          timeoutMs: 18000,
          readyFn: () => {
            const spinning = Boolean(
              document.querySelector('.spin-center, .arco-spin-loading, [aria-busy="true"]')
            );
            if (spinning) return false;
            const aside = document.querySelector('aside');
            const hasDetailOrEmpty = Boolean(document.querySelector('article h1')?.innerText.trim() &&
              document.querySelector('article ve-tabs ve-tab-pane[title="工具配置"]'));
            return aside && hasDetailOrEmpty ? window.location.pathname : false;
          },
        }
      );

      await waitForTerminalDom(page, () => !document.querySelector('.spin-center, .arco-spin-loading'), {
        timeoutMs: 8000,
      });
      const coldOracle = await page.collectStepOracle(coldStep);
      validateStepTerminalState(coldOracle, cfg, {
        stepLabel: '冷启动进入领域详情',
        forbidWrite: true,
      });
      if (!coldNav.settledOk) {
        throw new Error(`冷启动领域详情在超时窗口内未完成终态挂载 (${coldNav.firstContentMs}ms)`);
      }

      const { settled, oracle } = await clickSidebarSafely(
        page,
        cfg,
        '工作台',
        '01-cold-sidebar-click-workbench',
        () => {
          if (!window.location.pathname.endsWith('/context/workbench')) return false;
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const tabs = [...document.querySelectorAll('ve-tabs[type="capsule"]')].flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]).filter(
            el => {
              const txt = (el.textContent || '').trim();
              const r = el.getBoundingClientRect();
              return (txt === '概览' || txt === '调试台') && r.width > 0 && r.height > 0;
            }
          );
          const terminal = document.querySelector('.context-workbench-chatkit [contenteditable="true"], .context-workbench-chatkit textarea') ||
            document.querySelector('[class*="overviewPane"] a, [class*="overviewPane"] button:not([disabled]), [class*="overviewPane"] .arco-empty');
          return tabs.length >= 2 && terminal ? { tabCount: tabs.length, href: window.location.href } : false;
        }
      );

      return `coldDetail=${coldNav.firstContentMs}ms, sidebarToWorkbench=${settled.elapsedMs}ms, APIs=${oracle.records.length}`;
    }
  );

  await t.check(
    '热态连续真实点击侧栏「知识管理 → 业务领域 → 工作台」全程保持工作区、project 与主体容器有效尺寸',
    async () => {
      await restoreSafeWorkspace(page, cfg, '01-warm-prep');

      const catalogRes = await clickSidebarSafely(
        page,
        cfg,
        '知识管理',
        '01-warm-sidebar-catalog',
        () => {
          if (!window.location.pathname.endsWith('/context/catalog')) return false;
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const mainEl =
            document.querySelector('.arco-table') ||
            document.querySelector('.arco-empty') ||
            document.querySelector('main, .console-content-wrapper-v2');
          if (!mainEl) return false;
          const r = mainEl.getBoundingClientRect();
          const terminal = mainEl.querySelector('tbody tr[data-row-key]') ||
            mainEl.querySelector('.arco-empty-description');
          return terminal && r.width >= 300 && r.height >= 120
            ? { width: Math.round(r.width), height: Math.round(r.height) }
            : false;
        },
        [/ListContextConnections|ListContextEntries/i]
      );

      const domainsRes = await clickSidebarSafely(
        page,
        cfg,
        '业务领域',
        '01-warm-sidebar-domains',
        () => {
          if (!window.location.pathname.endsWith('/context/domains')) return false;
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const searchInput = document.querySelector('input[aria-label="搜索业务领域"]');
          const cardOrEmpty =
            document.querySelector('[class*="cards"]') || document.querySelector('.arco-empty');
          if (!searchInput || !cardOrEmpty) return false;
          const sr = searchInput.getBoundingClientRect();
          const cr = cardOrEmpty.getBoundingClientRect();
          return sr.width >= 160 && sr.height >= 24 && cr.width >= 200 && cr.height >= 60
            ? { width: Math.round(cr.width), height: Math.round(cr.height) }
            : false;
        },
        [/List.*Domains/i]
      );

      const workbenchRes = await clickSidebarSafely(
        page,
        cfg,
        '工作台',
        '01-warm-sidebar-workbench',
        () => {
          if (!window.location.pathname.endsWith('/context/workbench')) return false;
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const tabs = [...document.querySelectorAll('ve-tabs[type="capsule"]')].flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]).filter(
            el => {
              const txt = (el.textContent || '').trim();
              const r = el.getBoundingClientRect();
              return (txt === '概览' || txt === '调试台') && r.width > 20 && r.height > 18;
            }
          );
          return tabs.length >= 2 ? { tabs: tabs.length } : false;
        }
      );

      return `catalog=${catalogRes.settled.elapsedMs}ms, domains=${domainsRes.settled.elapsedMs}ms, workbench=${workbenchRes.settled.elapsedMs}ms`;
    }
  );

  await t.check(
    '直开独立页：知识加工 (/context/processing) 终态加载正常，且点击「返回业务领域」保持 workspaceId 与 project',
    async () => {
      const openStep = '01-direct-open-processing';
      try {
        await page.gotoContext('/context/processing', {
          stepName: openStep,
          readyFn: () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const hasTabs = ['加工记录', '已保存任务'].every(label =>
              [...document.querySelectorAll('ve-tabs ve-tab-pane')].some(
                el => el.getAttribute('title') === label
              )
            );
            const terminal = document.querySelector('tbody tr[data-row-key], .arco-empty-description') ||
              [...document.querySelectorAll('ve-table')].some(table => table.shadowRoot?.querySelector('tbody tr'));
            return Boolean(hasTabs && terminal);
          },
        });
        const settledOpen = await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 10000 }
        );
        const openOracle = await page.collectStepOracle(openStep);
        validateStepTerminalState(openOracle, cfg, {
          stepLabel: '直开 /context/processing',
          forbidWrite: true,
        });
        if (!settledOpen.ok) {
          throw new Error('直开 /context/processing 持续处于 loading 未收敛');
        }

        const backBtn = await page.evalJSON(() => {
          const btn = [...document.querySelectorAll('button, ve-button')].find(
            el => (el.textContent || '').trim() === '返回业务领域'
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height };
        });
        if (!backBtn || !(backBtn.width > 20 && backBtn.height > 18)) {
          throw new Error('知识加工页缺少有效尺寸的「返回业务领域」按钮');
        }

        const backStep = '01-processing-return-domains';
        page.setStep(backStep);
        await cdpClickPoint(page, backBtn.x, backBtn.y);

        const backSettled = await waitForTerminalDom(
          page,
          () =>
            window.location.pathname.endsWith('/context/domains') &&
            !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 12000 }
        );
        const backOracle = await page.collectStepOracle(backStep);
        validateStepTerminalState(backOracle, cfg, {
          stepLabel: '知识加工页点击「返回业务领域」',
          forbidWrite: true,
        });
        if (!backSettled.ok) {
          throw new Error(`点击「返回业务领域」后未成功回到业务领域列表终态 (${backOracle.href})`);
        }
        return `returnElapsed=${backSettled.elapsedMs}ms, href=${backOracle.href}`;
      } finally {
        await restoreSafeWorkspace(page, cfg, '01-direct-processing-restore');
      }
    }
  );

  await t.check(
    '直开独立页：MCP 管理 (/context/domains/mcp) 终态加载正常，且点击工具栏「业务领域」返回保持 workspaceId 与 project',
    async () => {
      const openStep = '01-direct-open-mcp';
      try {
        await page.gotoContext('/context/domains/mcp', {
          stepName: openStep,
          readyFn: () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            return Boolean(
              document.querySelector('ve-table.ak-data-table') ||
                document.querySelector('.arco-empty') ||
                document.querySelector('.arco-alert')
            );
          },
        });
        const settledOpen = await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 10000 }
        );
        const openOracle = await page.collectStepOracle(openStep);
        validateStepTerminalState(openOracle, cfg, {
          stepLabel: '直开 /context/domains/mcp',
          requiredActions: [/List.*Domains/i],
          forbidWrite: true,
        });
        if (!settledOpen.ok) {
          throw new Error('直开 /context/domains/mcp 持续处于 loading 未收敛');
        }

        // 在内容区（排除侧栏 aside）查找页内「业务领域」返回按钮
        const backBtn = await page.evalJSON(`(() => {
          const forbidden = ${JSON.stringify(cfg.forbiddenWorkspaceId)};
          const contentRoot = document.querySelector('.console-content-wrapper-v2') || document.body;
          const btn = [...contentRoot.querySelectorAll('button, ve-button')].find(el => {
            if (el.closest('aside')) return false;
            return (el.textContent || '').trim() === '业务领域';
          });
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          const href = btn.closest('a')?.getAttribute('href') || '';
          return {
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
            width: r.width,
            height: r.height,
            forbiddenHref: Boolean(forbidden && href.includes(forbidden)),
          };
        })()`);
        if (!backBtn || !(backBtn.width > 20 && backBtn.height > 18)) {
          throw new Error('MCP 管理页工具栏缺少有效尺寸的「业务领域」返回按钮');
        }
        if (backBtn.forbiddenHref) {
          throw new Error(`MCP 管理页「业务领域」按钮指向禁区工作区 ${cfg.forbiddenWorkspaceId}，已终止点击`);
        }

        const backStep = '01-mcp-return-domains';
        page.setStep(backStep);
        await cdpClickPoint(page, backBtn.x, backBtn.y);

        const backSettled = await waitForTerminalDom(
          page,
          () =>
            window.location.pathname.endsWith('/context/domains') &&
            !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 12000 }
        );
        const backOracle = await page.collectStepOracle(backStep);
        validateStepTerminalState(backOracle, cfg, {
          stepLabel: 'MCP 管理页点击「业务领域」返回',
          forbidWrite: true,
        });
        if (!backSettled.ok) {
          throw new Error(`MCP 管理页点击「业务领域」后未回到领域列表终态 (${backOracle.href})`);
        }
        return `returnElapsed=${backSettled.elapsedMs}ms, href=${backOracle.href}`;
      } finally {
        await restoreSafeWorkspace(page, cfg, '01-direct-mcp-restore');
      }
    }
  );

  await t.checkKnownBug(
    'CTX-006',
    '旧连接路由 /context/connections/:Id/detail 自动重定向到资产详情且返回不丢 workspaceId 与 project',
    async () => {
      const targetConnId =
        cfg.workspaceId === KNOWN_FIXTURES.workspaceId
          ? KNOWN_FIXTURES.r4Domain.localKbConnId
          : cfg.baselineLocalKbConnId;
      if (!targetConnId) {
        t.block(
          'CTX-006 旧连接路由重定向资产详情',
          `当前工作区 (${cfg.workspaceId}) 未配置 CONTEXT_BASELINE_LOCAL_KB_CONN_ID，跳过旧连接 ID 深链重定向检查`
        );
        return;
      }
      const step = '01-legacy-conn-redirect';

      try {
        await page.gotoContext(`/context/connections/${encodeURIComponent(targetConnId)}/detail`, {
          stepName: step,
          timeoutMs: 12000,
          readyFn: () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            return (
              /\/context\/catalog\/[^/]+\/detail/.test(window.location.pathname) ||
              /返回知识管理|来源不存在或无权查看|暂时无法读取此来源|此来源暂无已接入资产/.test(
                document.body?.innerText || ''
              )
            );
          },
        });
        await waitForTerminalDom(
          page,
          () => !document.querySelector('.spin-center, .arco-spin-loading'),
          { timeoutMs: 6000 }
        );

        const oracle = await page.collectStepOracle(step);
        if (oracle.forbiddenWorkspaceHit) {
          throw new Error(`旧连接路由越界跳入禁区工作区 ${cfg.forbiddenWorkspaceId} (${oracle.href})`);
        }
        if (oracle.pageErrors.length > 0) {
          throw new Error(`旧连接路由抛未捕获异常: ${oracle.pageErrors[0].text}`);
        }

        const info = await page.evalJSON(() => {
          const backBtn = [...document.querySelectorAll('button, ve-button')].find(el =>
            /返回知识管理|返回目录|返回/.test((el.textContent || '').trim())
          );
          const r = backBtn?.getBoundingClientRect();
          return {
            href: window.location.href,
            pathname: window.location.pathname,
            text: (document.body?.innerText || '').slice(0, 1000),
            backBtn:
              backBtn && r && r.width > 0 && r.height > 0
                ? { x: r.x + r.width / 2, y: r.y + r.height / 2 }
                : null,
          };
        });

        const redirectedToCatalogDetail = /\/context\/catalog\/[^/]+\/detail/.test(info.pathname);
        if (!redirectedToCatalogDetail) {
          // 若落入回退页，进一步验证回退按钮是否会丢失 workspaceId / project
          let backScopeNote = '';
          if (info.backBtn) {
            await cdpClickPoint(page, info.backBtn.x, info.backBtn.y);
            await page.sleep(600);
            const afterHref = await page.evalJSON(() => window.location.href);
            const u = new URL(afterHref);
            backScopeNote = `, 点击返回后 workspaceId=${u.searchParams.get('workspaceId') || '丢失'}, project=${u.searchParams.get('project') || '丢失'}`;
          }
          // Exact CTX-006 symptom
          throw new Error(
            `未成功重定向至资产详情: href=${info.href}，仍停留在旧连接路由${backScopeNote}`
          );
        }

        validateStepTerminalState(oracle, cfg, {
          stepLabel: '旧连接路由重定向资产详情',
          forbidWrite: true,
        });
        return `成功重定向至 ${info.href}`;
      } finally {
        await restoreSafeWorkspace(page, cfg, '01-restore-safe-ws');
      }
    }
  );

  await t.check(
    'NAV-04 聚合数据库旧连接路由 /context/connections/:pgId/detail 重定向保留原 connectionId、渲染真实数据表，且返回与前进后退不丢范围',
    async () => {
      if (cfg.workspaceId !== KNOWN_FIXTURES.workspaceId) {
        t.block('NAV-04 数据库旧连接跳转', '当前工作区非回归基线工作区，缺少已知 PG 连接夹具');
        return;
      }
      const pgConnId = KNOWN_FIXTURES.pgSourceId;
      const expectedTable = KNOWN_FIXTURES.pgExpectedTable;
      const step = '01-legacy-pg-conn-redirect';

      try {
        await page.gotoContext(`/context/connections/${encodeURIComponent(pgConnId)}/detail`, {
          stepName: step,
          timeoutMs: 14000,
          readyFn: () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            return /\/context\/catalog\/[^/]+\/detail/.test(window.location.pathname);
          },
        });
        const settled = await waitForTerminalDom(
          page,
          () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const main = document.querySelector('main, article, .console-content-wrapper-v2');
            const text = main?.innerText || '';
            return Boolean(
              text.includes('public.events') ||
                /无法加载已接入数据表|暂无已接入数据表|来源不存在/.test(text)
            );
          },
          { timeoutMs: 12000 }
        );
        const redirectOracle = await page.collectStepOracle(step);
        validateStepTerminalState(redirectOracle, cfg, {
          stepLabel: 'PG 旧连接路由重定向详情',
          forbidWrite: true,
        });
        if (!settled.ok) {
          throw new Error(`PG 旧连接重定向后详情页未收敛 (${redirectOracle.href})`);
        }

        const detailSnap = await page.evalJSON(() => {
          const root = document.querySelector('main, article, .console-content-wrapper-v2') || document.body;
          const rows = [...root.querySelectorAll('table tbody tr')].filter(
            tr => tr.getClientRects().length && !tr.querySelector('.arco-empty')
          );
          const backBtn = [...root.querySelectorAll('button, ve-button, a')].find(el => {
            const label = el.getAttribute('aria-label') || el.getAttribute('title') || el.textContent || '';
            return el.getClientRects().length &&
              /^(返回资源列表|返回知识管理|返回目录|返回资产列表|返回)$/.test(label.trim());
          });
          const r = backBtn?.getBoundingClientRect();
          return {
            detailHref: window.location.href,
            text: root.innerText || '',
            hasErrorAlert: Boolean(root.querySelector('.arco-alert-error')),
            tableCount: rows.length,
            backPos:
              backBtn && r && r.width > 0 && r.height > 0
                ? { x: r.x + r.width / 2, y: r.y + r.height / 2 }
                : null,
          };
        });

        if (!detailSnap.backPos) throw new Error('PG 详情缺少可操作的返回资源列表按钮');
        let backHref = '';
        if (detailSnap.backPos) {
          const backStep = '01-legacy-pg-back-catalog';
          page.setStep(backStep);
          await cdpClickPoint(page, detailSnap.backPos.x, detailSnap.backPos.y);
          const backSettled = await waitForTerminalDom(
            page,
            () =>
              window.location.pathname.endsWith('/context/catalog') &&
              !document.querySelector('.spin-center, .arco-spin-loading'),
            { timeoutMs: 10000 }
          );
          const backOracle = await page.collectStepOracle(backStep);
          validateStepTerminalState(backOracle, cfg, {
            stepLabel: 'PG 详情点击返回目录',
            forbidWrite: true,
          });
          if (!backSettled.ok) {
            throw new Error(`PG 详情点击返回后未回到目录终态 (${backOracle.href})`);
          }
          backHref = backOracle.href;

          // 浏览器后退应恢复同一数据库资产详情及 connectionId
          const histBackStep = '01-legacy-pg-history-back';
          page.setStep(histBackStep);
          await page.evalJSON(() => window.history.back());
          const histSettled = await waitForTerminalDom(
            page,
            () =>
              /\/context\/catalog\/[^/]+\/detail/.test(window.location.pathname) &&
              !document.querySelector('.spin-center, .arco-spin-loading') &&
              (document.body?.innerText || '').includes('public.events'),
            { timeoutMs: 10000 }
          );
          const histOracle = await page.collectStepOracle(histBackStep);
          validateStepTerminalState(histOracle, cfg, {
            stepLabel: '浏览器后退恢复 PG 详情',
            forbidWrite: true,
          });
          if (!histSettled.ok) {
            throw new Error(`浏览器后退未恢复原 PG 详情与数据表 (${histOracle.href})`);
          }
        }

        assertLegacyDatabaseRedirectView(
          { ...detailSnap, backHref },
          cfg,
          { connectionId: pgConnId, expectedTable }
        );
        return `connectionId=${pgConnId} 保留，已渲染 ${detailSnap.tableCount} 张表含 ${expectedTable}`;
      } finally {
        await restoreSafeWorkspace(page, cfg, '01-restore-pg-ws');
      }
    }
  );
}
