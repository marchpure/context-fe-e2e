import { dispatchRealMouseClick } from '../lib/catalog-checks.mjs';
import { assertListEntriesContinuation, assertListEntriesPage } from '../lib/list-entries-contract.mjs';
import { assertCatalogReadBudget, assertScopedRoute } from '../lib/regression-checks.mjs';

function paginationState() {
  const main = document.querySelector('input[placeholder="按资产名称搜索"]')?.closest('main');
  if (!main || main.querySelector('.arco-spin-loading, .arco-skeleton, .arco-alert-error')) return null;
  const nav = main.querySelector('nav[aria-label="资产列表分页"]');
  const rows = [...main.querySelectorAll('tbody tr[data-row-key]')]
    .filter(row => row.getClientRects().length && row.querySelector('td'))
    .map(row => ({
      id: row.getAttribute('data-row-key'),
      table: [...row.cells].some(cell => cell.innerText.trim() === '数据表'),
    }));
  const current = nav?.querySelector('[aria-live="polite"]')?.textContent?.trim() || '第 1 页';
  const prev = [...(nav?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === '上一页');
  const next = [...(nav?.querySelectorAll('button') || [])].find(button => button.textContent.trim() === '下一页');
  return {
    rows,
    current,
    prevEnabled: Boolean(prev && !prev.disabled && prev.getAttribute('aria-disabled') !== 'true' && prev.getClientRects().length),
    nextEnabled: Boolean(next && !next.disabled && next.getAttribute('aria-disabled') !== 'true' && next.getClientRects().length),
  };
}

async function observePage(page, cfg, step, started, pageNumber, budgetOptions) {
  const result = await page.waitFor(`(() => {
    const state = (${paginationState.toString()})();
    return state?.current === ${JSON.stringify(`第 ${pageNumber} 页`)} && state.rows.length ? state : false;
  })()`, { timeoutMs: Math.max(1, 5000 - (Date.now() - started)) });
  const elapsed = Date.now() - started;
  const oracle = await page.collectStepOracle(step);
  const evidence = assertCatalogReadBudget(oracle, cfg, elapsed, budgetOptions);
  if (!result.ok) throw new Error(`第 ${pageNumber} 页未到可操作终态`);
  const records = oracle.records.filter(record => record.action === 'ListContextEntries');
  for (const record of records) assertListEntriesPage(record, { pageSize: 10, entryType: 'DATA_ASSET' });
  if (result.value.rows.some(row => !row.id || !row.table)) {
    throw new Error(`第 ${pageNumber} 页混入其他资产类型或无法核对资产 ID`);
  }
  const rows = result.value.rows.map(row => row.id);
  if (rows.length > 10 || rows.length !== new Set(rows).size) {
    throw new Error(`第 ${pageNumber} 页资产超过展示上限或重复`);
  }
  return { ...result.value, rows, oracle, records, evidence };
}

export async function run(t, page, cfg) {
  await t.check('CAT-04/12 数据表筛选、下一页与上一页往返保持 EntryType、游标、不重叠行集及范围', async () => {
    const firstStep = '12-tables-first';
    const nextStep = '12-tables-next';
    const prevStep = '12-tables-prev';
    const started = Date.now();
    const nav = await page.gotoContext('/context/catalog?assetType=Table', { stepName: firstStep, timeoutMs: 5000 });
    if (!nav.settledOk) throw new Error('按数据表筛选的知识管理地址未就绪');
    const first = await observePage(page, cfg, firstStep, started, 1);
    assertScopedRoute(first.oracle.href, cfg, '/context/catalog', { assetType: 'Table' });
    if (first.prevEnabled) {
      throw new Error('第 1 页「上一页」按钮不应处于可点击状态');
    }
    if (first.records[0].listEntriesRequest.nextTokens.some(Boolean)) {
      throw new Error('新筛选的首个请求沿用了其他页的 NextToken');
    }
    const lastFirst = first.records.at(-1);
    if (!first.nextEnabled) {
      if (lastFirst.listEntriesResponse.nextToken) throw new Error('仍有后续游标但下一页不可点击');
      return t.block('CAT-12 目录翻页', '当前合成数据表筛选结果不足两页');
    }

    const nextStarted = Date.now();
    page.setStep(nextStep);
    await dispatchRealMouseClick(page, `Array.from(document.querySelectorAll(
      'nav[aria-label="资产列表分页"] button:not([disabled])'
    )).find(button => button.textContent.trim() === '下一页')`, '下一页');
    const next = await observePage(page, cfg, nextStep, nextStarted, 2);
    assertScopedRoute(next.oracle.href, cfg, '/context/catalog', { assetType: 'Table', page: '2' });
    assertListEntriesContinuation(lastFirst, next.records[0]);
    if (next.rows.some(id => first.rows.includes(id))) throw new Error('相邻两页出现重复资产');
    if (!next.prevEnabled) {
      throw new Error('进入第 2 页后「上一页」按钮仍处于禁用态，无法回翻');
    }

    const prevStarted = Date.now();
    page.setStep(prevStep);
    await dispatchRealMouseClick(page, `Array.from(document.querySelectorAll(
      'nav[aria-label="资产列表分页"] button:not([disabled])'
    )).find(button => button.textContent.trim() === '上一页')`, '上一页');
    const backToFirst = await observePage(page, cfg, prevStep, prevStarted, 1, {
      cachedPageAllowed: true,
    });
    assertScopedRoute(backToFirst.oracle.href, cfg, '/context/catalog', { assetType: 'Table' });
    if (JSON.stringify(backToFirst.rows) !== JSON.stringify(first.rows)) {
      throw new Error('点击「上一页」返回第 1 页后展示的资产行集与首屏不一致');
    }
    return `第 1 页 ${first.rows.length} 项 → 第 2 页 ${next.rows.length} 项 → 上一页恢复一致，${first.evidence}；${next.evidence}`;
  });
}
