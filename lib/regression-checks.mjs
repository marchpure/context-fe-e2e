import { validateStepTerminalState } from './ui-checks.mjs';

export function assertCatalogReadBudget(oracle, cfg, elapsedMs) {
  validateStepTerminalState(oracle, cfg, {
    stepLabel: '所有资产',
    requiredActions: ['ListContextEntries'],
  });
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0 || elapsedMs > 5000) {
    throw new Error(`所有资产可操作终态耗时 ${elapsedMs}ms，红线 5000ms`);
  }
  const reads = oracle.records.filter(record => record.action === 'ListContextEntries');
  for (const record of reads) {
    const { durationMs, requestId, httpStatus, errorCode } = record;
    if (!requestId || httpStatus !== 200 || errorCode ||
        !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 1500) {
      throw new Error(`ListContextEntries HTTP=${httpStatus} code=${errorCode || '—'} ${durationMs}ms，红线 1500ms，RequestId=${requestId || '缺失'}`);
    }
  }
  return reads.map(({ durationMs, requestId }) => `${durationMs}ms/${requestId}`).join(', ');
}

export function assertScopedRoute(href, cfg, suffix, query = {}) {
  const url = new URL(href, cfg.consoleBaseUrl);
  if (url.origin !== new URL(cfg.consoleBaseUrl).origin || !url.pathname.endsWith(suffix)) {
    throw new Error('导航未进入同一控制台的预期详情');
  }
  for (const [key, value] of Object.entries({
    ...query, workspaceId: cfg.workspaceId, project: cfg.projectName,
  })) {
    const values = url.searchParams.getAll(key);
    if (values.length !== 1 || values[0] !== value ||
        (key === 'workspaceId' && value === cfg.forbiddenWorkspaceId)) {
      throw new Error(`导航参数 ${key} 缺失、重复或与预期不符`);
    }
  }
  for (const [key, value] of [['contextWorkspaceId', cfg.workspaceId], ['WorkspaceId', cfg.workspaceId],
    ['workspace_id', cfg.workspaceId], ['ProjectName', cfg.projectName], ['project_name', cfg.projectName],
    ['projectName', cfg.projectName]]) {
    if (url.searchParams.getAll(key).some(actual => actual !== value)) {
      throw new Error(`导航参数 ${key} 与预期范围不符`);
    }
  }
  return url;
}

export function assertPinnedCitation({ answer, source, inlinePreview, detail, href, returned }, cfg, fixture) {
  const { version, days, entryId, domainId, releaseId, sessionId } = fixture;
  const expected = new RegExp(`(?<![0-9])${days}\\s*天`);
  const opposite = /(?<![0-9])(?:7|15)\s*天/g;
  const matchesRevision = text => typeof text === 'string' && expected.test(text) &&
    [...text.matchAll(opposite)].every(match => expected.test(match[0]));
  if (!matchesRevision(answer) || !matchesRevision(detail)) {
    throw new Error('回答与打开的原文修订不一致');
  }
  if (inlinePreview !== undefined && !matchesRevision(inlinePreview)) {
    throw new Error('点击消息内引文卡片打开的侧栏预览未固定到本轮发布修订');
  }
  if (!new RegExp(`(?:\\bv|修订\\s*|Revision\\s*)${version}(?!\\d)`, 'i').test(source)) {
    throw new Error('引文卡片未固定到预期源修订');
  }
  const detailUrl = assertScopedRoute(href, cfg, `/context/catalog/${entryId}/detail`, { domainId, releaseId });
  const returnTo = detailUrl.searchParams.get('returnTo');
  if (!returnTo) throw new Error('引文详情缺少工作台返回目标');
  const returnUrl = assertScopedRoute(returnTo, cfg, '/context/workbench', { tab: 'chat', sessionId });
  const messageId = returnUrl.searchParams.get('resumeMessage');
  if (!messageId || returnUrl.searchParams.getAll('resumeMessage').length !== 1) {
    throw new Error('引文详情未固定原回答');
  }
  assertScopedRoute(returned.href, cfg, '/context/workbench', { tab: 'chat', sessionId, resumeMessage: messageId });
  const normalize = text => text.replace(/\s+/g, ' ').trim();
  if (!matchesRevision(returned.answer) || normalize(answer) !== normalize(returned.answer)) {
    throw new Error('返回后未恢复原会话的同一回答');
  }
}

export function assertScanRow(text, kind, { discovered, added = 0, unchanged }) {
  for (const [label, value] of Object.entries({
    发现对象: discovered, 新增资产: added, 更新: 0, 未变更: unchanged,
    移除: 0, 正文索引入队: 0, 投影索引入队: 0,
  })) {
    const match = text.match(new RegExp(`(?:^|[\\s·])${label}\\s*(\\d+)`));
    if (match?.[1] !== String(value)) throw new Error(`${kind} 的 ${label} 没有回读到 ${value}`);
  }
  if (!text.includes(kind) || !text.includes('成功')) throw new Error(`${kind} 未到成功终态`);
}

export function assertFrozenRowsUnchanged(before, during, after) {
  if (!before.length || before.length !== during.length || before.length !== after.length ||
      before.some((row, i) => row !== during[i] || row !== after[i])) {
    throw new Error('PG 范围变更影响了已发布快照，或缺少真实冻结条目');
  }
}

export function assertViewerDenial({ simulation, tool, visible, protectedMarker }, fixture) {
  const words = simulation.split(/\s+/);
  const reasonFor = (id, reason) => id && words.some((word, index) => word === id && words[index + 1] === reason);
  if (!simulation.includes('DOCUMENT_FILTERED') ||
      !reasonFor(fixture.documentEntryId, 'POLICY_DENY') ||
      !reasonFor(fixture.derivedEntryId, 'DERIVED_FROM_DENIED_DOCUMENT')) {
    throw new Error('Viewer 模拟未显示原文标签 DENY 和派生拒绝');
  }
  if (!/(?:^|\D)403\s*(?:[:：·-]\s*)?DOCUMENT_ACCESS_FORBIDDEN\b/.test(tool)) {
    throw new Error('工作台工具未显示 HTTP 403 DOCUMENT_ACCESS_FORBIDDEN');
  }
  if (!protectedMarker || visible.includes(protectedMarker)) {
    throw new Error('缺少正文负对照标识，或受限正文已显示');
  }
}

export function assertMergedReview({ directDisabled, currentDraft, submitted, reopened, marker }) {
  if (!directDisabled || !currentDraft.trim() || !marker ||
      submitted.httpStatus !== 200 || submitted.errorCode || !submitted.requestId ||
      !reopened.includes('只读快照') || !reopened.includes(marker)) {
    throw new Error('CREATE 冲突合并未通过直接覆盖保护、提交或持久正文回读');
  }
}

export const UNIFIED_ONLINE_SOURCES = {
  database: {
    key: 'database',
    label: '数据库',
    labelPattern: /数据库/,
    step2Markers: [/PostgreSQL/, /MySQL/],
  },
  knowledge: {
    key: 'knowledge',
    label: '引用已有知识库',
    labelPattern: /引用已有知识库/,
    step2Markers: [/知识库/],
  },
  viking_kb: {
    key: 'viking_kb',
    label: '外部 OpenViking',
    labelPattern: /OpenViking/,
    step2Markers: [/服务地址/, /集合名称|CollectionName/],
  },
  feishu: {
    key: 'feishu',
    label: '飞书',
    labelPattern: /飞书/,
    step2Markers: [
      /飞书.*(?:链接|空间|节点|Wiki|文档)|SpaceId|RootNodeToken/,
      /检测并加载目录树|检查授权|OAuth/,
    ],
    requireEnabledActionPattern: /检测并加载目录树|检查授权|前往飞书 OAuth 授权/,
  },
  tos: {
    key: 'tos',
    label: '火山 TOS',
    labelPattern: /(?:火山\s*)?TOS/,
    step2Markers: [/Bucket|存储桶/],
  },
  coderepo: {
    key: 'coderepo',
    label: '代码仓',
    labelPattern: /代码仓/,
    step2Markers: [/Git\s*仓库地址|RepoUrl/],
  },
};

export function assertUnifiedOnlineSourceStep1({ text = '', options = [], selectedLabel = null, nextDisabled = false }) {
  const normalizedOptions = options
    .filter(opt => opt && opt.visible !== false && !opt.disabled)
    .map(opt => String(opt.label || '').trim())
    .filter(Boolean);
  const haystack = `${text}\n${normalizedOptions.join('\n')}`;

  if (/(?:^|\s)业务应用(?:\s|$)|Meego|风神|Aeolus/i.test(haystack)) {
    throw new Error('新建连接向导仍暴露 Meego / 风神入口卡片');
  }

  const missing = [];
  for (const spec of Object.values(UNIFIED_ONLINE_SOURCES)) {
    const matched = normalizedOptions.length
      ? normalizedOptions.some(label => spec.labelPattern.test(label))
      : spec.labelPattern.test(text);
    if (!matched) missing.push(spec.label);
  }
  if (missing.length > 0) {
    throw new Error(`接入在线来源第 1 步缺少可用数据源入口：${missing.join('、')}`);
  }

  if (selectedLabel !== null) {
    if (!String(selectedLabel).trim()) {
      throw new Error('接入在线来源第 1 步未保留当前选中的数据源');
    }
    if (nextDisabled) {
      throw new Error(`已选中「${selectedLabel}」，但「下一步」按钮仍处于禁用态`);
    }
  }
  return Object.keys(UNIFIED_ONLINE_SOURCES);
}

export function assertOnlineSourceStep2Form(
  sourceKey,
  { href, text = '', controls = [], step1Remounted = false },
  cfg
) {
  const spec = UNIFIED_ONLINE_SOURCES[sourceKey];
  if (!spec) throw new Error(`未知的在线数据源类型：${sourceKey}`);

  const url = assertScopedRoute(href, cfg, '/context/catalog');
  if (url.searchParams.get('connect') === '1') {
    throw new Error('从接入在线来源进入配置时发生了 ?connect=1 旧弹窗重定向（禁止二次跳转重选数据源）');
  }

  if (
    step1Remounted ||
    /选择受控资产单元类别/.test(text) ||
    Object.values(UNIFIED_ONLINE_SOURCES).every(item => item.labelPattern.test(text) && !/上一步/.test(text))
  ) {
    throw new Error(`选择「${spec.label}」点击下一步后未进入配置表单，回退或重挂载到了数据源选择第 1 步`);
  }

  if (
    /暂无法通过链接校验单篇飞书文档|接入飞书\s*Wiki\s*空间/.test(text) &&
    controls.some(ctrl => /检查授权/.test(ctrl.label || '') && ctrl.disabled)
  ) {
    throw new Error(
      '飞书接入进入死胡同占位页（暂无法通过链接校验单篇飞书文档 / 检查授权与下一步禁用），未直达可操作的飞书授权与配置表单'
    );
  }
  if (/暂无法通过链接校验单篇飞书文档/.test(text)) {
    throw new Error('飞书接入仍渲染「暂无法通过链接校验单篇飞书文档」死胡同占位提示，未直达飞书配置表单');
  }

  for (const marker of spec.step2Markers) {
    if (!marker.test(text)) {
      throw new Error(`「${spec.label}」第 2 步配置表单缺少预期字段或说明：${marker}`);
    }
  }

  const enabledInputs = controls.filter(ctrl => ctrl.kind === 'input' && !ctrl.disabled);
  if (enabledInputs.length === 0) {
    throw new Error(`「${spec.label}」第 2 步配置表单没有任何可交互输入控件`);
  }

  if (spec.requireEnabledActionPattern) {
    const matchingActions = controls.filter(
      ctrl => ctrl.kind === 'button' && spec.requireEnabledActionPattern.test(ctrl.label || '')
    );
    if (matchingActions.length === 0 || matchingActions.every(ctrl => ctrl.disabled)) {
      throw new Error(`「${spec.label}」第 2 步缺少可点击的授权/探测按钮（处于缺失或禁用死锁态）`);
    }
  }
  return url;
}

export function assertOnlineSourceBackRoundTrip(
  sourceKey,
  { href, text = '', options = [], selectedLabel = '', nextDisabled = false },
  cfg
) {
  const spec = UNIFIED_ONLINE_SOURCES[sourceKey];
  if (!spec) throw new Error(`未知的在线数据源类型：${sourceKey}`);

  const url = assertScopedRoute(href, cfg, '/context/catalog');
  if (url.searchParams.get('connect') === '1') {
    throw new Error('点击上一步返回时被切换到了 ?connect=1 旧弹窗');
  }

  assertUnifiedOnlineSourceStep1({ text, options, selectedLabel, nextDisabled });
  if (!spec.labelPattern.test(selectedLabel)) {
    throw new Error(
      `从「${spec.label}」配置点击上一步返回后选中项丢失或被重置为「${selectedLabel || '空'}」`
    );
  }
  return selectedLabel;
}

export function assertLegacyDatabaseRedirectView(
  { detailHref, text = '', hasErrorAlert = false, tableCount = 0, backHref = '' },
  cfg,
  { connectionId, expectedTable }
) {
  const detailUrl = new URL(detailHref, cfg.consoleBaseUrl);
  if (!/\/context\/catalog\/[^/]+\/detail$/.test(detailUrl.pathname)) {
    throw new Error(`未成功重定向至数据库资产详情: href=${detailHref}`);
  }
  assertScopedRoute(detailHref, cfg, detailUrl.pathname.slice(detailUrl.pathname.indexOf('/context/catalog/')), {
    connectionId,
  });
  if (hasErrorAlert || /无法加载已接入数据表/.test(text)) {
    throw new Error(`数据库旧连接重定向后数据表列表加载失败 (${detailHref})`);
  }
  if (tableCount <= 0 || /暂无已接入数据表|暂无数据/.test(text) || (expectedTable && !text.includes(expectedTable))) {
    throw new Error(
      `数据库旧连接重定向虽保留 connectionId=${connectionId}，但未渲染原连接下的预期数据表「${expectedTable || ''}」(tableCount=${tableCount})`
    );
  }
  if (backHref) {
    assertScopedRoute(backHref, cfg, '/context/catalog');
  }
  return detailUrl;
}

export function assertReportCitationRoundTrip(
  { detailHref, returnedHref, reportReady = false, domainId, taskId },
  cfg
) {
  const detailUrl = new URL(detailHref, cfg.consoleBaseUrl);
  if (!/\/context\/catalog\/[^/]+\/detail$/.test(detailUrl.pathname)) {
    throw new Error(`点击「查看资产 ↗」未进入资产详情路由: ${detailHref}`);
  }
  assertScopedRoute(detailHref, cfg, detailUrl.pathname.slice(detailUrl.pathname.indexOf('/context/catalog/')));
  const returnTo = detailUrl.searchParams.get('returnTo');
  if (!returnTo) {
    throw new Error('从加工报告建议打开资产详情时缺少 returnTo 参数，无法返回原报告');
  }
  const reportSuffix = `/context/domains/${encodeURIComponent(domainId)}/processing`;
  assertScopedRoute(returnTo, cfg, reportSuffix, { taskId });
  assertScopedRoute(returnedHref, cfg, reportSuffix, { taskId });
  if (!reportReady) {
    throw new Error(`从资产详情返回后未恢复原运行报告视图 (taskId=${taskId}, href=${returnedHref})`);
  }
  return true;
}

export function assertSourceObjectsStateSeparation({
  loading = false,
  entriesFailed = false,
  hasErrorAlert = false,
  hasRetryButton = false,
  showsEmptyState = false,
  objectCount = 0,
}) {
  if (loading && showsEmptyState) {
    throw new Error('列表或来源对象加载期间过早渲染了空态（在途请求未完成不得闪现空态）');
  }
  if (entriesFailed) {
    if (showsEmptyState || !hasErrorAlert || !hasRetryButton) {
      throw new Error('来源条目读取失败时误展示为空态或缺少可重试错误提示');
    }
    return 'ERROR_RETRYABLE';
  }
  if (hasErrorAlert) {
    throw new Error('来源条目正常返回时误展示了错误提示');
  }
  if (objectCount > 0 && showsEmptyState) {
    throw new Error('存在已接入对象时误渲染了空态');
  }
  return objectCount > 0 ? 'NON_EMPTY' : 'EMPTY';
}

export function assertRunningPublishNotice({
  hasActiveRun = false,
  modalText = '',
  cancelledStaysOnDomain = true,
}) {
  if (!cancelledStaysOnDomain) {
    throw new Error('发布确认取消后离开了当前业务领域详情页');
  }
  if (hasActiveRun) {
    if (
      !/正在运行的加工任务|运行中的加工/.test(modalText) ||
      !/当前草稿/.test(modalText) ||
      !/不包含/.test(modalText)
    ) {
      throw new Error('领域存在运行中的加工任务时，发布弹窗未明确提示本次采用当前草稿且不包含未完成/未采纳结果');
    }
  }
  return true;
}

export function assertCancelledRunTerminal({
  headerStatus = '',
  rowStatus = '',
  proposalCount = 0,
  duplicateTriggerDisabled = true,
}) {
  if (!duplicateTriggerDisabled) {
    throw new Error('同一加工流水线运行期间未禁用重复触发入口');
  }
  if (!/已取消/.test(headerStatus) || !/已取消/.test(rowStatus)) {
    throw new Error(`取消加工运行后报告头(${headerStatus})与记录行(${rowStatus})未一致收敛为「已取消」`);
  }
  if (proposalCount !== 0) {
    throw new Error(`已取消的加工运行不应产出待审建议，实际产出 ${proposalCount} 条`);
  }
  return true;
}
