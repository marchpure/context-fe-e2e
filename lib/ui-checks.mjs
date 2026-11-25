// Context 前端真机回归公共校验器与真实交互辅助函数（零外部依赖，纯逻辑函数支持 Node 单测直跑）。

export const KNOWN_FIXTURES = {
  workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
  forbiddenWorkspaceId: 'ws-7710414566965542920',
  projectName: 'default',
  pgSourceId: 'res-01a21278ed7472dfbe6cb5caf4a882bc',
  pgExpectedTable: 'public.events',
  r4Domain: {
    domainId: 'dom-388b2bb4788d3808801363f6272e62a7',
    domainName: 'codex-e2e-r4-domain-1125',
    refundEntryId: 'r_7ba12641287a2f626f85c883f3a2884e432ce8e4e570fd49ae15fafb07b3bf42',
    localKbConnId: 'res-01a210b459d2794ca1a034720fabebf8',
    r1: {
      version: '1.0.1',
      statusText: '历史版本',
      frozenRevision: '1',
      minFrozenCount: 2,
    },
    r2: {
      version: '1.0.2',
      statusText: '当前发布',
      frozenRevision: '2',
      minFrozenCount: 2,
    },
    enrichmentTasks: {
      dualEvalFailedId: 'enr-01a2110650c87ef2a4fb80087ce167e6',
      rebuildUpdateId: 'enr-01a211142a9c71a1a74a0c9df573b2bd',
      incrementalV2Id: 'enr-01a210fa90d9751894a474047dfdd82b',
      fullV2Id: 'enr-01a21101f51c74cc9edcb2703fc805a2',
      savedPipelineName: 'codex-e2e-r4-incremental-1125',
    },
  },
};

export const WRITE_ACTION_REGEX =
  /^(Create|Update|Delete|Remove|Review|Confirm|Withdraw|Publish|Bind|Upsert|Disable|Cancel|Pause|Resume|Unpublish|Trigger|Start|Scan|Import|Upload|Send|Stream|RunWorkbench|Submit|Modify|Certify|Revoke)/i;

const READ_ONLY_ACTION_ALLOWLIST = new Set([
  'CheckServiceLinkedRole',
  'ExploreContextSource',
  'GetOrganization',
  'GetOrganizationStudioStatus',
  'GetFeatureGateValidateResult',
  'GetWorkspace',
  'ListWorkspaces',
  'GetRole',
  'ListAttachedRolePolicies',
]);

export function isWriteActionRecord(rec) {
  if (!rec || typeof rec !== 'object') return false;
  const action = String(rec.action || '').trim();
  if (!action || READ_ONLY_ACTION_ALLOWLIST.has(action)) return false;
  if (/^(List|Get|Check|Describe|Explore)/i.test(action)) return false;
  if (WRITE_ACTION_REGEX.test(action)) return true;
  const url = String(rec.url || '');
  const method = String(rec.method || 'GET').toUpperCase();
  if (method !== 'GET' && /\/(?:chat|stream|messages|sessions\/[^/]+\/turns)\b/i.test(url)) {
    return true;
  }
  return false;
}

export function findWriteActions(records = [], pendingApis = []) {
  return [...(records || []), ...(pendingApis || [])].filter(isWriteActionRecord);
}

export function assertNoWriteActions(records = [], pendingApis = [], contextLabel = '只读步骤') {
  const writes = findWriteActions(records, pendingApis);
  if (writes.length > 0) {
    const summary = writes
      .map(w => `${w.action}(HTTP=${w.httpStatus ?? 'pending'}, reqId=${w.requestId || '—'})`)
      .join(', ');
    throw new Error(`${contextLabel}检测到禁止的写/副作用请求: ${summary}`);
  }
}

export function validateStepTerminalState(oracle, cfg, options = {}) {
  const {
    stepLabel = '当前步骤',
    forbidWrite = true,
    checkProject = true,
    check1970 = true,
    allowPendingActions = [],
    requiredActions = [],
    allowErrorCodes = [],
  } = options;

  if (!oracle || typeof oracle !== 'object') {
    throw new Error(`${stepLabel}缺少 collectStepOracle 采集结果`);
  }

  const href = String(oracle.href || '');
  let parsedUrl;
  try {
    parsedUrl = new URL(href);
  } catch {
    throw new Error(`${stepLabel}地址栏 URL 非法: ${href}`);
  }

  const forbiddenWs = cfg?.forbiddenWorkspaceId || KNOWN_FIXTURES.forbiddenWorkspaceId;
  const expectedWs = cfg?.workspaceId || KNOWN_FIXTURES.workspaceId;
  const expectedProject = cfg?.projectName || KNOWN_FIXTURES.projectName;

  if (oracle.forbiddenWorkspaceHit || parsedUrl.searchParams.getAll('workspaceId').includes(forbiddenWs)) {
    throw new Error(`${stepLabel}严重越界：URL 串入禁区工作区 ${forbiddenWs} (${href})`);
  }

  const allRecords = [...(oracle.records || []), ...(oracle.pendingApis || [])];
  const forbiddenRec = allRecords.find(r => r?.workspaceId && r.workspaceId === forbiddenWs);
  if (forbiddenRec) {
    throw new Error(
      `${stepLabel}严重越界：接口 ${forbiddenRec.action} 向禁区工作区 ${forbiddenWs} 发出了请求`
    );
  }

  const wrongWsRec = allRecords.find(
    r => r?.workspaceId && expectedWs && r.workspaceId !== expectedWs
  );
  if (wrongWsRec) {
    throw new Error(
      `${stepLabel}工作区越界：接口 ${wrongWsRec.action} 携带了非预期 workspaceId=${wrongWsRec.workspaceId}（期望 ${expectedWs}）`
    );
  }

  if (oracle.scopeViolations?.length) {
    throw new Error(`${stepLabel}拦截了偏离测试工作区或项目的请求: ${oracle.scopeViolations.map(item => item.action).join('、')}`);
  }

  const actualWs = parsedUrl.searchParams.get('workspaceId');
  const wsOk = oracle.urlWorkspaceOk !== false && actualWs === expectedWs;
  if (!wsOk) {
    throw new Error(
      `${stepLabel}地址栏 workspaceId 丢失或不一致：期望=${expectedWs}，实际=${actualWs || '空'} (${href})`
    );
  }

  if (checkProject) {
    const actualProject = parsedUrl.searchParams.get('project');
    const projOk = oracle.urlProjectOk !== false && actualProject === expectedProject;
    if (!projOk) {
      throw new Error(
        `${stepLabel}地址栏 project 丢失或不一致：期望=${expectedProject}，实际=${actualProject || '空'} (${href})`
      );
    }
    const wrongProject = allRecords.find(record =>
      record.projectName && record.projectName !== expectedProject
    );
    if (wrongProject) {
      throw new Error(`${stepLabel}项目越界：接口 ${wrongProject.action} 携带了非预期 project=${wrongProject.projectName}（期望 ${expectedProject}）`);
    }
  }

  if (Array.isArray(oracle.pageErrors) && oracle.pageErrors.length > 0) {
    throw new Error(`${stepLabel}捕获到未处理页面异常: ${oracle.pageErrors[0].text}`);
  }

  if (forbidWrite) {
    assertNoWriteActions(oracle.records, oracle.pendingApis, stepLabel);
  }

  const allowedPendingSet = new Set(allowPendingActions);
  const blockingPending = (oracle.pendingApis || []).filter(
    r => !allowedPendingSet.has(r.action)
  );
  if (blockingPending.length > 0) {
    const names = blockingPending.map(r => `${r.action}(${r.durationMs ?? '?'}ms)`).join(', ');
    throw new Error(`${stepLabel}存在尚未返回的飞行中接口: ${names}`);
  }

  const allowedErrSet = new Set(allowErrorCodes);
  for (const pattern of requiredActions) {
    const matcher =
      typeof pattern === 'string' ? a => a === pattern : a => pattern.test(String(a || ''));
    const matched = (oracle.records || []).filter(r => matcher(r.action));
    if (matched.length === 0) {
      throw new Error(`${stepLabel}未观测到必需的后端读接口完成: ${String(pattern)}`);
    }
    const sample = matched.at(-1);
    if (sample.httpStatus !== 200 || (sample.errorCode && !allowedErrSet.has(sample.errorCode))) {
      throw new Error(
        `${stepLabel}关键接口 ${sample.action} 未达成功终态: HTTP=${sample.httpStatus}, errorCode=${sample.errorCode || '—'}, reqId=${sample.requestId || '—'}`
      );
    }
  }

  if (check1970 && oracle.has1970Timestamp) {
    throw new Error(`${stepLabel}可见文本出现 1970-01-01 零值时间戳`);
  }

  return {
    href,
    workspaceId: actualWs,
    project: parsedUrl.searchParams.get('project'),
    apiCount: (oracle.records || []).length,
  };
}

export function evaluateSidebarTargetSafety(targetInfo, cfg) {
  const forbiddenWs = cfg?.forbiddenWorkspaceId || KNOWN_FIXTURES.forbiddenWorkspaceId;
  if (!targetInfo || !targetInfo.found) {
    return {
      safe: false,
      forbidden: false,
      reason: `侧边栏未找到目标菜单项「${targetInfo?.label || ''}」`,
    };
  }
  const href = String(targetInfo.href || '');
  const scopeText = String(targetInfo.scopeBannerText || '');
  const targetWorkspace = new URL(href || '/', cfg?.consoleBaseUrl || 'https://console.volcengine.com');
  const targetScopes = ['workspaceId', 'WorkspaceId', 'workspace_id']
    .flatMap(key => targetWorkspace.searchParams.getAll(key));
  if (forbiddenWs && (targetScopes.includes(forbiddenWs) || scopeText.includes(forbiddenWs))) {
    return {
      safe: false,
      forbidden: true,
      reason: `侧边栏目标「${targetInfo.label}」或空间切换器指向禁区工作区 ${forbiddenWs}（href=${href || '—'}, scope=${scopeText.slice(0, 80)}），已终止点击防止越界`,
    };
  }
  if (targetInfo.disabled) {
    return {
      safe: false,
      forbidden: false,
      reason: `侧边栏菜单项「${targetInfo.label}」处于禁用态`,
    };
  }
  const rect = targetInfo.rect || { width: 0, height: 0 };
  if (!targetInfo.visible || !(rect.width >= 20 && rect.height >= 16)) {
    return {
      safe: false,
      forbidden: false,
      reason: `侧边栏菜单项「${targetInfo.label}」不可见或尺寸异常 (${rect.width}x${rect.height})`,
    };
  }
  return {
    safe: true,
    forbidden: false,
    centerX: rect.x + rect.width / 2,
    centerY: rect.y + rect.height / 2,
  };
}

export function assertOrderedBoxes(
  boxes = [],
  expectedLabels = [],
  { axis = 'x', minWidth = 16, minHeight = 14, contextLabel = '控件序列' } = {}
) {
  if (!Array.isArray(boxes) || boxes.length < expectedLabels.length) {
    throw new Error(
      `${contextLabel}数量不足：期望 [${expectedLabels.join(' → ')}]，实际仅获取 ${boxes?.length || 0} 项`
    );
  }

  const matched = expectedLabels.map(expected => {
    const found = boxes.find(b => {
      const text = String(b?.label || b?.text || '').trim();
      return expected instanceof RegExp ? expected.test(text) : text === expected || text.startsWith(`${expected} `);
    });
    if (!found) {
      const actualText = boxes.map(b => String(b?.label || b?.text || '').trim()).join(' | ');
      throw new Error(`${contextLabel}缺少「${String(expected)}」（实际可见: ${actualText || '空'}）`);
    }
    const w = Number(found.width ?? found.rect?.width ?? 0);
    const h = Number(found.height ?? found.rect?.height ?? 0);
    if (!(w >= minWidth && h >= minHeight)) {
      throw new Error(
        `${contextLabel}中「${String(expected)}」尺寸无效: ${w}x${h} (要求 >= ${minWidth}x${minHeight})`
      );
    }
    const pos =
      axis === 'y'
        ? Number(found.top ?? found.y ?? found.rect?.y ?? 0) + h / 2
        : Number(found.left ?? found.x ?? found.rect?.x ?? 0) + w / 2;
    return { label: String(expected), width: w, height: h, pos };
  });

  for (let i = 1; i < matched.length; i += 1) {
    if (!(matched[i - 1].pos < matched[i].pos)) {
      throw new Error(
        `${contextLabel}排列顺序异常：「${matched[i - 1].label}」(${Math.round(matched[i - 1].pos)}) 未排在「${matched[i].label}」(${Math.round(matched[i].pos)}) 之前`
      );
    }
  }

  return matched;
}

export function validatePublishedVersionComparison(view, fixture = KNOWN_FIXTURES.r4Domain) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少版本对比视图采集数据');
  }
  const rows = Array.isArray(view.rows) ? view.rows : [];
  const r2Idx = rows.findIndex(r => r.version === fixture.r2.version);
  const r1Idx = rows.findIndex(r => r.version === fixture.r1.version);

  if (r2Idx < 0 || r1Idx < 0) {
    throw new Error(
      `版本列表缺少预期的对照发布版本：期望同时存在 ${fixture.r2.version} 与 ${fixture.r1.version}，实际=[${rows.map(r => r.version).join(', ')}]`
    );
  }
  if (!(r2Idx < r1Idx)) {
    throw new Error(
      `版本排序错误：当前发布 ${fixture.r2.version} (index=${r2Idx}) 必须排在历史版本 ${fixture.r1.version} (index=${r1Idx}) 之前`
    );
  }

  const r2Row = rows[r2Idx];
  const r1Row = rows[r1Idx];
  if (!String(r2Row.status || '').includes(fixture.r2.statusText)) {
    throw new Error(
      `版本 ${fixture.r2.version} 状态应为「${fixture.r2.statusText}」，实际为「${r2Row.status || '空'}」`
    );
  }
  if (!String(r1Row.status || '').includes(fixture.r1.statusText)) {
    throw new Error(
      `版本 ${fixture.r1.version} 状态应为「${fixture.r1.statusText}」，实际为「${r1Row.status || '空'}」`
    );
  }
  const publishedR1 = Date.parse(r1Row.publishedAt || '');
  const publishedR2 = Date.parse(r2Row.publishedAt || '');
  if (!(publishedR2 > publishedR1)) {
    throw new Error(`发布时间失效或顺序错误：R1「${r1Row.publishedAt || '空'}」，R2「${r2Row.publishedAt || '空'}」`);
  }

  const headerVersions = view.headerText?.match(/\b\d+\.\d+\.\d+\b/g) || [];
  if (headerVersions.includes(fixture.r1.version) && !headerVersions.includes(fixture.r2.version)) {
    throw new Error(`领域页头摘要仍沿用旧版本 ${fixture.r1.version}`);
  }

  if (String(view.r1RefundRevision || '') !== fixture.r1.frozenRevision) {
    throw new Error(
      `R1 (${fixture.r1.version}) 退款文档冻结修订应为 ${fixture.r1.frozenRevision}，实际为「${view.r1RefundRevision || '缺失'}」`
    );
  }
  if ((view.r1FrozenCount || 0) < fixture.r1.minFrozenCount) {
    throw new Error(
      `R1 (${fixture.r1.version}) 冻结条目数不足：期望 >= ${fixture.r1.minFrozenCount}，实际 ${view.r1FrozenCount || 0}`
    );
  }
  if (String(view.r2RefundRevision || '') !== fixture.r2.frozenRevision) {
    throw new Error(
      `R2 (${fixture.r2.version}) 退款文档冻结修订应为 ${fixture.r2.frozenRevision}，实际为「${view.r2RefundRevision || '缺失'}」`
    );
  }
  if ((view.r2FrozenCount || 0) < fixture.r2.minFrozenCount) {
    throw new Error(
      `R2 (${fixture.r2.version}) 冻结条目数不足：期望 >= ${fixture.r2.minFrozenCount}，实际 ${view.r2FrozenCount || 0}`
    );
  }

  return `${fixture.r2.version}(当前, rev=${view.r2RefundRevision}) > ${fixture.r1.version}(历史, rev=${view.r1RefundRevision})`;
}

export function classifyEvaluationReportView(view) {
  if (!view || typeof view !== 'object') {
    throw new Error('缺少效果评估页签采集数据');
  }
  const text = String(view.text || '');
  const badges = Array.isArray(view.badges) ? view.badges.map(s => String(s).trim()) : [];
  const rows = Array.isArray(view.rows) ? view.rows : [];
  const joinedBadges = badges.join(' | ');

  const isUnconfigured =
    badges.some(b => /未配置评测集|双轮评测已关闭/.test(b)) ||
    /本次运行没有问答评估结果|未关联评测集|未启用双轮问答评估/.test(text);

  if (isUnconfigured) {
    if (/(?:评测|命中率|覆盖率)[^%\n]{0,16}0%|0%[^%\n]{0,16}(?:评测|命中率)/.test(`${joinedBadges} ${text}`)) {
      // Exact CTX-002 symptom
      throw new Error(`禁用或未配置的评测仍渲染评测命中率 0% (badges=${joinedBadges})`);
    }
    if (badges.some(b => /^(?:双轮评测通过|(?:问答)?评测未通过|问答评估未通过|问答评估已降级|评测降级回退.*)$/.test(b)) || rows.length) {
      throw new Error(`未配置或已关闭评测时误展示了通过/失败状态标签 (${joinedBadges})`);
    }
    return { kind: 'unconfigured', rowCount: 0, badges };
  }

  const isFailed = badges.some(b => b === '评测未通过' || b === '问答评估未通过');
  const isDegraded = badges.some(b => /评测降级回退|^问答评估已降级$/.test(b));
  const isPassed = badges.some(b => b === '双轮评测通过');

  if ((isFailed || isDegraded) && isPassed) {
    throw new Error(`评测失败/降级与「双轮评测通过」同时出现，状态分离失效 (${joinedBadges})`);
  }
  if (isDegraded && !/未通过|降级/.test(text)) {
    throw new Error(`降级回退评测缺少明确未通过说明 (${joinedBadges})`);
  }
  if (!isFailed && !isDegraded && !isPassed) {
    throw new Error(`已启用评测的运行缺少明确总评状态标签（通过 / 未通过 / 降级），当前标签: [${joinedBadges}]`);
  }
  if (rows.length === 0) {
    throw new Error(`效果评估处于「${joinedBadges}」态，但缺少真实逐题评估明细表行`);
  }

  const validVerdict = /^(?:已覆盖通过|通过（已改善）|待改进|本轮退化|执行异常)$/;
  const invalidRow = rows.find(r => !String(r.question || '').trim() || r.question === '—' ||
    !validVerdict.test(String(r.verdict || '').trim()));
  if (invalidRow) {
    throw new Error(`逐题评估表存在空题目或缺失结果列的行: ${JSON.stringify(invalidRow)}`);
  }

  const hasNonPassItem = rows.some(r => /待改进|本轮退化|执行异常/.test(String(r.verdict || '')));
  if (isPassed && hasNonPassItem) {
    throw new Error(`总评显示「双轮评测通过」，但逐题明细存在未通过项 (${rows.map(r => r.verdict).join(', ')})`);
  }

  return {
    kind: isFailed ? 'failed' : isDegraded ? 'degraded' : 'passed',
    rowCount: rows.length,
    badges,
  };
}

export function classifyProposalCitationsView(citations = []) {
  if (!Array.isArray(citations) || citations.length === 0) {
    throw new Error('建议详情「来源依据」为空，缺少可核验的源资料引用卡片');
  }

  for (const cit of citations) {
    const title = String(cit.title || '').trim();
    const kindLabel = String(cit.kindLabel || '').trim();
    const revision = String(cit.revision || '').trim();
    if (!title || !kindLabel) {
      throw new Error(`来源引用卡片缺少标题或类型标签: ${JSON.stringify(cit)}`);
    }
    if (/^(?:数据表|来源|条目|资产|未命名)\s*#\d+$/.test(title)) {
      throw new Error(`来源引用卡片标题退化为合成占位符「${title}」，未展示真实来源名称`);
    }
    const isDocSource =
      /\.(md|pdf|docx?|txt)\b/i.test(title) ||
      /doc-|refund|退款|文档|指南|知识库/i.test(title) ||
      /docx_rev|pdf_rev|^v?\d+$/i.test(revision) ||
      Boolean(cit.hasDocQuote);
    if (isDocSource && /数据表/.test(kindLabel)) {
      // Exact CTX-011 / ENR-05 symptom
      throw new Error(`Markdown/PDF 文档引用「${title}」被误标为「数据表」`);
    }
    if (isDocSource && /当前快照/.test(revision)) {
      throw new Error(`文档引用「${title}」版本退化为「当前快照」，未绑定具体源修订号`);
    }
    const isSessionOrExample = /工作台会话|精选样本/.test(kindLabel);
    if (!isSessionOrExample && !cit.hasAssetLink) {
      // Exact CTX-011 / ENR-05 symptom
      throw new Error(`来源引用「${title}」(${kindLabel}) 引用缺少原资产跳转链接「查看资产 ↗」`);
    }
  }

  return citations.length;
}

export function classifyMcpMetricsDrawerView(drawer) {
  if (!drawer || !drawer.open) {
    throw new Error('点击「查看」后未弹出近 24 小时调用统计抽屉');
  }
  if (drawer.loading) {
    throw new Error('近 24 小时调用统计抽屉持续处于 loading 状态未收敛');
  }
  if (!(drawer.width >= 320 && drawer.height >= 160)) {
    throw new Error(`调用统计抽屉尺寸异常: ${drawer.width}x${drawer.height}`);
  }
  const text = String(drawer.text || '');
  if (/暂时无法获取调用统计|UNAVAILABLE/i.test(text)) {
    // Exact CTX-021 symptom
    throw new Error('24h 调用统计状态为 UNAVAILABLE（抽屉显示「暂时无法获取调用统计。」）');
  }
  if (/当前身份没有查看调用统计的权限/.test(text)) {
    return { status: 'FORBIDDEN', counts: null };
  }
  const metrics = drawer.metrics || {};
  for (const label of ['调用次数', '失败次数', '权限拦截次数']) {
    const val = String(metrics[label] ?? '').trim();
    if (!/^\d+$/.test(val)) {
      throw new Error(`24h 调用统计字段「${label}」不是有效非负整数，实际为「${val || '缺失'}」`);
    }
  }
  const counts = {
    total: Number(metrics['调用次数']),
    errors: Number(metrics['失败次数']),
    denied: Number(metrics['权限拦截次数']),
  };
  if (!Object.values(counts).every(Number.isSafeInteger) ||
      counts.errors > counts.total || counts.denied > counts.total) {
    throw new Error('调用统计异常，失败次数或权限拦截次数超过总调用次数，或存在无效计数');
  }
  return { status: 'READY', counts };
}

export function validateWorkbenchReadyView(state) {
  if (!state || typeof state !== 'object') {
    throw new Error('缺少工作台调试台 DOM 状态数据');
  }
  if (state.hasSpin) {
    throw new Error('工作台调试台仍存在未结束的 Spin loading');
  }
  if (!state.chatTabActive) {
    throw new Error('点击「调试台」后胶囊页签未处于激活态');
  }

  const domBox = state.domainPicker || {};
  if (!domBox.visible || !(domBox.width >= 80 && domBox.height >= 20)) {
    throw new Error(`调试台「业务领域与版本」选择器不可见或尺寸无效 (${domBox.width || 0}x${domBox.height || 0})`);
  }
  if (/加载领域/.test(String(domBox.text || '')) || domBox.disabled) {
    throw new Error(`调试台「业务领域与版本」未就绪或被禁用 (text="${domBox.text || ''}", disabled=${Boolean(domBox.disabled)})`);
  }

  const modelBox = state.modelPicker || {};
  if (!modelBox.visible || !(modelBox.width >= 60 && modelBox.height >= 20)) {
    throw new Error(`调试台「模型」选择器不可见或尺寸无效 (${modelBox.width || 0}x${modelBox.height || 0})`);
  }
  const modelText = String(modelBox.text || '').trim();
  if (!modelText || /加载模型|选择模型/.test(modelText) || modelBox.disabled) {
    throw new Error(`调试台未自动选中可用模型 (text="${modelText || '空'}", disabled=${Boolean(modelBox.disabled)})`);
  }

  const comp = state.composer || {};
  if (!comp.visible || !(comp.width >= 180 && comp.height >= 20)) {
    throw new Error(`调试台问题输入框不可见或尺寸过小 (${comp.width || 0}x${comp.height || 0})`);
  }
  if (comp.disabled) {
    throw new Error(`调试台问题输入框处于禁用态 (${comp.disabledReason || 'disabled'})`);
  }

  return {
    selectedDomain: String(domBox.text || '').trim(),
    selectedModel: modelText,
    composerSize: `${Math.round(comp.width)}x${Math.round(comp.height)}`,
  };
}

// === CDP 真机交互辅助（仅在 spec 运行时调用 page.send / page.evalJSON / page.waitFor） ===

export async function cdpClickPoint(page, x, y) {
  const cx = Math.round(x);
  const cy = Math.round(y);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: cx,
    y: cy,
    button: 'none',
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: cx,
    y: cy,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: cx,
    y: cy,
    button: 'left',
    clickCount: 1,
  });
}

export async function cdpPressKey(page, key, code = key, windowsVirtualKeyCode = 0) {
  const payload = {
    key,
    code,
    ...(windowsVirtualKeyCode ? { windowsVirtualKeyCode, nativeVirtualKeyCode: windowsVirtualKeyCode } : {}),
  };
  await page.send('Input.dispatchKeyEvent', { type: 'keyDown', ...payload });
  await page.send('Input.dispatchKeyEvent', { type: 'keyUp', ...payload });
}

export async function waitForTerminalDom(
  page,
  predicateFn,
  { timeoutMs = 15000, intervalMs = 250, settleMs = 200 } = {}
) {
  const start = Date.now();
  let lastVal = null;
  while (Date.now() - start < timeoutMs) {
    const stepInflightCount =
      page.inflight instanceof Map
        ? [...page.inflight.values()].filter(r => r.step === page.currentStep).length
        : 0;
    lastVal = await page.evalJSON(predicateFn);
    if (lastVal && stepInflightCount === 0) {
      if (settleMs > 0) await page.sleep(settleMs);
      const stillInflight =
        page.inflight instanceof Map
          ? [...page.inflight.values()].filter(r => r.step === page.currentStep).length
          : 0;
      const confirmed = await page.evalJSON(predicateFn);
      if (confirmed && stillInflight === 0) {
        return { ok: true, elapsedMs: Date.now() - start, value: confirmed };
      }
      lastVal = confirmed;
    }
    await page.sleep(intervalMs);
  }
  return { ok: false, elapsedMs: Date.now() - start, value: lastVal };
}

export async function restoreSafeWorkspace(page, cfg, stepName = 'restore-safe-workspace') {
  const loc = await page.evalJSON(() => window.location.href).catch(() => '');
  if (!loc) return;
  try {
    const u = new URL(loc);
    if (
      loc.includes(cfg.forbiddenWorkspaceId) ||
      u.searchParams.get('workspaceId') !== cfg.workspaceId ||
      u.searchParams.get('project') !== cfg.projectName
    ) {
      await page.gotoContext('/context/catalog', { stepName, includeWorkspace: true });
    }
  } catch {
    await page.gotoContext('/context/catalog', { stepName, includeWorkspace: true });
  }
}
