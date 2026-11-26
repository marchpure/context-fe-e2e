import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BASELINE_ACCOUNT_ID,
  BASELINE_WORKSPACE_ID,
  FORBIDDEN_WORKSPACE_ID,
  IsolatedCdpPage,
  buildTargetConfig,
} from '../lib/cdpSession.mjs';
import {
  DOMAIN_DELETE_PUBLISHED_REASON,
  MCP_DELETE_BEFORE_PAUSE_TOOLTIP,
  V041_CHAIN_TRACEABILITY,
  assertCrossAccountIsolation,
  evaluateBlankWorkspaceOnboarding,
  evaluateEnterpriseVsWorkspaceView,
  isReadOnlySelectSql,
  validateChatSettingsDrawer,
  validateLocalUploadModesSnapshot,
  validateManualKnowledgeBranches,
  validateMcpLifecycleAndDeleteGuards,
  validateMcpServiceNameCandidate,
  validatePipelineAndBatchReviewControls,
  validateSourceHeaderActionExclusivity,
} from '../lib/v041-walkthrough-checks.mjs';
import { assertProperty } from './support/propHarness.mjs';

test('PM v0.4.1 走查指南 L01–L31 全任务链 31 条链路 100% 映射至验收矩阵与自动化模块', () => {
  assert.equal(V041_CHAIN_TRACEABILITY.length, 31);
  const expectedIds = Array.from({ length: 31 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`);
  assert.deepEqual(
    V041_CHAIN_TRACEABILITY.map(item => item.chainId),
    expectedIds
  );
  for (const chain of V041_CHAIN_TRACEABILITY) {
    assert.ok(chain.title.length >= 4, `${chain.chainId} 缺少标题`);
    assert.ok(Array.isArray(chain.matrixIds) && chain.matrixIds.length >= 1, `${chain.chainId} 未映射矩阵编号`);
    assert.ok(Array.isArray(chain.specFiles) && chain.specFiles.length >= 1, `${chain.chainId} 未绑定 spec 文件`);
  }
});

test('多账号隔离属性：切换到 2100390175 等任意非基线工作区时绝不串入 2107625663 资源 ID，且禁区工作区无条件拦截', () => {
  assertProperty(
    {
      name: '跨账号配置隔离与禁区工作区拦截',
      seed: 0x21003901,
      runs: 160,
      file: 'test/v041-walkthrough.property.test.mjs',
      generate: rng => ({
        scenario: rng.pick(['baseline_2107625663', 'secondary_2100390175', 'forbidden', 'leaked_id']),
        wsSuffix: rng.hex(8),
      }),
    },
    ({ scenario, wsSuffix }) => {
      if (scenario === 'baseline_2107625663') {
        const cfg = buildTargetConfig({});
        assert.equal(cfg.accountId, BASELINE_ACCOUNT_ID);
        assert.equal(cfg.workspaceId, BASELINE_WORKSPACE_ID);
        assert.ok(cfg.baselineDomainId.startsWith('dom-'));
        assert.equal(assertCrossAccountIsolation(cfg).isBaselineWorkspace, true);
        return;
      }
      if (scenario === 'secondary_2100390175') {
        const wsId = `ws-2100390175-${wsSuffix}`;
        const cfg = buildTargetConfig({
          CONTEXT_ACCOUNT_ID: '2100390175',
          CONTEXT_WORKSPACE_ID: wsId,
          CONTEXT_E2E_EXPECTED_FE_VERSION: '1.0.0.2303',
        });
        assert.equal(cfg.accountId, '2100390175');
        assert.equal(cfg.workspaceId, wsId);
        assert.equal(cfg.expectedFrontendVersion, '1.0.0.2303');
        assert.equal(cfg.baselineLocalKbConnId, '');
        assert.equal(cfg.baselineDocEntryId, '');
        assert.equal(cfg.baselineDomainId, '');
        assert.equal(cfg.baselineTosConnId, '');
        assert.equal(assertCrossAccountIsolation(cfg).isBaselineWorkspace, false);
        return;
      }
      if (scenario === 'forbidden') {
        const cfg = buildTargetConfig({ CONTEXT_WORKSPACE_ID: FORBIDDEN_WORKSPACE_ID });
        assert.throws(() => assertCrossAccountIsolation(cfg), /禁区工作区/);
        return;
      }
      const leakedCfg = {
        ...buildTargetConfig({
          CONTEXT_ACCOUNT_ID: '2100390175',
          CONTEXT_WORKSPACE_ID: `ws-2100390175-${wsSuffix}`,
        }),
        baselineDomainId: 'dom-61a07705c778406af7257e19137f011d',
      };
      assert.throws(() => assertCrossAccountIsolation(leakedCfg), /泄漏了 2107625663 基线固定 ID/);
    }
  );
});

test('企业视图 OrganizationWorkspaces 请求体若包含禁区工作区即使开启 allowOrgScope 仍在发送前硬阻断', () => {
  const cfg = buildTargetConfig({
    CONTEXT_ACCOUNT_ID: '2100390175',
    CONTEXT_WORKSPACE_ID: 'ws-2100390175-alpha',
  });
  const page = new IsolatedCdpPage(cfg);
  const actions = [];
  page.send = async (method, { requestId }) => actions.push([method, requestId]);
  page.setStep('org-summary-step', { allowOrgScope: true });

  const apiUrl = 'https://console.volcengine.com/api/top/agentkit?Action=ListContextDomains';
  // 1) 干净的 2100390175 多空间企业汇总请求 -> 放行
  page._onMessage(
    JSON.stringify({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'clean-org-req',
        resourceType: 'Fetch',
        request: {
          url: apiUrl,
          postData: JSON.stringify({
            OrganizationWorkspaces: [
              { WorkspaceId: 'ws-2100390175-alpha', ProjectName: 'default' },
              { WorkspaceId: 'ws-2100390175-beta', ProjectName: 'default' },
            ],
          }),
        },
      },
    })
  );
  // 2) 混入禁区工作区 ws-7710414566965542920 的企业汇总请求 -> 必须拦截并标记 forbidden=true
  page._onMessage(
    JSON.stringify({
      method: 'Fetch.requestPaused',
      params: {
        requestId: 'poisoned-org-req',
        resourceType: 'Fetch',
        request: {
          url: apiUrl,
          postData: JSON.stringify({
            OrganizationWorkspaces: [
              { WorkspaceId: 'ws-2100390175-alpha', ProjectName: 'default' },
              { WorkspaceId: FORBIDDEN_WORKSPACE_ID, ProjectName: 'default' },
            ],
          }),
        },
      },
    })
  );

  assert.deepEqual(actions, [
    ['Fetch.continueRequest', 'clean-org-req'],
    ['Fetch.failRequest', 'poisoned-org-req'],
  ]);
  assert.equal(page.scopeViolations.length, 1);
  assert.equal(page.scopeViolations[0].forbidden, true);
});

test('NAV-05 / ONB-01 企业只读边界与 L30 空白工作区概览优先不变量', () => {
  assertProperty(
    {
      name: '企业只读不暴露写操作且空白工作区不早挂载聊天框',
      seed: 0x04010002,
      runs: 150,
      file: 'test/v041-walkthrough.property.test.mjs',
      generate: rng => ({
        leakWrite: rng.bool(0.4),
        prematureChat: rng.bool(0.4),
        includeForbidden: rng.bool(0.2),
      }),
    },
    ({ leakWrite, prematureChat, includeForbidden }) => {
      const cfg = { workspaceId: 'ws-2100390175-clean', projectName: 'default' };
      const checkOrg = () =>
        evaluateEnterpriseVsWorkspaceView(
          {
            mode: 'enterprise',
            href: 'https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/domains',
            organizationWorkspaces: [
              { WorkspaceId: includeForbidden ? FORBIDDEN_WORKSPACE_ID : 'ws-2100390175-clean' },
            ],
            canAddAsset: leakWrite,
            canCreateDomain: false,
            canPublishDomain: false,
            canMutateMcpService: false,
            workbenchChatTabVisible: leakWrite,
          },
          cfg
        );
      if (includeForbidden || leakWrite) assert.throws(checkOrg);
      else assert.equal(checkOrg().readOnlyVerified, true);

      const checkBlank = () =>
        evaluateBlankWorkspaceOnboarding({
          hasErrorAlert: false,
          assetCount: 0,
          domainCount: 0,
          explicitChatRequested: false,
          workbenchActiveTab: prematureChat ? 'chat' : 'overview',
          chatComposerMountedAndEnabled: prematureChat,
          hasOverviewGuidance: true,
          catalogShowsEmptyWithAddCta: true,
          domainsShowsEmptyState: true,
        });
      if (prematureChat) assert.throws(checkBlank);
      else assert.equal(checkBlank().stage, 'blank_ready_for_l30');
    }
  );
});

test('SRC-13 本地上传三路径与来源页头动作互斥性质（内置知识库 vs 外部知识库 vs 数据库）', () => {
  assertProperty(
    {
      name: '上传三路径完整性与来源动作严格互斥',
      seed: 0x04010009,
      runs: 150,
      file: 'test/v041-walkthrough.property.test.mjs',
      generate: rng => ({
        writableCount: rng.int(0, 3),
        selectedAddMode: rng.pick(['existing', 'new']),
        sourceKind: rng.pick(['builtin_kb', 'remote_kb', 'database']),
        wrongAction: rng.bool(0.35),
      }),
    },
    ({ writableCount, selectedAddMode, sourceKind, wrongAction }) => {
      const mode = writableCount === 0 ? 'new' : selectedAddMode;
      const uploadRes = validateLocalUploadModesSnapshot({
        writableLibraryCount: writableCount,
        selectedAddMode: mode,
        hasNewKbNameInput: mode === 'new',
        hasExistingKbSelect: mode === 'existing' && writableCount > 0,
        storageOptions: [
          {
            label: '添加为文件资产',
            disabled: true,
            disabledReason: '当前上传接口需要指定知识库，暂不支持直接添加文件资产。',
            checked: false,
          },
          { label: '上传到知识库', disabled: false, checked: true },
        ],
        addModeOptions: [
          { label: '加入已有知识库', disabled: writableCount === 0, checked: mode === 'existing' },
          {
            label: '新建知识库',
            description: '创建知识库并上传首批文件',
            disabled: false,
            checked: mode === 'new',
          },
        ],
      });
      assert.equal(uploadRes.existingKbEnabled, writableCount > 0);

      const validActionShape = {
        sourceKind,
        hasUploadFile: sourceKind === 'builtin_kb',
        hasSyncMetadata: sourceKind === 'database',
        hasViewHistory: true,
      };
      const mutated = wrongAction
        ? { ...validActionShape, hasUploadFile: !validActionShape.hasUploadFile }
        : validActionShape;
      if (wrongAction) assert.throws(() => validateSourceHeaderActionExclusivity(mutated));
      else assert.equal(validateSourceHeaderActionExclusivity(mutated).valid, true);
    }
  );
});

test('DOM-07 / ENR-09 / USE-09 手动知识三分支、批量审核冲突/拒审状态机与对话设置校验优先级', () => {
  assert.doesNotThrow(() =>
    validateManualKnowledgeBranches({
      options: [{ title: '指标口径' }, { title: '业务规则' }, { title: '来源说明' }],
      nextDisabledInitially: true,
      metricBranch: {
        heading: '新增指标口径',
        hasNoTableNotice: true,
        hasFourFactorWorkspace: false,
        returnedToKnowledgeTabOnCancel: true,
      },
      sourceNoteBranch: { requiresSourceAsset: true },
    })
  );

  // 批量审核：存在冲突时「全部通过」必须禁用；点击全部不通过后未填拒绝原因时「确认全部不通过」必须禁用
  assert.throws(() =>
    validatePipelineAndBatchReviewControls({
      batchModal: { pendingCount: 3, hasConflict: true, approveAllDisabled: false },
    })
  );
  assert.throws(() =>
    validatePipelineAndBatchReviewControls({
      batchModal: {
        pendingCount: 2,
        hasConflict: false,
        approveAllDisabled: false,
        rejectMode: true,
        rejectBtnLabel: '确认全部不通过',
        reason: '   ',
        rejectSubmitDisabled: false,
      },
    })
  );
  assert.equal(
    validatePipelineAndBatchReviewControls({
      pipelineFormChecked: true,
      hasAiGeneratePromptBtn: true,
      batchModal: {
        pendingCount: 2,
        hasConflict: true,
        approveAllDisabled: true,
        rejectMode: true,
        rejectBtnLabel: '确认全部不通过',
        reason: '证据切片不匹配',
        rejectSubmitDisabled: false,
      },
    }).valid,
    true
  );

  // 对话设置：同时存在半填回答示范与非法 SQL 查询示例时，优先定位到 responses，且禁止写 SQL
  assert.equal(isReadOnlySelectSql('SELECT count(*) FROM public.events'), true);
  assert.equal(isReadOnlySelectSql('DELETE FROM public.events'), false);
  const bothInvalid = validateChatSettingsDrawer({
    tabs: ['来源', '系统提示词', '回答示范', '查询示例'],
    noticeText: '系统提示词、回答示范与查询示例随新会话下发至常驻 Host Agent，仅作用于当前调试会话。',
    hasResetBtn: true,
    hasApplyNewSessionBtn: true,
    availableTables: ['public.events'],
    responseExamples: [{ question: '净 GMV 怎么算？', answer: '' }],
    queryExamples: [{ question: '事件总数', table: 'public.events', sql: 'DROP TABLE public.events' }],
  });
  assert.equal(bothInvalid.valid, false);
  assert.equal(bothInvalid.firstErrorTab, 'responses');
});

test('USE-10 / DOM-08 MCP 服务命名规则（拒绝连字符）、先停用后删除不变量与资产中心/网关互跳路径', () => {
  assertProperty(
    {
      name: 'MCP 服务命名、先停用再删除与已发布领域禁删',
      seed: 0x04010024,
      runs: 160,
      file: 'test/v041-walkthrough.property.test.mjs',
      generate: rng => ({
        stem: rng.slug('ctx').replace(/-/g, '_'),
        useHyphen: rng.bool(0.5),
        allowDeleteWhilePublished: rng.bool(0.4),
      }),
    },
    ({ stem, useHyphen, allowDeleteWhilePublished }) => {
      const candidate = useHyphen ? `context-${stem}-svc` : `context_${stem}_svc`;
      const nameVerdict = validateMcpServiceNameCandidate(candidate);
      assert.equal(nameVerdict.valid, !useHyphen);

      const checkLifecycle = () =>
        validateMcpLifecycleAndDeleteGuards({
          status: 'Published',
          operations: [
            { name: '调用示例', disabled: false },
            { name: '停用', disabled: false },
            {
              name: '删除',
              disabled: !allowDeleteWhilePublished,
              tooltip: MCP_DELETE_BEFORE_PAUSE_TOOLTIP,
            },
          ],
          domainDeleteReason: DOMAIN_DELETE_PUBLISHED_REASON,
          registryHref: '/registry/mcp/asset-123/detail',
          gatewayHref: '/gateway/instance/gw-456/detail?tab=mcp',
        });
      if (allowDeleteWhilePublished) assert.throws(checkLifecycle, /禁用态/);
      else assert.equal(checkLifecycle().verified, true);
    }
  );
});
