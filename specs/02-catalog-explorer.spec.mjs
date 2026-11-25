import { assertCatalogReadBudget } from '../lib/regression-checks.mjs';
// 模块 02：资产目录（/context/catalog）端到端真机只读回归套件
// 覆盖：
// 1. 冷启动慢列表完整收敛（禁止凭标题/导航/按钮/在途请求假绿）与树计数一致性
// 2. [P0 复现] 从已加载专用 OWN codex-e2e 来源用真实鼠标点击左侧「所有资产」，退出 Spinner 出现预期行并点进连接与资产
// 3. 已知固定内置知识库 / PostgreSQL / Bitable 预置规模与详情真实可见行一致性
// 4. 类别页签（知识库/数据库/代码仓/业务应用）与资产类型筛选（文档/数据表）
// 5. 检索有结果 -> 无结果明确空态（与错误态严格区分） -> 点击「所有资产」清空恢复全列表
// 6. 目录树搜索目录、索引状态徽标、来源「处理记录」抽屉（含 Bitable 历史可读）与零 1970 时间戳
// 7. 快速连续热切来源与「所有资产」竞态防护 + 浏览器前进/后退保持状态与 workspaceId
// 8. 存量 TOS「管理同步范围」目录探测红线（CTX-016）与新建连接死入口守卫（CTX-020）

import {
  CATALOG_ALL_UNITS_LABEL,
  CATALOG_SEARCH_RESET_LABEL,
  FORBIDDEN_FIXTURE_PREFIX,
  KNOWN_FIXED_FIXTURES,
  OWN_FIXTURE_PREFIX,
  VALID_INDEX_LABELS,
  assertStepOracleHealthy,
  captureCatalogDomSnapshot,
  dispatchRealMouseClick,
  isValidDisplayTimestamp,
  pickDedicatedSourceFixture,
  verifyTreeAndOverviewCounts,
  waitForAssetDetailSettled,
  waitForCatalogSettled,
  waitForSourceHistorySettled,
} from '../lib/catalog-checks.mjs';
import { assertListEntriesPage } from '../lib/list-entries-contract.mjs';

function pickSyntheticAsset(rows) {
  return (rows || []).find(row => row.name &&
    !FORBIDDEN_FIXTURE_PREFIX.test(row.name) &&
    !FORBIDDEN_FIXTURE_PREFIX.test(row.sourceText) &&
    (OWN_FIXTURE_PREFIX.test(row.name) || OWN_FIXTURE_PREFIX.test(row.sourceText))
  );
}

function checkCatalogWirePages(records) {
  for (const record of records) {
    if (record.action === 'ListContextEntries') assertListEntriesPage(record, { pageSize: 10 });
  }
}

async function setReactInputValue(page, selector, nextValue) {
  const updated = await page.evalJSON(`(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    if (!input) return false;
    const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
    if (!setter) return false;
    input.focus();
    setter.call(input, ${JSON.stringify(nextValue)});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!updated) {
    throw new Error(`未找到输入框 ${selector}`);
  }
}

const directorySearch = 'aside input[placeholder="搜索目录"]';

async function findSourceInDirectory(page, sourceName) {
  await setReactInputValue(page, directorySearch, sourceName);
  const result = await page.waitFor(`(() => {
    const nav = document.querySelector('nav[aria-label="数据目录"]');
    return [...(nav?.querySelectorAll('ul > li > ul > li > button') || [])]
      .some(button => button.innerText.trim() === ${JSON.stringify(sourceName)});
  })()`, { timeoutMs: 5000 });
  await setReactInputValue(page, directorySearch, '');
  return result.ok;
}

function leftTreeAllNodeExpr() {
  return `document.querySelector('nav[aria-label="数据目录"] [data-testid="tree-count-all"]')?.closest("button")`;
}

function leftTreeSourceNodeExpr(sourceName) {
  return `Array.from(document.querySelectorAll('nav[aria-label="数据目录"] ul > li > ul > li > button'))
    .find(button => button.innerText.trim() === ${JSON.stringify(sourceName)})`;
}

async function setKnowledgeQuery(page, value) {
  const focused = await page.evalJSON(() => {
    const host = document.querySelector('section[aria-label="搜索资产或业务知识"] [aria-label="搜索资产或业务知识"]');
    const input = host?.matches('input') ? host : host?.shadowRoot?.querySelector('input');
    if (!input) return false;
    input.focus();
    input.select();
    return true;
  });
  if (!focused) throw new Error('知识检索输入不可用');
  await page.send('Input.insertText', { text: value });
  await dispatchRealMouseClick(
    page,
    `document.querySelector('section[aria-label="搜索资产或业务知识"] [aria-label="搜索"]')`,
    '搜索资产或业务知识'
  );
}

export async function run(t, page, cfg) {
  let coldSnapshot = null;
  let workspaceEmpty = false;

  // -------------------------------------------------------------------------
  // 1. 冷启动：必须等数据目录与慢列表 AssetTable 全部退出 Spinner 且接口清零
  // -------------------------------------------------------------------------
  await t.check('资产目录冷启动退出全部 Spinner，数据目录分组计数一致且慢接口达标', async () => {
    const step = '02-catalog-cold-open';
    const navStart = Date.now();
    await page.gotoContext('/context/catalog', {
      stepName: step,
      readyFn: () => Boolean(document.querySelector('aside input[placeholder="搜索目录"]')),
    });
    const settled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 20000 });
    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);

    if (!settled.ok) {
      throw new Error(
        `资产目录冷启动超时未收敛 (${settled.elapsedMs}ms): ${settled.verdict?.status} — ${settled.verdict?.reason}`
      );
    }
    if (settled.verdict.status === 'ERROR') {
      throw new Error(`资产目录冷启动进入错误态: ${settled.verdict.reason}`);
    }

    const coldLoadMs = Date.now() - navStart;
    const readEvidence = assertCatalogReadBudget(oracle, cfg, coldLoadMs);
    checkCatalogWirePages(oracle.records);
    coldSnapshot = settled.snapshot;
    const countCheck = verifyTreeAndOverviewCounts(coldSnapshot);
    if (!countCheck.ok) {
      throw new Error(countCheck.reason);
    }

    if (cfg.workspaceId === '800e2e0a-bb05-4591-8cd2-f8df54be0ebe' &&
        settled.verdict.status !== 'READY') {
      throw new Error(`CAT-01 已接入的回归工作区应呈现资产列表，实际状态为 ${settled.verdict.status}`);
    }

    if (settled.verdict.status === 'EMPTY') {
      workspaceEmpty = true;
      return `空工作区明确渲染空态 (${settled.verdict.reason}), totalMs=${Date.now() - navStart}ms`;
    }

    return `settled=${Date.now() - navStart}ms, treeTotal=${countCheck.total}, assetRows=${settled.verdict.assetRowCount}, APIs=${oracle.records.length}, ListContextEntries=${readEvidence}`;
  });

  // -------------------------------------------------------------------------
  // 2. 时间戳守卫（CTX-007）
  // -------------------------------------------------------------------------
  await t.check('资产目录列表更新时间格式有效且不出现 1970-01-01 零值时间戳', async () => {
    const oracle = await page.collectStepOracle('02-catalog-cold-open');
    if (oracle.has1970Timestamp) {
      throw new Error('资产目录可见文本中存在 1970-01-01 零值更新时间');
    }
    const rows = coldSnapshot?.assetRows || [];
    for (const row of rows) {
      const check = isValidDisplayTimestamp(row.updatedAt);
      if (!check.valid) {
        throw new Error(`资产「${row.name}」更新时间异常: ${check.reason}`);
      }
    }
    return `已校验 ${rows.length} 条可见资产更新时间，零 1970-01-01`;
  });

  // -------------------------------------------------------------------------
  // 3. [P0 用户复现] 已加载专用 codex-e2e 来源 -> 真实鼠标点击左侧「所有资产」 -> 退出 Spinner 出现预期行并能点进连接与资产
  // -------------------------------------------------------------------------
  await t.check(
    `[P0] 从已加载专用 codex-e2e 来源用真实鼠标点击左侧「${CATALOG_ALL_UNITS_LABEL}」，退出 Spinner 出现预期行并能点进连接与资产`,
    async () => {
      if (workspaceEmpty || !coldSnapshot) {
        t.block(
          `[P0] 从已加载专用 codex-e2e 来源点击左侧「${CATALOG_ALL_UNITS_LABEL}」`,
          '当前工作区为空或冷启动未就绪，缺少已接入的 codex-e2e 专用来源 fixture'
        );
        return;
      }

      const step = '02-p0-source-to-all-units';
      page.setStep(step);

      // 汇总可见来源与目录树节点，优先挑选 OWN codex-e2e-* 专用 fixture
      const candidateItems = [
        ...(coldSnapshot.directoryRows || []),
        ...(coldSnapshot.treeConnectionNames || []).map(name => ({ name })),
      ];
      const picked = pickDedicatedSourceFixture(candidateItems);
      if (picked.tier !== 'own' || !picked.fixture) {
        t.block(
          `[P0] 从已加载专用 codex-e2e 来源点击左侧「${CATALOG_ALL_UNITS_LABEL}」`,
          `当前工作区未找到安全的 OWN codex-e2e-* 专用来源（treeTotal=${coldSnapshot.treeAllCount}）`
        );
        return;
      }

      const fixtureName = String(picked.fixture.name || picked.fixture.Name).trim();

      // Step A: 用真实鼠标在左侧目录树点击该专用 codex-e2e 来源并等待其专用治理面板完整加载
      await dispatchRealMouseClick(
        page,
        leftTreeSourceNodeExpr(fixtureName),
        `左侧目录树专用来源「${fixtureName}」`
      );
      const sourceSettled = await waitForCatalogSettled(
        page,
        { mode: 'source', expectedSourceName: fixtureName },
        { timeoutMs: 18000 }
      );
      if (!sourceSettled.ok) {
        throw new Error(
          `进入专用来源「${fixtureName}」超时未收敛: ${sourceSettled.verdict?.reason}`
        );
      }
      if (sourceSettled.verdict.status === 'ERROR') {
        throw new Error(`专用来源「${fixtureName}」加载报错: ${sourceSettled.verdict.reason}`);
      }
      const loadedSourceId = new URLSearchParams(sourceSettled.snapshot.search).get('source') || '';
      if (!loadedSourceId) {
        throw new Error(`进入专用来源「${fixtureName}」后 URL 未携带 source 参数`);
      }

      // Step B: 用真实鼠标点击左侧目录树顶层「所有资产」（对应用户所述「所有资产」当前真实 UI 名称）
      const allStep = '02-source-to-all-read';
      page.setStep(allStep);
      const allClickStarted = Date.now();
      await dispatchRealMouseClick(
        page,
        leftTreeAllNodeExpr(),
        `左侧目录树「${CATALOG_ALL_UNITS_LABEL}」`
      );
      const allSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
      if (!allSettled.ok) {
        throw new Error(
          `从「${fixtureName}」点击「${CATALOG_ALL_UNITS_LABEL}」后未退出 Spinner 或未就绪: ${allSettled.verdict?.status} — ${allSettled.verdict?.reason}`
        );
      }
      if (allSettled.verdict.status !== 'READY') {
        throw new Error(
          `点击「${CATALOG_ALL_UNITS_LABEL}」后未渲染出预期数据行 (status=${allSettled.verdict.status}, reason=${allSettled.verdict.reason})`
        );
      }

      const clickToAssetsMs = Date.now() - allClickStarted;
      const allOracle = await page.collectStepOracle(allStep);
      assertCatalogReadBudget(allOracle, cfg, clickToAssetsMs);
      checkCatalogWirePages(allOracle.records);
      page.setStep(step);

      // 从数据目录重新打开相同来源，校验来源 ID 和加载结果。
      if (!(allSettled.snapshot.directoryRows || []).some(row => row.name === fixtureName)) {
        throw new Error(`恢复列表后数据目录缺少来源「${fixtureName}」`);
      }
      await dispatchRealMouseClick(
        page,
        leftTreeSourceNodeExpr(fixtureName),
        `数据目录来源按钮「${fixtureName}」`
      );
      const reenterSource = await waitForCatalogSettled(
        page,
        {
          mode: 'source',
          expectedSourceId: loadedSourceId,
          expectedSourceName: fixtureName,
        },
        { timeoutMs: 15000 }
      );
      if (!reenterSource.ok || reenterSource.verdict.status === 'ERROR') {
        throw new Error(
          `从「${CATALOG_ALL_UNITS_LABEL}」点进连接「${fixtureName}」失败: ${reenterSource.verdict?.reason}`
        );
      }

      // Step D: 再次用真实鼠标回到「所有资产」，并点进一条安全资产行验证完整详情跳转
      await dispatchRealMouseClick(
        page,
        leftTreeAllNodeExpr(),
        `返回「${CATALOG_ALL_UNITS_LABEL}」`
      );
      const backAll = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
      if (!backAll.ok || backAll.verdict.status !== 'READY') {
        throw new Error(
          `再次返回「${CATALOG_ALL_UNITS_LABEL}」失败: ${backAll.verdict?.reason}`
        );
      }

      const safeAssetRow = pickSyntheticAsset(backAll.snapshot.assetRows);
      if (!safeAssetRow) {
        t.block('CAT-02 资产列表行到详情', '所有资产已加载，但当前分页未显示归属明确的合成资产');
        return;
      }

      await dispatchRealMouseClick(
        page,
        `(() => {
          const tables = Array.from(document.querySelectorAll('main .arco-table'));
          const assetTbl = tables.find(tbl => {
            const hs = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.innerText || '').trim());
            return hs.includes('可用状态') && hs.includes('更新时间');
          });
          if (!assetTbl) return null;
          const row = Array.from(assetTbl.querySelectorAll('tbody tr')).find(tr =>
            (tr.innerText || '').includes(${JSON.stringify(safeAssetRow.name)})
          );
          return (
            Array.from(row?.querySelectorAll('a, button, span') || []).find(
              el => (el.textContent || '').trim() === ${JSON.stringify(safeAssetRow.name)}
            ) || null
          );
        })()`,
        `资产行「${safeAssetRow.name}」`
      );

      const detailSettled = await waitForAssetDetailSettled(page, { timeoutMs: 18000 });
      if (
        !detailSettled.ok ||
        detailSettled.verdict.status === 'ERROR' ||
        detailSettled.verdict.status === 'NOT_FOUND'
      ) {
        throw new Error(
          `从资产目录进入资产详情失败: ${detailSettled.verdict?.status} — ${detailSettled.verdict?.reason}`
        );
      }

      const oracle = await page.collectStepOracle(step);
      assertStepOracleHealthy(oracle);

      // 点击详情页左上角返回按钮回到 /context/catalog
      await dispatchRealMouseClick(
        page,
        `document.querySelector('.ak-detail-back')`,
        '资产详情返回按钮'
      );
      const returnedCatalog = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
      if (!returnedCatalog.ok || returnedCatalog.verdict.status !== 'READY') {
        throw new Error(`从资产详情返回资产目录未就绪: ${returnedCatalog.verdict?.reason}`);
      }

      assertStepOracleHealthy(await page.collectStepOracle(step));
      return `点击到列表可用 ${clickToAssetsMs}ms, source=${fixtureName}(${loadedSourceId}) -> ${CATALOG_ALL_UNITS_LABEL}(assets=${allSettled.verdict.assetRowCount}) -> asset=${safeAssetRow.name}(${detailSettled.verdict.status})`;
    }
  );

  // -------------------------------------------------------------------------
  // 4. 已知固定内置知识库 / PG / Bitable 预置规模与详情真实可见行检查
  // -------------------------------------------------------------------------
  await t.check('已知固定的内置知识库、PostgreSQL 与 Bitable 在数据目录与来源详情显示真实可见行', async () => {
    if (cfg.workspaceId !== '800e2e0a-bb05-4591-8cd2-f8df54be0ebe' || workspaceEmpty) {
      t.block(
        '已知固定的内置知识库、PostgreSQL 与 Bitable 目录与详情核对',
        `当前工作区 (${cfg.workspaceId}) 非标准测试工作区或为空，跳过固定实体计数断言`
      );
      return;
    }

    const step = '02-fixed-fixtures-counts-and-rows';
    page.setStep(step);

    const missingFixtures = [];
    const verifiedParts = [];

    for (const spec of KNOWN_FIXED_FIXTURES) {
      if (!(await findSourceInDirectory(page, spec.name))) {
        missingFixtures.push(spec.name);
        continue;
      }
      await dispatchRealMouseClick(page, leftTreeSourceNodeExpr(spec.name), `固定来源「${spec.name}」`);

      const unitSettled = await waitForCatalogSettled(
        page,
        { mode: 'source', expectedSourceName: spec.name },
        { timeoutMs: 18000 }
      );
      if (!unitSettled.ok || unitSettled.verdict.status !== 'READY') {
        throw new Error(
          `固定来源「${spec.name}」详情面板未渲染预期行: ${unitSettled.verdict?.status} — ${unitSettled.verdict?.reason}`
        );
      }
      if (unitSettled.verdict.unitRowCount !== spec.expectedRowCount) {
        throw new Error(
          `固定来源「${spec.name}」预期「${spec.expectedScale}」，但来源详情实际可见 ${unitSettled.verdict.unitRowCount} 行（预期 ${spec.expectedRowCount} 行）`
        );
      }

      if (spec.expectedObjects) {
        const visibleNames = unitSettled.snapshot.unitRows.map(r => r.name);
        for (const objName of spec.expectedObjects) {
          if (!visibleNames.some(v => v.includes(objName))) {
            throw new Error(
              `固定 PG 来源「${spec.name}」缺少预期表「${objName}」（实际可见: ${visibleNames.join(', ')}）`
            );
          }
        }
      }

      verifiedParts.push(`${spec.name}=${spec.expectedScale}(实测 ${unitSettled.verdict.unitRowCount} 行)`);

      // 用真实鼠标切回「所有资产」继续下一项
      await dispatchRealMouseClick(
        page,
        leftTreeAllNodeExpr(),
        `切回「${CATALOG_ALL_UNITS_LABEL}」`
      );
      const backSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
      if (!backSettled.ok) {
        throw new Error(`从「${spec.name}」返回「${CATALOG_ALL_UNITS_LABEL}」超时`);
      }
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);

    if (verifiedParts.length === 0) {
      t.block(
        '已知固定的内置知识库、PostgreSQL 与 Bitable 目录与详情核对',
        `工作区缺少预设固定来源: ${missingFixtures.join(', ')}`
      );
      return;
    }
    if (missingFixtures.length > 0) {
      t.block(
        `补充缺失固定来源 (${missingFixtures.join(', ')})`,
        `已核验 ${verifiedParts.join('；')}；其余连接尚未在当前工作区创建`
      );
      return;
    }

    return verifiedParts.join('；');
  });

  // -------------------------------------------------------------------------
  // 5. 不同类型页签：单元类别页签 + 资产类型筛选（文档 / 数据表）
  // -------------------------------------------------------------------------
  await t.check('不同类型页签（知识库/数据库/代码仓/业务应用）与资产类型筛选切换准确无串类', async () => {
    if (workspaceEmpty) {
      t.block('不同类型页签与资产类型筛选', '当前工作区为空，无连接或资产可供按类型验证');
      return;
    }

    const step = '02-category-and-type-tabs';
    page.setStep(step);

    const base = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 15000 });
    if (!base.ok) throw new Error(`进入全部单元视图未就绪: ${base.verdict?.reason}`);
    const groupCounts = base.snapshot.treeGroupCounts;

    for (const [groupKey, tabLabel] of [
      ['knowledge', '知识库'],
      ['database', '数据库'],
      ['coderepo', '代码仓'],
      ['app_mcp', '业务应用'],
    ]) {
      const groupButton = `document.querySelector('[data-testid="tree-count-${groupKey}"]')?.closest('button')`;
      const expectedTotal = groupCounts[groupKey];
      if (!Number.isInteger(expectedTotal)) throw new Error(`类别「${tabLabel}」缺少目录计数`);
      if (expectedTotal > 0) {
        const expanded = await page.evalJSON(`${groupButton}?.getAttribute('aria-expanded') === 'true'`);
        if (expanded) await dispatchRealMouseClick(page, groupButton, `折叠「${tabLabel}」`);
        await dispatchRealMouseClick(page, groupButton, `展开「${tabLabel}」`);
      }
      const snapshot = await captureCatalogDomSnapshot(page);
      const rows = snapshot.directoryRows.filter(row => row.category === groupKey);
      if (rows.length !== expectedTotal) {
        throw new Error(`类别「${tabLabel}」目录显示 ${expectedTotal}，实际来源 ${rows.length}`);
      }
    }

    for (const [typeValue, uiOptionLabel] of [
      ['FileCollection', '文档'],
      ['Table', '数据表'],
      ['AppSchema', '应用字典'],
      ['CodeRepo', '代码仓'],
    ]) {
      const filterStep = `${step}-${typeValue}`;
      page.setStep(filterStep);
      await dispatchRealMouseClick(
        page,
        `(() => {
          const selects = Array.from(document.querySelectorAll('main .arco-select'));
          return selects.find(s => s.querySelector('input[placeholder="全部类型"]') ||
            /^(全部类型|文档|数据表|代码仓|应用字典)$/.test((s.innerText || '').trim())) || null;
        })()`,
        '资产类型筛选下拉框'
      );
      await page.waitFor(
        `Array.from(document.querySelectorAll('.arco-select-option')).some(o => (o.innerText || '').trim() === ${JSON.stringify(uiOptionLabel)})`,
        { timeoutMs: 5000, intervalMs: 100 }
      );
      await dispatchRealMouseClick(
        page,
        `Array.from(document.querySelectorAll('.arco-select-option')).find(o => (o.innerText || '').trim() === ${JSON.stringify(uiOptionLabel)}) || null`,
        `资产类型下拉项「${uiOptionLabel}」`
      );

      const filtered = await waitForCatalogSettled(
        page,
        { mode: 'all', expectedAssetType: typeValue },
        { timeoutMs: 18000 }
      );
      if (!filtered.ok || filtered.verdict.status === 'ERROR') {
        throw new Error(`筛选资产类型「${uiOptionLabel}」失败: ${filtered.verdict?.reason}`);
      }
      const wrongTypeRow = (filtered.snapshot.assetRows || []).find(
        r => r.typeLabel !== uiOptionLabel
      );
      if (wrongTypeRow) {
        throw new Error(
          `筛选「${uiOptionLabel}」时出现异类资产「${wrongTypeRow.name}」(类型=${wrongTypeRow.typeLabel})`
        );
      }
      const filterOracle = await page.collectStepOracle(filterStep);
      assertStepOracleHealthy(filterOracle);
      const reads = filterOracle.records.filter(record => record.action === 'ListContextEntries');
      checkCatalogWirePages(reads);
      if (['CodeRepo', 'AppSchema'].includes(typeValue)) {
        if (reads.length !== 1) {
          throw new Error(`筛选「${uiOptionLabel}」首批应只读取一页，实际 ${reads.length} 次`);
        }
        if (!Number.isFinite(reads[0].durationMs) || reads[0].durationMs > cfg.slo.standardApiMaxMs) {
          throw new Error(`筛选「${uiOptionLabel}」读取 ${reads[0].durationMs}ms 超红线`);
        }
      }
    }

    page.setStep(step);
    // 点击「清空全部」恢复无筛选列表
    await dispatchRealMouseClick(
      page,
      `Array.from(document.querySelectorAll('main button')).find(b => (b.innerText || '').trim() === '清空全部') || null`,
      '筛选栏「清空全部」按钮'
    );
    const restored = await waitForCatalogSettled(
      page,
      { mode: 'all', expectedAssetType: '' },
      { timeoutMs: 18000 }
    );
    if (!restored.ok || restored.verdict.status !== 'READY') {
      throw new Error(`清空类型筛选后未恢复全量列表: ${restored.verdict?.reason}`);
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `四类来源目录与文档／数据表／应用字典／代码仓筛选核验通过，恢复后资产行=${restored.verdict.assetRowCount}`;
  });

  // -------------------------------------------------------------------------
  // 6. 搜索有结果 -> 搜索无结果明确空态 -> 清空恢复全列表
  // -------------------------------------------------------------------------
  await t.check('知识检索有结果与无结果严格区分空态/错误态，点击「所有资产」清空后恢复全列表', async () => {
    if (workspaceEmpty) {
      t.block('知识检索有结果/无结果/清空闭环', '当前工作区为空，无已入库资产可供检索命中对照');
      return;
    }

    const step = '02-search-hit-miss-reset';
    page.setStep(step);

    const baseline = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 15000 });
    if (!baseline.ok || baseline.verdict.status !== 'READY') {
      throw new Error(`搜索前基线列表未就绪: ${baseline.verdict?.reason}`);
    }
    const baselineRowCount = baseline.snapshot.assetRows.length;
    const sampleAsset = pickSyntheticAsset(baseline.snapshot.assetRows);
    if (!sampleAsset) {
      t.block('CAT-03 检索与清空', '当前分页没有可确认的合成资产用于检索对照');
      return;
    }
    const hitKeyword = sampleAsset.name.slice(0, Math.min(24, sampleAsset.name.length));
    await setKnowledgeQuery(page, hitKeyword);

    const hitSettled = await waitForCatalogSettled(
      page,
      { mode: 'search', expectedQuery: hitKeyword },
      { timeoutMs: 18000 }
    );
    if (!hitSettled.ok) {
      throw new Error(`检索有结果词「${hitKeyword}」超时: ${hitSettled.verdict?.reason}`);
    }
    const foundSample = hitSettled.snapshot.assetRows.some(row => row.name === sampleAsset.name);
    if (hitSettled.verdict.status !== 'READY' || !foundSample) {
      throw new Error(
        `检索已知资产词「${hitKeyword}」应命中对照资产，实际 status=${hitSettled.verdict.status} (${hitSettled.verdict.reason})`
      );
    }

    // 2) 搜索确定不存在的关键词 -> 必须进入明确 EMPTY，绝不能报 ERROR 或空白假绿
    const missKeyword = '__codex_e2e_nonexistent_token_998877__';
    await setKnowledgeQuery(page, missKeyword);

    const missSettled = await waitForCatalogSettled(
      page,
      { mode: 'search', expectedQuery: missKeyword },
      { timeoutMs: 18000 }
    );
    if (!missSettled.ok) {
      throw new Error(`检索无结果词超时: ${missSettled.verdict?.reason}`);
    }
    if (missSettled.verdict.status !== 'EMPTY') {
      throw new Error(
        `无结果检索应进入明确 EMPTY 态，实际为 ${missSettled.verdict.status}: ${missSettled.verdict.reason}`
      );
    }
    if (!missSettled.verdict.reason.includes('请调整搜索或筛选条件')) {
      throw new Error(`无结果空态文案不符预期: ${missSettled.verdict.reason}`);
    }

    // 3) 用真实鼠标点击 SearchPanel 的「所有资产」重置按钮回到全列表
    await dispatchRealMouseClick(
      page,
      `Array.from(document.querySelectorAll('section[aria-label="搜索资产或业务知识"] button')).find(b => (b.innerText || '').trim() === ${JSON.stringify(CATALOG_SEARCH_RESET_LABEL)}) || null`,
      `检索区「${CATALOG_SEARCH_RESET_LABEL}」重置按钮`
    );

    const resetSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!resetSettled.ok || resetSettled.verdict.status !== 'READY') {
      throw new Error(`清空检索后未恢复全列表: ${resetSettled.verdict?.reason}`);
    }
    if (resetSettled.snapshot.assetRows.length !== baselineRowCount) {
      throw new Error(
        `清空检索后资产行数 (${resetSettled.snapshot.assetRows.length}) 与基线 (${baselineRowCount}) 不一致`
      );
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `hit("${hitKeyword}")=${hitSettled.verdict.assetRowCount}行 -> miss=EMPTY("${missSettled.verdict.reason}") -> reset=${resetSettled.snapshot.assetRows.length}行`;
  });

  // -------------------------------------------------------------------------
  // 7. 目录树搜索目录 + 来源索引状态与「处理记录」抽屉（含 Bitable 历史可读校验）
  // -------------------------------------------------------------------------
  await t.check('目录树来源过滤、来源索引状态展示与「处理记录」抽屉可读且无 1970 时间戳', async () => {
    if (workspaceEmpty) {
      t.block('目录树过滤与来源处理记录核验', '当前工作区为空，无已接入来源');
      return;
    }

    const step = '02-tree-filter-and-source-history';
    page.setStep(step);
    const treeInputSelector = 'aside input[placeholder="搜索目录"]';

    // 1) 目录树无匹配来源空态
    await setReactInputValue(page, treeInputSelector, '__codex_e2e_no_source_match__');
    const emptyTree = await page.waitFor(
      `(() => {
        const aside = Array.from(document.querySelectorAll('aside')).find(el =>
          el.querySelector('input[placeholder="搜索目录"]')
        );
        const txt = (aside?.querySelector('.arco-empty-description')?.innerText || '').trim();
        return txt === '没有匹配的目录' ? txt : false;
      })()`,
      { timeoutMs: 6000, intervalMs: 120 }
    );
    if (!emptyTree.ok) {
      await setReactInputValue(page, treeInputSelector, '');
      throw new Error('目录树搜索不存在来源时未展示「没有匹配的目录」空态');
    }

    // 2) 清空目录树搜索词恢复完整树
    await setReactInputValue(page, treeInputSelector, '');
    await page.waitFor(
      `(() => {
        const u = new URL(window.location.href);
        return !u.searchParams.has('dirq');
      })()`,
      { timeoutMs: 5000, intervalMs: 120 }
    );

    const currentSnap = await captureCatalogDomSnapshot(page);
    const preferredHistoryNames = [
      'codex-e2e-bitable-1125',
      'codex-e2e-r4-kb-1125',
      'codex-e2e-local-kb-1125',
      'codex-e2e-pg-1125',
    ];
    const targetName =
      preferredHistoryNames.find(name => currentSnap.treeConnectionNames.includes(name)) ||
      pickDedicatedSourceFixture(currentSnap.treeConnectionNames.map(name => ({ name }))).fixture
        ?.name;

    if (!targetName) {
      t.block('来源处理记录抽屉核验', '当前工作区无安全可用的 codex-e2e 来源');
      return;
    }

    await dispatchRealMouseClick(
      page,
      leftTreeSourceNodeExpr(targetName),
      `目录树来源「${targetName}」`
    );
    const sourceReady = await waitForCatalogSettled(
      page,
      { mode: 'source', expectedSourceName: targetName },
      { timeoutMs: 18000 }
    );
    if (!sourceReady.ok || sourceReady.verdict.status === 'ERROR') {
      throw new Error(`切换到来源「${targetName}」失败: ${sourceReady.verdict?.reason}`);
    }

    // 若为知识库连接且有文档行，校验列表内索引徽标合法性
    for (const row of sourceReady.snapshot.unitRows) {
      if (row.indexText) {
        const hasValidBadge = Array.from(VALID_INDEX_LABELS).some(lbl =>
          row.indexText.includes(lbl)
        );
        if (!hasValidBadge) {
          throw new Error(`来源「${targetName}」资产「${row.name}」索引状态文本异常: ${row.indexText}`);
        }
      }
    }

    // 打开右上角「更多」->「处理记录」（只读抽屉，严禁点击立即刷新/重新导入）
    await dispatchRealMouseClick(
      page,
      `Array.from(document.querySelectorAll('main header button')).find(b => (b.innerText || '').trim() === '更多') || null`,
      '来源页头「更多」下拉按钮'
    );
    await page.waitFor(
      `Array.from(document.querySelectorAll('.arco-dropdown-menu-item, [role="menuitem"]')).some(el => (el.innerText || '').trim() === '查看记录')`,
      { timeoutMs: 5000, intervalMs: 100 }
    );
    await dispatchRealMouseClick(
      page,
      `Array.from(document.querySelectorAll('.arco-dropdown-menu-item, [role="menuitem"]')).find(el => (el.innerText || '').trim() === '查看记录') || null`,
      '下拉菜单「查看记录」'
    );

    const historySettled = await waitForSourceHistorySettled(page, { timeoutMs: 15000 });
    if (!historySettled.ok) {
      throw new Error(`来源「${targetName}」处理记录抽屉加载超时: ${historySettled.verdict?.reason}`);
    }
    if (historySettled.verdict.status === 'ERROR') {
      throw new Error(`来源「${targetName}」处理记录报错: ${historySettled.verdict.reason}`);
    }

    // 关闭处理记录抽屉并回到「所有资产」
    await dispatchRealMouseClick(
      page,
      `(() => {
        const d = Array.from(document.querySelectorAll('.arco-drawer')).find(el =>
          (el.innerText || '').includes('处理记录')
        );
        return Array.from(d?.querySelectorAll('button') || []).find(b => (b.innerText || '').trim() === '关闭') || null;
      })()`,
      '处理记录抽屉「关闭」按钮'
    );
    await page.waitFor(
      `!Array.from(document.querySelectorAll('.arco-drawer')).some(el => el.getBoundingClientRect().width > 0 && (el.innerText || '').includes('处理记录'))`,
      { timeoutMs: 5000, intervalMs: 120 }
    );

    await dispatchRealMouseClick(page, leftTreeAllNodeExpr(), `切回「${CATALOG_ALL_UNITS_LABEL}」`);
    await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `target=${targetName}, historyStatus=${historySettled.verdict.status} (${historySettled.verdict.reason})`;
  });

  // -------------------------------------------------------------------------
  // 8. 热切竞态与浏览器前进/后退
  // -------------------------------------------------------------------------
  await t.check('快速连续热切来源与「所有资产」无陈旧响应覆盖，浏览器后退/前进保持状态与 workspaceId', async () => {
    if (workspaceEmpty) {
      t.block('热切竞态与浏览器前进后退', '当前工作区为空，无来源与资产可供切换');
      return;
    }

    const step = '02-hot-switch-and-history-nav';
    page.setStep(step);

    const snap = await captureCatalogDomSnapshot(page);
    const raceTargets = snap.treeConnectionNames.filter(name => OWN_FIXTURE_PREFIX.test(name)).slice(0, 2);
    if (raceTargets.length < 2) {
      t.block('CAT-05 连续切换与历史记录', '需要两个合成来源作为竞态对照');
      return;
    }

    // 1) 热切竞态：不等待中间请求完成，连续真实鼠标点击来源 -> 所有资产
    for (const srcName of raceTargets) {
      await dispatchRealMouseClick(page, leftTreeSourceNodeExpr(srcName), `热切来源「${srcName}」`);
      await page.sleep(40);
    }
    await dispatchRealMouseClick(
      page,
      leftTreeAllNodeExpr(),
      `热切终点「${CATALOG_ALL_UNITS_LABEL}」`
    );

    const afterRace = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!afterRace.ok || afterRace.verdict.status !== 'READY') {
      throw new Error(`连续热切后未收敛回「${CATALOG_ALL_UNITS_LABEL}」: ${afterRace.verdict?.reason}`);
    }

    // 2) 浏览器前进 / 后退：从目录进入资产详情（history.push） -> back -> forward -> back
    const targetAsset = pickSyntheticAsset(afterRace.snapshot.assetRows);
    if (!targetAsset) {
      t.block('NAV-04 资产详情前进和后退', '当前分页没有可确认的合成资产用于详情回读');
      return;
    }

    await dispatchRealMouseClick(
      page,
      `(() => {
        const tables = Array.from(document.querySelectorAll('main .arco-table'));
        const assetTbl = tables.find(tbl => {
          const hs = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.innerText || '').trim());
          return hs.includes('可用状态') && hs.includes('更新时间');
        });
        const row = Array.from(assetTbl?.querySelectorAll('tbody tr') || []).find(tr =>
          (tr.innerText || '').includes(${JSON.stringify(targetAsset.name)})
        );
        return Array.from(row?.querySelectorAll('span, a, button') || []).find(
          el => (el.textContent || '').trim() === ${JSON.stringify(targetAsset.name)}
        ) || null;
      })()`,
      `资产行「${targetAsset.name}」`
    );

    const detailFirst = await waitForAssetDetailSettled(page, { timeoutMs: 18000 });
    if (!detailFirst.ok || detailFirst.verdict.status === 'ERROR') {
      throw new Error(`进入资产详情失败: ${detailFirst.verdict?.reason}`);
    }

    // 浏览器后退 -> 回到 /context/catalog
    await page.evalJSON(() => window.history.back());
    const backCatalog = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!backCatalog.ok || backCatalog.verdict.status !== 'READY') {
      throw new Error(`浏览器后退回资产目录未就绪: ${backCatalog.verdict?.reason}`);
    }

    // 浏览器前进 -> 回到 /context/catalog/:Id/detail
    await page.evalJSON(() => window.history.forward());
    const forwardDetail = await waitForAssetDetailSettled(page, { timeoutMs: 18000 });
    if (!forwardDetail.ok || forwardDetail.verdict.status === 'ERROR') {
      throw new Error(`浏览器前进回资产详情未就绪: ${forwardDetail.verdict?.reason}`);
    }

    // 浏览器再后退 -> 保持停留在 /context/catalog 供后续用例执行
    await page.evalJSON(() => window.history.back());
    const finalCatalog = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!finalCatalog.ok) {
      throw new Error(`二次后退回资产目录未就绪: ${finalCatalog.verdict?.reason}`);
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `raceTargets=${raceTargets.length}, back/forward detail="${detailFirst.snapshot.headerTitle}" 均保持 workspaceId 且零竞态残留`;
  });

  // -------------------------------------------------------------------------
  // 9. 存量 TOS 连接「管理同步范围」ExploreContextSource 耗时红线（CTX-016）
  // -------------------------------------------------------------------------
  await t.checkKnownBug(
    'CTX-016',
    '存量 TOS 连接打开「管理同步范围」目录探测 ExploreContextSource 耗时不超过 4000ms 红线',
    async () => {
      const step = '02-tos-explore-slo';
      page.setStep(step);

      const snap = await captureCatalogDomSnapshot(page);
      const tosName = ['codex-e2e-r4-tos-selected', 'codex-e2e-tos-1125'].find(n =>
        snap.treeConnectionNames.includes(n)
      );

      if (tosName) {
        await dispatchRealMouseClick(page, leftTreeSourceNodeExpr(tosName), `TOS 来源「${tosName}」`);
      } else if (cfg.baselineTosConnId) {
        await page.gotoContext(`/context/catalog?source=${encodeURIComponent(cfg.baselineTosConnId)}`, {
          stepName: step,
        });
      } else {
        t.block('存量 TOS 目录探测耗时核验', '工作区未配置可用 TOS 连接');
        return;
      }

      const tosSettled = await waitForCatalogSettled(page, { mode: 'source' }, { timeoutMs: 18000 });
      if (!tosSettled.ok || tosSettled.verdict.status === 'ERROR') {
        t.block(
          '存量 TOS 目录探测耗时核验',
          `目标工作区未找到可访问的存量 TOS 连接 (${tosSettled.verdict?.reason || '未就绪'})`
        );
        await page.gotoContext('/context/catalog', { stepName: `${step}-restore` });
        await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
        return;
      }

      const hasScopeBtn = await page.evalJSON(
        `Array.from(document.querySelectorAll('main button')).some(b => (b.innerText || '').includes('管理同步范围'))`
      );
      if (!hasScopeBtn) {
        t.block('存量 TOS 目录探测耗时核验', '当前账号无 canConnect 权限展示「管理同步范围」按钮');
        return;
      }

      await dispatchRealMouseClick(
        page,
        `Array.from(document.querySelectorAll('main button')).find(b => (b.innerText || '').includes('管理同步范围')) || null`,
        '「管理同步范围 / 添加文档」按钮'
      );

      const explorerSettled = await page.waitFor(
        `(() => {
          const el = document.querySelector('[data-testid="source-node-explorer-tos"]');
          if (!el) return false;
          const txt = el.innerText || '';
          if (txt.includes('正在同步加载目录列表')) return false;
          if (/已连通|连接探测失败|封闭私网环境|暂无可接入对象/.test(txt)) return txt.slice(0, 200);
          return false;
        })()`,
        { timeoutMs: 15000, intervalMs: 180, label: 'tos-source-explorer' }
      );

      // 只读关闭抽屉（点击取消，严禁保存目录范围或添加文档）
      await dispatchRealMouseClick(
        page,
        `Array.from(document.querySelectorAll('.arco-drawer button')).find(b => (b.innerText || '').trim() === '取消') || null`,
        '同步范围抽屉「取消」按钮'
      );
      await dispatchRealMouseClick(page, leftTreeAllNodeExpr(), `切回「${CATALOG_ALL_UNITS_LABEL}」`);
      await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });

      const oracle = await page.collectStepOracle(step);
      assertStepOracleHealthy(oracle, { allowSlowActions: ['ExploreContextSource'] });

      if (!explorerSettled.ok) {
        throw new Error('TOS 目录探测 ExploreContextSource 超时未退出加载态');
      }
      const slowExplore = oracle.slowApis.find(r => r.action === 'ExploreContextSource');
      if (slowExplore) {
        throw new Error(
          `TOS 目录探测 ExploreContextSource 耗时超红线: ${slowExplore.durationMs}ms (> ${slowExplore.sloLimitMs}ms, RequestId=${slowExplore.requestId || '—'})`
        );
      }
      const exploreRec = oracle.records.find(r => r.action === 'ExploreContextSource');
      if (!exploreRec || exploreRec.httpStatus !== 200 || exploreRec.errorCode ||
          /连接探测失败|封闭私网环境/.test(explorerSettled.value)) {
        throw new Error(`TOS 目录未能成功读取，HTTP=${exploreRec?.httpStatus ?? '—'}，业务码=${exploreRec?.errorCode || '—'}，RequestId=${exploreRec?.requestId || '—'}`);
      }
      return `ExploreContextSource 耗时=${exploreRec.durationMs ?? '—'}ms (RequestId=${exploreRec.requestId || '—'})`;
    }
  );

  // -------------------------------------------------------------------------
  // 10. 新建连接向导死入口守卫（CTX-020，全程只读不提交，关闭弹窗）
  // -------------------------------------------------------------------------
  await t.checkKnownBug(
    'CTX-020',
    '添加资产向导不暴露数据面已下线在线能力的 Meego / 风神死入口',
    async () => {
      const step = '02-connect-modal-dead-sources';
      page.setStep(step);

      const hasAddBtn = await page.evalJSON(
        `Array.from(document.querySelectorAll('main header button')).some(b => /添加资产/.test((b.innerText || '').trim()))`
      );
      if (!hasAddBtn) {
        t.block('添加资产向导死入口核验', '当前身份无 canConnect 权限，未渲染「添加资产」按钮');
        return;
      }

      await dispatchRealMouseClick(
        page,
        `Array.from(document.querySelectorAll('main header button')).find(b => /添加资产/.test((b.innerText || '').trim())) || null`,
        '页头「添加资产」按钮'
      );

      await dispatchRealMouseClick(
        page,
        `Array.from(document.querySelectorAll('[role="menuitem"], .arco-dropdown-menu-item'))
          .find(item => item.innerText.trim() === '接入在线来源')`,
        '接入在线来源'
      );
      const modalReady = await page.waitFor(() => {
        const dialog = document.querySelector('.arco-modal');
        const text = dialog?.innerText || '';
        return dialog?.getClientRects().length && !dialog.querySelector('.arco-spin-loading') && text.trim()
          ? text
          : false;
      }, { timeoutMs: 8000, intervalMs: 120 });
      if (!modalReady.ok) throw new Error('在线来源选择区未到完整表单终态');
      const combinedModalText = modalReady.value;

      // 严格关闭模态框，绝不点击确认接入
      await dispatchRealMouseClick(
        page,
        `document.querySelector('.arco-modal .arco-modal-close-icon')`,
        '关闭在线来源向导'
      );
      const closed = await page.waitFor(
        `!document.querySelector('.arco-modal') || document.querySelector('.arco-modal').getBoundingClientRect().width === 0`,
        { timeoutMs: 5000, intervalMs: 100 }
      );
      if (!closed.ok) throw new Error('关闭后在线来源向导仍在显示');

      const oracle = await page.collectStepOracle(step);
      assertStepOracleHealthy(oracle);

      if (/(?:^|\s)业务应用(?:\s|$)|Meego|风神|Aeolus/i.test(combinedModalText)) {
        throw new Error('新建连接向导仍暴露 Meego / 风神入口卡片');
      }
      for (const [label, pattern] of [
        ['数据库', /数据库/],
        ['引用已有知识库', /引用已有知识库/],
        ['外部 OpenViking', /OpenViking/],
        ['飞书', /飞书/],
        ['火山 TOS', /(?:火山\s*)?TOS/],
        ['代码仓', /代码仓/],
      ]) {
        if (!pattern.test(combinedModalText)) {
          throw new Error(`接入在线来源第 1 步缺少可用数据源入口：${label}`);
        }
      }
      return '接入在线来源已完整展示 6 类可用来源且无 Meego / 风神死入口残留';
    }
  );
}
