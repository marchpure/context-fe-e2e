// AgentKit Context v0.4.1 全任务链图文走查指南（L01–L31）纯逻辑终态校验器与多账号隔离守卫。
// 零外部依赖，既供 specs/13-v041-walkthrough-gaps.spec.mjs 真机调用，也供 Node 属性测试离线自测。

import { BASELINE_WORKSPACE_ID, FORBIDDEN_WORKSPACE_ID } from './cdpSession.mjs';

const BASELINE_2107625663_IDS = new Set([
  'res-01a20d5afab17c8fa64fbbcedf492414',
  'r_65f5835dbd19a08236467e6acd7bf32eac5801ec52f6f584b87d22847fab5e39',
  'dom-61a07705c778406af7257e19137f011d',
  'res-01a20cd199e87f1b89c6411fc443942b',
  'dom-388b2bb4788d3808801363f6272e62a7',
  'res-01a21278ed7472dfbe6cb5caf4a882bc',
]);

export const MCP_SERVICE_NAME_RE = /^[A-Za-z0-9_]{4,64}$/;
export const MCP_DELETE_BEFORE_PAUSE_TOOLTIP = '请先停用 MCP 服务，再删除。';
export const DOMAIN_DELETE_PUBLISHED_REASON =
  '该领域的 MCP 服务仍已发布；请先进入领域详情停用 MCP 服务，再删除领域。';

export const V041_CHAIN_TRACEABILITY = [
  { chainId: 'L01', title: '空间视图全局入口与顶栏切换', matrixIds: ['NAV-01', 'NAV-02'], specFiles: ['01-navigation-scope.spec.mjs'] },
  { chainId: 'L02', title: '企业视图只读汇总与切回空间视图', matrixIds: ['NAV-05'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L03', title: '资产目录筛选、名称搜索与翻页', matrixIds: ['CAT-01', 'CAT-03', 'CAT-04', 'CAT-12'], specFiles: ['02-catalog-explorer.spec.mjs', '12-catalog-pagination.spec.mjs'] },
  { chainId: 'L04', title: '顶部自然语言搜索业务知识与指标口径', matrixIds: ['CAT-13'], specFiles: ['02-catalog-explorer.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L05', title: '文档/数据表/知识资产详情与血缘权限', matrixIds: ['CAT-08', 'CAT-09'], specFiles: ['03-asset-detail-lineage.spec.mjs'] },
  { chainId: 'L06', title: '来源目录树切换、关系图谱与处理记录', matrixIds: ['CAT-02', 'CAT-07', 'CAT-10', 'CAT-11', 'SRC-13'], specFiles: ['02-catalog-explorer.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L07', title: '接入在线数据库（自动发现与手动白名单表）', matrixIds: ['SRC-06', 'SRC-07', 'SRC-10'], specFiles: ['09-source-wizard.spec.mjs', '11-seal-regressions.spec.mjs'] },
  { chainId: 'L08', title: '接入飞书/多维表格/TOS/OpenViking/代码仓', matrixIds: ['SRC-03', 'SRC-04', 'SRC-08', 'SRC-09', 'SRC-10'], specFiles: ['02-catalog-explorer.spec.mjs', '09-source-wizard.spec.mjs'] },
  { chainId: 'L09', title: '本地上传：添加为文件资产模式状态与说明', matrixIds: ['SRC-01', 'SRC-13'], specFiles: ['09-source-wizard.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L10', title: '本地上传：加入已有可写知识库', matrixIds: ['SRC-01', 'SRC-02', 'SRC-13'], specFiles: ['09-source-wizard.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L11', title: '本地上传：新建知识库并上传首批文件', matrixIds: ['SRC-13', 'ONB-01'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L12', title: '内置知识库详情补传文件与操作互斥', matrixIds: ['SRC-12', 'SRC-13'], specFiles: ['03-asset-detail-lineage.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L13', title: '业务领域列表搜索与卡片状态', matrixIds: ['DOM-01', 'DOM-03'], specFiles: ['04-domains-versions.spec.mjs'] },
  { chainId: 'L14', title: '创建业务领域与编辑查询资产范围', matrixIds: ['DOM-01', 'DOM-02'], specFiles: ['04-domains-versions.spec.mjs'] },
  { chainId: 'L15', title: '手动补充业务规则、来源说明与知识模型', matrixIds: ['DOM-03', 'DOM-07'], specFiles: ['04-domains-versions.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L16', title: '手动新增/编辑指标口径、四要素与查询示例校验', matrixIds: ['DOM-07'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L17', title: '创建知识加工流水线与 AI 生成提炼提示词', matrixIds: ['ENR-08', 'ENR-09'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L18', title: '立即触发全量/增量知识加工与执行日志', matrixIds: ['ENR-01', 'ENR-02', 'ENR-03', 'ENR-06'], specFiles: ['05-processing-eval.spec.mjs'] },
  { chainId: 'L19', title: '已保存流水线关联资产查看与定时/事件暂停启用', matrixIds: ['ENR-08', 'ENR-09'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L20', title: '加工报告逐条前后对比审核、冲突合并与批量审核', matrixIds: ['ENR-04', 'ENR-05', 'REL-01', 'REL-02', 'ENR-09'], specFiles: ['05-processing-eval.spec.mjs', '11-seal-regressions.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L21', title: '工作台概览/调试台往返、对话设置四页签与任务面板图谱切换', matrixIds: ['USE-03', 'USE-04', 'USE-06', 'USE-07', 'USE-09'], specFiles: ['07-workbench-first-paint.spec.mjs', '08-draft-debug.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L22', title: '首次发布与更新发布（网关选择、服务命名校验、R1/R2 冻结快照）', matrixIds: ['REL-03', 'REL-04', 'USE-10'], specFiles: ['04-domains-versions.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L23', title: 'MCP 服务列表、调用示例、工具清单与 24h 调用统计', matrixIds: ['USE-01', 'USE-02', 'USE-10'], specFiles: ['06-mcp-services.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L24', title: 'MCP 服务停用、启用与先停用后删除保护闭环', matrixIds: ['USE-10'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L25', title: '资产删除引用保护与可清理合成资产移除', matrixIds: ['SRC-05', 'DOM-08'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L26', title: '业务领域删除保护（已发布 MCP 阻断）与清理', matrixIds: ['DOM-08'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L27', title: '来源设置同步策略、数据库同步元数据与移除来源', matrixIds: ['SRC-11', 'SRC-12', 'SRC-13'], specFiles: ['03-asset-detail-lineage.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L28', title: '与资产中心（Context/MCP 登记）及 MCP 关联网关互跳', matrixIds: ['USE-10'], specFiles: ['13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L29', title: '角色画像、数据权限策略模拟与企业只读能力边界', matrixIds: ['AUTH-01', 'AUTH-02', 'AUTH-03', 'NAV-05'], specFiles: ['10-domain-permissions.spec.mjs', '11-seal-regressions.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L30', title: '空白工作区从 0 到 1 引导闭环（概览优先、空目录、首资产入库到首发布）', matrixIds: ['ONB-01'], specFiles: ['02-catalog-explorer.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
  { chainId: 'L31', title: '领域草稿资产版本引用策略（随领域版本/最新/指定版本）与草稿联调', matrixIds: ['DOM-04', 'DOM-05', 'DOM-06', 'ONB-01'], specFiles: ['08-draft-debug.spec.mjs', '13-v041-walkthrough-gaps.spec.mjs'] },
];

export function assertCrossAccountIsolation(cfg, explicitOverrides = {}) {
  if (!cfg || typeof cfg !== 'object') {
    throw new Error('缺少测试目标配置对象');
  }
  const ws = String(cfg.workspaceId || '').trim();
  const forbidden = String(cfg.forbiddenWorkspaceId || FORBIDDEN_WORKSPACE_ID).trim();
  if (!ws || ws === forbidden) {
    throw new Error(`工作区配置非法或命中禁区工作区: workspaceId="${ws || '空'}"`);
  }
  if (ws !== BASELINE_WORKSPACE_ID) {
    for (const key of [
      'baselineLocalKbConnId',
      'baselineDocEntryId',
      'baselineDomainId',
      'baselineTosConnId',
    ]) {
      const val = String(cfg[key] || '').trim();
      if (val && BASELINE_2107625663_IDS.has(val) && !explicitOverrides[key]) {
        throw new Error(
          `跨账号工作区 (${ws}) 泄漏了 2107625663 基线固定 ID: ${key}=${val}`
        );
      }
    }
  }
  return {
    accountId: cfg.accountId || '',
    workspaceId: ws,
    isBaselineWorkspace: ws === BASELINE_WORKSPACE_ID,
  };
}

export function evaluateEnterpriseVsWorkspaceView(view, cfg = {}) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少企业/空间视图快照');
  }
  const forbidden = cfg.forbiddenWorkspaceId || FORBIDDEN_WORKSPACE_ID;
  const parsed = new URL(view.href || 'https://console.volcengine.com/v2/context/domains');
  const urlWorkspaces = [
    ...parsed.searchParams.getAll('workspaceId'),
    ...parsed.searchParams.getAll('contextWorkspaceId'),
  ];
  const orgWorkspaces = Array.isArray(view.organizationWorkspaces) ? view.organizationWorkspaces : [];

  if (
    urlWorkspaces.includes(forbidden) ||
    orgWorkspaces.some(item => (item?.WorkspaceId || item) === forbidden)
  ) {
    throw new Error(`严重越界：企业/空间视图包含禁区工作区 ${forbidden}`);
  }

  if (view.mode === 'enterprise') {
    if (parsed.searchParams.has('workspaceId')) {
      throw new Error(`企业汇总视图 URL 不应携带单空间 workspaceId (${view.href})`);
    }
    const exposedWriteControls = [
      view.canAddAsset && '添加资产',
      view.canCreateDomain && '创建业务领域',
      view.canPublishDomain && '发布',
      view.canMutateMcpService && '停用/删除 MCP 服务',
      view.workbenchChatTabVisible && '工作台调试台写会话',
    ].filter(Boolean);
    if (exposedWriteControls.length > 0) {
      throw new Error(
        `企业只读视图泄漏了空间级写/构建入口: ${exposedWriteControls.join('、')}`
      );
    }
    return { mode: 'enterprise', readOnlyVerified: true, orgWorkspaceCount: orgWorkspaces.length };
  }

  const expectedWs = cfg.workspaceId || BASELINE_WORKSPACE_ID;
  const expectedProject = cfg.projectName || 'default';
  if (parsed.searchParams.get('workspaceId') !== expectedWs) {
    throw new Error(
      `空间构建视图缺少预期 workspaceId=${expectedWs}，实际=${parsed.searchParams.get('workspaceId') || '空'}`
    );
  }
  if (parsed.searchParams.get('project') !== expectedProject) {
    throw new Error(
      `空间构建视图缺少预期 project=${expectedProject}，实际=${parsed.searchParams.get('project') || '空'}`
    );
  }
  return { mode: 'workspace', workspaceId: expectedWs, project: expectedProject };
}

export function evaluateBlankWorkspaceOnboarding(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少空白工作区引导态快照');
  }
  if (view.hasErrorAlert) {
    throw new Error(`空白工作区首次打开误报错误态: ${view.errorText || '未知错误'}`);
  }
  if (view.assetCount === 0 && view.domainCount === 0 && !view.explicitChatRequested) {
    if (view.workbenchActiveTab !== 'overview') {
      throw new Error(
        `空白工作区未传 tab=chat 时工作台应默认停留在「概览」引导页，实际 activeTab=${view.workbenchActiveTab}`
      );
    }
    if (view.chatComposerMountedAndEnabled) {
      throw new Error('空白工作区无可用表与领域时不应提前挂载可发送的对话编辑器');
    }
    if (!view.hasOverviewGuidance) {
      throw new Error('空白工作区工作台「概览」缺少分步使用引导文案');
    }
    if (!view.catalogShowsEmptyWithAddCta) {
      throw new Error('空白工作区知识管理未展示明确空态与「添加资产」引导按钮');
    }
    if (!view.domainsShowsEmptyState) {
      throw new Error('空白工作区业务领域未展示明确空态（「暂无业务领域」）');
    }
    return { stage: 'blank_ready_for_l30', defaultTab: 'overview' };
  }
  return {
    stage: 'populated_workspace',
    assetCount: view.assetCount ?? null,
    domainCount: view.domainCount ?? null,
  };
}

export function validateLocalUploadModesSnapshot(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('缺少「上传本地文件」弹窗快照');
  }
  const storageOptions = Array.isArray(snap.storageOptions) ? snap.storageOptions : [];
  const addOptions = Array.isArray(snap.addModeOptions) ? snap.addModeOptions : [];

  const fileAssetOpt = storageOptions.find(o => o.label === '添加为文件资产');
  const kbStorageOpt = storageOptions.find(o => o.label === '上传到知识库');
  if (!fileAssetOpt || !kbStorageOpt) {
    throw new Error(
      `「存放方式」必须完整呈现「添加为文件资产」与「上传到知识库」，实际=[${storageOptions.map(o => o.label).join(', ')}]`
    );
  }
  if (fileAssetOpt.disabled && !String(fileAssetOpt.disabledReason || '').includes('知识库')) {
    throw new Error('「添加为文件资产」处于禁用态时必须给出明确原因说明');
  }
  if (!kbStorageOpt.checked && !fileAssetOpt.checked) {
    throw new Error('「存放方式」未默认选中有效项');
  }

  const existingKbOpt = addOptions.find(o => o.label === '加入已有知识库');
  const newKbOpt = addOptions.find(o => o.label === '新建知识库');
  if (!existingKbOpt || !newKbOpt) {
    throw new Error(
      `「添加方式」必须完整呈现「加入已有知识库」与「新建知识库」，实际=[${addOptions.map(o => o.label).join(', ')}]`
    );
  }
  if (newKbOpt.disabled) {
    throw new Error('「新建知识库」选项在可写空间内不应被禁用');
  }
  if (!String(newKbOpt.description || '').includes('创建知识库并上传首批文件')) {
    throw new Error(`「新建知识库」说明文案异常: ${newKbOpt.description || '空'}`);
  }
  if (typeof snap.writableLibraryCount === 'number') {
    const expectedExistingDisabled = snap.writableLibraryCount === 0;
    if (Boolean(existingKbOpt.disabled) !== expectedExistingDisabled) {
      throw new Error(
        `可写知识库数量=${snap.writableLibraryCount} 时，「加入已有知识库」disabled 应为 ${expectedExistingDisabled}，实际=${Boolean(existingKbOpt.disabled)}`
      );
    }
  }
  if (snap.selectedAddMode === 'new' && !snap.hasNewKbNameInput) {
    throw new Error('选中「新建知识库」后未渲染必填的「知识库名称」输入框');
  }
  if (snap.selectedAddMode === 'existing' && !existingKbOpt.disabled && !snap.hasExistingKbSelect) {
    throw new Error('选中「加入已有知识库」后未渲染知识库选择下拉框');
  }

  return {
    fileAssetDisabledWithReason: Boolean(fileAssetOpt.disabled),
    existingKbEnabled: !existingKbOpt.disabled,
    newKbReady: Boolean(snap.hasNewKbNameInput || !newKbOpt.disabled),
  };
}

export function validateSourceHeaderActionExclusivity(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少来源详情页头动作快照');
  }
  const { sourceKind, hasUploadFile, hasSyncMetadata, hasViewHistory } = view;
  if (!hasViewHistory) {
    throw new Error(`来源 (${sourceKind}) 缺少「查看记录」操作入口`);
  }
  if (sourceKind === 'builtin_kb') {
    if (!hasUploadFile) {
      throw new Error('内置本地知识库详情缺少「上传文件」补传入口（L12）');
    }
    if (hasSyncMetadata) {
      throw new Error('内置本地知识库不应展示数据库专属「同步元数据」按钮');
    }
  } else if (sourceKind === 'remote_kb') {
    if (hasUploadFile) {
      throw new Error('在线外部知识库（飞书 / OpenViking / TOS）不应暴露本地「上传文件」按钮');
    }
    if (hasSyncMetadata) {
      throw new Error('在线文档来源不应展示数据库专属「同步元数据」按钮');
    }
  } else if (sourceKind === 'database') {
    if (hasUploadFile) {
      throw new Error('数据库来源详情不应展示本地文档「上传文件」按钮');
    }
    if (!hasSyncMetadata) {
      throw new Error('数据库来源详情缺少「同步元数据」入口（L27）');
    }
  } else {
    throw new Error(`未知来源类型: ${String(sourceKind)}`);
  }
  return { sourceKind, valid: true };
}

export function validateManualKnowledgeBranches(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('缺少「手动补充」领域知识弹窗与分支快照');
  }
  const expectedOrder = ['指标口径', '业务规则', '来源说明'];
  const actualTitles = (snap.options || []).map(o => String(o.title || o.label || '').trim());
  if (JSON.stringify(actualTitles) !== JSON.stringify(expectedOrder)) {
    throw new Error(
      `「手动补充」知识类型顺序或项不符：期望 ${expectedOrder.join(' / ')}，实际 ${actualTitles.join(' / ') || '空'}`
    );
  }
  if (!snap.nextDisabledInitially) {
    throw new Error('未选择任何知识类型时「下一步」按钮必须处于禁用态');
  }

  if (snap.metricBranch) {
    const mb = snap.metricBranch;
    if (mb.heading !== '新增指标口径' && mb.heading !== '编辑指标口径') {
      throw new Error(`选择「指标口径」未进入独立指标编辑页，实际标题="${mb.heading || '空'}"`);
    }
    if (!mb.hasNoTableNotice && !mb.hasFourFactorWorkspace) {
      throw new Error('指标口径编辑页既未展示四要素编辑工作区，也未展示无可用数据表提示');
    }
    if (!mb.returnedToKnowledgeTabOnCancel) {
      throw new Error('从指标口径编辑页取消后未回到所属领域「领域知识」页签');
    }
  }

  if (snap.sourceNoteBranch && !snap.sourceNoteBranch.requiresSourceAsset) {
    throw new Error('「新增来源说明」未强制要求至少关联一项依据资产');
  }

  return { branchesVerified: expectedOrder.length };
}

export function validatePipelineAndBatchReviewControls(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少加工流水线与批量审核控件快照');
  }
  if (view.pipelineFormChecked && !view.hasAiGeneratePromptBtn) {
    throw new Error('加工流水线提炼提示词区域缺少「AI 生成」辅助按钮（L17）');
  }
  if (view.batchModal) {
    const bm = view.batchModal;
    if (!Number.isInteger(bm.pendingCount) || bm.pendingCount < 0) {
      throw new Error(`批量审核待审核数量非法: ${bm.pendingCount}`);
    }
    if (bm.hasConflict && !bm.approveAllDisabled) {
      throw new Error('存在知识关系或草稿冲突时，「全部通过」按钮必须禁用并提示逐项审核');
    }
    if (bm.rejectMode) {
      if (bm.rejectBtnLabel !== '确认全部不通过') {
        throw new Error(`进入全部不通过确认态后按钮文案应为「确认全部不通过」，实际="${bm.rejectBtnLabel}"`);
      }
      const emptyReason = !String(bm.reason || '').trim();
      if (emptyReason && !bm.rejectSubmitDisabled) {
        throw new Error('未填写拒绝原因时，「确认全部不通过」必须保持禁用');
      }
    }
  }
  return { valid: true };
}

export function isReadOnlySelectSql(sql = '') {
  const cleaned = String(sql || '')
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/--[^\n]*/g, ' ')
    .trim();
  if (!cleaned) return false;
  if (cleaned.includes(';')) {
    const parts = cleaned.split(';').map(s => s.trim()).filter(Boolean);
    if (parts.length !== 1) return false;
  }
  if (!/^(?:SELECT|WITH)\b/i.test(cleaned)) return false;
  if (/\b(?:INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE|GRANT|REVOKE|COPY)\b/i.test(cleaned)) {
    return false;
  }
  return true;
}

export function validateChatSettingsDrawer(snap) {
  if (!snap || typeof snap !== 'object') {
    throw new Error('缺少工作台「对话设置」抽屉快照');
  }
  const expectedTabs = ['来源', '系统提示词', '回答示范', '查询示例'];
  const actualTabs = (snap.tabs || []).map(t => String(t).trim());
  if (JSON.stringify(actualTabs) !== JSON.stringify(expectedTabs)) {
    throw new Error(
      `「对话设置」页签不完整或顺序不符：期望 [${expectedTabs.join(', ')}]，实际 [${actualTabs.join(', ')}]`
    );
  }
  if (!String(snap.noticeText || '').includes('仅作用于当前调试会话')) {
    throw new Error('「对话设置」缺少仅作用于当前调试会话、不改已发布版本的隔离提示');
  }
  if (!snap.hasResetBtn || !snap.hasApplyNewSessionBtn) {
    throw new Error('「对话设置」底部缺少「恢复默认」或「应用并开启新会话」按钮');
  }

  const responseErrors = (snap.responseExamples || []).filter(item => {
    const q = String(item?.question || '').trim();
    const a = String(item?.answer || '').trim();
    return (q && !a) || (!q && a);
  });
  const allowedTables = new Set(snap.availableTables || []);
  const queryErrors = (snap.queryExamples || []).filter(item => {
    const q = String(item?.question || '').trim();
    const tbl = String(item?.table || '').trim();
    const sql = String(item?.sql || '').trim();
    if (!q && !tbl && !sql) return false;
    if (!q || !tbl || !sql) return true;
    if (allowedTables.size > 0 && !allowedTables.has(tbl)) return true;
    return !isReadOnlySelectSql(sql);
  });

  const firstErrorTab =
    responseErrors.length > 0 ? 'responses' : queryErrors.length > 0 ? 'queries' : null;

  return {
    valid: firstErrorTab === null,
    firstErrorTab,
    responseErrorCount: responseErrors.length,
    queryErrorCount: queryErrors.length,
  };
}

export function validateMcpServiceNameCandidate(name) {
  const val = String(name ?? '');
  if (!val) {
    return { valid: false, reason: '请输入 MCP 服务名称' };
  }
  if (!MCP_SERVICE_NAME_RE.test(val)) {
    return { valid: false, reason: '请输入 4–64 个英文字母、数字或下划线' };
  }
  return { valid: true, reason: '' };
}

export function validateMcpLifecycleAndDeleteGuards(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少 MCP 服务生命周期与删除保护快照');
  }
  const { status, readOnly = false, operations = [], domainDeleteReason, registryHref, gatewayHref } = view;

  if (status === 'Unpublished') {
    if (operations.length !== 0) {
      throw new Error(`已下线 MCP 服务不应暴露运行期操作项，实际=[${operations.map(o => o.name).join(', ')}]`);
    }
  } else if (readOnly) {
    if (operations.some(o => o.name === '停用' || o.name === '启用' || o.name === '删除')) {
      throw new Error('只读视图下 MCP 服务列表不应暴露停用/启用/删除写操作');
    }
  } else if (status === 'Published') {
    const pauseOp = operations.find(o => o.name === '停用');
    const delOp = operations.find(o => o.name === '删除');
    if (!pauseOp) {
      throw new Error('已发布 MCP 服务缺少「停用」操作项');
    }
    if (!delOp || !delOp.disabled) {
      throw new Error('已发布 MCP 服务的「删除」操作必须处于禁用态（防误删线上服务）');
    }
    if (delOp.tooltip && !String(delOp.tooltip).includes(MCP_DELETE_BEFORE_PAUSE_TOOLTIP)) {
      throw new Error(`已发布 MCP 服务禁用删除提示不符: ${delOp.tooltip}`);
    }
    if (domainDeleteReason !== undefined && domainDeleteReason !== DOMAIN_DELETE_PUBLISHED_REASON) {
      throw new Error(`已发布领域删除阻断提示不符: ${domainDeleteReason || '空'}`);
    }
  } else if (status === 'Paused') {
    const resumeOp = operations.find(o => o.name === '启用');
    const delOp = operations.find(o => o.name === '删除');
    const exampleOp = operations.find(o => o.name === '调用示例');
    if (!resumeOp || !delOp) {
      throw new Error('已停用 MCP 服务必须同时提供「启用」与「删除」操作');
    }
    if (exampleOp && !exampleOp.disabled) {
      throw new Error('已停用 MCP 服务的「调用示例」应处于禁用态');
    }
  }

  if (registryHref && !/\/registry\/mcp\/[^/?#]+\/detail/.test(registryHref)) {
    throw new Error(`资产中心登记跳转路径非法: ${registryHref}`);
  }
  if (gatewayHref && !/\/gateway\/instance\/[^/?#]+\/detail\?tab=mcp/.test(gatewayHref)) {
    throw new Error(`关联网关跳转路径非法: ${gatewayHref}`);
  }

  return { status, verified: true };
}
