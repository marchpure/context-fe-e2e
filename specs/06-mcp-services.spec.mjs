// 模块 06：MCP 服务管理页列表渲染（CTX-001）、表头顺序与行尺寸、本地搜索过滤及 24h 调用统计真实状态检查（CTX-021）

import {
  KNOWN_FIXTURES,
  assertOrderedBoxes,
  cdpClickPoint,
  cdpPressKey,
  classifyMcpMetricsDrawerView,
  restoreSafeWorkspace,
  validateStepTerminalState,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';

async function applyMcpKeywordSearch(page, keyword) {
  const inputBox = await page.evalJSON(() => {
    const control = document.querySelector('[aria-label="搜索 MCP 服务"]');
    const input = control?.matches('input') ? control : control?.shadowRoot?.querySelector('input');
    if (!input) return null;
    const r = input.getBoundingClientRect();
    return r.width > 0 && r.height > 0
      ? { x: r.x + r.width / 2, y: r.y + r.height / 2, width: r.width, height: r.height }
      : null;
  });
  if (!inputBox) {
    throw new Error('MCP 管理页缺少「搜索服务名称、ID 或业务领域」搜索输入框');
  }

  await cdpClickPoint(page, inputBox.x, inputBox.y);
  await page.evalJSON(`(() => {
    const control = document.querySelector('[aria-label="搜索 MCP 服务"]');
    const input = control?.matches('input') ? control : control?.shadowRoot?.querySelector('input');
    if (!input) return;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set?.call(
      input,
      ${JSON.stringify(keyword)}
    );
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  })()`);
  await cdpPressKey(page, 'Enter', 'Enter', 13);


}

async function readMcpTableState(page) {
  return page.evalJSON(() => {
    const host = document.querySelector('ve-table.ak-data-table');
    const table = host?.shadowRoot?.querySelector('table');
    if (!table) return { hasTable: false, headers: [], rows: [], emptyText: '' };

    const seenHeaders = new Set();
    const headers = [...table.querySelectorAll('thead th')]
      .map(th => {
        const label = (th.textContent || '').replace(/\s+/g, ' ').trim();
        const r = th.getBoundingClientRect();
        return { label, x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .filter(h => {
        if (!h.label || !(h.width > 0 && h.height > 0) || seenHeaders.has(h.label)) return false;
        seenHeaders.add(h.label);
        return true;
      });

    const mainBody = table.querySelector('tbody');
    const trs = mainBody ? [...mainBody.querySelectorAll('tr')] : [];
    const emptyText = host.closest('section')?.innerText || table.innerText;
    const rows = trs
      .filter(tr => tr.cells.length === headers.length)
      .map(tr => {
        const r = tr.getBoundingClientRect();
        const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());
        const metricsBtn = [...tr.querySelectorAll('td button, td ve-button, td a')].find(
          el => (el.textContent || '').trim() === '查看'
        );
        const mr = metricsBtn?.getBoundingClientRect();
        return {
          width: Math.round(r.width),
          height: Math.round(r.height),
          nameAndId: tds[0] || '',
          status: tds[1] || '',
          domainName: tds[2] || '',
          workspace: tds[3] || '',
          version: tds[4] || '',
          gateway: tds[5] || '',
          registry: tds[6] || '',
          metricsBtnPos:
            metricsBtn && mr && mr.width > 0 ? { x: mr.x + mr.width / 2, y: mr.y + mr.height / 2 } : null,
        };
      })
      .filter(row => row.nameAndId);

    return {
      hasTable: true,
      headers,
      rows,
      emptyText: emptyText.trim(),
    };
  });
}

async function closeMcpDrawer(page) {
  const pos = await page.evalJSON(() => {
    const closeBtn = document.querySelector('.arco-drawer .arco-drawer-close-icon');
    if (!closeBtn) return null;
    const r = closeBtn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (pos) {
    await cdpClickPoint(page, pos.x, pos.y);
  } else {
    await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  }
  await waitForTerminalDom(page, () => !document.querySelector('.arco-drawer'), {
    timeoutMs: 6000,
    settleMs: 100,
  });
}

export async function run(t, page, cfg) {
  let initialRows = [];

  await t.checkKnownBug(
    'CTX-001',
    'MCP 服务管理页终态渲染列表、列头顺序与行尺寸有效，不抛 localeCompare TypeError',
    async () => {
      const step = '06-mcp-services-list';
      const nav = await page.gotoContext('/context/domains/mcp', {
        stepName: step,
        readyFn: () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          return Boolean(
            document.querySelector('ve-table.ak-data-table') ||
              document.querySelector('.arco-alert') ||
              /加载失败/.test(document.body?.innerText || '')
          );
        },
      });

      const settled = await waitForTerminalDom(
        page,
        () => !document.querySelector('.spin-center, .arco-spin-loading'),
        { timeoutMs: 12000 }
      );
      const oracle = await page.collectStepOracle(step);

      const consoleLocaleErr = page.consoleErrors.find(
        e => e.step === step && /localeCompare/i.test(e.text)
      );
      const pageLocaleErr = oracle.pageErrors.find(e => /localeCompare/i.test(e.text));
      if (consoleLocaleErr || pageLocaleErr) {
        // Exact CTX-001 symptom
        throw new Error(
          `MCP 管理列表触发 localeCompare TypeError (${nav.firstContentMs}ms): ${
            consoleLocaleErr?.text || pageLocaleErr?.text
          }`
        );
      }

      validateStepTerminalState(oracle, cfg, {
        stepLabel: 'MCP 服务管理列表',
        requiredActions: [/List.*Domains/i],
        forbidWrite: true,
      });

      if (!nav.settledOk || !settled.ok) {
        throw new Error(`MCP 服务列表加载超时或存在持续 loading (${nav.firstContentMs}ms)`);
      }
      if (/MCP 服务加载失败|加载失败，点击重试/.test(oracle.visibleText)) {
        throw new Error('MCP 服务管理页出现错误提示（非 localeCompare 异常）');
      }

      const tableState = await readMcpTableState(page);
      if (!tableState.hasTable) {
        throw new Error('MCP 服务管理页未挂载 MCP 服务表格');
      }
      assertOrderedBoxes(
        tableState.headers,
        ['服务名称 / ID', '服务状态', '业务领域', '所属空间', '发布版本', '关联网关', '资产中心', '操作'],
        { axis: 'x', minWidth: 40, minHeight: 16, contextLabel: 'MCP 服务表头' }
      );

      if (cfg.workspaceId === KNOWN_FIXTURES.workspaceId) {
        if (tableState.rows.length === 0) {
          throw new Error('回归工作区 800e2e0a… 中 MCP 服务列表为空，应包含已发布测试领域的服务');
        }
        const r4Row = tableState.rows.find(r =>
          r.domainName.includes(KNOWN_FIXTURES.r4Domain.domainName)
        );
        if (!r4Row || r4Row.version !== KNOWN_FIXTURES.r4Domain.r2.version) {
          throw new Error(
            `MCP 列表对照领域 ${KNOWN_FIXTURES.r4Domain.domainName} 版本应为 ${KNOWN_FIXTURES.r4Domain.r2.version}，实际=${r4Row ? r4Row.version : '未找到行'}`
          );
        }
      }

      const invalidRow = tableState.rows.find(
        r => !(r.width >= 360 && r.height >= 28) || !r.status || !r.domainName || !r.version
      );
      if (invalidRow) {
        throw new Error(`MCP 服务行尺寸或核心字段缺失: ${JSON.stringify(invalidRow)}`);
      }

      initialRows = tableState.rows;
      return `firstContent=${nav.firstContentMs}ms, rows=${tableState.rows.length}, APIs=${oracle.records.length}`;
    }
  );

  await t.check(
    'MCP 服务列表关键词搜索过滤（无匹配空态、精确匹配与清空恢复）真实生效且零写请求',
    async () => {
      if (initialRows.length === 0) {
        t.block(
          'MCP 服务列表关键词搜索过滤（无匹配空态、精确匹配与清空恢复）真实生效且零写请求',
          '当前工作区暂无已发布 MCP 服务行，无法核验关键词过滤与恢复'
        );
        return;
      }

      const step = '06-mcp-filter-search';
      page.setStep(step);

      const preferredRow =
        initialRows.find(r => r.domainName.includes(KNOWN_FIXTURES.r4Domain.domainName)) ||
        initialRows[0];
      const targetKeyword = preferredRow.domainName;

      // 1. 搜索不存在的关键词 -> 必须显示「请调整搜索或筛选条件」且 0 行数据
      await applyMcpKeywordSearch(page, '__nonexistent_mcp_e2e_99999__');
      const emptyFiltered = await waitForTerminalDom(
        page,
        () => {
          const table = document.querySelector('ve-table.ak-data-table');
          if (!table) return false;
          return /请调整搜索或筛选条件/.test(table.closest('section')?.innerText || table.shadowRoot?.textContent || '');
        },
        { timeoutMs: 8000, settleMs: 150 }
      );
      if (!emptyFiltered.ok) {
        throw new Error('输入不存在的服务关键词后，表格未过滤为空态「请调整搜索或筛选条件」');
      }

      // 2. 搜索真实已发布领域名 -> 必须只展示匹配行
      await applyMcpKeywordSearch(page, targetKeyword);
      const matchedFiltered = await waitForTerminalDom(
        page,
        `(() => {
          const kw = ${JSON.stringify(targetKeyword.toLowerCase())};
          const table = document.querySelector('ve-table.ak-data-table');
          const body = table?.querySelector('.arco-table-content-inner tbody') || table?.querySelector('tbody');
          const rows = body ? [...body.querySelectorAll('tr')].filter(tr => tr.cells.length === headers.length) : [];
          if (rows.length === 0) return false;
          const allMatch = rows.every(tr => (tr.innerText || '').toLowerCase().includes(kw));
          return allMatch ? rows.length : false;
        })()`,
        { timeoutMs: 8000, settleMs: 150 }
      );
      if (!matchedFiltered.ok || !matchedFiltered.value) {
        throw new Error(`按领域「${targetKeyword}」过滤后未精确命中目标 MCP 服务行`);
      }

      // 3. 清空搜索词 -> 恢复初始列表行数
      await applyMcpKeywordSearch(page, '');
      const restored = await waitForTerminalDom(
        page,
        `(() => {
          const expectedMin = ${initialRows.length};
          const table = document.querySelector('ve-table.ak-data-table');
          const body = table?.querySelector('.arco-table-content-inner tbody') || table?.querySelector('tbody');
          const rows = body ? [...body.querySelectorAll('tr')].filter(tr => tr.cells.length === headers.length) : [];
          return rows.length >= expectedMin ? rows.length : false;
        })()`,
        { timeoutMs: 8000, settleMs: 150 }
      );
      if (!restored.ok) {
        throw new Error(`清空 MCP 搜索关键词后列表行数未恢复（期望 >= ${initialRows.length}）`);
      }

      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: 'MCP 服务搜索过滤',
        forbidWrite: true,
      });

      return `keyword="${targetKeyword}" 命中 ${matchedFiltered.value} 行，空匹配与清空恢复(${restored.value} 行)均正常`;
    }
  );

  await t.checkKnownBug(
    'CTX-021',
    'MCP 服务点击「调用统计 → 查看」抽屉展示真实 24h 调用指标而非 UNAVAILABLE',
    async () => {
      const freshTable = await readMcpTableState(page);
      if (freshTable.rows.length === 0) {
        t.block(
          'MCP 服务点击「调用统计 → 查看」抽屉展示真实 24h 调用指标而非 UNAVAILABLE',
          '当前工作区暂无已发布 MCP 服务，无法打开近 24 小时调用统计抽屉'
        );
        return;
      }

      const targetRow =
        freshTable.rows.find(
          r => r.domainName.includes(KNOWN_FIXTURES.r4Domain.domainName) && r.metricsBtnPos
        ) || freshTable.rows.find(r => r.metricsBtnPos);

      if (!targetRow?.metricsBtnPos) {
        throw new Error('MCP 服务列表「调用统计」列缺少可点击的「查看」按钮');
      }

      const step = '06-mcp-24h-metrics-drawer';
      page.setStep(step);

      try {
        await cdpClickPoint(page, targetRow.metricsBtnPos.x, targetRow.metricsBtnPos.y);

        const drawerSettled = await waitForTerminalDom(
          page,
          () => {
            const drawer = document.querySelector('.arco-drawer');
            if (!drawer) return false;
            if (drawer.querySelector('.arco-spin, .arco-spin-loading')) return false;
            const r = drawer.getBoundingClientRect();
            const headerText = (drawer.querySelector('.arco-drawer-header')?.innerText || '').trim();
            if (!headerText.includes('近 24 小时调用')) return false;

            const metrics = {};
            const itemRows = [...drawer.querySelectorAll('.arco-descriptions-row, tr')];
            for (const row of itemRows) {
              const cells = [...row.querySelectorAll('th, td, .arco-descriptions-item-label, .arco-descriptions-item-value')]
                .map(c => (c.textContent || '').trim())
                .filter(Boolean);
              if (cells.length >= 2) {
                metrics[cells[0]] = cells[1];
              }
            }
            return {
              open: true,
              loading: false,
              width: Math.round(r.width),
              height: Math.round(r.height),
              headerText,
              text: (drawer.innerText || '').trim(),
              metrics,
            };
          },
          { timeoutMs: 12000 }
        );

        await closeMcpDrawer(page);
        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: 'MCP 24h 调用统计查询',
          requiredActions: [/Get.*DomainService/i],
          forbidWrite: true,
        });

        if (!drawerSettled.ok || !drawerSettled.value) {
          throw new Error('点击「查看」后近 24 小时调用统计抽屉超时未完成加载');
        }

        const res = classifyMcpMetricsDrawerView(drawerSettled.value);
        if (res.status === 'FORBIDDEN') {
          t.block(
            'MCP 服务点击「调用统计 → 查看」抽屉展示真实 24h 调用指标而非 UNAVAILABLE',
            `当前账号对领域「${targetRow.domainName}」无调用统计查看权限（FORBIDDEN）`
          );
          return;
        }

        return `domain=${targetRow.domainName}, total=${res.counts.total}, errors=${res.counts.errors}, denied=${res.counts.denied}`;
      } finally {
        await closeMcpDrawer(page).catch(() => {});
        await restoreSafeWorkspace(page, cfg, '06-mcp-restore');
      }
    }
  );
}
