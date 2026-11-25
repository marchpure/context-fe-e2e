import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_ALL_UNITS_LABEL,
  KNOWN_FIXED_FIXTURES,
  assertStepOracleHealthy,
  dispatchRealMouseClick,
  evaluateAssetDetailSettlement,
  evaluateCatalogViewSettlement,
  evaluateFixedFixtureRow,
  evaluateLineageSettlement,
  evaluateSourceHistorySettlement,
  isValidDisplayTimestamp,
  pickDedicatedSourceFixture,
  verifyTreeAndOverviewCounts,
} from '../lib/catalog-checks.mjs';

function makeReadyAllCatalogSnapshot(overrides = {}) {
  return {
    pathname: '/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/catalog',
    search: '?workspaceId=800e2e0a-bb05-4591-8cd2-f8df54be0ebe&project=default',
    treeSpinning: false,
    mainSpinning: false,
    hasSkeleton: false,
    pendingApiCount: 0,
    pendingActions: [],
    treeFailedText: '',
    mainErrorTexts: [],
    sourceMissingWarn: '',
    headerTitle: CATALOG_ALL_UNITS_LABEL,
    selectedTreeTitle: `${CATALOG_ALL_UNITS_LABEL}\n6`,
    unitGovernanceTabsVisible: false,
    treeAllCount: 6,
    treeGroupCounts: { knowledge: 4, coderepo: 0, database: 2, app_mcp: 0 },
    overviewTotalBadge: 6,
    hasOverviewTable: true,
    overviewRows: [
      { name: 'codex-e2e-local-kb-1125', category: '知识库', scaleText: '2 篇文档' },
      { name: 'codex-e2e-pg-1125', category: '数据库', scaleText: '2 张表' },
      { name: 'codex-e2e-bitable-1125', category: '知识库', scaleText: '1 篇文档' },
    ],
    overviewEmptyText: '',
    hasAssetTable: true,
    assetRows: [
      { name: 'doc-codex-e2e-1125-refund', typeLabel: '文档', updatedAt: '2026-11-25 11:20' },
      { name: 'adk_sessions', typeLabel: '数据表', updatedAt: '2026-11-25 12:40' },
    ],
    assetTableEmptyText: '',
    treeEmptyText: '',
    ...overrides,
  };
}

test('慢列表防假绿：标题/按钮/汇总行已出现但 Spinner、骨架屏或在途请求仍在时绝不报 READY', () => {
  const withMainSpinner = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({ mainSpinning: true })
  );
  assert.equal(withMainSpinner.settled, false);
  assert.equal(withMainSpinner.status, 'LOADING');
  assert.match(withMainSpinner.reason, /Spinner/);

  const withTreeSpinner = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({ treeSpinning: true })
  );
  assert.equal(withTreeSpinner.settled, false);
  assert.equal(withTreeSpinner.status, 'LOADING');

  const withSkeleton = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({ hasSkeleton: true })
  );
  assert.equal(withSkeleton.settled, false);
  assert.equal(withSkeleton.status, 'LOADING');
  assert.match(withSkeleton.reason, /骨架屏/);

  const withPendingApi = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      pendingApiCount: 1,
      pendingActions: ['ListContextEntries'],
    })
  );
  assert.equal(withPendingApi.settled, false);
  assert.equal(withPendingApi.status, 'LOADING');
  assert.match(withPendingApi.reason, /ListContextEntries/);
});

test('慢列表防假绿：从专用来源点击「所有资产单元」过渡期（旧 source/页签未卸载或慢表空白）不误判就绪', () => {
  // 1. URL 仍停留旧 source
  const staleUrl = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      search: '?workspaceId=800e2e0a-bb05-4591-8cd2-f8df54be0ebe&project=default&source=res-1',
    }),
    { mode: 'all' }
  );
  assert.equal(staleUrl.settled, false);
  assert.equal(staleUrl.status, 'TRANSITIONING');

  // 2. 旧来源治理页签尚未卸载
  const staleTabs = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({ unitGovernanceTabsVisible: true }),
    { mode: 'all' }
  );
  assert.equal(staleTabs.settled, false);
  assert.equal(staleTabs.status, 'TRANSITIONING');

  // 3. 汇总表先返回，但底部慢列表 AssetTable 既无数据行也无 Empty（首帧未请求完空白期）
  const slowAssetTableBlank = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      assetRows: [],
      assetTableEmptyText: '',
    }),
    { mode: 'all' }
  );
  assert.equal(slowAssetTableBlank.settled, false);
  assert.equal(slowAssetTableBlank.status, 'BLANK_UNSETTLED');

  // 4. 全部就绪后才返回 settled=true, status='READY'
  const ready = evaluateCatalogViewSettlement(makeReadyAllCatalogSnapshot(), { mode: 'all' });
  assert.equal(ready.settled, true);
  assert.equal(ready.status, 'READY');
  assert.equal(ready.overviewRowCount, 3);
  assert.equal(ready.assetRowCount, 2);
});

test('资产目录严格区分 ERROR 与 EMPTY，绝不混为一谈', () => {
  // 主内容区报错 Alert
  const mainError = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      assetRows: [],
      mainErrorTexts: ['资产加载失败，请重试'],
    }),
    { mode: 'all' }
  );
  assert.equal(mainError.settled, true);
  assert.equal(mainError.status, 'ERROR');
  assert.equal(mainError.errorKind, 'MAIN_ALERT_ERROR');

  // 目录树加载失败
  const treeError = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      treeFailedText: '来源加载失败，重试',
    }),
    { mode: 'all' }
  );
  assert.equal(treeError.settled, true);
  assert.equal(treeError.status, 'ERROR');
  assert.equal(treeError.errorKind, 'TREE_LOAD_ERROR');

  // 空工作区（0 来源 + 明确空态文案）
  const emptyWorkspace = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      treeAllCount: 0,
      treeGroupCounts: { knowledge: 0, coderepo: 0, database: 0, app_mcp: 0 },
      overviewTotalBadge: 0,
      hasOverviewTable: false,
      overviewRows: [],
      assetRows: [],
      treeEmptyText: '尚未连接受控资产单元',
      assetTableEmptyText: '暂无资产，添加数据来源或上传文档后在这里查看',
    }),
    { mode: 'all' }
  );
  assert.equal(emptyWorkspace.settled, true);
  assert.equal(emptyWorkspace.status, 'EMPTY');
  assert.equal(emptyWorkspace.emptyKind, 'WORKSPACE_NO_SOURCES');

  // 搜索无结果（明确空态文案）
  const searchEmpty = evaluateCatalogViewSettlement(
    makeReadyAllCatalogSnapshot({
      search: '?workspaceId=ws-1&project=default&q=__nonexistent__',
      headerTitle: '检索结果',
      assetRows: [],
      assetTableEmptyText: '没有匹配的资产，请调整筛选条件',
    }),
    { mode: 'search', expectedQuery: '__nonexistent__' }
  );
  assert.equal(searchEmpty.settled, true);
  assert.equal(searchEmpty.status, 'EMPTY');
  assert.equal(searchEmpty.emptyKind, 'SEARCH_NO_MATCH');
});

test('专用来源挑选：严格优先 OWN codex-e2e-* 并剔除禁碰前缀 p0-wave3-* / p0-stageE-*', () => {
  const picked = pickDedicatedSourceFixture([
    { name: 'p0-wave3-prod-mirror', scaleText: '10 篇文档' },
    { name: 'p0-stageE-domain-src', scaleText: '5 张表' },
    { name: 'codex-ui-legacy-wiki', scaleText: '3 篇文档' },
    { name: 'codex-e2e-local-kb-1125', scaleText: '2 篇文档' },
  ]);
  assert.equal(picked.tier, 'own');
  assert.equal(picked.fixture.name, 'codex-e2e-local-kb-1125');

  const blockedOnly = pickDedicatedSourceFixture([
    { name: 'p0-wave3-do-not-touch' },
    { name: 'p0-stageE-do-not-touch' },
  ]);
  assert.equal(blockedOnly.tier, 'none');
  assert.equal(blockedOnly.fixture, null);
});

test('计数核对与固定来源规模断言：验证树分组求和及内置知识库/PG/Bitable 行规模', () => {
  const snap = makeReadyAllCatalogSnapshot();
  const countCheck = verifyTreeAndOverviewCounts(snap);
  assert.equal(countCheck.ok, true);
  assert.equal(countCheck.total, 6);

  const mismatch = verifyTreeAndOverviewCounts(
    makeReadyAllCatalogSnapshot({ overviewTotalBadge: 5 })
  );
  assert.equal(mismatch.ok, false);

  for (const spec of KNOWN_FIXED_FIXTURES) {
    const res = evaluateFixedFixtureRow(snap.overviewRows, spec);
    assert.equal(res.found, true);
    assert.equal(res.ok, true);
  }

  const degraded = evaluateFixedFixtureRow(
    [{ name: 'codex-e2e-local-kb-1125', scaleText: '—' }],
    KNOWN_FIXED_FIXTURES[0]
  );
  assert.equal(degraded.found, true);
  assert.equal(degraded.ok, false);
  assert.match(degraded.reason, /未知占位符/);
});

test('资产详情页防假绿：标题为「—」或 pending 占位时绝不报就绪，严格区分 ACL_DENIED / TABLE / CONTENT / ERROR', () => {
  // 静态页签先渲染但标题还是 '—'
  const placeholder = evaluateAssetDetailSettlement({
    pathname: '/context/catalog/doc-1/detail',
    detailSpinning: false,
    previewSpinning: false,
    hasPendingPlaceholder: false,
    pendingApiCount: 0,
    headerTitle: '—',
  });
  assert.equal(placeholder.settled, false);
  assert.equal(placeholder.status, 'BLANK_UNSETTLED');

  // 远端 ACL 无权限提示（零正文泄露）
  const aclDenied = evaluateAssetDetailSettlement({
    pathname: '/context/catalog/wiki-1/detail',
    detailSpinning: false,
    previewSpinning: false,
    hasPendingPlaceholder: false,
    pendingApiCount: 0,
    headerTitle: '飞书受控文档',
    assetTypeTag: '文件集合',
    aclDeniedAlert:
      '当前身份无权读取此来源的内容。若来源已开启远端权限控制，请确认当前账号具备原文档协作者权限并已完成个人账号授权。',
    markdownText: '',
    snippetCount: 0,
  });
  assert.equal(aclDenied.settled, true);
  assert.equal(aclDenied.status, 'READY_ACL_DENIED');

  // ACL_DENIED 若同时泄露正文片段则判为 ERROR
  const leaked = evaluateAssetDetailSettlement({
    pathname: '/context/catalog/wiki-1/detail',
    detailSpinning: false,
    previewSpinning: false,
    hasPendingPlaceholder: false,
    pendingApiCount: 0,
    headerTitle: '飞书受控文档',
    assetTypeTag: '文件集合',
    aclDeniedAlert: '当前身份无权读取此来源的内容。',
    snippetCount: 1,
  });
  assert.equal(leaked.settled, true);
  assert.equal(leaked.status, 'ERROR');

  // PG 数据表详情：必须有字段行且无文档正文区块
  const tableReady = evaluateAssetDetailSettlement({
    pathname: '/context/catalog/tbl-1/detail',
    detailSpinning: false,
    previewSpinning: false,
    hasPendingPlaceholder: false,
    pendingApiCount: 0,
    headerTitle: 'adk_sessions',
    assetTypeTag: '数据表',
    fieldRowCount: 6,
    hasMarkdownSection: false,
  });
  assert.equal(tableReady.settled, true);
  assert.equal(tableReady.status, 'READY_TABLE');
});

test('数据血缘与来源处理记录纯判定：准确识别 BindingRequired、1970 脏时间与正常就绪', () => {
  const bindingErr = evaluateLineageSettlement(
    { lineageSpinning: false, pendingApiCount: 0, visibleText: '血缘加载失败，重试' },
    [{ action: 'ListContextEntryLinks', httpStatus: 200, errorCode: 'BindingRequired', requestId: 'req-123' }]
  );
  assert.equal(bindingErr.settled, true);
  assert.equal(bindingErr.status, 'ERROR');
  assert.equal(bindingErr.isBindingRequired, true);
  assert.match(bindingErr.reason, /BindingRequired/);

  const lineageReady = evaluateLineageSettlement(
    {
      lineageSpinning: false,
      pendingApiCount: 0,
      hintText: '3 个节点 · 2 条关系 · 选择节点查看详情',
      nodeCardCount: 3,
      visibleText: '3 个节点 · 2 条关系',
    },
    [{ action: 'ListContextEntryLinks', httpStatus: 200 }]
  );
  assert.equal(lineageReady.settled, true);
  assert.equal(lineageReady.status, 'READY');
  assert.equal(lineageReady.nodeCount, 3);
  assert.equal(lineageReady.edgeCount, 2);

  assert.equal(isValidDisplayTimestamp('1970-01-01 08:00').valid, false);
  assert.equal(isValidDisplayTimestamp('2026-11-25 12:40').valid, true);

  const historyBadTs = evaluateSourceHistorySettlement({
    drawerOpen: true,
    tableSpinning: false,
    pendingApiCount: 0,
    rows: [{ name: '文档解析入库', status: '已完成', time: '1970-01-01 08:00' }],
  });
  assert.equal(historyBadTs.settled, true);
  assert.equal(historyBadTs.status, 'ERROR');
  assert.match(historyBadTs.reason, /1970-01-01/);

  const historyReady = evaluateSourceHistorySettlement({
    drawerOpen: true,
    tableSpinning: false,
    pendingApiCount: 0,
    rows: [{ name: 'Bitable 首扫', status: '成功', time: '2026-11-25 12:41' }],
  });
  assert.equal(historyReady.settled, true);
  assert.equal(historyReady.status, 'READY');
  assert.equal(historyReady.rowCount, 1);
});

test('安全与只读熔断守卫：命中禁区 workspace、丢失 project 或发出写接口一律抛错阻断', () => {
  const cleanOracle = {
    href: 'https://console.volcengine.com/v2/context/catalog?workspaceId=ws-ok&project=default',
    forbiddenWorkspaceHit: false,
    urlWorkspaceOk: true,
    urlProjectOk: true,
    pageErrors: [],
    slowApis: [],
    records: [{ action: 'ListContextConnections', httpStatus: 200 }],
  };
  assert.doesNotThrow(() => assertStepOracleHealthy(cleanOracle));

  assert.throws(
    () =>
      assertStepOracleHealthy({
        ...cleanOracle,
        records: [{ action: 'CreateContextTask', requestId: 'req-write-1' }],
      }),
    /只读回归期间禁止发起写接口.*CreateContextTask/
  );

  assert.throws(
    () => assertStepOracleHealthy({ ...cleanOracle, forbiddenWorkspaceHit: true }),
    /命中禁区工作区/
  );

  assert.throws(
    () => assertStepOracleHealthy({ ...cleanOracle, urlProjectOk: false }),
    /project/
  );
});

test('真实鼠标点击辅助：按 mouseMoved -> mousePressed -> mouseReleased 顺序派发 CDP 并在被遮挡时报错', async () => {
  const sentEvents = [];
  let evalCall = 0;
  const mockPage = {
    sleep: async () => {},
    evalJSON: async () => {
      evalCall += 1;
      if (evalCall === 1) return { found: true };
      return { ok: true, x: 120, y: 240, text: '所有资产单元' };
    },
    send: async (method, params) => {
      sentEvents.push({ method, params });
    },
  };

  const res = await dispatchRealMouseClick(mockPage, 'document.body', '所有资产单元');
  assert.equal(res.x, 120);
  assert.equal(res.y, 240);
  assert.deepEqual(
    sentEvents.map(e => `${e.method}:${e.params.type}:${e.params.buttons ?? 'none'}`),
    [
      'Input.dispatchMouseEvent:mouseMoved:none',
      'Input.dispatchMouseEvent:mousePressed:1',
      'Input.dispatchMouseEvent:mouseReleased:0',
    ]
  );

  let blockedCall = 0;
  const obscuredPage = {
    sleep: async () => {},
    evalJSON: async () => {
      blockedCall += 1;
      if (blockedCall === 1) return { found: true };
      return { ok: false, reason: '目标被上层节点遮挡 (hit=DIV.arco-modal-mask)' };
    },
    send: async () => {
      throw new Error('被遮挡时不应发出鼠标事件');
    },
  };
  await assert.rejects(
    () => dispatchRealMouseClick(obscuredPage, 'document.body', '被遮挡节点'),
    /目标被上层节点遮挡/
  );
});

test('模块加载冒烟：02 与 03 用例模块均可无副作用导入并导出标准 run(t, page, cfg) 函数', async () => {
  const spec02 = await import('../specs/02-catalog-explorer.spec.mjs');
  const spec03 = await import('../specs/03-asset-detail-lineage.spec.mjs');
  assert.equal(typeof spec02.run, 'function');
  assert.equal(typeof spec03.run, 'function');
});
