import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCancelledRunTerminal,
  assertLegacyDatabaseRedirectView,
  assertPinnedCitation,
  assertReportCitationRoundTrip,
  assertRunningPublishNotice,
  assertSourceObjectsStateSeparation,
} from '../lib/regression-checks.mjs';
import { KNOWN_FIXTURES, classifyProposalCitationsView } from '../lib/ui-checks.mjs';
import { assertProperty } from './support/propHarness.mjs';

const CFG = {
  consoleBaseUrl: 'https://console.volcengine.com',
  workspaceId: KNOWN_FIXTURES.workspaceId,
  forbiddenWorkspaceId: KNOWN_FIXTURES.forbiddenWorkspaceId,
  projectName: 'default',
};

test('性质 ENR-05：建议来源引用严禁退化为「数据表 #1 / 当前快照」，且从资产详情返回必须保留同一 taskId 报告', () => {
  assertProperty(
    {
      name: 'ENR-05 建议来源引用保真与报告往返',
      seed: 0x05e2e8fb,
      runs: 220,
      file: 'test/step3-regressions.property.test.mjs',
      generate(rng) {
        const domainId = `dom-${rng.hex(12)}`;
        const taskId = `enr-${rng.hex(16)}`;
        const entryId = `r_${rng.hex(16)}`;
        const ext = rng.pick(['pdf', 'md']);
        const rev = `v${rng.int(1, 5)}`;
        const fault = rng.pick([
          'none',
          'placeholder_table_hash',
          'doc_as_table',
          'doc_current_snapshot',
          'lost_task_id_on_return',
          'report_not_mounted',
        ]);
        return { domainId, taskId, entryId, ext, rev, fault };
      },
    },
    ({ domainId, taskId, entryId, ext, rev, fault }) => {
      const card = {
        title: `codex-e2e-refund.${ext}`,
        kindLabel: '文档',
        revision: rev,
        hasDocQuote: true,
        hasAssetLink: true,
      };
      if (fault === 'placeholder_table_hash') {
        assert.throws(
          () =>
            classifyProposalCitationsView([
              { ...card, title: '数据表 #1', kindLabel: '数据表', revision: '当前快照' },
            ]),
          /占位符/
        );
        return;
      }
      if (fault === 'doc_as_table') {
        assert.throws(
          () => classifyProposalCitationsView([{ ...card, kindLabel: '数据表' }]),
          /误标为「数据表」/
        );
        return;
      }
      if (fault === 'doc_current_snapshot') {
        assert.throws(
          () => classifyProposalCitationsView([{ ...card, revision: '当前快照' }]),
          /退化为「当前快照」/
        );
        return;
      }

      assert.equal(classifyProposalCitationsView([card]), 1);

      const goodReportUrl = `${CFG.consoleBaseUrl}/v2/context/domains/${domainId}/processing?taskId=${taskId}&workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;
      const bareListUrl = `${CFG.consoleBaseUrl}/v2/context/domains/${domainId}/processing?workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;
      const returnTarget = fault === 'lost_task_id_on_return' ? bareListUrl : goodReportUrl;
      const detailHref = `${CFG.consoleBaseUrl}/v2/context/catalog/${entryId}/detail?returnTo=${encodeURIComponent(returnTarget)}&workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;

      if (fault === 'lost_task_id_on_return') {
        assert.throws(
          () =>
            assertReportCitationRoundTrip(
              { detailHref, returnedHref: bareListUrl, reportReady: false, domainId, taskId },
              CFG
            ),
          /taskId/
        );
        return;
      }
      if (fault === 'report_not_mounted') {
        assert.throws(
          () =>
            assertReportCitationRoundTrip(
              { detailHref, returnedHref: goodReportUrl, reportReady: false, domainId, taskId },
              CFG
            ),
          /未恢复原运行报告视图/
        );
        return;
      }

      assert.equal(
        assertReportCitationRoundTrip(
          { detailHref, returnedHref: goodReportUrl, reportReady: true, domainId, taskId },
          CFG
        ),
        true
      );
    }
  );
});

test('性质 NAV-04 / CAT-04：聚合数据库旧连接跳转保留原 connectionId 与真实数据表，严格分离加载态、重试错误与空态', () => {
  assertProperty(
    {
      name: 'NAV-04 数据库旧连接跳转与错误空态分离',
      seed: 0x04db7399,
      runs: 220,
      file: 'test/step3-regressions.property.test.mjs',
      generate(rng) {
        const connId = `res-${rng.hex(16)}`;
        const dbAssetId = `db-${rng.hex(10)}`;
        const table = rng.pick(['public.events', 'public.adk_sessions']);
        const fault = rng.pick([
          'none',
          'missing_connection_id',
          'empty_tables',
          'error_alert',
          'loading_false_empty',
          'error_swallowed_as_empty',
        ]);
        return { connId, dbAssetId, table, fault };
      },
    },
    ({ connId, dbAssetId, table, fault }) => {
      if (fault === 'loading_false_empty') {
        assert.throws(
          () =>
            assertSourceObjectsStateSeparation({
              loading: true,
              entriesFailed: false,
              showsEmptyState: true,
              objectCount: 0,
            }),
          /加载期间过早渲染了空态/
        );
        return;
      }
      if (fault === 'error_swallowed_as_empty') {
        assert.throws(
          () =>
            assertSourceObjectsStateSeparation({
              loading: false,
              entriesFailed: true,
              hasErrorAlert: false,
              hasRetryButton: false,
              showsEmptyState: true,
              objectCount: 0,
            }),
          /误展示为空态或缺少可重试错误提示/
        );
        return;
      }

      assert.equal(
        assertSourceObjectsStateSeparation({
          loading: false,
          entriesFailed: true,
          hasErrorAlert: true,
          hasRetryButton: true,
          showsEmptyState: false,
          objectCount: 0,
        }),
        'ERROR_RETRYABLE'
      );

      const query = new URLSearchParams({
        ...(fault === 'missing_connection_id' ? {} : { connectionId: connId }),
        workspaceId: CFG.workspaceId,
        project: CFG.projectName,
      });
      const detailHref = `${CFG.consoleBaseUrl}/v2/context/catalog/${dbAssetId}/detail?${query}`;
      const backHref = `${CFG.consoleBaseUrl}/v2/context/catalog?workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;

      if (fault === 'missing_connection_id') {
        assert.throws(
          () =>
            assertLegacyDatabaseRedirectView(
              { detailHref, text: `已接入表 ${table}`, tableCount: 2, backHref },
              CFG,
              { connectionId: connId, expectedTable: table }
            ),
          /connectionId/
        );
        return;
      }
      if (fault === 'empty_tables') {
        assert.throws(
          () =>
            assertLegacyDatabaseRedirectView(
              { detailHref, text: '暂无已接入数据表', tableCount: 0, backHref },
              CFG,
              { connectionId: connId, expectedTable: table }
            ),
          /未渲染原连接下的预期数据表/
        );
        return;
      }
      if (fault === 'error_alert') {
        assert.throws(
          () =>
            assertLegacyDatabaseRedirectView(
              { detailHref, text: '无法加载已接入数据表。', hasErrorAlert: true, tableCount: 0, backHref },
              CFG,
              { connectionId: connId, expectedTable: table }
            ),
          /数据表列表加载失败/
        );
        return;
      }

      const parsed = assertLegacyDatabaseRedirectView(
        { detailHref, text: `资产详情 · ${table}`, hasErrorAlert: false, tableCount: 3, backHref },
        CFG,
        { connectionId: connId, expectedTable: table }
      );
      assert.equal(parsed.searchParams.get('connectionId'), connId);
    }
  );
});

test('性质 USE-03：历史回答内联引文侧栏预览与图谱详情均不得串到另一发布修订', () => {
  assertProperty(
    {
      name: 'USE-03 内联引文预览与图谱详情双路径版本锁定',
      seed: 0x03715da9,
      runs: 180,
      file: 'test/step3-regressions.property.test.mjs',
      generate(rng) {
        const isR1 = rng.bool(0.5);
        const leakInline = rng.bool(0.5);
        return {
          version: isR1 ? 1 : 2,
          days: isR1 ? 7 : 15,
          otherDays: isR1 ? 15 : 7,
          leakInline,
          sessionId: `sess-${rng.hex(10)}`,
          releaseId: `rel-${rng.hex(10)}`,
          domainId: `dom-${rng.hex(10)}`,
          entryId: `r_${rng.hex(12)}`,
          msgId: `turn-${rng.hex(8)}`,
        };
      },
    },
    ({ version, days, otherDays, leakInline, sessionId, releaseId, domainId, entryId, msgId }) => {
      const returnTo = `${CFG.consoleBaseUrl}/v2/context/workbench?tab=chat&sessionId=${sessionId}&resumeMessage=${msgId}&workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;
      const href = `${CFG.consoleBaseUrl}/v2/context/catalog/${entryId}/detail?domainId=${domainId}&releaseId=${releaseId}&returnTo=${encodeURIComponent(returnTo)}&workspaceId=${CFG.workspaceId}&project=${CFG.projectName}`;
      const answer = `根据生效规范，退款时效为 ${days} 天。`;
      const payload = {
        answer,
        source: `退款规范 v${version}`,
        inlinePreview: `资产预览原文：申请退款需在 ${leakInline ? otherDays : days} 天内提交。`,
        detail: `发布版本原文：申请退款需在 ${days} 天内提交。`,
        href,
        returned: { href: returnTo, answer },
      };
      const fixture = { version, days, entryId, domainId, releaseId, sessionId };

      if (leakInline) {
        assert.throws(() => assertPinnedCitation(payload, CFG, fixture), /侧栏预览未固定到本轮发布修订/);
      } else {
        assert.doesNotThrow(() => assertPinnedCitation(payload, CFG, fixture));
      }
    }
  );
});

test('性质 REL-05 / ENR-08：加工运行中发布弹窗必须披露快照边界，取消任务必须收敛至零建议已取消终态', () => {
  assertProperty(
    {
      name: 'REL-05 运行中发布边界提示与 ENR-08 取消终态守恒',
      seed: 0x0508ca9c,
      runs: 180,
      file: 'test/step3-regressions.property.test.mjs',
      generate(rng) {
        return {
          missingNotice: rng.bool(0.4),
          orphanProposals: rng.bool(0.4) ? rng.int(1, 5) : 0,
          statusMismatch: rng.bool(0.3),
        };
      },
    },
    ({ missingNotice, orphanProposals, statusMismatch }) => {
      if (missingNotice) {
        assert.throws(
          () =>
            assertRunningPublishNotice({
              hasActiveRun: true,
              modalText: '确认发布新版本 1.0.13？',
              cancelledStaysOnDomain: true,
            }),
          /未明确提示本次采用当前草稿/
        );
      } else {
        assert.equal(
          assertRunningPublishNotice({
            hasActiveRun: true,
            modalText: '本领域有正在运行的加工任务，本次发布采用当前草稿，不包含未完成或未采纳结果。',
            cancelledStaysOnDomain: true,
          }),
          true
        );
      }

      const terminal = {
        headerStatus: '已取消',
        rowStatus: statusMismatch ? '运行中' : '已取消',
        proposalCount: orphanProposals,
        duplicateTriggerDisabled: true,
      };
      if (statusMismatch || orphanProposals > 0) {
        assert.throws(() => assertCancelledRunTerminal(terminal));
      } else {
        assert.equal(assertCancelledRunTerminal(terminal), true);
      }
    }
  );
});

test('全量 12 个 E2E 规格模块均可干净导入并导出标准 run(t, page, cfg) 入口', async () => {
  const allSpecs = [
    '../specs/01-navigation-scope.spec.mjs',
    '../specs/02-catalog-explorer.spec.mjs',
    '../specs/03-asset-detail-lineage.spec.mjs',
    '../specs/04-domains-versions.spec.mjs',
    '../specs/05-processing-eval.spec.mjs',
    '../specs/06-mcp-services.spec.mjs',
    '../specs/07-workbench-first-paint.spec.mjs',
    '../specs/08-draft-debug.spec.mjs',
    '../specs/09-source-wizard.spec.mjs',
    '../specs/10-domain-permissions.spec.mjs',
    '../specs/11-seal-regressions.spec.mjs',
    '../specs/12-catalog-pagination.spec.mjs',
  ];
  for (const rel of allSpecs) {
    const mod = await import(rel);
    assert.equal(typeof mod.run, 'function', `${rel} 必须导出 run()`);
  }
});
