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

export function assertPinnedCitation({ answer, source, detail, href, returned }, cfg, fixture) {
  const { version, days, entryId, domainId, releaseId, sessionId } = fixture;
  const expected = new RegExp(`(?<![0-9])${days}\\s*天`);
  const opposite = /(?<![0-9])(?:7|15)\s*天/g;
  const matchesRevision = text => typeof text === 'string' && expected.test(text) &&
    [...text.matchAll(opposite)].every(match => expected.test(match[0]));
  if (!matchesRevision(answer) || !matchesRevision(detail)) {
    throw new Error('回答与打开的原文修订不一致');
  }
  if (!new RegExp(`(?:\\bv|修订\\s*|Revision\\s*)${version}(?!\\d)`, 'i').test(source)) {
    throw new Error('引文卡片未固定到预期源修订');
  }
  const detailUrl = assertScopedRoute(href, cfg, `/context/catalog/${entryId}/detail`, { domainId, releaseId });
  const returnTo = detailUrl.searchParams.get('returnTo');
  if (!returnTo) throw new Error('引文详情缺少工作台返回目标');
  assertScopedRoute(returnTo, cfg, '/context/workbench', { tab: 'chat', sessionId });
  assertScopedRoute(returned.href, cfg, '/context/workbench', { tab: 'chat', sessionId });
  if (!matchesRevision(returned.answer)) throw new Error('返回后未恢复原会话回答');
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
