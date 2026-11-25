// 离线旅程观测契约（Observation-Based Validators）与多视图等价归一化校验器。
// 说明：
// 1. 本仓库负责前端与接口回执的验收校验，不伪造后端状态机自测来冒充真实服务端保证。
// 2. 以下纯函数只消费「前后快照（before/after snapshots）+ 扫描/加工回执（receipts）+ 多视图 DOM 采样」，
//    检验跨观测的幂等性与多视图归一化等价关系。
// 3. Codex 接线建议：
//    - validateUnchangedRescanObservation / validateLogicalDocumentUpdateObservation -> 可迁入 lib/catalog-checks.mjs，
//      接入真实 E2E 的 SRC-01（同标识更新）、SRC-04（飞书不变重扫与增量更新）与 SRC-08（TOS 单键白名单重扫）。
//    - validateRepeatedEnrichmentTriggerObservation -> 可迁入 lib/ui-checks.mjs，接入 ENR-06（运行中刷新与重复点击提交）。
//    - validateCrossViewEquivalence / validateDomainReleaseCrossViewEquivalence -> 可接入 specs/02、specs/03、specs/04 与 specs/05。

import {
  VALID_INDEX_LABELS,
  evaluateAssetDetailSettlement,
  evaluateCatalogViewSettlement,
  isValidDisplayTimestamp,
  verifyTreeAndOverviewCounts,
} from '../../lib/catalog-checks.mjs';
import {
  classifyProposalCitationsView,
  validatePublishedVersionComparison,
} from '../../lib/ui-checks.mjs';

const TERMINAL_SCAN_SUCCESS_STATUSES = new Set(['SUCCEEDED', 'COMPLETED', '已完成', '成功']);
const ACTIVE_ENRICHMENT_STATUSES = new Set(['RUNNING', 'QUEUED', 'PENDING', '运行中', '排队中']);
const CONFLICT_REJECTION_CODES = new Set([
  'Conflict',
  'TaskAlreadyRunning',
  'ResourceInUse',
  'DuplicateRequest',
  'IdempotentConflict',
]);

const GROUP_KEY_TO_CATEGORY = {
  knowledge: { label: '知识库', scaleUnit: '篇文档' },
  database: { label: '数据库', scaleUnit: '张表' },
  coderepo: { label: '代码仓', scaleUnit: '个代码仓' },
  app_mcp: { label: '业务应用', scaleUnit: '个应用空间' },
};

const CATEGORY_TO_GROUP_KEY = Object.fromEntries(
  Object.entries(GROUP_KEY_TO_CATEGORY).map(([key, meta]) => [meta.label, key])
);

export function parseRevisionNumber(rawRevision) {
  if (typeof rawRevision === 'number') {
    return Number.isSafeInteger(rawRevision) && rawRevision >= 0 ? rawRevision : null;
  }
  const text = String(rawRevision ?? '').trim();
  if (!text) return null;
  const match = text.match(/^(?:v|rev[-_]?|docx_rev[:_-]?)?(\d+)$/i);
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

export function parseOverviewScaleText(scaleText) {
  const text = String(scaleText ?? '').trim();
  const match = text.match(/^(\d+)\s*(篇文档|张表|个代码仓|个应用空间)$/);
  if (!match) return null;
  return { count: Number(match[1]), unit: match[2] };
}

export function normalizeAssetTypeKind(rawLabel) {
  const text = String(rawLabel ?? '').trim();
  if (text === '文档' || text === '文件集合') return 'document';
  if (text === '数据表') return 'table';
  if (text === '数据库') return 'database';
  if (text === '代码仓') return 'coderepo';
  if (text === '应用字典') return 'app_dict';
  if (text === '指标模型' || text === '业务规则' || text === '来源说明') return 'semantic';
  return null;
}

export function extractPrimaryIndexLabel(rawIndexText) {
  const text = String(rawIndexText ?? '').trim();
  if (!text) return '';
  const contentMatch = text.match(/正文索引[\s\n]*(已就绪|构建中|排队中|索引失败|不适用)/);
  if (contentMatch) return contentMatch[1];
  const fallbackMatch = text.match(/(已就绪|构建中|排队中|索引失败|不适用)/);
  return fallbackMatch ? fallbackMatch[1] : text;
}

export function parseIndexSummaryBanner(bannerText) {
  const text = String(bannerText ?? '').trim();
  if (!text.includes('连接索引汇总：')) return null;
  const extractCount = label => {
    const m = text.match(new RegExp(`${label}\\s*(\\d+)`));
    return m ? Number(m[1]) : 0;
  };
  return {
    ready: extractCount('已就绪'),
    building: extractCount('构建中'),
    queued: extractCount('排队中'),
    failed: extractCount('索引失败'),
  };
}

export function normalizeMinuteTimestamp(rawTs) {
  const check = isValidDisplayTimestamp(rawTs);
  if (!check.valid) return null;
  const m = String(rawTs).trim().match(/\b(20\d{2}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  return m ? `${m[1]} ${m[2]}` : String(rawTs).trim();
}

function isNonNegativeInt(n) {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0;
}

function indexRowsByUniqueKeys(rows, contextLabel) {
  if (!Array.isArray(rows)) {
    return { ok: false, code: 'INVALID_ROWS', reason: `${contextLabel} rows 不是数组` };
  }
  const byLogicalKey = new Map();
  const seenAssetIds = new Set();
  for (const row of rows) {
    const logicalKey = String(row?.logicalKey || row?.uri || row?.name || '').trim();
    const assetId = String(row?.assetId || '').trim();
    if (!logicalKey || !assetId) {
      return {
        ok: false,
        code: 'MISSING_IDENTITY',
        reason: `${contextLabel} 存在缺失 logicalKey 或 assetId 的资产行`,
      };
    }
    if (byLogicalKey.has(logicalKey)) {
      return {
        ok: false,
        code: 'DUPLICATE_LOGICAL_KEY',
        reason: `${contextLabel} 同一逻辑标识「${logicalKey}」出现重复资产行`,
      };
    }
    if (seenAssetIds.has(assetId)) {
      return {
        ok: false,
        code: 'DUPLICATE_ASSET_ID',
        reason: `${contextLabel} 出现重复 assetId=${assetId}`,
      };
    }
    const rev = parseRevisionNumber(row.revision);
    if (rev === null || rev < 1) {
      return {
        ok: false,
        code: 'INVALID_REVISION',
        reason: `${contextLabel} 资产「${logicalKey}」修订号非法 (${row.revision})`,
      };
    }
    byLogicalKey.set(logicalKey, { ...row, logicalKey, assetId, revisionNum: rev });
    seenAssetIds.add(assetId);
  }
  return { ok: true, byLogicalKey };
}

/**
 * 幂等契约 1（SRC-04 / SRC-08）：内容未改动时重扫，回执增改删失败均为 0，不衍生额外行、不推进修订、不混入未选前缀对象。
 */
export function validateUnchangedRescanObservation({
  before,
  after,
  scanReceipt,
  selectedScopeKeys = null,
} = {}) {
  if (!before || !after || !scanReceipt) {
    return { ok: false, code: 'MISSING_OBSERVATION', reason: '缺少重扫前后快照或扫描回执' };
  }

  const status = String(scanReceipt.status || '').trim();
  if (!TERMINAL_SCAN_SUCCESS_STATUSES.has(status)) {
    return {
      ok: false,
      code: 'SCAN_NOT_SETTLED_SUCCESS',
      reason: `扫描回执未收敛为成功终态 (status=${status || '空'})`,
    };
  }

  const tsCheck = isValidDisplayTimestamp(scanReceipt.completedAt ?? scanReceipt.time);
  if (!tsCheck.valid) {
    return {
      ok: false,
      code: 'INVALID_RECEIPT_TIMESTAMP',
      reason: `扫描回执完成时间非法: ${tsCheck.reason}`,
    };
  }

  for (const field of ['addedCount', 'updatedCount', 'deletedCount', 'failedCount']) {
    if (!isNonNegativeInt(scanReceipt[field])) {
      return {
        ok: false,
        code: 'INVALID_RECEIPT_COUNTER',
        reason: `扫描回执计数 ${field} 非法 (${scanReceipt[field]})`,
      };
    }
  }
  if (
    scanReceipt.addedCount !== 0 ||
    scanReceipt.updatedCount !== 0 ||
    scanReceipt.deletedCount !== 0 ||
    scanReceipt.failedCount !== 0
  ) {
    return {
      ok: false,
      code: 'NON_ZERO_RESCAN_DELTA',
      reason: `未改动重扫回执出现非零变更 (+${scanReceipt.addedCount}/~${scanReceipt.updatedCount}/-${scanReceipt.deletedCount}/fail=${scanReceipt.failedCount})`,
    };
  }

  const beforeIndexed = indexRowsByUniqueKeys(before.rows, '重扫前快照');
  if (!beforeIndexed.ok) return beforeIndexed;
  const afterIndexed = indexRowsByUniqueKeys(after.rows, '重扫后快照');
  if (!afterIndexed.ok) return afterIndexed;

  if (selectedScopeKeys) {
    const allowed = new Set(selectedScopeKeys);
    for (const key of afterIndexed.byLogicalKey.keys()) {
      if (!allowed.has(key)) {
        return {
          ok: false,
          code: 'UNSELECTED_SCOPE_INGESTED',
          reason: `未勾选的同前缀对象「${key}」在重扫后被入库`,
        };
      }
    }
  }

  if (beforeIndexed.byLogicalKey.size !== afterIndexed.byLogicalKey.size) {
    return {
      ok: false,
      code: 'ROW_COUNT_DRIFT',
      reason: `未改动重扫前后资产行数不一致 (before=${beforeIndexed.byLogicalKey.size}, after=${afterIndexed.byLogicalKey.size})`,
    };
  }

  const allReadyBefore = [...beforeIndexed.byLogicalKey.values()].every(
    r => !r.indexLabel || r.indexLabel === '已就绪'
  );
  if (
    allReadyBefore &&
    scanReceipt.queuedIndexJobs !== undefined &&
    scanReceipt.queuedIndexJobs !== 0
  ) {
    return {
      ok: false,
      code: 'REDUNDANT_INDEX_ENQUEUE',
      reason: `未改动且索引已就绪的资产重扫后仍重复入队索引任务 (queuedIndexJobs=${scanReceipt.queuedIndexJobs})`,
    };
  }

  for (const [key, prev] of beforeIndexed.byLogicalKey.entries()) {
    const curr = afterIndexed.byLogicalKey.get(key);
    if (!curr) {
      return {
        ok: false,
        code: 'ASSET_MISSING_AFTER_RESCAN',
        reason: `未改动重扫后丢失原有资产「${key}」`,
      };
    }
    if (curr.assetId !== prev.assetId) {
      return {
        ok: false,
        code: 'ASSET_ID_CHURNED',
        reason: `未改动重扫后资产「${key}」的 assetId 被替换 (${prev.assetId} -> ${curr.assetId})`,
      };
    }
    if (curr.revisionNum !== prev.revisionNum) {
      return {
        ok: false,
        code: 'REVISION_CHANGED_ON_NOOP',
        reason: `未改动重扫后资产「${key}」修订号发生漂移 (${prev.revisionNum} -> ${curr.revisionNum})`,
      };
    }
    if (prev.contentHash && curr.contentHash && prev.contentHash !== curr.contentHash) {
      return {
        ok: false,
        code: 'CONTENT_HASH_CHANGED_ON_NOOP',
        reason: `未改动重扫后资产「${key}」内容摘要变化`,
      };
    }
  }

  if (before.overviewScaleText && after.overviewScaleText) {
    const bScale = parseOverviewScaleText(before.overviewScaleText);
    const aScale = parseOverviewScaleText(after.overviewScaleText);
    if (!bScale || !aScale || bScale.count !== aScale.count || aScale.count !== after.rows.length) {
      return {
        ok: false,
        code: 'OVERVIEW_SCALE_MISMATCH',
        reason: `汇总规模文本与真实资产数不一致 (before="${before.overviewScaleText}", after="${after.overviewScaleText}", rows=${after.rows.length})`,
      };
    }
  }

  return { ok: true, assetCount: afterIndexed.byLogicalKey.size };
}

/**
 * 幂等契约 2（SRC-01 / SRC-04 / ENR-02 / REL-04）：同一逻辑文档更新只推进同一份资产（零新增重复行、修订递增、兄弟资产与历史冻结发布不变）。
 */
export function validateLogicalDocumentUpdateObservation({
  before,
  after,
  updateSpec,
  scanReceipt = null,
  priorPublishedReleases = [],
} = {}) {
  if (!before || !after || !updateSpec?.logicalKey) {
    return { ok: false, code: 'MISSING_OBSERVATION', reason: '缺少更新前后快照或目标逻辑文档标识' };
  }

  const beforeIndexed = indexRowsByUniqueKeys(before.rows, '更新前快照');
  if (!beforeIndexed.ok) return beforeIndexed;
  const afterIndexed = indexRowsByUniqueKeys(after.rows, '更新后快照');
  if (!afterIndexed.ok) return afterIndexed;

  const targetKey = String(updateSpec.logicalKey).trim();
  const prevTarget = beforeIndexed.byLogicalKey.get(targetKey);
  if (!prevTarget) {
    return {
      ok: false,
      code: 'TARGET_MISSING_BEFORE_UPDATE',
      reason: `更新前快照不存在目标逻辑文档「${targetKey}」`,
    };
  }

  if (afterIndexed.byLogicalKey.size !== beforeIndexed.byLogicalKey.size) {
    return {
      ok: false,
      code: 'EXTRA_OR_LOST_ROW_ON_UPDATE',
      reason: `同名逻辑文档更新后总行数改变 (before=${beforeIndexed.byLogicalKey.size}, after=${afterIndexed.byLogicalKey.size})`,
    };
  }

  const currTarget = afterIndexed.byLogicalKey.get(targetKey);
  if (!currTarget) {
    return {
      ok: false,
      code: 'TARGET_LOST_AFTER_UPDATE',
      reason: `更新后快照丢失目标逻辑文档「${targetKey}」`,
    };
  }

  if (currTarget.assetId !== prevTarget.assetId) {
    return {
      ok: false,
      code: 'ASSET_ID_REPLACED_ON_UPDATE',
      reason: `逻辑文档「${targetKey}」更新未复用同一资产 ID (${prevTarget.assetId} -> ${currTarget.assetId})`,
    };
  }

  if (!(currTarget.revisionNum > prevTarget.revisionNum)) {
    return {
      ok: false,
      code: 'REVISION_DID_NOT_ADVANCE',
      reason: `逻辑文档「${targetKey}」更新后修订号未递增 (${prevTarget.revisionNum} -> ${currTarget.revisionNum})`,
    };
  }

  if (updateSpec.expectedNextRevision !== undefined) {
    const expectedRev = parseRevisionNumber(updateSpec.expectedNextRevision);
    if (currTarget.revisionNum !== expectedRev) {
      return {
        ok: false,
        code: 'UNEXPECTED_NEXT_REVISION',
        reason: `逻辑文档「${targetKey}」期望修订 ${expectedRev}，实际为 ${currTarget.revisionNum}`,
      };
    }
  }

  if (updateSpec.expectedBodySubstring && !after.detailPreview) {
    return { ok: false, code: 'MISSING_DETAIL_PREVIEW', reason: '缺少更新后的详情预览' };
  }

  if (after.detailPreview) {
    const previewBody = String(after.detailPreview.bodyText || '').trim();
    if (
      updateSpec.expectedBodySubstring &&
      !previewBody.includes(updateSpec.expectedBodySubstring)
    ) {
      return {
        ok: false,
        code: 'STALE_DETAIL_PREVIEW_BODY',
        reason: `更新后详情预览未呈现新正文标识「${updateSpec.expectedBodySubstring}」`,
      };
    }
    if (after.detailPreview.updatedAtText) {
      const ts = isValidDisplayTimestamp(after.detailPreview.updatedAtText);
      if (!ts.valid) {
        return {
          ok: false,
          code: 'INVALID_DETAIL_TIMESTAMP',
          reason: `更新后详情时间非法: ${ts.reason}`,
        };
      }
    }
  }

  for (const [key, prevRow] of beforeIndexed.byLogicalKey.entries()) {
    if (key === targetKey) continue;
    const currRow = afterIndexed.byLogicalKey.get(key);
    if (
      !currRow ||
      currRow.assetId !== prevRow.assetId ||
      currRow.revisionNum !== prevRow.revisionNum ||
      (prevRow.contentHash && currRow.contentHash && prevRow.contentHash !== currRow.contentHash)
    ) {
      return {
        ok: false,
        code: 'COLLATERAL_SIBLING_MUTATION',
        reason: `更新「${targetKey}」时意外篡改了未变更兄弟资产「${key}」`,
      };
    }
  }

  if (scanReceipt) {
    const status = String(scanReceipt.status || '').trim();
    if (!TERMINAL_SCAN_SUCCESS_STATUSES.has(status)) {
      return {
        ok: false,
        code: 'UPDATE_SCAN_NOT_SUCCEEDED',
        reason: `增量刷新回执未处于成功终态 (${status})`,
      };
    }
    if (
      scanReceipt.addedCount !== 0 ||
      scanReceipt.updatedCount !== 1 ||
      scanReceipt.deletedCount !== 0 ||
      (scanReceipt.failedCount ?? 0) !== 0
    ) {
      return {
        ok: false,
        code: 'UPDATE_RECEIPT_DELTA_MISMATCH',
        reason: `单文档更新回执计数应为 +0/~1/-0/fail=0，实际为 +${scanReceipt.addedCount}/~${scanReceipt.updatedCount}/-${scanReceipt.deletedCount}/fail=${scanReceipt.failedCount ?? 0}`,
      };
    }
  }

  for (const rel of priorPublishedReleases) {
    const frozenRev = parseRevisionNumber(rel.frozenRevision);
    const expectedFrozenRev = parseRevisionNumber(rel.expectedFrozenRevision ?? prevTarget.revisionNum);
    if (frozenRev !== expectedFrozenRev) {
      return {
        ok: false,
        code: 'FROZEN_RELEASE_MUTATED',
        reason: `历史已发布版本 ${rel.version || '?'} 的冻结修订被源文档升级污染 (期望=${expectedFrozenRev}, 实际=${frozenRev})`,
      };
    }
  }

  return {
    ok: true,
    assetId: currTarget.assetId,
    previousRevision: prevTarget.revisionNum,
    nextRevision: currTarget.revisionNum,
  };
}

/**
 * 幂等契约 3（ENR-06）：重复点击/触发知识加工与运行中刷新重入不会衍生并发脏任务或回退阶段进度。
 */
export function validateRepeatedEnrichmentTriggerObservation({
  domainId,
  baselineActiveRunId = null,
  triggerAttempts = [],
  runHistoryRows = [],
  reenteredView = null,
} = {}) {
  if (!domainId || !Array.isArray(triggerAttempts) || triggerAttempts.length < 2 ||
      !Array.isArray(runHistoryRows)) {
    return { ok: false, code: 'MISSING_OBSERVATION', reason: '缺少知识加工触发序列或运行记录列表' };
  }

  const domainRuns = runHistoryRows.filter(row => !row.domainId || row.domainId === domainId);
  const seenRunIds = new Set();
  for (const row of domainRuns) {
    if (!row.runId || seenRunIds.has(row.runId)) {
      return {
        ok: false,
        code: 'DUPLICATE_OR_EMPTY_RUN_ROW',
        reason: `加工记录表出现空或重复的 RunId (${row.runId || '空'})`,
      };
    }
    seenRunIds.add(row.runId);
    if (row.createdAt && !isValidDisplayTimestamp(row.createdAt, { allowDash: false }).valid) {
      return {
        ok: false,
        code: 'INVALID_RUN_TIMESTAMP',
        reason: `加工记录 ${row.runId} 时间戳非法 (${row.createdAt})`,
      };
    }
  }

  const activeRuns = domainRuns.filter(row =>
    ACTIVE_ENRICHMENT_STATUSES.has(String(row.status || '').trim())
  );
  if (activeRuns.length > 1) {
    return {
      ok: false,
      code: 'CONCURRENT_DIRTY_RUNS',
      reason: `同一领域 ${domainId} 同时存在 ${activeRuns.length} 个未收敛活动运行: ${activeRuns.map(r => r.runId).join(', ')}`,
    };
  }

  const acceptedRunIds = new Set();
  let networkTriggerCount = 0;

  for (const attempt of triggerAttempts) {
    if (attempt.blockedByDisabledUi) {
      if (attempt.networkSent) {
        return {
          ok: false,
          code: 'DISABLED_UI_LEAKED_REQUEST',
          reason: '按钮已处于防重禁用态但仍向后端发出了触发请求',
        };
      }
      continue;
    }

    if (!attempt.networkSent) continue;
    networkTriggerCount += 1;

    if (attempt.httpStatus === 200 && !attempt.errorCode) {
      if (!attempt.runId) {
        return {
          ok: false,
          code: 'MISSING_RUN_ID_ON_200',
          reason: 'HTTP 200 成功触发回执缺少 RunId',
        };
      }
      acceptedRunIds.add(attempt.runId);
    } else {
      const code = String(attempt.errorCode || '').trim();
      const isCleanConflict =
        (attempt.httpStatus === 409 || attempt.httpStatus === 200) &&
        CONFLICT_REJECTION_CODES.has(code);
      if (!isCleanConflict) {
        return {
          ok: false,
          code: 'UNEXPECTED_TRIGGER_FAILURE',
          reason: `重复触发返回了非预期错误而非幂等合并或明确冲突拒绝 (HTTP=${attempt.httpStatus}, errorCode=${code || '—'})`,
        };
      }
    }
  }

  if (acceptedRunIds.size > 1) {
    return {
      ok: false,
      code: 'MULTIPLE_RUNS_ACCEPTED',
      reason: `重复点击触发创建了多个不同 RunId: ${[...acceptedRunIds].join(', ')}`,
    };
  }

  const canonicalRunId =
    baselineActiveRunId ||
    [...acceptedRunIds][0] ||
    activeRuns[0]?.runId ||
    null;

  if (baselineActiveRunId && acceptedRunIds.size === 1 && !acceptedRunIds.has(baselineActiveRunId)) {
    return {
      ok: false,
      code: 'REPLACED_ACTIVE_RUN',
      reason: `已有运行 ${baselineActiveRunId} 进行中时，重复触发衍生了另一任务 ${[...acceptedRunIds][0]}`,
    };
  }

  if (!canonicalRunId || !seenRunIds.has(canonicalRunId)) {
    return {
      ok: false,
      code: 'RUN_ID_NOT_OBSERVED',
      reason: `加工回执对应的运行未在同一领域的历史中回读 (RunId=${canonicalRunId || '空'})`,
    };
  }

  if (activeRuns.length === 1 && activeRuns[0].runId !== canonicalRunId) {
    return {
      ok: false,
      code: 'ACTIVE_RUN_DRIFTED',
      reason: `活动任务身份发生漂移 (expected=${canonicalRunId}, actual=${activeRuns[0].runId})`,
    };
  }

  if (reenteredView && canonicalRunId) {
    if (reenteredView.runId !== canonicalRunId) {
      return {
        ok: false,
        code: 'REFRESH_LOST_RUN_IDENTITY',
        reason: `运行中刷新/重入后任务身份丢失或串单 (expected=${canonicalRunId}, actual=${reenteredView.runId || '空'})`,
      };
    }
    if (
      typeof reenteredView.completedStageCount === 'number' &&
      typeof reenteredView.beforeRefreshStageCount === 'number' &&
      reenteredView.completedStageCount < reenteredView.beforeRefreshStageCount
    ) {
      return {
        ok: false,
        code: 'STAGE_PROGRESS_REGRESSED',
        reason: `刷新重入后已完成阶段数倒退 (${reenteredView.beforeRefreshStageCount} -> ${reenteredView.completedStageCount})`,
      };
    }
  }

  return { ok: true, canonicalRunId, networkTriggerCount };
}

/**
 * 多视图归一化等价校验（CAT-01 / CAT-07 / CAT-08）：
 * 联合校验目录树计数、单元汇总行、单来源治理列表、慢列表资产行与单资产详情页在计数、类型、索引状态、时间戳及远端 ACL 上的等价性。
 */
export function validateCrossViewEquivalence({
  summarySnapshot,
  sourceSnapshot,
  detailSnapshot,
  targetSourceName,
  targetSourceId,
  targetAssetName,
} = {}) {
  const summaryVerdict = evaluateCatalogViewSettlement(summarySnapshot, { mode: 'all' });
  if (!summaryVerdict.settled || summaryVerdict.status !== 'READY') {
    return {
      ok: false,
      code: 'SUMMARY_NOT_READY',
      reason: `目录汇总视图未就绪: ${summaryVerdict.status} (${summaryVerdict.reason})`,
    };
  }

  const countCheck = verifyTreeAndOverviewCounts(summarySnapshot);
  if (!countCheck.ok) {
    return { ok: false, code: 'TREE_OVERVIEW_COUNT_MISMATCH', reason: countCheck.reason };
  }

  const overviewRows = summarySnapshot.overviewRows || [];
  if (overviewRows.length > summarySnapshot.treeAllCount) {
    return {
      ok: false,
      code: 'OVERVIEW_ROWS_EXCEED_TOTAL',
      reason: `汇总表可见行数 (${overviewRows.length}) 超过目录树总单元数 (${summarySnapshot.treeAllCount})`,
    };
  }

  const groupTallies = { knowledge: 0, coderepo: 0, database: 0, app_mcp: 0 };
  for (const row of overviewRows) {
    const groupKey = CATEGORY_TO_GROUP_KEY[String(row.category || '').trim()];
    if (!groupKey) {
      return {
        ok: false,
        code: 'UNKNOWN_OVERVIEW_CATEGORY',
        reason: `汇总行「${row.name}」类别标签非法 (${row.category})`,
      };
    }
    groupTallies[groupKey] += 1;
    const parsedScale = parseOverviewScaleText(row.scaleText);
    if (!parsedScale || parsedScale.unit !== GROUP_KEY_TO_CATEGORY[groupKey].scaleUnit) {
      return {
        ok: false,
        code: 'CATEGORY_SCALE_UNIT_MISMATCH',
        reason: `汇总行「${row.name}」类别「${row.category}」与规模单位「${row.scaleText}」不匹配`,
      };
    }
  }
  for (const [k, seen] of Object.entries(groupTallies)) {
    if (seen > summarySnapshot.treeGroupCounts[k]) {
      return {
        ok: false,
        code: 'GROUP_ROWS_EXCEED_TREE_GROUP',
        reason: `分组 ${k} 汇总行数 (${seen}) 超过左侧树分组计数 (${summarySnapshot.treeGroupCounts[k]})`,
      };
    }
  }

  const overviewTarget = overviewRows.find(r => String(r.name || '').trim() === targetSourceName);
  if (!overviewTarget) {
    return {
      ok: false,
      code: 'TARGET_SOURCE_MISSING_IN_OVERVIEW',
      reason: `汇总表中未找到目标来源「${targetSourceName}」`,
    };
  }
  const targetScale = parseOverviewScaleText(overviewTarget.scaleText);

  const sourceVerdict = evaluateCatalogViewSettlement(sourceSnapshot, {
    mode: 'source',
    expectedSourceId: targetSourceId,
    expectedSourceName: targetSourceName,
  });
  if (!sourceVerdict.settled || (sourceVerdict.status !== 'READY' && sourceVerdict.status !== 'EMPTY')) {
    return {
      ok: false,
      code: 'SOURCE_VIEW_NOT_SETTLED',
      reason: `专用来源视图未就绪: ${sourceVerdict.status} (${sourceVerdict.reason})`,
    };
  }

  const unitRows = sourceSnapshot.unitRows || [];
  if (unitRows.length !== targetScale.count) {
    return {
      ok: false,
      code: 'OVERVIEW_TO_UNIT_ROW_COUNT_MISMATCH',
      reason: `来源「${targetSourceName}」汇总显示「${overviewTarget.scaleText}」，但专用来源列表实际为 ${unitRows.length} 行`,
    };
  }

  if (sourceSnapshot.indexSummaryBanner) {
    const banner = parseIndexSummaryBanner(sourceSnapshot.indexSummaryBanner);
    if (!banner) {
      return {
        ok: false,
        code: 'INVALID_INDEX_BANNER',
        reason: `连接索引汇总横幅格式非法: ${sourceSnapshot.indexSummaryBanner}`,
      };
    }
    const rowCounts = { ready: 0, building: 0, queued: 0, failed: 0 };
    for (const uRow of unitRows) {
      const primary = extractPrimaryIndexLabel(uRow.indexText);
      if (!VALID_INDEX_LABELS.has(primary)) {
        return {
          ok: false,
          code: 'INVALID_UNIT_INDEX_BADGE',
          reason: `来源行「${uRow.name}」索引状态非法 (${uRow.indexText})`,
        };
      }
      if (primary === '已就绪') rowCounts.ready += 1;
      else if (primary === '构建中') rowCounts.building += 1;
      else if (primary === '排队中') rowCounts.queued += 1;
      else if (primary === '索引失败') rowCounts.failed += 1;
    }
    if (
      banner.ready !== rowCounts.ready ||
      banner.building !== rowCounts.building ||
      banner.queued !== rowCounts.queued ||
      banner.failed !== rowCounts.failed
    ) {
      return {
        ok: false,
        code: 'INDEX_BANNER_ROW_MISMATCH',
        reason: `连接索引汇总横幅 (${JSON.stringify(banner)}) 与来源列表行统计 (${JSON.stringify(rowCounts)}) 不一致`,
      };
    }
  }

  const unitTarget = unitRows.find(r => String(r.name || '').trim() === targetAssetName);
  const listTarget = (summarySnapshot.assetRows || []).find(
    r => String(r.name || '').trim() === targetAssetName
  );
  if (!unitTarget || !listTarget) {
    return {
      ok: false,
      code: 'TARGET_ASSET_MISSING_IN_LISTS',
      reason: `目标资产「${targetAssetName}」在来源列表或全局慢列表中缺失`,
    };
  }

  if (String(listTarget.sourceText || '').trim() !== targetSourceName) {
    return {
      ok: false,
      code: 'ASSET_SOURCE_ATTRIBUTION_MISMATCH',
      reason: `慢列表资产「${targetAssetName}」来源归属为「${listTarget.sourceText}」，期望「${targetSourceName}」`,
    };
  }

  const detailVerdict = evaluateAssetDetailSettlement(detailSnapshot);
  if (!detailVerdict.settled || detailVerdict.status === 'ERROR' || detailVerdict.status === 'NOT_FOUND') {
    return {
      ok: false,
      code: 'DETAIL_NOT_READY',
      reason: `单资产详情未收敛为有效终态: ${detailVerdict.status} (${detailVerdict.reason})`,
    };
  }

  if (String(detailSnapshot.headerTitle || '').trim() !== targetAssetName) {
    return {
      ok: false,
      code: 'DETAIL_TITLE_MISMATCH',
      reason: `详情页标题「${detailSnapshot.headerTitle}」与列表资产名「${targetAssetName}」不一致`,
    };
  }

  const listKind = normalizeAssetTypeKind(listTarget.typeLabel);
  const detailKind = normalizeAssetTypeKind(detailSnapshot.assetTypeTag);
  if (!listKind || !detailKind || listKind !== detailKind) {
    return {
      ok: false,
      code: 'LIST_DETAIL_TYPE_MISMATCH',
      reason: `列表资产类型「${listTarget.typeLabel}」(${listKind}) 与详情类型标签「${detailSnapshot.assetTypeTag}」(${detailKind}) 归一化后不一致`,
    };
  }

  const listTs = normalizeMinuteTimestamp(listTarget.updatedAt);
  const detailTs = normalizeMinuteTimestamp(detailSnapshot.updatedAtText);
  if (!listTs || !detailTs || listTs !== detailTs) {
    return {
      ok: false,
      code: 'LIST_DETAIL_TIMESTAMP_MISMATCH',
      reason: `列表更新时间「${listTarget.updatedAt}」与详情更新时间「${detailSnapshot.updatedAtText}」不一致或含非法时间`,
    };
  }

  const unitIndex = extractPrimaryIndexLabel(unitTarget.indexText);
  const detailIndex = String(detailSnapshot.contentIndexLabel || '').trim();
  if (
    !VALID_INDEX_LABELS.has(unitIndex) ||
    !VALID_INDEX_LABELS.has(detailIndex) ||
    unitIndex !== detailIndex
  ) {
    return {
      ok: false,
      code: 'UNIT_DETAIL_INDEX_MISMATCH',
      reason: `单来源列表索引徽标「${unitIndex}」与详情正文索引「${detailIndex}」不一致`,
    };
  }

  const unitRequiresAcl = /受限|无权限|协作者权限|远端权限控制/.test(
    String(unitTarget.aclWatermarkText || '')
  );
  const unitAclDisabled = /未开启|公开|不适用/.test(String(unitTarget.aclWatermarkText || ''));
  const detailAclDenied = detailVerdict.status === 'READY_ACL_DENIED';

  if (detailAclDenied && unitAclDisabled) {
    return {
      ok: false,
      code: 'ACL_UNEXPECTED_DENIAL',
      reason: `来源列表标注远端权限未开启 (${unitTarget.aclWatermarkText})，但详情却进入 READY_ACL_DENIED`,
    };
  }
  if (
    unitRequiresAcl &&
    unitTarget.viewerAuthorized === false &&
    !detailAclDenied
  ) {
    return {
      ok: false,
      code: 'ACL_DENIAL_NOT_ENFORCED_IN_DETAIL',
      reason: `当前身份对资产「${targetAssetName}」无远端 ACL 权限，但详情返回 ${detailVerdict.status}`,
    };
  }

  return {
    ok: true,
    normalizedKind: listKind,
    indexLabel: detailIndex,
    detailStatus: detailVerdict.status,
  };
}

/**
 * 领域版本、冻结范围抽屉、加工建议引用与 MCP 服务列表的跨视图版本/修订等价校验（REL-04 / CTX-011 / CTX-014 / USE-01）。
 */
export function validateDomainReleaseCrossViewEquivalence({
  comparisonView,
  comparisonFixture,
  proposalCitations,
  mcpRow,
} = {}) {
  try {
    validatePublishedVersionComparison(comparisonView, comparisonFixture);
    classifyProposalCitationsView(proposalCitations);
  } catch (error) {
    return { ok: false, code: 'BASE_VALIDATOR_REJECTED', reason: error.message };
  }

  const expectedActiveVersion = comparisonFixture.r2.version;
  const expectedFrozenRev = parseRevisionNumber(comparisonFixture.r2.frozenRevision);

  if (mcpRow) {
    if (String(mcpRow.version || '').trim() !== expectedActiveVersion) {
      return {
        ok: false,
        code: 'MCP_VERSION_DRIFT',
        reason: `MCP 服务行版本 (${mcpRow.version}) 与当前发布版本 (${expectedActiveVersion}) 不一致`,
      };
    }
  }

  for (const cit of proposalCitations) {
    if (cit.matchesTargetAsset) {
      const citRev = parseRevisionNumber(cit.revision);
      if (citRev !== expectedFrozenRev) {
        return {
          ok: false,
          code: 'CITATION_REVISION_DRIFT',
          reason: `建议引用「${cit.title}」修订 (${cit.revision}) 与 R2 冻结修订 (${expectedFrozenRev}) 不一致`,
        };
      }
    }
  }

  return { ok: true, activeVersion: expectedActiveVersion, frozenRevision: expectedFrozenRev };
}
