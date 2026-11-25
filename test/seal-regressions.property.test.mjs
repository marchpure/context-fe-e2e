import test from 'node:test';
import assert from 'node:assert/strict';
import {
  assertCatalogReadBudget, assertFrozenRowsUnchanged, assertMergedReview, assertPinnedCitation,
  assertScanRow, assertScopedRoute, assertViewerDenial,
} from '../lib/regression-checks.mjs';
import { assertProperty } from './support/propHarness.mjs';

const cfg = {
  consoleBaseUrl: 'https://console.volcengine.com/agentkit-stg/v2',
  workspaceId: 'ws-test',
  projectName: '项目 + & /',
  forbiddenWorkspaceId: 'ws-forbidden',
};

function href(path, params = {}) {
  const url = new URL(cfg.consoleBaseUrl + path);
  for (const [key, value] of Object.entries({ workspaceId: cfg.workspaceId, project: cfg.projectName, ...params })) {
    url.searchParams.set(key, value);
  }
  return url;
}

test('CAT-01/02 性能门禁覆盖每次目录读请求、边界值、挂起与业务错误', () => {
  assertProperty({
    name: '用户终态 ≤5000ms，全部目录请求 ≤1500ms',
    seed: 0x112502, runs: 180, file: 'test/seal-regressions.property.test.mjs',
    generate: (rng, i) => ({
      uiMs: i % 2 ? rng.int(4990, 5010) : 5000,
      readMs: rng.int(1490, 1510),
      fault: rng.pick(['none', 'none', 'pending', 'business', 'missing-id', 'missing-read', 'http']),
    }),
  }, ({ uiMs, readMs, fault }) => {
    const prefix = { action: 'ListContextEntries', httpStatus: 200, durationMs: readMs, requestId: 'req-1' };
    const last = { ...prefix, requestId: 'req-2', durationMs: 1111 };
    const oracle = { href: href('/context/catalog').href, records: [prefix, last], pendingApis: [] };
    if (fault === 'pending') oracle.pendingApis.push({ action: 'ListContextEntries' });
    if (fault === 'business') prefix.errorCode = 'TIMEOUT';
    if (fault === 'missing-id') prefix.requestId = '';
    if (fault === 'missing-read') oracle.records = [];
    if (fault === 'http') prefix.httpStatus = 403;
    if (fault === 'none' && uiMs <= 5000 && readMs <= 1500) {
      assert.match(assertCatalogReadBudget(oracle, cfg, uiMs), /req-1.*req-2/);
    } else {
      assert.throws(() => assertCatalogReadBudget(oracle, cfg, uiMs));
    }
  });
  const request = { action: 'ListContextEntries', httpStatus: 200, durationMs: 1500, requestId: 'req-limit' };
  assert.equal(assertCatalogReadBudget({ href: href('/context/catalog').href, records: [request] }, cfg, 5000), '1500ms/req-limit');
});

test('NAV-03 所属领域编辑 URL 和返回目标保留特殊字符项目，拒绝重复、缺失或跨域', () => {
  assertProperty({
    name: '工作区和项目往返，拒绝污染的路由参数',
    seed: 0x112503, runs: 160, file: 'test/seal-regressions.property.test.mjs',
    generate: rng => ({
      id: rng.slug('knowledge'),
      edit: rng.pick(['none', 'duplicate', 'forbidden', 'context-workspace', 'project-alias', 'no-project', 'other-origin']),
    }),
  }, ({ id, edit }) => {
    const suffix = '/context/domains/dom-test/detail';
    const url = href(suffix, { tab: 'knowledge', editKnowledge: id });
    if (edit === 'duplicate') url.searchParams.append('workspaceId', cfg.workspaceId);
    if (edit === 'forbidden') url.searchParams.set('workspaceId', cfg.forbiddenWorkspaceId);
    if (edit === 'context-workspace') url.searchParams.set('contextWorkspaceId', cfg.forbiddenWorkspaceId);
    if (edit === 'project-alias') url.searchParams.set('ProjectName', 'other-project');
    if (edit === 'no-project') url.searchParams.delete('project');
    if (edit === 'other-origin') url.hostname = 'another.example';
    const check = () => assertScopedRoute(url.href, cfg, suffix, { tab: 'knowledge', editKnowledge: id });
    if (edit === 'none') assert.equal(check().searchParams.get('project'), cfg.projectName);
    else assert.throws(check);
  });
});

test('USE-03/07 冻结引文不能串版本、串正文或回到另一个会话', () => {
  assertProperty({
    name: 'R1 / R2 引文和返回路径同时锁定',
    seed: 0x112507, runs: 160, file: 'test/seal-regressions.property.test.mjs',
    generate: rng => ({
      version: rng.int(1, 2), sessionId: rng.slug('wbs'),
      fault: rng.pick(['none', 'body', 'citation', 'session', 'release', 'workspace', 'answer', 'mixed-answer', 'mixed-return']),
    }),
  }, ({ version, sessionId, fault }) => {
    const days = version === 1 ? 7 : 15;
    const other = version === 1 ? 15 : 7;
    const pin = { entryId: 'r-entry', domainId: 'dom-demo', releaseId: 'rel-' + version, sessionId, version, days };
    const chat = href('/context/workbench', { tab: 'chat', sessionId });
    const url = href('/context/catalog/r-entry/detail', { domainId: pin.domainId, releaseId: pin.releaseId, returnTo: chat.href });
    const back = new URL(chat);
    if (fault === 'session') back.searchParams.set('sessionId', 'wbs-other');
    if (fault === 'release') url.searchParams.set('releaseId', 'rel-other');
    if (fault === 'workspace') url.searchParams.delete('workspaceId');
    const observation = {
      answer: '退款时效为 ' + (fault === 'answer' ? other : days) + ' 天' +
        (fault === 'mixed-answer' ? ` 或 ${other} 天` : ''),
      source: '退款时效 v' + (fault === 'citation' ? 3 - version : version),
      detail: '原文退款时效为 ' + (fault === 'body' ? other : days) + ' 天',
      href: url.href, returned: { href: back.href, answer: '退款时效为 ' + days + ' 天' +
        (fault === 'mixed-return' ? ` 或 ${other} 天` : '') },
    };
    const check = () => assertPinnedCitation(observation, cfg, pin);
    if (fault === 'none') assert.doesNotThrow(check);
    else assert.throws(check);
  });
});

test('SRC-07 随机表数回执只读、恢复无重复，发布清单前中后等价', () => {
  assertProperty({
    name: '刷新与恢复不得改变资产或冻结清单',
    seed: 0x11250702, runs: 160, file: 'test/seal-regressions.property.test.mjs',
    generate: rng => ({
      total: rng.int(2, 150), rowId: rng.slug('asset'),
      fault: rng.pick(['none', 'added', 'removed', 'queued', 'frozen-during', 'frozen-after', 'empty']),
    }),
  }, ({ total, rowId, fault }) => {
    const n = total - 1;
    const scan = 'RefreshMetadata 成功 发现对象 ' + n + ' · 新增资产 ' + Number(fault === 'added') +
      ' · 更新 0 · 未变更 ' + n + ' · 移除 ' + Number(fault === 'removed') +
      ' · 正文索引入队 ' + Number(fault === 'queued') + ' · 投影索引入队 0';
    const restore = 'AddObjects 成功 发现对象 1 · 新增资产 0 · 更新 0 · 未变更 1 · 移除 0 · 正文索引入队 0 · 投影索引入队 0';
    const baseline = fault === 'empty' ? [] : [rowId + '/v1'];
    const during = fault === 'frozen-during' ? [rowId + '/v2'] : [...baseline];
    const after = fault === 'frozen-after' ? [rowId + '/v2'] : [...baseline];
    const check = () => {
      assertScanRow(scan, 'RefreshMetadata', { discovered: n, unchanged: n });
      assertScanRow(restore, 'AddObjects', { discovered: 1, unchanged: 1 });
      assertFrozenRowsUnchanged(baseline, during, after);
    };
    if (fault === 'none') assert.doesNotThrow(check);
    else assert.throws(check);
  });
  assert.throws(() => assertScanRow('AddObjects 成功 发现对象 1 · 新增资产 1', 'AddObjects', { discovered: 1, unchanged: 1 }));
});

test('AUTH-02/USE-06 拒绝必须同时证明策略拦截、实际 403 和正文不可见', () => {
  assertProperty({
    name: 'Viewer DENY 生效且无泄漏',
    seed: 0x11250206, runs: 160, file: 'test/seal-regressions.property.test.mjs',
    generate: rng => ({
      fixture: { documentEntryId: rng.slug('document'), derivedEntryId: rng.slug('derived') },
      protectedMarker: rng.slug('synthetic-protected'),
      fault: rng.pick(['none', 'wrong-simulation', 'wrong-asset', 'wrong-status', 'wrong-code', 'leak']),
    }),
  }, ({ fixture, protectedMarker, fault }) => {
    const decision = fault === 'wrong-simulation' ? 'ALLOWED' : 'DOCUMENT_FILTERED';
    const reason = fault === 'wrong-asset' ? 'other' : fixture.documentEntryId;
    const simulation = [decision, reason, 'POLICY_DENY', fixture.derivedEntryId, 'DERIVED_FROM_DENIED_DOCUMENT'].join(' ');
    const tool = (fault === 'wrong-status' ? 'HTTP 200 ' : 'HTTP 403 ') +
      (fault === 'wrong-code' ? 'SQL_COLUMN_FORBIDDEN' : 'DOCUMENT_ACCESS_FORBIDDEN');
    const visible = fault === 'leak' ? protectedMarker : '当前身份无权读取';
    const check = () => assertViewerDenial({ simulation, tool, visible, protectedMarker }, fixture);
    if (fault === 'none') assert.doesNotThrow(check);
    else assert.throws(check);
  });
});


test('REL-02 新增建议只能走合并，业务成功且重开读到合并正文', () => {
  assertProperty({
    name: 'CREATE 冲突保留草稿文字并落盘本次合并',
    seed: 0x11250202, runs: 150, file: 'test/seal-regressions.property.test.mjs',
    generate: rng => ({
      marker: rng.slug('synthetic-merge'),
      fault: rng.pick(['none', 'direct-open', 'empty-draft', 'write-error', 'missing-marker', 'editable']),
    }),
  }, ({ marker, fault }) => {
    const check = () => assertMergedReview({
      directDisabled: fault !== 'direct-open',
      currentDraft: fault === 'empty-draft' ? ' ' : '当前草稿。',
      submitted: { httpStatus: 200, requestId: 'req-review', errorCode: fault === 'write-error' ? 'CONFLICT' : '' },
      reopened: (fault === 'editable' ? '待处理 ' : '已采纳只读快照 ') + (fault === 'missing-marker' ? '旧正文' : marker),
      marker,
    });
    if (fault === 'none') assert.doesNotThrow(check);
    else assert.throws(check);
  });
});
