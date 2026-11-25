// Property Suite 4：多视图归一化等价性（List / Detail / Summary / Release / Citation / MCP）属性测试。
// 覆盖：
// 1. 异构 DOM/Mock 形状（目录树英文分组键 vs 汇总中文类别与规模单位、单来源索引横幅/多行徽标 vs 详情正文索引、
//    慢列表「文档」vs 详情「文件集合」、秒级 vs 分钟级时间格式、远端 ACL 受控 vs 授权预览）的归一化等价通过
// 2. 注入任意单点跨视图偏差（计数、规模、索引徽标、类型误标、时间戳漂移/1970、ACL 泄露或错判）的精确拒绝
// 3. 领域发布头/版本表/冻结抽屉/加工引用（'2' vs 'v2' vs 'docx_rev_2'）/MCP 服务行等价性与评测/调用统计跨字段不变量

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ACL_DENIED_ALERT_SUBSTRING,
  CATALOG_ALL_UNITS_LABEL,
} from '../lib/catalog-checks.mjs';
import {
  classifyEvaluationReportView,
  classifyMcpMetricsDrawerView,
} from '../lib/ui-checks.mjs';
import {
  validateCrossViewEquivalence,
  validateDomainReleaseCrossViewEquivalence,
} from './support/observationContracts.mjs';
import { assertProperty } from './support/propHarness.mjs';

const FILE = 'test/view-equivalence-normalization.property.test.mjs';

function buildConsistentCatalogViews(spec) {
  const isTable = spec.sourceKind === 'database';
  const targetSourceName = isTable ? 'codex-e2e-pg-1125' : 'codex-e2e-local-kb-1125';
  const targetSourceId = isTable ? 'res-pg-01' : 'res-kb-01';
  const targetAssetName = isTable ? 'adk_sessions' : 'doc-codex-e2e-1125-refund.md';

  const unitRows = Array.from({ length: spec.unitCount }, (_, idx) => {
    const isTarget = idx === 0;
    const badge = isTarget ? spec.targetIndexBadge : spec.siblingIndexBadge;
    const indexText =
      spec.indexShape === 'multiline'
        ? `正文索引\n${badge}\n目录投影索引\n已就绪`
        : badge;
    return {
      name: isTarget ? targetAssetName : `${isTable ? 'tbl' : 'doc'}-extra-${idx}`,
      indexText,
      aclWatermarkText: spec.aclEnabled
        ? spec.viewerAuthorized
          ? '已开启远端权限控制 · 已同步'
          : '已开启远端权限控制 · 需协作者权限'
        : '未开启（公开可读）',
      viewerAuthorized: spec.viewerAuthorized,
    };
  });

  const bannerCounts = { ready: 0, building: 0, queued: 0, failed: 0 };
  for (const r of unitRows) {
    const b = r === unitRows[0] ? spec.targetIndexBadge : spec.siblingIndexBadge;
    if (b === '已就绪') bannerCounts.ready += 1;
    else if (b === '构建中') bannerCounts.building += 1;
    else if (b === '排队中') bannerCounts.queued += 1;
    else if (b === '索引失败') bannerCounts.failed += 1;
  }

  const indexSummaryBanner = `连接索引汇总：已就绪 ${bannerCounts.ready} · 构建中 ${bannerCounts.building} · 排队中 ${bannerCounts.queued} · 索引失败 ${bannerCounts.failed}`;

  const extraKnowledge = isTable ? spec.extraSources : 1 + spec.extraSources;
  const extraDatabase = isTable ? 1 : 0;
  const treeGroupCounts = {
    knowledge: extraKnowledge,
    coderepo: spec.codeRepoCount,
    database: extraDatabase,
    app_mcp: spec.appMcpCount,
  };
  const treeAllCount =
    treeGroupCounts.knowledge +
    treeGroupCounts.coderepo +
    treeGroupCounts.database +
    treeGroupCounts.app_mcp;

  const baseMinute = `2026-11-25 13:${String(spec.minute).padStart(2, '0')}`;
  const listUpdatedAt = spec.listHasSeconds ? `${baseMinute}:28` : baseMinute;
  const detailUpdatedAt = spec.detailHasSeconds ? `${baseMinute}:28` : baseMinute;

  const summarySnapshot = {
    pathname: '/v2/context/catalog',
    search: '?workspaceId=ws-1&project=default',
    headerTitle: CATALOG_ALL_UNITS_LABEL,
    selectedTreeTitle: `${CATALOG_ALL_UNITS_LABEL}\n${treeAllCount}`,
    unitGovernanceTabsVisible: false,
    treeAllCount,
    treeGroupCounts,
    overviewTotalBadge: treeAllCount,
    hasOverviewTable: true,
    overviewRows: [
      {
        name: targetSourceName,
        category: isTable ? '数据库' : '知识库',
        scaleText: isTable ? `${spec.unitCount} 张表` : `${spec.unitCount} 篇文档`,
      },
    ],
    hasAssetTable: true,
    assetRows: [
      {
        name: targetAssetName,
        assetId: 'r_target_01',
        typeLabel: isTable ? '数据表' : '文档',
        statusText: spec.targetIndexBadge,
        sourceText: targetSourceName,
        domainText: 'codex-e2e-r4-domain-1125',
        updatedAt: listUpdatedAt,
      },
    ],
    pendingApiCount: 0,
  };

  const sourceSnapshot = {
    pathname: '/v2/context/catalog',
    search: `?workspaceId=ws-1&project=default&source=${targetSourceId}`,
    headerTitle: targetSourceName,
    selectedTreeTitle: targetSourceName,
    hasUnitTable: true,
    unitRows,
    indexSummaryBanner,
    pendingApiCount: 0,
  };

  const aclBlocked = spec.aclEnabled && !spec.viewerAuthorized;
  const detailSnapshot = {
    pathname: '/v2/context/catalog/r_target_01/detail',
    search: '?workspaceId=ws-1&project=default',
    headerTitle: targetAssetName,
    // 注意真实前端形状差异：列表用「文档」，详情页头用「文件集合」
    assetTypeTag: isTable ? '数据表' : '文件集合',
    updatedAtText: detailUpdatedAt,
    contentIndexLabel: spec.targetIndexBadge,
    projectionIndexLabel: '已就绪',
    aclDeniedAlert: aclBlocked ? `${ACL_DENIED_ALERT_SUBSTRING}。` : '',
    markdownText: !aclBlocked && !isTable ? '# 退款规则正文' : '',
    snippetCount: !aclBlocked && !isTable ? 2 : 0,
    fieldRowCount: !aclBlocked && isTable ? 6 : 0,
    hasMarkdownSection: !aclBlocked && !isTable,
    pendingApiCount: 0,
  };

  return {
    summarySnapshot,
    sourceSnapshot,
    detailSnapshot,
    targetSourceName,
    targetSourceId,
    targetAssetName,
  };
}

test('P4.1 目录树/单元汇总/专用来源列表/全局慢列表/单资产详情异构形状在归一化后完全等价一致 (300 cases)', () => {
  assertProperty(
    {
      name: 'P4.1 Equivalent catalog/source/list/detail shapes agree across formatting variants',
      seed: 0x54040001,
      runs: 300,
      file: FILE,
      generate(rng) {
        const aclEnabled = rng.bool(0.45);
        const viewerAuthorized = aclEnabled ? rng.bool(0.5) : true;
        // 若远端 ACL 拦截，仅在文档集合下测 READY_ACL_DENIED；已授权时覆盖文档与数据表
        const sourceKind = !viewerAuthorized ? 'knowledge' : rng.pick(['knowledge', 'database']);
        return {
          sourceKind,
          unitCount: rng.int(1, 6),
          extraSources: rng.int(0, 4),
          codeRepoCount: rng.int(0, 2),
          appMcpCount: rng.int(0, 2),
          targetIndexBadge: rng.pick(['已就绪', '构建中', '排队中']),
          siblingIndexBadge: rng.pick(['已就绪', '构建中', '索引失败']),
          indexShape: rng.pick(['multiline', 'compact']),
          aclEnabled,
          viewerAuthorized,
          minute: rng.int(0, 59),
          listHasSeconds: rng.bool(0.5),
          detailHasSeconds: rng.bool(0.5),
        };
      },
    },
    spec => {
      const bundle = buildConsistentCatalogViews(spec);
      const res = validateCrossViewEquivalence(bundle);
      assert.equal(res.ok, true, res.reason);
      assert.equal(res.normalizedKind, spec.sourceKind === 'database' ? 'table' : 'document');
      assert.equal(res.indexLabel, spec.targetIndexBadge);
    }
  );
});

test('P4.2 跨视图等价校验 100% 拒绝计数/规模/索引横幅/徽标/类型/时间戳/ACL 任意单点不一致 (300 cases)', () => {
  assertProperty(
    {
      name: 'P4.2 Deliberate cross-view discrepancy is rejected across distinct mock shapes',
      seed: 0x54040002,
      runs: 300,
      file: FILE,
      generate(rng) {
        return {
          unitCount: rng.int(2, 5),
          mutation: rng.pick([
            'tree_group_sum_mismatch',
            'overview_scale_unit_wrong_for_category',
            'overview_scale_count_differs_from_unit_rows',
            'index_banner_disagrees_with_unit_rows',
            'unit_index_disagrees_with_detail_index',
            'list_document_mislabeled_as_table_in_detail',
            'detail_table_renders_markdown_section',
            'list_vs_detail_timestamp_drift',
            'detail_1970_timestamp_ctx007',
            'acl_disabled_in_list_but_denied_in_detail',
            'acl_unauthorized_in_unit_but_content_shown_in_detail',
          ]),
        };
      },
      *shrink(s) {
        if (s.unitCount > 2) yield { ...s, unitCount: 2 };
      },
    },
    s => {
      const bundle = buildConsistentCatalogViews({
        sourceKind: 'knowledge',
        unitCount: s.unitCount,
        extraSources: 1,
        codeRepoCount: 0,
        appMcpCount: 0,
        targetIndexBadge: '已就绪',
        siblingIndexBadge: '已就绪',
        indexShape: 'multiline',
        aclEnabled: false,
        viewerAuthorized: true,
        minute: 20,
        listHasSeconds: false,
        detailHasSeconds: true,
      });

      if (s.mutation === 'tree_group_sum_mismatch') {
        bundle.summarySnapshot.treeAllCount += 1;
      } else if (s.mutation === 'overview_scale_unit_wrong_for_category') {
        bundle.summarySnapshot.overviewRows[0].scaleText = `${s.unitCount} 张表`;
      } else if (s.mutation === 'overview_scale_count_differs_from_unit_rows') {
        bundle.summarySnapshot.overviewRows[0].scaleText = `${s.unitCount + 1} 篇文档`;
      } else if (s.mutation === 'index_banner_disagrees_with_unit_rows') {
        bundle.sourceSnapshot.indexSummaryBanner = `连接索引汇总：已就绪 ${s.unitCount - 1} · 构建中 0 · 排队中 0 · 索引失败 1`;
      } else if (s.mutation === 'unit_index_disagrees_with_detail_index') {
        bundle.detailSnapshot.contentIndexLabel = '索引失败';
      } else if (s.mutation === 'list_document_mislabeled_as_table_in_detail') {
        bundle.detailSnapshot.assetTypeTag = '数据表';
        bundle.detailSnapshot.hasMarkdownSection = false;
        bundle.detailSnapshot.fieldRowCount = 4;
      } else if (s.mutation === 'detail_table_renders_markdown_section') {
        bundle.summarySnapshot.assetRows[0].typeLabel = '数据表';
        bundle.detailSnapshot.assetTypeTag = '数据表';
        bundle.detailSnapshot.fieldRowCount = 4;
        bundle.detailSnapshot.hasMarkdownSection = true;
      } else if (s.mutation === 'list_vs_detail_timestamp_drift') {
        bundle.detailSnapshot.updatedAtText = '2026-11-25 13:21:00';
      } else if (s.mutation === 'detail_1970_timestamp_ctx007') {
        bundle.detailSnapshot.updatedAtText = '1970-01-01 08:00:00';
      } else if (s.mutation === 'acl_disabled_in_list_but_denied_in_detail') {
        bundle.detailSnapshot.aclDeniedAlert = `${ACL_DENIED_ALERT_SUBSTRING}。`;
        bundle.detailSnapshot.markdownText = '';
        bundle.detailSnapshot.snippetCount = 0;
      } else if (s.mutation === 'acl_unauthorized_in_unit_but_content_shown_in_detail') {
        bundle.sourceSnapshot.unitRows[0].aclWatermarkText = '已开启远端权限控制 · 需协作者权限';
        bundle.sourceSnapshot.unitRows[0].viewerAuthorized = false;
      }

      const res = validateCrossViewEquivalence(bundle);
      assert.equal(res.ok, false, `跨视图偏差 ${s.mutation} 必须被归一化等价校验器拒绝`);
    }
  );
});

test('P4.3 领域版本/冻结范围/建议引用（v2 / docx_rev_2 归一化）/MCP 服务行等价性与偏差拦截 (260 cases)', () => {
  assertProperty(
    {
      name: 'P4.3 Domain release, frozen scope, proposal citation & MCP version equivalence',
      seed: 0x54040003,
      runs: 260,
      file: FILE,
      generate(rng) {
        const rev1 = rng.int(1, 4);
        const rev2 = rev1 + rng.int(1, 3);
        const minor = rng.int(1, 8);
        const r1Ver = `1.0.${minor}`;
        const r2Ver = `1.0.${minor + 1}`;
        const citationRevFormat = rng.pick([String(rev2), `v${rev2}`, `docx_rev_${rev2}`, `rev-${rev2}`]);
        const injectMismatch = rng.pick([
          'none',
          'header_stuck_on_r1',
          'r1_ordered_before_r2',
          'timestamps_reversed',
          'citation_mislabeled_as_table_ctx011',
          'citation_missing_asset_link_ctx011',
          'citation_revision_stuck_on_r1',
          'mcp_service_version_lagging',
        ]);
        return { rev1, rev2, r1Ver, r2Ver, citationRevFormat, injectMismatch };
      },
      *shrink(s) {
        if (s.rev1 > 1 || s.rev2 > 2) yield { ...s, rev1: 1, rev2: 2 };
      },
    },
    s => {
      const fixture = {
        r1: { version: s.r1Ver, statusText: '历史版本', frozenRevision: String(s.rev1), minFrozenCount: 2 },
        r2: { version: s.r2Ver, statusText: '当前发布', frozenRevision: String(s.rev2), minFrozenCount: 2 },
      };

      const comparisonView = {
        headerText: `codex-e2e-r4-domain-1125 · 当前生效 ${s.r2Ver}`,
        rows: [
          { version: s.r2Ver, status: '当前发布', publishedAt: '2026-11-25 13:30:00' },
          { version: s.r1Ver, status: '历史版本', publishedAt: '2026-11-25 11:10:00' },
        ],
        r1RefundRevision: String(s.rev1),
        r1FrozenCount: 2,
        r2RefundRevision: String(s.rev2),
        r2FrozenCount: 3,
      };

      const proposalCitations = [
        {
          title: 'doc-codex-e2e-1125-refund.md',
          kindLabel: '文档',
          revision: s.citationRevFormat,
          hasAssetLink: true,
          matchesTargetAsset: true,
        },
        {
          title: '历史调试优质问答 #1',
          kindLabel: '工作台会话',
          revision: '',
          hasAssetLink: false,
          matchesTargetAsset: false,
        },
      ];

      const mcpRow = {
        domainName: 'codex-e2e-r4-domain-1125',
        version: s.r2Ver,
        status: '运行中',
      };

      if (s.injectMismatch === 'header_stuck_on_r1') {
        comparisonView.headerText = `codex-e2e-r4-domain-1125 · 当前生效 ${s.r1Ver}`;
      } else if (s.injectMismatch === 'r1_ordered_before_r2') {
        comparisonView.rows.reverse();
      } else if (s.injectMismatch === 'timestamps_reversed') {
        comparisonView.rows[0].publishedAt = '2026-11-25 09:00:00';
      } else if (s.injectMismatch === 'citation_mislabeled_as_table_ctx011') {
        proposalCitations[0].kindLabel = '数据表';
      } else if (s.injectMismatch === 'citation_missing_asset_link_ctx011') {
        proposalCitations[0].hasAssetLink = false;
      } else if (s.injectMismatch === 'citation_revision_stuck_on_r1') {
        proposalCitations[0].revision = `v${s.rev1}`;
      } else if (s.injectMismatch === 'mcp_service_version_lagging') {
        mcpRow.version = s.r1Ver;
      }

      const verdict = validateDomainReleaseCrossViewEquivalence({
        comparisonView,
        comparisonFixture: fixture,
        proposalCitations,
        mcpRow,
      });

      if (s.injectMismatch === 'none') {
        assert.equal(verdict.ok, true, verdict.reason);
        assert.equal(verdict.activeVersion, s.r2Ver);
        assert.equal(verdict.frozenRevision, s.rev2);
      } else {
        assert.equal(verdict.ok, false, `发布/引用/MCP 偏差 ${s.injectMismatch} 必须被拒绝`);
      }
    }
  );
});

test('P4.4 效果评估总评/逐题明细与 MCP 24h 调用统计抽屉跨字段计数守恒属性（拒绝失败数或拦截数大于总调用数） (240 cases)', () => {
  assertProperty(
    {
      name: 'P4.4 Evaluation report & MCP 24h metrics cross-field count invariants',
      seed: 0x54040004,
      runs: 240,
      file: FILE,
      generate(rng) {
        const total = rng.int(0, 50);
        const errors = rng.int(0, total);
        const denied = rng.int(0, total);
        const excess = rng.int(1, 10);
        const scenarioKind = rng.pick([
          'valid_passed_eval_and_metrics',
          'eval_unconfigured_with_0_percent_ctx002',
          'eval_passed_badge_with_failed_question',
          'mcp_unavailable_ctx021',
          'mcp_errors_exceed_total_calls',
          'mcp_denied_exceed_total_calls',
        ]);
        return { total, errors, denied, excess, scenarioKind };
      },
      *shrink(s) {
        if (s.total > 2) yield { ...s, total: 2, errors: Math.min(s.errors, 2), denied: Math.min(s.denied, 2) };
        if (s.excess > 1) yield { ...s, excess: 1 };
      },
    },
    s => {
      if (s.scenarioKind === 'valid_passed_eval_and_metrics') {
        const evalRes = classifyEvaluationReportView({
          badges: ['双轮评测通过', '评测命中率 100%'],
          text: '全部通过',
          rows: [{ question: '退款时效是几天？', verdict: '已覆盖通过' }],
        });
        assert.equal(evalRes.kind, 'passed');

        const mcpRes = classifyMcpMetricsDrawerView({
          open: true,
          loading: false,
          width: 480,
          height: 720,
          text: `调用次数 ${s.total} 失败次数 ${s.errors} 权限拦截次数 ${s.denied}`,
          metrics: {
            调用次数: String(s.total),
            失败次数: String(s.errors),
            权限拦截次数: String(s.denied),
          },
        });
        assert.equal(mcpRes.status, 'READY');
        assert.equal(mcpRes.counts.total, s.total);
      } else if (s.scenarioKind === 'eval_unconfigured_with_0_percent_ctx002') {
        assert.throws(
          () =>
            classifyEvaluationReportView({
              badges: ['未配置评测集'],
              text: '本次运行没有问答评估结果，评测命中率 0%',
              rows: [],
            }),
          /0%/
        );
      } else if (s.scenarioKind === 'eval_passed_badge_with_failed_question') {
        assert.throws(
          () =>
            classifyEvaluationReportView({
              badges: ['双轮评测通过'],
              text: '总评',
              rows: [
                { question: 'Q1', verdict: '已覆盖通过' },
                { question: 'Q2', verdict: '本轮退化' },
              ],
            }),
          /逐题明细存在未通过项/
        );
      } else if (s.scenarioKind === 'mcp_unavailable_ctx021') {
        assert.throws(
          () =>
            classifyMcpMetricsDrawerView({
              open: true,
              loading: false,
              width: 480,
              height: 720,
              text: '暂时无法获取调用统计。',
              metrics: {},
            }),
          /UNAVAILABLE/
        );
      } else if (s.scenarioKind === 'mcp_errors_exceed_total_calls') {
        assert.throws(
          () =>
            classifyMcpMetricsDrawerView({
              open: true,
              loading: false,
              width: 480,
              height: 720,
              text: `调用次数 ${s.total} 失败次数 ${s.total + s.excess} 权限拦截次数 0`,
              metrics: {
                调用次数: String(s.total),
                失败次数: String(s.total + s.excess),
                权限拦截次数: '0',
              },
            }),
          /失败次数|调用次数|不一致|超过|异常/,
          `失败次数 (${s.total + s.excess}) 超过总调用次数 (${s.total}) 时调用统计校验必须拒绝`
        );
      } else if (s.scenarioKind === 'mcp_denied_exceed_total_calls') {
        assert.throws(
          () =>
            classifyMcpMetricsDrawerView({
              open: true,
              loading: false,
              width: 480,
              height: 720,
              text: `调用次数 ${s.total} 失败次数 0 权限拦截次数 ${s.total + s.excess}`,
              metrics: {
                调用次数: String(s.total),
                失败次数: '0',
                权限拦截次数: String(s.total + s.excess),
              },
            }),
          /权限拦截次数|调用次数|不一致|超过|异常/,
          `权限拦截次数 (${s.total + s.excess}) 超过总调用次数 (${s.total}) 时调用统计校验必须拒绝`
        );
      }
    }
  );
});
