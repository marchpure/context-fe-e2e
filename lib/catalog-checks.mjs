// 资产目录（02）与资产详情/血缘（03）纯判定函数库与只读 CDP 交互辅助。
// 设计目标：
// 1. 严禁因看到页面标题、导航文字、任意按钮、请求已发出或接口未返回就误判 READY。
// 2. 只要树/主内容区/表格/抽屉存在任何可见 Spinner、骨架屏、详情占位块，或仍有在途 Context API 请求，一律返回 LOADING（settled=false）。
// 3. 严格区分 LOADING / TRANSITIONING / BLANK_UNSETTLED（未完成）与 ERROR / NOT_FOUND / EMPTY / READY*（已收敛终态）。
// 4. 全程只读零副作用：内置写接口熔断守卫，严禁触发任何 Create/Update/Delete/Publish/Scan 写操作。

import { findWriteActions } from './ui-checks.mjs';

export const CATALOG_ALL_UNITS_LABEL = '所有资产';
export const CATALOG_SEARCH_RESET_LABEL = '所有资产';
export const ACL_DENIED_ALERT_SUBSTRING = '当前身份暂无权限预览该资产原文';
export const VALID_INDEX_LABELS = new Set(['已就绪', '构建中', '排队中', '索引失败', '不适用']);

export const FORBIDDEN_FIXTURE_PREFIX = /^(?:p0-wave3-|p0-stageE-)/i;
export const OWN_FIXTURE_PREFIX = /^codex-e2e-/i;
export const READONLY_FALLBACK_PREFIX = /^codex-ui-/i;

export const KNOWN_FIXED_FIXTURES = [
  {
    name: 'codex-e2e-local-kb-1125',
    category: 'knowledge',
    expectedScale: '2 篇文档',
    expectedRowCount: 2,
  },
  {
    name: 'codex-e2e-pg-1125',
    category: 'database',
    expectedScale: '2 张表',
    expectedRowCount: 2,
    expectedObjects: ['adk_sessions', 'adk_events'],
  },
  {
    name: 'codex-e2e-bitable-1125',
    category: 'knowledge',
    expectedScale: '1 篇文档',
    expectedRowCount: 1,
  },
];

const PREFERRED_OWN_FIXTURE_NAMES = [
  'codex-e2e-local-kb-1125',
  'codex-e2e-r4-kb-1125',
  'codex-e2e-pg-1125',
  'codex-e2e-r4-wiki-1125',
  'codex-e2e-bitable-1125',
  'codex-e2e-r4-tos-selected',
];

/**
 * 校验页面展示时间戳：拒绝 1970-01-01 零值时间、Invalid Date、NaN 等脏格式。
 */
export function isValidDisplayTimestamp(rawText, { allowDash = false } = {}) {
  const text = String(rawText ?? '').trim();
  if (!text) {
    return { valid: false, reason: '时间文本为空' };
  }
  if (/1970-01-01/.test(text)) {
    return { valid: false, is1970: true, reason: `出现 1970-01-01 零值时间戳 (${text})` };
  }
  if (/Invalid Date|NaN|undefined|null/i.test(text)) {
    return { valid: false, reason: `出现非法时间格式 (${text})` };
  }
  if (text === '—' || text === '-') {
    return allowDash
      ? { valid: true, isDash: true }
      : { valid: false, reason: '时间字段展示为空占位符 —' };
  }
  if (!/\b20\d{2}-\d{2}-\d{2}(?:\s+\d{2}:\d{2}(?::\d{2})?)?\b/.test(text)) {
    return { valid: false, reason: `时间格式不符合 YYYY-MM-DD (${text})` };
  }
  return { valid: true };
}

/**
 * 从当前可见来源列表中挑选安全的专用测试来源（优先 OWN codex-e2e-*，严禁触碰 p0-wave3-* / p0-stageE-*）。
 */
export function pickDedicatedSourceFixture(connections = []) {
  const safeList = (Array.isArray(connections) ? connections : []).filter(item => {
    const name = String(item?.name || item?.Name || '').trim();
    return Boolean(name) && !FORBIDDEN_FIXTURE_PREFIX.test(name);
  });

  const ownList = safeList.filter(item =>
    OWN_FIXTURE_PREFIX.test(String(item?.name || item?.Name || '').trim())
  );

  if (ownList.length > 0) {
    for (const preferred of PREFERRED_OWN_FIXTURE_NAMES) {
      const hit = ownList.find(
        item => String(item?.name || item?.Name || '').trim() === preferred
      );
      if (hit) {
        return { fixture: hit, tier: 'own' };
      }
    }
    const withPositiveScale = ownList.find(item => {
      const scale = String(item?.scaleText || '').trim();
      const m = scale.match(/^(\d+)\s*(?:篇文档|张表|个代码仓|个应用空间)$/);
      return Boolean(m && Number(m[1]) > 0);
    });
    return { fixture: withPositiveScale || ownList[0], tier: 'own' };
  }

  const fallback = safeList.find(item =>
    READONLY_FALLBACK_PREFIX.test(String(item?.name || item?.Name || '').trim())
  );
  if (fallback) {
    return { fixture: fallback, tier: 'readonly_fallback' };
  }

  return { fixture: null, tier: 'none' };
}

/**
 * 核对左侧目录树分组计数与主区「全部单元 (N)」汇总徽标一致性。
 */
export function verifyTreeAndOverviewCounts(snapshot) {
  if (!Number.isSafeInteger(snapshot?.treeAllCount) || snapshot.treeAllCount < 0) {
    return { ok: false, reason: '左侧目录树未渲染所有资产单元计数 (tree-count-all)' };
  }
  const groups = snapshot.treeGroupCounts || {};
  const groupKeys = ['knowledge', 'coderepo', 'database', 'app_mcp'];
  for (const key of groupKeys) {
    if (!Number.isSafeInteger(groups[key]) || groups[key] < 0) {
      return { ok: false, reason: `左侧目录树分组 ${key} 计数缺失或非法 (${groups[key]})` };
    }
  }
  const sum = groupKeys.reduce((acc, k) => acc + groups[k], 0);
  if (sum !== snapshot.treeAllCount) {
    return {
      ok: false,
      reason: `左侧目录树分组计数之和 (${sum}) 与所有资产单元总数 (${snapshot.treeAllCount}) 不一致`,
    };
  }
  if (
    snapshot.overviewTotalBadge != null &&
    snapshot.overviewTotalBadge !== snapshot.treeAllCount
  ) {
    return {
      ok: false,
      reason: `主内容区「全部单元 (${snapshot.overviewTotalBadge})」与左侧树总数 (${snapshot.treeAllCount}) 不一致`,
    };
  }
  if (snapshot.overviewRows?.length > snapshot.treeAllCount) {
    return { ok: false, reason: '汇总表实际行数超过目录树总数' };
  }
  return {
    ok: true,
    total: snapshot.treeAllCount,
    groups: { ...groups },
  };
}

/**
 * 校验已知固定来源在「所有资产单元」汇总表中的规模文本。
 */
export function evaluateFixedFixtureRow(overviewRows = [], fixtureSpec) {
  const rows = Array.isArray(overviewRows) ? overviewRows : [];
  const row = rows.find(item => String(item?.name || '').trim() === fixtureSpec.name);
  if (!row) {
    return { found: false, ok: false, reason: `未找到固定来源 ${fixtureSpec.name}` };
  }
  const scaleText = String(row.scaleText || '').trim();
  if (!scaleText || scaleText === '—') {
    return {
      found: true,
      ok: false,
      row,
      reason: `${fixtureSpec.name} 资产规模显示为未知占位符「${scaleText || '空'}」`,
    };
  }
  if (fixtureSpec.expectedScale && scaleText !== fixtureSpec.expectedScale) {
    return {
      found: true,
      ok: false,
      row,
      reason: `${fixtureSpec.name} 应显示「${fixtureSpec.expectedScale}」，实际「${scaleText}」`,
    };
  }
  return { found: true, ok: true, row };
}

/**
 * 资产目录（/context/catalog）慢列表与视图切换完成态纯判定函数。
 */
export function evaluateCatalogViewSettlement(snapshot, expected = {}) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { settled: false, status: 'LOADING', reason: 'DOM 快照为空' };
  }

  const pathname = String(snapshot.pathname || '');
  if (!/\/context\/catalog\/?$/.test(pathname)) {
    return {
      settled: false,
      status: 'WRONG_ROUTE',
      reason: `当前路径不在 /context/catalog (${pathname || '空'})`,
    };
  }

  const pendingApiCount = Number(snapshot.pendingApiCount || 0);
  if (snapshot.treeSpinning || snapshot.mainSpinning || snapshot.hasSkeleton || pendingApiCount > 0) {
    const reasons = [];
    if (snapshot.treeSpinning) reasons.push('左侧目录树 Spinner 加载中');
    if (snapshot.mainSpinning) reasons.push('主内容区/表格 Spinner 加载中');
    if (snapshot.hasSkeleton) reasons.push('骨架屏仍在场');
    if (pendingApiCount > 0) {
      const actions =
        Array.isArray(snapshot.pendingActions) && snapshot.pendingActions.length > 0
          ? snapshot.pendingActions.join(',')
          : `${pendingApiCount} 个请求`;
      reasons.push(`接口尚未返回 (${actions})`);
    }
    return {
      settled: false,
      status: 'LOADING',
      reason: reasons.join('；'),
    };
  }

  const mode = expected.mode || 'all';
  const params = new URLSearchParams(String(snapshot.search || ''));
  const urlSource = (params.get('source') || '').trim();
  const urlQuery = (params.get('q') || '').trim();
  const urlName = (params.get('name') || '').trim();
  const urlAssetType = (params.get('assetType') || '').trim();
  const urlFolder = (params.get('folder') || '').trim();
  const headerTitle = String(snapshot.headerTitle || '').trim();
  const selectedTreeTitle = String(snapshot.selectedTreeTitle || '').trim();

  if (snapshot.treeFailedText) {
    return {
      settled: true,
      status: 'ERROR',
      errorKind: 'TREE_LOAD_ERROR',
      reason: String(snapshot.treeFailedText).trim(),
    };
  }

  if (mode === 'all') {
    if (urlSource || urlQuery || urlFolder) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `URL 仍携带筛选参数 (source=${urlSource || '—'}, q=${urlQuery || '—'}, folder=${urlFolder || '—'})`,
      };
    }
    if (expected.expectedNameFilter !== undefined && urlName !== expected.expectedNameFilter.trim()) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `URL name 参数尚未同步为「${expected.expectedNameFilter}」(实际「${urlName}」)`,
      };
    }
    if (expected.expectedAssetType !== undefined && urlAssetType !== expected.expectedAssetType) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `URL assetType 参数尚未同步为「${expected.expectedAssetType}」(实际「${urlAssetType}」)`,
      };
    }
    if (headerTitle !== CATALOG_ALL_UNITS_LABEL) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `主内容区标题尚未切换为「${CATALOG_ALL_UNITS_LABEL}」(当前「${headerTitle || '空'}」)`,
      };
    }
    if (!selectedTreeTitle.startsWith(CATALOG_ALL_UNITS_LABEL)) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `左侧目录树选中项尚未切换为「${CATALOG_ALL_UNITS_LABEL}」(当前「${selectedTreeTitle || '空'}」)`,
      };
    }
    if (snapshot.unitGovernanceTabsVisible) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: '专用来源治理页签尚未卸载',
      };
    }
  } else if (mode === 'source') {
    if (!urlSource) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: 'URL 尚未写入 source 参数',
      };
    }
    if (expected.expectedSourceId && urlSource !== expected.expectedSourceId) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `URL source 尚未切换到 ${expected.expectedSourceId} (当前 ${urlSource})`,
      };
    }
    if (snapshot.sourceMissingWarn) {
      return {
        settled: true,
        status: 'ERROR',
        errorKind: 'SOURCE_NOT_FOUND_OR_FORBIDDEN',
        reason: String(snapshot.sourceMissingWarn).trim(),
      };
    }
    if (expected.expectedSourceName && headerTitle !== expected.expectedSourceName) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `主区标题尚未切换为来源「${expected.expectedSourceName}」(当前「${headerTitle || '空'}」)`,
      };
    }
    if (
      expected.expectedSourceName &&
      selectedTreeTitle &&
      !selectedTreeTitle.includes(expected.expectedSourceName)
    ) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `左侧树选中项尚未切换为「${expected.expectedSourceName}」(当前「${selectedTreeTitle}」)`,
      };
    }
  } else if (mode === 'search') {
    const expectedQuery = String(expected.expectedQuery ?? '').trim();
    if (expected.expectedQuery !== undefined && (
      expectedQuery ? urlQuery !== expectedQuery && urlName !== expectedQuery : Boolean(urlQuery || urlName)
    )) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `检索参数尚未同步为「${expectedQuery}」(q=${urlQuery || '—'}, name=${urlName || '—'})`,
      };
    }
    if (urlQuery && headerTitle !== (snapshot.dataDirectory ? '匹配结果' : '检索结果') &&
        !(snapshot.dataDirectory && (snapshot.assetTableEmptyText || snapshot.mainErrorTexts?.length))) {
      return {
        settled: false,
        status: 'TRANSITIONING',
        reason: `全文检索页头尚未切换为「检索结果」(当前「${headerTitle || '空'}」)`,
      };
    }
  }

  const mainErrors = Array.isArray(snapshot.mainErrorTexts)
    ? snapshot.mainErrorTexts.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (mainErrors.length > 0) {
    return {
      settled: true,
      status: 'ERROR',
      errorKind: 'MAIN_ALERT_ERROR',
      reason: mainErrors.join('；'),
    };
  }
  if (snapshot.sourceMissingWarn) {
    return {
      settled: true,
      status: 'ERROR',
      errorKind: 'SOURCE_NOT_FOUND_OR_FORBIDDEN',
      reason: String(snapshot.sourceMissingWarn).trim(),
    };
  }

  const overviewRows = Array.isArray(snapshot.overviewRows) ? snapshot.overviewRows : [];
  const assetRows = Array.isArray(snapshot.assetRows) ? snapshot.assetRows : [];
  const unitRows = Array.isArray(snapshot.unitRows) ? snapshot.unitRows : [];
  const treeEmptyText = String(snapshot.treeEmptyText || '').trim();
  const overviewEmptyText = String(snapshot.overviewEmptyText || '').trim();
  const assetTableEmptyText = String(snapshot.assetTableEmptyText || '').trim();
  const unitEmptyText = String(snapshot.unitEmptyText || '').trim();

  if (mode === 'all') {
    if (typeof snapshot.treeAllCount !== 'number' || Number.isNaN(snapshot.treeAllCount)) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '左侧目录树计数尚未渲染完成',
      };
    }

    if (snapshot.treeAllCount === 0) {
      if (!treeEmptyText && !assetTableEmptyText) {
        return {
          settled: false,
          status: 'BLANK_UNSETTLED',
          reason: '0 来源下尚未渲染明确空态文案',
        };
      }
      return {
        settled: true,
        status: 'EMPTY',
        emptyKind: 'WORKSPACE_NO_SOURCES',
        reason: treeEmptyText || assetTableEmptyText,
        overviewRowCount: 0,
        assetRowCount: 0,
      };
    }

    const hasSubFilter = Boolean(urlName || urlAssetType || params.get('domain'));
    if (!hasSubFilter && !snapshot.dataDirectory) {
      if (!snapshot.hasOverviewTable) {
        return {
          settled: false,
          status: 'BLANK_UNSETTLED',
          reason: '存在已接入来源但「资产单元汇总」表格尚未挂载',
        };
      }
      if (overviewRows.length === 0 && !overviewEmptyText) {
        return {
          settled: false,
          status: 'BLANK_UNSETTLED',
          reason: '「资产单元汇总」既无数据行也无空态说明',
        };
      }
    }

    if (!snapshot.hasAssetTable) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '慢列表 AssetTable 尚未挂载',
      };
    }
    if (assetRows.length === 0 && !assetTableEmptyText) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '慢列表 AssetTable 既无数据行也无明确空态说明（防止请求未触发前误判就绪）',
      };
    }

    if (assetRows.length === 0 && assetTableEmptyText) {
      return {
        settled: true,
        status: hasSubFilter || snapshot.dataDirectory ? 'EMPTY' : 'READY_OVERVIEW_ONLY',
        emptyKind: hasSubFilter ? 'FILTER_NO_MATCH' : 'SOURCES_WITHOUT_ENTRIES',
        reason: assetTableEmptyText,
        overviewRowCount: overviewRows.length,
        assetRowCount: 0,
      };
    }

    return {
      settled: true,
      status: 'READY',
      overviewRowCount: overviewRows.length,
      assetRowCount: assetRows.length,
      reason: `资产列表 ${assetRows.length} 行`,
    };
  }

  if (mode === 'source') {
    if (snapshot.isExternalVikingPanel || snapshot.isStaticUnitSummaryPanel) {
      return {
        settled: true,
        status: 'READY',
        unitRowCount: unitRows.length,
        isStaticPanel: true,
        reason: '外部集合/静态单元治理面板已就绪',
      };
    }
    if (!snapshot.hasUnitTable) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '专用来源治理表格尚未挂载',
      };
    }
    if (unitRows.length === 0 && !unitEmptyText) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '专用来源治理表格既无数据行也无空态说明',
      };
    }
    if (unitRows.length === 0 && unitEmptyText) {
      return {
        settled: true,
        status: 'EMPTY',
        emptyKind: 'SOURCE_NO_ASSETS',
        unitRowCount: 0,
        reason: unitEmptyText,
      };
    }
    return {
      settled: true,
      status: 'READY',
      unitRowCount: unitRows.length,
      reason: `专用来源已渲染 ${unitRows.length} 行`,
    };
  }

  if (!snapshot.hasAssetTable) {
    return {
      settled: false,
      status: 'BLANK_UNSETTLED',
      reason: '检索态资产表格尚未挂载',
    };
  }
  if (assetRows.length === 0 && !assetTableEmptyText) {
    return {
      settled: false,
      status: 'BLANK_UNSETTLED',
      reason: '检索结果既无数据行也无明确无匹配空态',
    };
  }
  if (assetRows.length === 0 && assetTableEmptyText) {
    return {
      settled: true,
      status: 'EMPTY',
      emptyKind: 'SEARCH_NO_MATCH',
      assetRowCount: 0,
      reason: assetTableEmptyText,
    };
  }
  return {
    settled: true,
    status: 'READY',
    assetRowCount: assetRows.length,
    reason: `检索命中 ${assetRows.length} 行`,
  };
}

/**
 * 单资产详情页（/context/catalog/:Id/detail）完成态纯判定函数。
 */
export function evaluateAssetDetailSettlement(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { settled: false, status: 'LOADING', reason: '详情快照为空' };
  }
  const pathname = String(snapshot.pathname || '');
  if (!/\/context\/catalog\/[^/?#]+\/detail\/?$/.test(pathname)) {
    return {
      settled: false,
      status: 'WRONG_ROUTE',
      reason: `当前路径不在资产详情页 (${pathname || '空'})`,
    };
  }

  const pendingApiCount = Number(snapshot.pendingApiCount || 0);
  if (
    snapshot.detailSpinning ||
    snapshot.previewSpinning ||
    snapshot.hasPendingPlaceholder ||
    snapshot.hasSkeleton ||
    pendingApiCount > 0
  ) {
    const reasons = [];
    if (snapshot.detailSpinning) reasons.push('详情主体 Spinner 加载中');
    if (snapshot.previewSpinning) reasons.push('内容预览 Spinner 加载中');
    if (snapshot.hasPendingPlaceholder) reasons.push('详情内容区仍处于 pending 占位');
    if (snapshot.hasSkeleton) reasons.push('骨架屏仍在场');
    if (pendingApiCount > 0) reasons.push(`仍有 ${pendingApiCount} 个接口未返回`);
    return {
      settled: false,
      status: 'LOADING',
      reason: reasons.join('；'),
    };
  }

  if (snapshot.notFoundText) {
    return {
      settled: true,
      status: 'NOT_FOUND',
      reason: String(snapshot.notFoundText).trim(),
    };
  }

  const headerTitle = String(snapshot.headerTitle || '').trim();
  if (!headerTitle || headerTitle === '—') {
    return {
      settled: false,
      status: 'BLANK_UNSETTLED',
      reason: '资产详情页头标题仍为占位符「—」',
    };
  }

  const errorAlerts = Array.isArray(snapshot.errorAlerts)
    ? snapshot.errorAlerts.map(s => String(s || '').trim()).filter(Boolean)
    : [];
  if (errorAlerts.length > 0) {
    return {
      settled: true,
      status: 'ERROR',
      reason: errorAlerts.join('；'),
    };
  }

  const aclDeniedAlert = String(snapshot.aclDeniedAlert || '').trim();
  const markdownText = String(snapshot.markdownText || '').trim();
  const snippetCount = Number(snapshot.snippetCount || 0);
  const fieldRowCount = Number(snapshot.fieldRowCount || 0);
  const emptyPreviewText = String(snapshot.emptyPreviewText || '').trim();
  const assetTypeTag = String(snapshot.assetTypeTag || '').trim();

  if (aclDeniedAlert) {
    if (markdownText || snippetCount > 0 || String(snapshot.snippetSample || '').trim() || fieldRowCount > 0) {
      return {
        settled: true,
        status: 'ERROR',
        reason: 'ACL_DENIED 受限状态下仍渲染了正文内容（疑似权限泄露）',
      };
    }
    return {
      settled: true,
      status: 'READY_ACL_DENIED',
      reason: aclDeniedAlert,
    };
  }

  if (assetTypeTag === '数据表') {
    if (snapshot.hasMarkdownSection) {
      return {
        settled: true,
        status: 'ERROR',
        reason: '数据表资产不应渲染「文档正文」区块',
      };
    }
    if (fieldRowCount <= 0) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '数据表资产「字段」表格尚未渲染列定义',
      };
    }
    return {
      settled: true,
      status: 'READY_TABLE',
      fieldRowCount,
      reason: `数据表详情已就绪（字段 ${fieldRowCount} 行）`,
    };
  }

  if (assetTypeTag === '数据库') {
    if (!snapshot.hasDatabaseOverview) {
      return {
        settled: false,
        status: 'BLANK_UNSETTLED',
        reason: '数据库资产概览尚未渲染',
      };
    }
    return {
      settled: true,
      status: 'READY_DATABASE',
      reason: '数据库资产详情已就绪',
    };
  }

  if (markdownText || snippetCount > 0 || snapshot.hasSemanticContent) {
    return {
      settled: true,
      status: 'READY_CONTENT',
      snippetCount,
      markdownLength: markdownText.length,
      reason: markdownText
        ? `文档正文已渲染 (${markdownText.length} 字符)`
        : snippetCount > 0
          ? `内容片段已渲染 (${snippetCount} 段)`
          : '语义定义已渲染',
    };
  }

  if (emptyPreviewText) {
    return {
      settled: true,
      status: 'READY_EMPTY_CONTENT',
      reason: emptyPreviewText,
    };
  }

  return {
    settled: false,
    status: 'BLANK_UNSETTLED',
    reason: '详情页既无正文/片段/字段，也无明确权限提示或空预览说明',
  };
}

/**
 * 资产详情「数据血缘」页签完成态纯判定函数（守护 CTX-017）。
 */
export function evaluateLineageSettlement(snapshot, stepRecords = []) {
  if (!snapshot || typeof snapshot !== 'object') {
    return { settled: false, status: 'LOADING', reason: '血缘快照为空' };
  }
  const pendingApiCount = Number(snapshot.pendingApiCount || 0);
  if (snapshot.lineageSpinning || pendingApiCount > 0) {
    return {
      settled: false,
      status: 'LOADING',
      reason: snapshot.lineageSpinning
        ? '数据血缘 Spinner 加载中'
        : `仍有 ${pendingApiCount} 个血缘请求未返回`,
    };
  }

  const records = Array.isArray(stepRecords) ? stepRecords : [];
  const bindingErrRec = records.find(
    r => r.httpStatus === 409 || /\bBindingRequired\b/i.test(String(r.errorCode || ''))
  );
  const visibleText = String(snapshot.visibleText || '');
  const uiHasBindingErr = /BindingRequired|Recreate the domain binding/i.test(visibleText);
  const uiHasLoadError = /血缘加载失败/.test(visibleText);

  if (bindingErrRec || uiHasBindingErr) {
    return {
      settled: true,
      status: 'ERROR',
      isBindingRequired: true,
      httpStatus: bindingErrRec?.httpStatus ?? null,
      requestId: bindingErrRec?.requestId || null,
      errorCode: bindingErrRec?.errorCode || 'BindingRequired',
      reason: `资产血缘加载失败: HTTP=${bindingErrRec?.httpStatus || 'UI报错'}, RequestId=${bindingErrRec?.requestId || '—'}, 错误码=${bindingErrRec?.errorCode || 'BindingRequired'}`,
    };
  }

  const otherFailedRec = records.find(
    r =>
      (r.action === 'ListContextEntryLinks' || r.action === 'GetContextEntry') &&
      (r.errorCode || (typeof r.httpStatus === 'number' && r.httpStatus >= 400))
  );
  if (uiHasLoadError || otherFailedRec) {
    return {
      settled: true,
      status: 'ERROR',
      isBindingRequired: false,
      httpStatus: otherFailedRec?.httpStatus ?? null,
      requestId: otherFailedRec?.requestId || null,
      errorCode: otherFailedRec?.errorCode || 'LINEAGE_LOAD_FAILED',
      reason: `资产血缘加载失败: HTTP=${otherFailedRec?.httpStatus || 'UI报错'}, RequestId=${otherFailedRec?.requestId || '—'}, 错误码=${otherFailedRec?.errorCode || '血缘加载失败'}`,
    };
  }

  const summaryMatch = String(snapshot.hintText || visibleText).match(
    /(\d+)\s*个节点\s*·\s*(\d+)\s*条关系/
  );
  const nodeCardCount = Number(snapshot.nodeCardCount || 0);
  if (!summaryMatch || nodeCardCount < 1) {
    return {
      settled: false,
      status: 'BLANK_UNSETTLED',
      reason: '数据血缘尚未渲染「N 个节点 · M 条关系」摘要或当前对象卡片',
    };
  }

  return {
    settled: true,
    status: 'READY',
    nodeCount: Number(summaryMatch[1]),
    edgeCount: Number(summaryMatch[2]),
    nodeCardCount,
    reason: `${summaryMatch[1]} 个节点 · ${summaryMatch[2]} 条关系 (卡片=${nodeCardCount})`,
  };
}

/**
 * 来源「处理记录」抽屉（SourceHistory）完成态纯判定函数。
 */
export function evaluateSourceHistorySettlement(snapshot) {
  if (!snapshot || typeof snapshot !== 'object' || !snapshot.drawerOpen) {
    return { settled: false, status: 'CLOSED', reason: '处理记录抽屉尚未打开' };
  }
  const pendingApiCount = Number(snapshot.pendingApiCount || 0);
  if (snapshot.tableSpinning || pendingApiCount > 0) {
    return {
      settled: false,
      status: 'LOADING',
      reason: snapshot.tableSpinning
        ? '处理记录表格 Spinner 加载中'
        : `仍有 ${pendingApiCount} 个接口未返回`,
    };
  }

  const errorAlertText = String(snapshot.errorAlertText || '').trim();
  const emptyText = String(snapshot.emptyText || '').trim();
  if (errorAlertText || emptyText === '处理记录暂不可用') {
    return {
      settled: true,
      status: 'ERROR',
      reason: errorAlertText || emptyText,
    };
  }

  const rows = Array.isArray(snapshot.rows) ? snapshot.rows : [];
  if (rows.length === 0) {
    if (emptyText === '暂无处理记录') {
      return {
        settled: true,
        status: 'EMPTY',
        rowCount: 0,
        reason: emptyText,
      };
    }
    return {
      settled: false,
      status: 'BLANK_UNSETTLED',
      reason: '处理记录表格既无数据行也无「暂无处理记录」空态',
    };
  }

  for (const row of rows) {
    const tsCheck = isValidDisplayTimestamp(row.time, { allowDash: true });
    if (!tsCheck.valid) {
      return {
        settled: true,
        status: 'ERROR',
        reason: `处理记录「${row.name || '未知任务'}」开始时间异常: ${tsCheck.reason}`,
      };
    }
  }

  return {
    settled: true,
    status: 'READY',
    rowCount: rows.length,
    rows,
    reason: `处理记录已加载 ${rows.length} 条`,
  };
}

// ============================================================================
// 只读 CDP 真实鼠标点击、DOM 快照采集与稳定收敛等待辅助（仅依赖传入的 page 实例）
// ============================================================================

export function getInflightActions(page) {
  if (page?.inflight instanceof Map) {
    return Array.from(page.inflight.values()).map(item => item.action);
  }
  if (typeof page?.evidenceRecords === 'function') {
    return page
      .evidenceRecords()
      .filter(item => item.pending)
      .map(item => item.action);
  }
  return [];
}

/**
 * 校验单步全局不变量（零越界工作区、零未捕获异常、零意外写请求、零慢响应超红线）。
 */
export function assertStepOracleHealthy(oracle, { allowSlowActions = [] } = {}) {
  if (oracle.forbiddenWorkspaceHit) {
    throw new Error(`命中禁区工作区 (${oracle.href})`);
  }
  if (!oracle.urlWorkspaceOk) {
    throw new Error(`URL 丢失或偏离目标 workspaceId (${oracle.href})`);
  }
  if (oracle.urlProjectOk === false) {
    throw new Error(`URL 丢失或偏离目标 project (${oracle.href})`);
  }
  if (oracle.scopeViolations?.length) {
    throw new Error('目录接口偏离测试工作区或项目');
  }
  const pending = oracle.pendingApis || [];
  const [mutated] = findWriteActions(oracle.records, pending);
  if (mutated) {
    throw new Error(`只读回归期间禁止发起写接口: ${mutated.action} (RequestId=${mutated.requestId || '—'})`);
  }
  if (pending.length) {
    throw new Error(`目录接口尚未返回，存在未完成请求: ${pending.map(item => item.action).join('、')}`);
  }
  if (Array.isArray(oracle.pageErrors) && oracle.pageErrors.length > 0) {
    throw new Error(`页面抛出未捕获异常: ${oracle.pageErrors[0].text}`);
  }
  const allowSet = new Set(allowSlowActions);
  const unexpectedSlow = (oracle.slowApis || []).filter(item => !allowSet.has(item.action));
  if (unexpectedSlow.length > 0) {
    const s = unexpectedSlow[0];
    throw new Error(
      `慢接口超红线: ${s.action} 耗时 ${s.durationMs}ms (> ${s.sloLimitMs}ms, RequestId=${s.requestId || '—'})`
    );
  }
}

/**
 * 通过 CDP Input.dispatchMouseEvent 执行真实硬件级鼠标移入、按下、抬起点击。
 * locatorExpr 必须是一段返回目标 Element（或 null）的浏览器端函数或表达式字符串。
 */
export async function dispatchRealMouseClick(page, locatorFnOrExpr, label = '目标控件') {
  const fnSource =
    typeof locatorFnOrExpr === 'function' ? locatorFnOrExpr.toString() : `() => (${locatorFnOrExpr})`;

  const scrolled = await page.evalJSON(`(() => {
    const resolveEl = ${fnSource};
    const el = resolveEl();
    if (!el) return { found: false, reason: '未在 DOM 中找到元素' };
    el.scrollIntoView({ block: 'center', inline: 'nearest' });
    return { found: true };
  })()`);

  if (!scrolled?.found) {
    throw new Error(`真实鼠标点击「${label}」失败: ${scrolled?.reason || '元素不存在'}`);
  }

  await page.sleep(80);

  const box = await page.evalJSON(`(() => {
    const resolveEl = ${fnSource};
    const el = resolveEl();
    if (!el) return { ok: false, reason: '滚动后元素消失' };
    const style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
      return { ok: false, reason: '元素处于隐藏状态' };
    }
    const rect = el.getBoundingClientRect();
    if (rect.width < 2 || rect.height < 2) {
      return { ok: false, reason: \`元素尺寸过小 (\${rect.width}x\${rect.height})\` };
    }
    const x = Math.round(rect.left + rect.width / 2);
    const y = Math.round(rect.top + rect.height / 2);
    if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) {
      return { ok: false, reason: \`元素中心超出视口 (\${x}, \${y})\` };
    }
    const hit = el.getRootNode()?.elementFromPoint?.(x, y) || document.elementFromPoint(x, y);
    if (!hit) {
      return { ok: false, reason: \`坐标 (\${x}, \${y}) 未命中任何节点\` };
    }
    const sameInteractiveRoot =
      el === hit ||
      el.contains(hit) ||
      hit.contains(el) ||
      (el.closest('button, ve-button, a, [role="tab"], .arco-radio-button, .arco-tabs-header-title') &&
        el.closest('button, ve-button, a, [role="tab"], .arco-radio-button, .arco-tabs-header-title') ===
          hit.closest('button, ve-button, a, [role="tab"], .arco-radio-button, .arco-tabs-header-title'));
    if (!sameInteractiveRoot) {
      return {
        ok: false,
        reason: \`目标被上层节点遮挡 (hit=\${hit.tagName}.\${String(hit.className || '').slice(0, 60)})\`,
      };
    }
    return { ok: true, x, y, text: (el.innerText || el.textContent || '').trim().slice(0, 80) };
  })()`);

  if (!box?.ok) {
    throw new Error(`真实鼠标点击「${label}」前置命中校验失败: ${box?.reason || '未知原因'}`);
  }

  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: box.x,
    y: box.y,
    button: 'none',
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: box.x,
    y: box.y,
    button: 'left',
    buttons: 1,
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: box.x,
    y: box.y,
    button: 'left',
    buttons: 0,
    clickCount: 1,
  });

  return box;
}

/**
 * 采集 /context/catalog 页面完整结构化 DOM 快照。
 */
export async function captureCatalogDomSnapshot(page) {
  const dom = await page.evalJSON(() => {
    const isVisible = el => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const hasActiveSpin = root => {
      if (!root) return false;
      const spinners = root.querySelectorAll(
        '.arco-spin-loading, .arco-spin > .arco-spin-icon, .arco-spin-mask, [aria-busy="true"]'
      );
      return Array.from(spinners).some(isVisible);
    };

    const treeAside = document.querySelector('input[placeholder="搜索目录"]')?.closest('aside');
    const directory = treeAside?.querySelector('nav[aria-label="数据目录"]');
    const results = Array.from(document.querySelectorAll('span')).find(
      el => el.textContent.trim() === '匹配结果' && el.closest('[class*="results"]')
    )?.closest('[class*="results"]');
    const searchPanel = document.querySelector('section[aria-label="搜索资产或业务知识"]');
    const searching = Boolean(new URLSearchParams(location.search).get('q'));
    const mainEl = searching
      ? searchPanel?.parentElement
      : document.querySelector('[aria-label="调整资产目录宽度"]')?.parentElement?.querySelector(':scope > main') ||
        Array.from(document.querySelectorAll('main')).find(el => el.querySelector('header h3'));
    const parseCount = key => {
      const text = directory?.querySelector(`[data-testid="tree-count-${key}"]`)?.textContent || '';
      const match = text.trim().match(/^\((\d+)\)$/);
      return match ? Number(match[1]) : null;
    };
    const directoryRows = Array.from(directory?.querySelectorAll('ul > li > ul > li') || [])
      .map(row => {
        const label = row.parentElement?.parentElement?.querySelector('[data-testid^="tree-count-"]');
        return {
          name: (row.querySelector('button')?.innerText || '').trim(),
          category: label?.getAttribute('data-testid')?.slice('tree-count-'.length),
        };
      })
      .filter(row => row.name);
    const treeConnectionNames = directoryRows.map(row => row.name);
    const tables = mainEl ? Array.from(mainEl.querySelectorAll('.arco-table')).filter(isVisible) : [];
    const headerNamesOf = tbl =>
      Array.from(tbl.querySelectorAll('thead th')).map(th => (th.innerText || '').trim());
    const assetTable = tables.find(tbl => {
      const hs = headerNamesOf(tbl);
      return hs.includes('可用状态') && hs.includes('类型') && hs.includes('更新时间');
    }) || null;
    const unitTable =
      tables.find(tbl => {
        if (tbl === assetTable) return false;
        const hs = headerNamesOf(tbl);
        return (
          hs.includes('文档标题') ||
          hs.some(h => h.startsWith('已纳管表名') || h === '已接入数据表') ||
          hs.some(h => /仓库|空间|应用|字典/.test(h))
        );
      }) || null;

    const extractDataRows = tbl => {
      if (!tbl) return [];
      return Array.from(tbl.querySelectorAll('tbody tr')).filter(
        tr => !tr.querySelector('.arco-empty') && !tr.classList.contains('arco-table-empty-row')
      );
    };

    const assetHeaders = assetTable ? headerNamesOf(assetTable) : [];
    const assetRows = extractDataRows(assetTable).map(tr => {
      const cell = name => (tr.cells[assetHeaders.indexOf(name)]?.innerText || '').trim();
      const [name, assetId] = cell('名称').split('\n').map(part => part.trim()).filter(Boolean);
      return {
        name: name || '', assetId: assetId || '',
        typeLabel: cell('类型'), statusText: cell('可用状态'), sourceText: cell('来源'),
        domainText: cell('关联领域'), updatedAt: cell('更新时间'),
      };
    });
    if (searching) {
      for (const link of mainEl?.querySelectorAll('.arco-card a[href*="/context/catalog/"]') || []) {
        if (isVisible(link)) assetRows.push({ name: link.innerText.trim() });
      }
    }
    const unitRows = unitTable ? extractDataRows(unitTable).map(tr => {
      const tds = Array.from(tr.querySelectorAll('td'));
      const btn = tds[0]?.querySelector('button, a');
      return {
        name: (btn?.textContent || tds[0]?.innerText || '').trim(),
        col1: (tds[1]?.innerText || '').trim(),
        col2: (tds[2]?.innerText || '').trim(),
        indexText: (tds[3]?.innerText || '').trim(),
        aclWatermarkText: (tds[4]?.innerText || '').trim(),
      };
    }) : assetRows;
    const unitTabTitles = mainEl
      ? Array.from(mainEl.querySelectorAll('.arco-tabs-header-title'))
          .filter(isVisible)
          .map(el => (el.innerText || '').trim())
      : [];

    const unitGovernanceTabsVisible = unitTabTitles.some(t =>
      /^(?:文档与标签管理|外部集合连接概览|已接入表与字段 Schema|权限与安全|连接级访问权限)/.test(t)
    );

    const errorAlerts = mainEl
      ? Array.from(mainEl.querySelectorAll('.arco-alert-error'))
          .filter(isVisible)
          .map(el => (el.innerText || '').trim())
          .filter(txt => txt && !/^(?:连接索引汇总|索引状态汇总)/.test(txt))
      : [];

    const warnAlerts = mainEl
      ? Array.from(mainEl.querySelectorAll('.arco-alert-warning'))
          .filter(isVisible)
          .map(el => (el.innerText || '').trim())
      : [];

    const sourceMissingWarn =
      warnAlerts.find(txt => txt.includes('该来源不存在或当前身份无访问权限')) || '';

    const indexSummaryBanner = mainEl
      ? Array.from(mainEl.querySelectorAll('.arco-alert'))
          .filter(isVisible)
          .map(el => (el.innerText || '').trim())
          .find(txt => txt.includes('连接索引汇总：')) || ''
      : '';

    const treeFailBtn = treeAside
      ? Array.from(treeAside.querySelectorAll('button')).find(b =>
          (b.innerText || '').includes('目录加载失败')
        )
      : null;

    return {
      pathname: window.location.pathname,
      search: window.location.search,
      href: window.location.href,
      treeSpinning: hasActiveSpin(treeAside),
      mainSpinning: hasActiveSpin(mainEl),
      hasSkeleton: Boolean(
        (treeAside && Array.from(treeAside.querySelectorAll('.arco-skeleton')).some(isVisible)) ||
          (mainEl && Array.from(mainEl.querySelectorAll('.arco-skeleton')).some(isVisible))
      ),
      treeFailedText: treeFailBtn ? (treeFailBtn.innerText || '').trim() : '',
      mainErrorTexts: errorAlerts,
      sourceMissingWarn,
      indexSummaryBanner,
      dataDirectory: true,
      headerTitle: searching ? (results ? '匹配结果' : '') : (mainEl?.querySelector('header h3')?.innerText || '').trim(),
      selectedTreeTitle: (directory?.querySelector('button[aria-current="true"]')?.innerText || '').trim(),
      treeAllCount: parseCount('all'),
      treeGroupCounts: {
        knowledge: parseCount('knowledge'),
        coderepo: parseCount('coderepo'),
        database: parseCount('database'),
        app_mcp: parseCount('app_mcp'),
      },
      treeConnectionNames,
      directoryRows,
      treeEmptyText: (treeAside?.querySelector('.arco-empty-description')?.innerText || '').trim(),
      hasAssetTable: Boolean(searching ? mainEl : assetTable),
      assetRows,
      assetTableEmptyText: (
        (searching ? mainEl : assetTable)?.querySelector('.arco-empty-description')?.innerText || ''
      ).trim(),
      unitTabTitles,
      unitGovernanceTabsVisible,
      hasUnitTable: Boolean(unitTable || assetTable),
      unitRows,
      unitEmptyText: ((unitTable || assetTable)?.querySelector('.arco-empty-description')?.innerText || '').trim(),
      isExternalVikingPanel: Boolean(
        mainEl && (mainEl.innerText || '').includes('外部检索集合：')
      ),
      isStaticUnitSummaryPanel: Boolean(
        mainEl &&
          unitTabTitles.length > 0 &&
          !unitTable &&
          /本期仅同步字典|代码仓/.test(mainEl.innerText || '')
      ),
    };
  });

  const pendingActions = getInflightActions(page);
  return {
    ...dom,
    pendingApiCount: pendingActions.length,
    pendingActions,
  };
}

/**
 * 等待 /context/catalog 收敛到终态（要求连续两次采样均 settled=true 且无在途 API）。
 */
export async function waitForCatalogSettled(
  page,
  expected = {},
  { timeoutMs = 18000, intervalMs = 180 } = {}
) {
  const start = Date.now();
  let lastSnapshot = null;
  let lastVerdict = null;
  let consecutiveSettled = 0;

  while (Date.now() - start < timeoutMs) {
    lastSnapshot = await captureCatalogDomSnapshot(page);
    lastVerdict = evaluateCatalogViewSettlement(lastSnapshot, expected);
    if (lastVerdict.settled) {
      consecutiveSettled += 1;
      if (consecutiveSettled >= 2) {
        return {
          ok: true,
          elapsedMs: Date.now() - start,
          snapshot: lastSnapshot,
          verdict: lastVerdict,
        };
      }
    } else {
      consecutiveSettled = 0;
    }
    await page.sleep(intervalMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - start,
    snapshot: lastSnapshot,
    verdict: lastVerdict || { settled: false, status: 'TIMEOUT', reason: '等待超时' },
  };
}

/**
 * 采集资产详情页（/context/catalog/:Id/detail）完整结构化 DOM 快照。
 */
export async function captureAssetDetailDomSnapshot(page) {
  const dom = await page.evalJSON(() => {
    const isVisible = el => {
      if (!el) return false;
      const st = window.getComputedStyle(el);
      if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
        return false;
      }
      const r = el.getBoundingClientRect();
      return r.width > 0 && r.height > 0;
    };

    const root = document.querySelector('article.ak-detail') || document.querySelector('main') || document.body;

    const findSectionByTitle = titlePrefix => {
      return (
        Array.from(root.querySelectorAll('.arco-layout')).find(sec => {
          if (sec.closest('.arco-drawer')) return false;
          const hdr = sec.querySelector(':scope > .arco-layout-header');
          const hdrText = (hdr?.innerText || '').trim();
          return hdrText === titlePrefix || hdrText.startsWith(`${titlePrefix}\n`);
        }) || null
      );
    };

    const spinners = Array.from(
      root.querySelectorAll(
        '.arco-spin-loading, .arco-spin > .arco-spin-icon, .arco-spin-mask, [aria-busy="true"]'
      )
    ).filter(el => !el.closest('.arco-drawer') && isVisible(el));

    const previewSection = findSectionByTitle('内容片段') || findSectionByTitle('数据预览');
    const markdownSection = findSectionByTitle('文档正文');

    const backEl = document.querySelector('.ak-detail-back');
    const titleEl =
      document.querySelector('.ak-detail-title h1') ||
      backEl?.nextElementSibling ||
      document.querySelector('h1');

    const bodyText = (root.innerText || '').trim();
    const notFoundText = (document.body?.innerText || '').includes('资产不存在、已删除或无权查看')
      ? '资产不存在、已删除或无权查看'
      : '';

    const errorAlerts = Array.from(root.querySelectorAll('.arco-alert-error'))
      .filter(el => !el.closest('.arco-drawer') && isVisible(el))
      .map(el => (el.innerText || '').trim())
      .filter(txt => txt && !txt.startsWith('异步索引构建失败') && !txt.startsWith('索引状态汇总：'));

    const warnAlerts = Array.from(root.querySelectorAll('.arco-alert-warning'))
      .filter(el => !el.closest('.arco-drawer') && isVisible(el))
      .map(el => (el.innerText || '').trim());

    const aclDeniedAlert =
      warnAlerts.find(txt => txt.includes('当前身份暂无权限预览该资产原文')) || '';

    // 页头资产类型标签
    const typeCandidates = [
      '数据库',
      '数据表',
      '文件集合',
      '代码仓',
      '应用字典',
      '指标模型',
      '业务规则',
      '来源说明',
    ];
    const headerArea =
      document.querySelector('.ak-detail-header') ||
      titleEl?.parentElement?.parentElement ||
      root;
    const headerTags = Array.from(headerArea.querySelectorAll('ve-tag, .arco-tag, span'))
      .map(el => (el.textContent || '').trim())
      .filter(Boolean);
    const assetTypeTag = typeCandidates.find(t => headerTags.includes(t)) || '';

    const updatedMatch = bodyText.match(/更新时间：\s*([^\n]+)/);
    const updatedAtText = updatedMatch ? updatedMatch[1].trim() : '';

    // 字段表格（数据表资产）
    const tables = Array.from(root.querySelectorAll('.arco-table')).filter(
      tbl => !tbl.closest('.arco-drawer')
    );
    const fieldTable = tables.find(tbl => {
      const hs = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.innerText || '').trim());
      return hs.includes('字段') && hs.includes('类型');
    });
    const fieldRowCount = fieldTable
      ? Array.from(fieldTable.querySelectorAll('tbody tr')).filter(
          tr => !tr.querySelector('.arco-empty') && !tr.classList.contains('arco-table-empty-row')
        ).length
      : 0;

    // 文档正文或内容片段（基于 Arco SectionLayout 标准结构提取，不依赖生产构建可能压缩的 CSS Module 类名）
    const markdownContentEl = markdownSection?.querySelector(':scope > .arco-layout-content');
    const markdownText = (markdownContentEl?.innerText || '').trim();

    const previewContentEl = previewSection?.querySelector(':scope > .arco-layout-content');
    const rawPreviewContent = (previewContentEl?.innerText || '').trim();
    const emptyPreviewText = rawPreviewContent.includes('暂无可预览内容') ? '暂无可预览内容' : '';
    const hasValidPreviewBody =
      Boolean(rawPreviewContent) &&
      !aclDeniedAlert &&
      errorAlerts.length === 0 &&
      !emptyPreviewText;
    const snippetCount = Number(hasValidPreviewBody);
    const hasMarkdownSection = Boolean(markdownSection);

    // 索引状态徽标提取
    const extractItemTag = label => {
      const re = new RegExp(`${label}[\\s\\n]+(已就绪|构建中|排队中|索引失败|不适用)`);
      const m = bodyText.match(re);
      return m ? m[1] : '';
    };
    const remoteAclMatch = bodyText.match(/远端权限同步[\s\n]+([^\n]+)/);

    const contentWrapper = document.querySelector('.ak-detail-content');
    const hasPendingPlaceholder = Boolean(
      contentWrapper && (contentWrapper.innerText || '').trim() === ''
    );

    return {
      pathname: window.location.pathname,
      search: window.location.search,
      href: window.location.href,
      detailSpinning: spinners.length > 0,
      previewSpinning: Boolean(
        previewSection &&
          Array.from(
            previewSection.querySelectorAll('.arco-spin-loading, .arco-spin > .arco-spin-icon')
          ).some(isVisible)
      ),
      hasPendingPlaceholder,
      hasSkeleton: Array.from(root.querySelectorAll('.arco-skeleton')).some(isVisible),
      notFoundText,
      headerTitle: (titleEl?.textContent || '').trim(),
      assetTypeTag,
      updatedAtText,
      errorAlerts,
      aclDeniedAlert,
      markdownText: markdownText.slice(0, 600),
      snippetCount,
      snippetSample: hasValidPreviewBody ? rawPreviewContent.slice(0, 400) : '',
      fieldRowCount,
      hasMarkdownSection,
      hasDatabaseOverview: bodyText.includes('连接信息') || bodyText.includes('已接入数据表'),
      hasSemanticContent:
        ['指标模型', '业务规则', '来源说明'].includes(assetTypeTag) && bodyText.length > 80,
      emptyPreviewText,
      contentIndexLabel: extractItemTag('正文索引'),
      projectionIndexLabel: extractItemTag('目录投影索引'),
      remoteAclText: remoteAclMatch ? remoteAclMatch[1].trim() : '',
    };
  });

  const pendingActions = getInflightActions(page);
  return {
    ...dom,
    pendingApiCount: pendingActions.length,
    pendingActions,
  };
}

/**
 * 等待资产详情页收敛到终态（连续两次采样均 settled=true 且无在途 API）。
 */
export async function waitForAssetDetailSettled(
  page,
  { timeoutMs = 18000, intervalMs = 180 } = {}
) {
  const start = Date.now();
  let lastSnapshot = null;
  let lastVerdict = null;
  let consecutiveSettled = 0;

  while (Date.now() - start < timeoutMs) {
    lastSnapshot = await captureAssetDetailDomSnapshot(page);
    lastVerdict = evaluateAssetDetailSettlement(lastSnapshot);
    if (lastVerdict.settled) {
      consecutiveSettled += 1;
      if (consecutiveSettled >= 2) {
        return {
          ok: true,
          elapsedMs: Date.now() - start,
          snapshot: lastSnapshot,
          verdict: lastVerdict,
        };
      }
    } else {
      consecutiveSettled = 0;
    }
    await page.sleep(intervalMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - start,
    snapshot: lastSnapshot,
    verdict: lastVerdict || { settled: false, status: 'TIMEOUT', reason: '详情页等待超时' },
  };
}

/**
 * 等待资产详情「数据血缘」页签收敛到终态。
 */
export async function waitForLineageSettled(
  page,
  stepName,
  { timeoutMs = 15000, intervalMs = 200 } = {}
) {
  const start = Date.now();
  let lastSnapshot = null;
  let lastVerdict = null;
  let consecutiveSettled = 0;

  while (Date.now() - start < timeoutMs) {
    const dom = await page.evalJSON(() => {
      const isVisible = el => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const root =
        document.querySelector('article.ak-detail') || document.body;
      const spinners = Array.from(
        root.querySelectorAll(
          '.arco-spin-loading, .arco-spin > .arco-spin-icon, .arco-spin-mask, [aria-busy="true"]'
        )
      ).filter(isVisible);
      const cards = Array.from(root.querySelectorAll('.arco-card')).filter(isVisible);
      const visibleText = (root.innerText || '').slice(0, 4000);
      const hintLine =
        visibleText
          .split('\n')
          .map(s => s.trim())
          .find(line => /个节点\s*·.*条关系|血缘加载失败/.test(line)) || '';
      return {
        lineageSpinning: spinners.length > 0,
        nodeCardCount: cards.length,
        hintText: hintLine,
        visibleText,
      };
    });

    await page.flushResponseMetadata?.(stepName);
    const pendingActions = getInflightActions(page);
    const records = typeof page.stepRecords === 'function' ? page.stepRecords(stepName) : [];
    lastSnapshot = { ...dom, pendingApiCount: pendingActions.length, pendingActions };
    lastVerdict = evaluateLineageSettlement(lastSnapshot, records);

    if (lastVerdict.settled) {
      consecutiveSettled += 1;
      if (consecutiveSettled >= 2) {
        return {
          ok: true,
          elapsedMs: Date.now() - start,
          snapshot: lastSnapshot,
          verdict: lastVerdict,
        };
      }
    } else {
      consecutiveSettled = 0;
    }
    await page.sleep(intervalMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - start,
    snapshot: lastSnapshot,
    verdict: lastVerdict || { settled: false, status: 'TIMEOUT', reason: '数据血缘等待超时' },
  };
}

/**
 * 等待来源「处理记录」抽屉收敛到终态。
 */
export async function waitForSourceHistorySettled(
  page,
  { timeoutMs = 15000, intervalMs = 180 } = {}
) {
  const start = Date.now();
  let lastSnapshot = null;
  let lastVerdict = null;
  let consecutiveSettled = 0;

  while (Date.now() - start < timeoutMs) {
    const dom = await page.evalJSON(() => {
      const isVisible = el => {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        if (st.display === 'none' || st.visibility === 'hidden' || Number(st.opacity) === 0) {
          return false;
        }
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0;
      };
      const drawers = Array.from(document.querySelectorAll('.arco-drawer')).filter(isVisible);
      const historyDrawer =
        drawers.find(d => (d.innerText || '').includes('处理记录')) || null;
      if (!historyDrawer) {
        return { drawerOpen: false };
      }
      const spinners = Array.from(
        historyDrawer.querySelectorAll(
          '.arco-spin-loading, .arco-spin > .arco-spin-icon, .arco-spin-mask, [aria-busy="true"]'
        )
      ).filter(isVisible);
      const errEl = historyDrawer.querySelector('.arco-alert-error');
      const emptyEl = historyDrawer.querySelector('.arco-empty-description');
      const trs = Array.from(historyDrawer.querySelectorAll('.arco-table tbody tr')).filter(
        tr => !tr.querySelector('.arco-empty') && !tr.classList.contains('arco-table-empty-row')
      );
      const rows = trs.map(tr => {
        const tds = Array.from(tr.querySelectorAll('td')).map(td => (td.innerText || '').trim());
        return {
          name: tds[0] || '',
          status: tds[1] || '',
          summary: tds.length > 3 ? tds[2] : '',
          time: tds[tds.length - 1] || '',
        };
      });
      return {
        drawerOpen: true,
        tableSpinning: spinners.length > 0,
        errorAlertText: isVisible(errEl) ? (errEl.innerText || '').trim() : '',
        emptyText: isVisible(emptyEl) ? (emptyEl.innerText || '').trim() : '',
        rows,
      };
    });

    const pendingActions = getInflightActions(page);
    lastSnapshot = { ...dom, pendingApiCount: pendingActions.length, pendingActions };
    lastVerdict = evaluateSourceHistorySettlement(lastSnapshot);

    if (lastVerdict.settled) {
      consecutiveSettled += 1;
      if (consecutiveSettled >= 2) {
        return {
          ok: true,
          elapsedMs: Date.now() - start,
          snapshot: lastSnapshot,
          verdict: lastVerdict,
        };
      }
    } else {
      consecutiveSettled = 0;
    }
    await page.sleep(intervalMs);
  }

  return {
    ok: false,
    elapsedMs: Date.now() - start,
    snapshot: lastSnapshot,
    verdict: lastVerdict || { settled: false, status: 'TIMEOUT', reason: '处理记录抽屉等待超时' },
  };
}
