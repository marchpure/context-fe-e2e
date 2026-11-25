import assert from 'node:assert/strict';
import test from 'node:test';
import {
  KNOWN_FIXTURES,
  assertNoWriteActions,
  assertOrderedBoxes,
  classifyEvaluationReportView,
  classifyMcpMetricsDrawerView,
  classifyProposalCitationsView,
  evaluateSidebarTargetSafety,
  findWriteActions,
  validatePublishedVersionComparison,
  validateStepTerminalState,
  validateWorkbenchReadyView,
} from '../lib/ui-checks.mjs';

const BASE_CFG = {
  workspaceId: KNOWN_FIXTURES.workspaceId,
  forbiddenWorkspaceId: KNOWN_FIXTURES.forbiddenWorkspaceId,
  projectName: 'default',
};

test('findWriteActions and assertNoWriteActions strictly block mutating calls while allowing reads', () => {
  const readRecords = [
    { action: 'ListContextDomains', method: 'POST', httpStatus: 200 },
    { action: 'GetContextDomain', method: 'GET', httpStatus: 200 },
    { action: 'CheckServiceLinkedRole', method: 'POST', httpStatus: 200 },
    { action: 'ExploreContextSource', method: 'POST', httpStatus: 200 },
  ];
  assert.equal(findWriteActions(readRecords, []).length, 0);
  assert.doesNotThrow(() => assertNoWriteActions(readRecords, []));

  for (const mutating of [
    { action: 'CreateContextDomain', httpStatus: 200 },
    { action: 'PublishContextDomain', httpStatus: 200 },
    { action: 'ReviewChangeRequest', httpStatus: 200 },
    { action: 'CancelTask', httpStatus: null },
    { action: 'SendChatMessage', httpStatus: 200 },
    { action: 'UnknownAction', method: 'POST', url: 'https://console.volcengine.com/api/context/data/v1/chat' },
  ]) {
    assert.equal(findWriteActions([mutating], []).length, 1);
    assert.throws(() => assertNoWriteActions([mutating], [], '空提交校验'), /禁止的写\/副作用请求/);
  }
});

test('validateStepTerminalState enforces workspace, project, zero pending APIs, and required 200 reads', () => {
  const goodOracle = {
    href: `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/domains?workspaceId=${BASE_CFG.workspaceId}&project=default`,
    urlWorkspaceId: BASE_CFG.workspaceId,
    urlWorkspaceOk: true,
    urlProjectOk: true,
    forbiddenWorkspaceHit: false,
    pageErrors: [],
    has1970Timestamp: false,
    pendingApis: [],
    records: [
      {
        action: 'ListContextDomains',
        httpStatus: 200,
        workspaceId: BASE_CFG.workspaceId,
        requestId: 'req-1',
      },
    ],
  };

  const ok = validateStepTerminalState(goodOracle, BASE_CFG, {
    stepLabel: '领域列表',
    requiredActions: ['ListContextDomains'],
  });
  assert.equal(ok.workspaceId, BASE_CFG.workspaceId);
  assert.equal(ok.project, 'default');

  // Missing project must fail
  assert.throws(
    () =>
      validateStepTerminalState(
        {
          ...goodOracle,
          href: `https://console.volcengine.com/v2/context/domains?workspaceId=${BASE_CFG.workspaceId}`,
          urlProjectOk: false,
        },
        BASE_CFG,
        { stepLabel: '领域列表' }
      ),
    /project 丢失或不一致/
  );

  // Forbidden workspace in network record must fail
  assert.throws(
    () =>
      validateStepTerminalState(
        {
          ...goodOracle,
          records: [
            { action: 'ListContextDomains', httpStatus: 200, workspaceId: BASE_CFG.forbiddenWorkspaceId },
          ],
        },
        BASE_CFG,
        { stepLabel: '领域列表' }
      ),
    /严重越界/
  );

  // Pending in-flight API must fail
  assert.throws(
    () =>
      validateStepTerminalState(
        {
          ...goodOracle,
          pendingApis: [{ action: 'ListContextDomains', durationMs: 320 }],
        },
        BASE_CFG,
        { stepLabel: '领域列表' }
      ),
    /尚未返回的飞行中接口/
  );
});

test('evaluateSidebarTargetSafety aborts before clicking when sidebar points to forbidden workspace', () => {
  const unsafe = evaluateSidebarTargetSafety(
    {
      found: true,
      label: '工作台',
      visible: true,
      disabled: false,
      href: `/context/workbench?workspaceId=${BASE_CFG.forbiddenWorkspaceId}&project=default`,
      scopeBannerText: BASE_CFG.forbiddenWorkspaceId,
      rect: { x: 16, y: 180, width: 180, height: 36 },
    },
    BASE_CFG
  );
  assert.equal(unsafe.safe, false);
  assert.equal(unsafe.forbidden, true);
  assert.match(unsafe.reason, /禁区工作区/);

  const safe = evaluateSidebarTargetSafety(
    {
      found: true,
      label: '工作台',
      visible: true,
      disabled: false,
      href: `/context/workbench?workspaceId=${BASE_CFG.workspaceId}&project=default`,
      scopeBannerText: '测试工作区',
      rect: { x: 20, y: 180, width: 160, height: 36 },
    },
    BASE_CFG
  );
  assert.equal(safe.safe, true);
  assert.equal(safe.centerX, 100);
  assert.equal(safe.centerY, 198);
});

test('assertOrderedBoxes checks dimensions and visual coordinate order', () => {
  const sidebarItems = [
    { label: '工作台', x: 12, y: 140, width: 176, height: 36 },
    { label: '知识管理', x: 12, y: 182, width: 176, height: 36 },
    { label: '业务领域', x: 12, y: 224, width: 176, height: 36 },
  ];
  const ordered = assertOrderedBoxes(sidebarItems, ['工作台', '知识管理', '业务领域'], {
    axis: 'y',
    contextLabel: 'Context 侧栏导航',
  });
  assert.equal(ordered.length, 3);

  assert.throws(
    () =>
      assertOrderedBoxes(
        [
          { label: '工作台', x: 12, y: 224, width: 176, height: 36 },
          { label: '知识管理', x: 12, y: 182, width: 176, height: 36 },
        ],
        ['工作台', '知识管理'],
        { axis: 'y' }
      ),
    /排列顺序异常/
  );

  assert.throws(
    () =>
      assertOrderedBoxes([{ label: '工作台', x: 12, y: 140, width: 0, height: 36 }], ['工作台'], {
        axis: 'y',
      }),
    /尺寸无效/
  );
});

test('validatePublishedVersionComparison verifies R2 > R1 order, publish timestamps, and frozen revisions', () => {
  const summary = validatePublishedVersionComparison({
    headerText: 'codex-e2e-r4-domain-1125 已发布',
    rows: [
      { version: '1.0.2', status: '当前发布', publishedAt: '2026-11-25 13:03:12' },
      { version: '1.0.1', status: '历史版本', publishedAt: '2026-11-25 11:24:36' },
    ],
    r1RefundRevision: '1',
    r1FrozenCount: 2,
    r2RefundRevision: '2',
    r2FrozenCount: 2,
  });
  assert.match(summary, /1\.0\.2.*1\.0\.1/);

  assert.throws(
    () =>
      validatePublishedVersionComparison({
        headerText: '当前 1.0.1 继续按原范围提供服务',
        rows: [
          { version: '1.0.2', status: '当前发布', publishedAt: '2026-11-25 13:03:12' },
          { version: '1.0.1', status: '历史版本', publishedAt: '2026-11-25 11:24:36' },
        ],
        r1RefundRevision: '1',
        r1FrozenCount: 2,
        r2RefundRevision: '2',
        r2FrozenCount: 2,
      }),
    /旧版本 1\.0\.1/
  );
});

test('classifyEvaluationReportView separates passed, failed, degraded, and unconfigured states (CTX-002)', () => {
  // Dual-pass failed gate with real per-question rows (matches results.md enr-01a2110650c87ef2a4fb80087ce167e6)
  const failedRes = classifyEvaluationReportView({
    badges: ['DUAL_PASS_MCP_SANDBOX', '评测未通过', '评测命中率 50%（1/2）'],
    text: '基线 50% → 候选 50%',
    rows: [
      { question: '退款时效是多少天？', verdict: '待改进', attribution: '输入源资料缺失' },
      { question: '验收标识是什么？', verdict: '已覆盖通过', attribution: '双轮通过' },
    ],
  });
  assert.equal(failedRes.kind, 'failed');
  assert.equal(failedRes.rowCount, 2);

  // Unconfigured / disabled clean state
  const unconf = classifyEvaluationReportView({
    badges: ['双轮评测已关闭'],
    text: '本次运行没有问答评估结果。未关联评测集。',
    rows: [],
  });
  assert.equal(unconf.kind, 'unconfigured');

  // CTX-002 exact symptom
  assert.throws(
    () =>
      classifyEvaluationReportView({
        badges: ['双轮评测已关闭', '评测命中率 0%'],
        text: '本次运行未启用双轮问答评估',
        rows: [],
      }),
    /0%.*(?:评测|命中率)|(?:评测|命中率).*0%/
  );

  // Degraded disguised as passed must fail
  assert.throws(
    () =>
      classifyEvaluationReportView({
        badges: ['评测降级回退（未通过）', '双轮评测通过'],
        text: '降级',
        rows: [{ question: 'Q1', verdict: '已覆盖通过' }],
      }),
    /状态分离失效/
  );
});

test('classifyProposalCitationsView detects CTX-011 symptoms and validates document citations', () => {
  assert.equal(
    classifyProposalCitationsView([
      {
        title: 'doc-codex-e2e-1125-refund.md',
        kindLabel: '文档',
        revision: '2',
        hasAssetLink: true,
      },
    ]),
    1
  );

  assert.throws(
    () =>
      classifyProposalCitationsView([
        {
          title: 'doc-codex-e2e-1125-refund.md',
          kindLabel: '数据表',
          hasAssetLink: true,
        },
      ]),
    /Markdown.*误标.*数据表/
  );

  assert.throws(
    () =>
      classifyProposalCitationsView([
        {
          title: '退款规则说明',
          kindLabel: '文档',
          hasAssetLink: false,
        },
      ]),
    /引用缺少原资产跳转链接/
  );
});

test('classifyMcpMetricsDrawerView distinguishes READY, FORBIDDEN, and CTX-021 UNAVAILABLE', () => {
  const ready = classifyMcpMetricsDrawerView({
    open: true,
    loading: false,
    width: 480,
    height: 900,
    text: '调用次数 4 失败次数 0 权限拦截次数 0',
    metrics: { 调用次数: '4', 失败次数: '0', 权限拦截次数: '0' },
  });
  assert.equal(ready.status, 'READY');
  assert.equal(ready.counts.total, 4);

  const forbidden = classifyMcpMetricsDrawerView({
    open: true,
    loading: false,
    width: 480,
    height: 900,
    text: '当前身份没有查看调用统计的权限。',
    metrics: {},
  });
  assert.equal(forbidden.status, 'FORBIDDEN');

  assert.throws(
    () =>
      classifyMcpMetricsDrawerView({
        open: true,
        loading: false,
        width: 480,
        height: 900,
        text: '暂时无法获取调用统计。',
        metrics: {},
      }),
    /24h.*UNAVAILABLE/
  );
});

test('validateWorkbenchReadyView verifies domain version picker, usable model, and enabled composer', () => {
  const ready = validateWorkbenchReadyView({
    hasSpin: false,
    chatTabActive: true,
    domainPicker: {
      visible: true,
      width: 220,
      height: 28,
      disabled: false,
      text: 'codex-e2e-r4-domain-1125 · v1.0.2',
    },
    modelPicker: {
      visible: true,
      width: 180,
      height: 28,
      disabled: false,
      text: 'doubao-seed-1-6',
    },
    composer: {
      visible: true,
      width: 760,
      height: 84,
      disabled: false,
    },
  });
  assert.equal(ready.selectedModel, 'doubao-seed-1-6');

  assert.throws(
    () =>
      validateWorkbenchReadyView({
        hasSpin: false,
        chatTabActive: true,
        domainPicker: { visible: true, width: 220, height: 28, disabled: false, text: '加载领域…' },
        modelPicker: { visible: true, width: 180, height: 28, disabled: false, text: 'doubao-seed-1-6' },
        composer: { visible: true, width: 760, height: 84, disabled: false },
      }),
    /未就绪/
  );
});

test('all 5 owned spec modules import cleanly and export async run(t, page, cfg)', async () => {
  const specPaths = [
    '../specs/01-navigation-scope.spec.mjs',
    '../specs/04-domains-versions.spec.mjs',
    '../specs/05-processing-eval.spec.mjs',
    '../specs/06-mcp-services.spec.mjs',
    '../specs/07-workbench-first-paint.spec.mjs',
  ];
  for (const rel of specPaths) {
    const mod = await import(rel);
    assert.equal(typeof mod.run, 'function', `${rel} must export run()`);
  }
});

test('knownBug symptom classification strictly distinguishes registered symptoms from missing-entry regressions', async () => {
  const { TestContext } = await import('../lib/testContext.mjs');
  const fakePage = {
    screenshot: async () => null,
  };

  // 1. Exact registered symptoms must map to KNOWN_BUG
  const symptomCases = [
    ['CTX-001', 'MCP 管理列表触发 localeCompare TypeError: Cannot read properties of undefined (reading localeCompare)'],
    ['CTX-006', '未成功重定向至资产详情: href=https://console.volcengine.com/v2/context/connections/res-1/detail，仍停留在旧连接路由'],
    ['CTX-012', '首次发布弹窗第一步仍展示网关/服务名/认证可编辑项（冗余网关/认证编辑项）'],
    ['CTX-013', '工作台首屏渲染耗时超标: 实测=8420ms (红线 <= 5000ms)'],
    ['CTX-021', '24h 调用统计状态为 UNAVAILABLE（抽屉显示「暂时无法获取调用统计。」）'],
  ];

  for (const [bugId, msg] of symptomCases) {
    const t = new TestContext(fakePage, 'symptom-check.spec.mjs');
    await t.checkKnownBug(bugId, `验证 ${bugId}`, async () => {
      throw new Error(msg);
    });
    assert.equal(
      t.results[0].status,
      'KNOWN_BUG',
      `${bugId} exact symptom should be KNOWN_BUG, got ${t.results[0].status}`
    );
  }

  // 2. Missing entry / unexpected failure in checkKnownBug must NEVER be masked as KNOWN_BUG or PASS
  const regressionCases = [
    ['CTX-021', 'MCP 服务列表「调用统计」列缺少可点击的「查看」按钮'],
    ['CTX-013', '工作台首屏展示「无法读取工作台数据，请重试。」错误态'],
    ['CTX-001', 'MCP 服务管理页出现错误提示（非异常排序）'],
  ];

  for (const [bugId, msg] of regressionCases) {
    const t = new TestContext(fakePage, 'missing-entry-check.spec.mjs');
    await t.checkKnownBug(bugId, `验证缺失入口 ${bugId}`, async () => {
      throw new Error(msg);
    });
    assert.equal(
      t.results[0].status,
      'REGRESSION_FAIL',
      `${bugId} missing entry "${msg}" must be REGRESSION_FAIL, got ${t.results[0].status}`
    );
  }

  // 3. t.block inside check / checkKnownBug records BLOCKED rather than PASS or FIXED_CANDIDATE
  const tBlock = new TestContext(fakePage, 'block-check.spec.mjs');
  await tBlock.checkKnownBug('CTX-006', '缺少前置版本', async () => {
    tBlock.block('缺少前置版本', '当前领域无已发布版本');
  });
  assert.equal(tBlock.results.length, 1);
  assert.equal(tBlock.results[0].status, 'BLOCKED');
});
