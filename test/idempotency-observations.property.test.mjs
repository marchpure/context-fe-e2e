// Property Suite 2：幂等性离线观测契约属性测试（本仓库负责回执与跨快照验收校验，不伪造后端状态机自测）。
// 覆盖：
// 1. 未改动内容重扫零增量（SRC-04 / SRC-08，含 TOS 白名单范围隔离与不重复入队索引）
// 2. 同一逻辑文档更新推进同一资产修订（SRC-01 / SRC-04 / ENR-02 / REL-04，零额外行、兄弟资产与已发布冻结版本不变）
// 3. 重复点击/触发知识加工与运行中刷新重入不产生脏并发状态（ENR-06）
// 4. 真实 IsolatedCdpPage signatureKey / duplicateApis 重复风暴探针与 classifyDraftTurnState 防回显/防旧消息幂等守卫

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, IsolatedCdpPage } from '../lib/cdpSession.mjs';
import {
  DRAFT_DEBUG_QUESTION,
  classifyDraftTurnState,
} from '../specs/08-draft-debug.spec.mjs';
import {
  validateLogicalDocumentUpdateObservation,
  validateRepeatedEnrichmentTriggerObservation,
  validateUnchangedRescanObservation,
} from './support/observationContracts.mjs';
import { assertProperty, assertPropertyAsync } from './support/propHarness.mjs';

const FILE = 'test/idempotency-observations.property.test.mjs';

function buildAssetRows(rng, count, prefix = 'codex-e2e-doc') {
  return Array.from({ length: count }, (_, idx) => {
    const rev = rng.int(1, 5);
    return {
      logicalKey: `tos://bucket/${prefix}-${idx}.md`,
      name: `${prefix}-${idx}.md`,
      assetId: `r_${rng.hex(16)}_${idx}`,
      revision: rng.pick([rev, String(rev), `v${rev}`]),
      contentHash: `sha256:${rng.hex(16)}`,
      indexLabel: '已就绪',
      bodyPreview: `合成正文 v${rev} 段落 #${idx}`,
    };
  });
}

function validTimestamp(rng, minuteOffset = 0) {
  const day = String(rng.int(10, 25)).padStart(2, '0');
  const totalMin = 600 + minuteOffset;
  const hh = String(Math.floor(totalMin / 60) % 24).padStart(2, '0');
  const mm = String(totalMin % 60).padStart(2, '0');
  return `2026-11-${day} ${hh}:${mm}:15`;
}

test('P2.1 未改动内容重扫观测契约：接受任意合法零增量前后快照与白名单范围（含修订格式差异） (260 cases)', () => {
  assertProperty(
    {
      name: 'P2.1 Valid zero-delta rescan observations pass',
      seed: 0x52020001,
      runs: 260,
      file: FILE,
      generate(rng) {
        const count = rng.int(1, 8);
        const rows = buildAssetRows(rng, count);
        const permuteAfterOrder = rng.bool(0.6);
        const afterRows = (permuteAfterOrder ? rng.shuffle(rows) : rows).map(r => ({
          ...r,
          // 允许不同接口返回 '2' vs 'v2' 等价表示，但修订数值与 assetId 不变
          revision: typeof r.revision === 'number' ? `v${r.revision}` : r.revision,
        }));
        const enforceTosWhitelist = rng.bool(0.5);
        return {
          before: {
            rows,
            overviewScaleText: `${count} 篇文档`,
          },
          after: {
            rows: afterRows,
            overviewScaleText: `${count} 篇文档`,
          },
          scanReceipt: {
            jobId: `scan-${rng.hex(8)}`,
            status: rng.pick(['SUCCEEDED', '已完成', '成功']),
            addedCount: 0,
            updatedCount: 0,
            deletedCount: 0,
            failedCount: 0,
            queuedIndexJobs: 0,
            completedAt: validTimestamp(rng, rng.int(1, 40)),
          },
          selectedScopeKeys: enforceTosWhitelist ? rows.map(r => r.logicalKey) : null,
        };
      },
    },
    obs => {
      const verdict = validateUnchangedRescanObservation(obs);
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(verdict.assetCount, obs.before.rows.length);
    }
  );
});

test('P2.2 未改动内容重扫观测契约：100% 拦截重扫衍生重复行、未勾选前缀混入、回执虚报 0 增量、无改动推进修订与重复入队索引 (280 cases)', () => {
  assertProperty(
    {
      name: 'P2.2 Corrupted rescan observations are rejected',
      seed: 0x52020002,
      runs: 280,
      file: FILE,
      generate(rng) {
        const count = rng.int(1, 5);
        const rows = buildAssetRows(rng, count);
        const violation = rng.pick([
          'non_zero_added_in_receipt',
          'non_zero_updated_in_receipt',
          'silent_extra_row_with_zero_receipt',
          'duplicate_logical_key_row',
          'unselected_tos_sibling_ingested',
          'asset_id_churned',
          'revision_bumped_on_unchanged',
          'content_hash_changed_on_noop',
          'redundant_index_requeue',
          'epoch_1970_receipt_timestamp',
          'scan_still_running',
          'overview_scale_drift',
        ]);
        return { rows, count, violation };
      },
      *shrink(s) {
        if (s.rows.length > 1) {
          yield { ...s, rows: s.rows.slice(0, 1), count: 1 };
        }
      },
    },
    s => {
      const before = { rows: s.rows, overviewScaleText: `${s.rows.length} 篇文档` };
      const afterRows = s.rows.map(r => ({ ...r }));
      const after = { rows: afterRows, overviewScaleText: `${s.rows.length} 篇文档` };
      const scanReceipt = {
        jobId: 'scan-bad-1',
        status: '已完成',
        addedCount: 0,
        updatedCount: 0,
        deletedCount: 0,
        failedCount: 0,
        queuedIndexJobs: 0,
        completedAt: '2026-11-25 13:10:00',
      };
      let selectedScopeKeys = s.rows.map(r => r.logicalKey);

      if (s.violation === 'non_zero_added_in_receipt') {
        scanReceipt.addedCount = 1;
      } else if (s.violation === 'non_zero_updated_in_receipt') {
        scanReceipt.updatedCount = 1;
      } else if (s.violation === 'silent_extra_row_with_zero_receipt') {
        const extraKey = 'tos://bucket/codex-e2e-phantom.md';
        selectedScopeKeys = [...selectedScopeKeys, extraKey];
        after.rows.push({
          logicalKey: extraKey,
          assetId: 'r_phantom_99',
          revision: 1,
          contentHash: 'sha256:99',
          indexLabel: '已就绪',
        });
      } else if (s.violation === 'duplicate_logical_key_row') {
        after.rows.push({ ...after.rows[0], assetId: 'r_dup_extra_row' });
      } else if (s.violation === 'unselected_tos_sibling_ingested') {
        after.rows.push({
          logicalKey: 'tos://bucket/unselected-sibling.md',
          assetId: 'r_unselected_1',
          revision: 1,
          contentHash: 'sha256:unselected',
          indexLabel: '已就绪',
        });
      } else if (s.violation === 'asset_id_churned') {
        after.rows[0] = { ...after.rows[0], assetId: 'r_replaced_id_on_noop' };
      } else if (s.violation === 'revision_bumped_on_unchanged') {
        after.rows[0] = { ...after.rows[0], revision: 99 };
      } else if (s.violation === 'content_hash_changed_on_noop') {
        after.rows[0] = { ...after.rows[0], contentHash: 'sha256:mutated_without_update' };
      } else if (s.violation === 'redundant_index_requeue') {
        scanReceipt.queuedIndexJobs = 1;
      } else if (s.violation === 'epoch_1970_receipt_timestamp') {
        scanReceipt.completedAt = '1970-01-01 08:00:00';
      } else if (s.violation === 'scan_still_running') {
        scanReceipt.status = 'RUNNING';
      } else if (s.violation === 'overview_scale_drift') {
        after.overviewScaleText = `${s.rows.length + 1} 篇文档`;
      }

      const verdict = validateUnchangedRescanObservation({
        before,
        after,
        scanReceipt,
        selectedScopeKeys,
      });
      assert.equal(
        verdict.ok,
        false,
        `违规场景 ${s.violation} 必须被未改动重扫校验器拦截`
      );
    }
  );
});

test('P2.3 同逻辑文档更新观测契约：推进同一 assetId 与修订号、保持总行数与兄弟资产不变并保护历史发布版本 R1 冻结快照 (260 cases)', () => {
  assertProperty(
    {
      name: 'P2.3 Valid logical document update advances single asset cleanly',
      seed: 0x52020003,
      runs: 260,
      file: FILE,
      generate(rng) {
        const count = rng.int(1, 6);
        const rows = buildAssetRows(rng, count, 'codex-e2e-refund');
        const targetIdx = rng.int(0, count - 1);
        const prevRevNum = Number(String(rows[targetIdx].revision).replace(/^v/i, ''));
        const nextRevNum = prevRevNum + rng.int(1, 3);
        const newMarker = `退款时效更新为 ${rng.int(7, 30)} 个工作日`;

        const afterRows = rng.shuffle(
          rows.map((r, idx) =>
            idx === targetIdx
              ? {
                  ...r,
                  revision: rng.pick([nextRevNum, `v${nextRevNum}`]),
                  contentHash: `sha256:updated_${rng.hex(12)}`,
                  bodyPreview: newMarker,
                }
              : { ...r }
          )
        );

        return {
          before: { rows },
          after: {
            rows: afterRows,
            detailPreview: {
              bodyText: `# 退款规则\n${newMarker}`,
              updatedAtText: validTimestamp(rng, 25),
            },
          },
          updateSpec: {
            logicalKey: rows[targetIdx].logicalKey,
            expectedNextRevision: nextRevNum,
            expectedBodySubstring: newMarker,
          },
          scanReceipt: {
            status: '已完成',
            addedCount: 0,
            updatedCount: 1,
            deletedCount: 0,
            failedCount: 0,
          },
          priorPublishedReleases: [
            {
              version: '1.0.1',
              frozenRevision: String(prevRevNum),
              expectedFrozenRevision: prevRevNum,
            },
          ],
        };
      },
    },
    obs => {
      const verdict = validateLogicalDocumentUpdateObservation(obs);
      assert.equal(verdict.ok, true, verdict.reason);
      assert.equal(verdict.nextRevision > verdict.previousRevision, true);
    }
  );
});

test('P2.4 同逻辑文档更新观测契约：拒绝更新变成新增重复行、替换 assetId、修订未递增、污染兄弟资产、详情残留旧文或篡改 R1 冻结修订 (280 cases)', () => {
  assertProperty(
    {
      name: 'P2.4 Invalid logical document update observations are rejected',
      seed: 0x52020004,
      runs: 280,
      file: FILE,
      generate(rng) {
        const count = rng.int(2, 5);
        const rows = buildAssetRows(rng, count, 'codex-e2e-policy');
        const violation = rng.pick([
          'append_extra_row_instead_of_in_place_update',
          'replace_asset_id_while_dropping_sibling',
          'revision_not_incremented',
          'revision_regressed',
          'sibling_revision_mutated',
          'detail_preview_shows_stale_v1_body',
          'scan_receipt_reports_added_instead_of_updated',
          'prior_frozen_release_retroactively_bumped',
        ]);
        return { rows, violation };
      },
      *shrink(s) {
        if (s.rows.length > 2) yield { ...s, rows: s.rows.slice(0, 2) };
      },
    },
    s => {
      const target = s.rows[0];
      const prevRev = Number(String(target.revision).replace(/^v/i, ''));
      const nextRev = prevRev + 1;
      const expectedBody = '更新后新口径 15 天';

      const before = { rows: s.rows };
      const afterRows = s.rows.map((r, idx) =>
        idx === 0
          ? { ...r, revision: nextRev, contentHash: 'sha256:new', bodyPreview: expectedBody }
          : { ...r }
      );
      const after = {
        rows: afterRows,
        detailPreview: { bodyText: expectedBody, updatedAtText: '2026-11-25 14:00:00' },
      };
      const scanReceipt = {
        status: '已完成',
        addedCount: 0,
        updatedCount: 1,
        deletedCount: 0,
        failedCount: 0,
      };
      const priorPublishedReleases = [
        { version: '1.0.1', frozenRevision: String(prevRev), expectedFrozenRevision: prevRev },
      ];

      if (s.violation === 'append_extra_row_instead_of_in_place_update') {
        after.rows = [
          ...s.rows,
          {
            ...target,
            logicalKey: `${target.logicalKey}#dup`,
            assetId: 'r_extra_appended',
            revision: nextRev,
          },
        ];
      } else if (s.violation === 'replace_asset_id_while_dropping_sibling') {
        after.rows[0] = { ...after.rows[0], assetId: 'r_brand_new_id' };
      } else if (s.violation === 'revision_not_incremented') {
        after.rows[0] = { ...after.rows[0], revision: prevRev };
      } else if (s.violation === 'revision_regressed') {
        before.rows = [{ ...target, revision: 3 }, ...s.rows.slice(1)];
        after.rows[0] = { ...after.rows[0], revision: 2 };
      } else if (s.violation === 'sibling_revision_mutated') {
        const sibRev = Number(String(after.rows[1].revision).replace(/^v/i, ''));
        after.rows[1] = { ...after.rows[1], revision: sibRev + 1 };
      } else if (s.violation === 'detail_preview_shows_stale_v1_body') {
        after.detailPreview.bodyText = '旧版口径 7 天（缓存未刷新）';
      } else if (s.violation === 'scan_receipt_reports_added_instead_of_updated') {
        scanReceipt.addedCount = 1;
        scanReceipt.updatedCount = 0;
      } else if (s.violation === 'prior_frozen_release_retroactively_bumped') {
        priorPublishedReleases[0].frozenRevision = String(nextRev);
      }

      const verdict = validateLogicalDocumentUpdateObservation({
        before,
        after,
        updateSpec: {
          logicalKey: target.logicalKey,
          expectedBodySubstring: expectedBody,
        },
        scanReceipt,
        priorPublishedReleases,
      });
      assert.equal(verdict.ok, false, `更新违规 ${s.violation} 必须被拦截`);
    }
  );
});

test('P2.5 重复触发知识加工与运行中刷新观测契约：接受防重禁用、409/Conflict 明确拒绝及幂等复用同一 RunId，并拒绝并发双任务或进度倒退 (300 cases)', () => {
  assertProperty(
    {
      name: 'P2.5 Enrichment repeated trigger & refresh re-entry idempotency contract',
      seed: 0x52020005,
      runs: 300,
      file: FILE,
      generate(rng) {
        const validCase = rng.bool(0.5);
        const clickCount = rng.int(2, 5);
        const runId = `enr-${rng.hex(12)}`;
        const secondRunId = `enr-${rng.hex(12)}-dup`;
        const stageBefore = rng.int(1, 3);
        const validStrategy = rng.pick([
          'ui_disabled_after_first_click',
          'backend_409_conflict_on_repeats',
          'backend_http200_conflict_code_on_repeats',
          'backend_idempotent_same_run_id',
        ]);
        const invalidKind = rng.pick([
          'two_concurrent_running_rows',
          'two_distinct_200_run_ids',
          'disabled_ui_still_sent_network_request',
          'refresh_lost_run_id',
          'refresh_stage_progress_regressed',
          'repeat_returned_500_internal_error',
        ]);
        return {
          validCase,
          clickCount,
          runId,
          secondRunId,
          stageBefore,
          validStrategy,
          invalidKind,
        };
      },
      *shrink(s) {
        if (s.clickCount > 2) yield { ...s, clickCount: 2 };
      },
    },
    s => {
      const domainId = 'dom-codex-e2e-1125';

      if (s.validCase) {
        const attempts = Array.from({ length: s.clickCount }, (_, idx) => {
          if (idx === 0) {
            return {
              blockedByDisabledUi: false,
              networkSent: true,
              httpStatus: 200,
              errorCode: null,
              runId: s.runId,
            };
          }
          if (s.validStrategy === 'ui_disabled_after_first_click') {
            return { blockedByDisabledUi: true, networkSent: false };
          }
          if (s.validStrategy === 'backend_409_conflict_on_repeats') {
            return {
              blockedByDisabledUi: false,
              networkSent: true,
              httpStatus: 409,
              errorCode: 'TaskAlreadyRunning',
              runId: null,
            };
          }
          if (s.validStrategy === 'backend_http200_conflict_code_on_repeats') {
            return {
              blockedByDisabledUi: false,
              networkSent: true,
              httpStatus: 200,
              errorCode: 'Conflict',
              runId: null,
            };
          }
          return {
            blockedByDisabledUi: false,
            networkSent: true,
            httpStatus: 200,
            errorCode: null,
            runId: s.runId,
          };
        });

        const res = validateRepeatedEnrichmentTriggerObservation({
          domainId,
          triggerAttempts: attempts,
          runHistoryRows: [
            {
              runId: s.runId,
              domainId,
              status: '运行中',
              createdAt: '2026-11-25 14:05:00',
            },
            {
              runId: 'enr-historical-done',
              domainId,
              status: '已完成',
              createdAt: '2026-11-25 11:00:00',
            },
          ],
          reenteredView: {
            runId: s.runId,
            beforeRefreshStageCount: s.stageBefore,
            completedStageCount: s.stageBefore + 1,
          },
        });
        assert.equal(res.ok, true, res.reason);
        assert.equal(res.canonicalRunId, s.runId);
        return;
      }

      // 非法观测集：必须全部拒绝
      let triggerAttempts = [
        { blockedByDisabledUi: false, networkSent: true, httpStatus: 200, runId: s.runId },
        { blockedByDisabledUi: true, networkSent: false },
      ];
      let runHistoryRows = [
        { runId: s.runId, domainId, status: '运行中', createdAt: '2026-11-25 14:05:00' },
      ];
      let reenteredView = {
        runId: s.runId,
        beforeRefreshStageCount: s.stageBefore,
        completedStageCount: s.stageBefore,
      };

      if (s.invalidKind === 'two_concurrent_running_rows') {
        runHistoryRows.push({
          runId: s.secondRunId,
          domainId,
          status: '排队中',
          createdAt: '2026-11-25 14:05:01',
        });
      } else if (s.invalidKind === 'two_distinct_200_run_ids') {
        triggerAttempts = [
          { blockedByDisabledUi: false, networkSent: true, httpStatus: 200, runId: s.runId },
          { blockedByDisabledUi: false, networkSent: true, httpStatus: 200, runId: s.secondRunId },
        ];
      } else if (s.invalidKind === 'disabled_ui_still_sent_network_request') {
        triggerAttempts = [
          { blockedByDisabledUi: false, networkSent: true, httpStatus: 200, runId: s.runId },
          { blockedByDisabledUi: true, networkSent: true, httpStatus: 200, runId: s.runId },
        ];
      } else if (s.invalidKind === 'refresh_lost_run_id') {
        reenteredView = {
          runId: s.secondRunId,
          beforeRefreshStageCount: s.stageBefore,
          completedStageCount: s.stageBefore,
        };
      } else if (s.invalidKind === 'refresh_stage_progress_regressed') {
        reenteredView = {
          runId: s.runId,
          beforeRefreshStageCount: s.stageBefore,
          completedStageCount: s.stageBefore - 1,
        };
      } else if (s.invalidKind === 'repeat_returned_500_internal_error') {
        triggerAttempts = [
          { blockedByDisabledUi: false, networkSent: true, httpStatus: 200, runId: s.runId },
          {
            blockedByDisabledUi: false,
            networkSent: true,
            httpStatus: 500,
            errorCode: 'InternalError',
            runId: null,
          },
        ];
      }

      const badRes = validateRepeatedEnrichmentTriggerObservation({
        domainId,
        triggerAttempts,
        runHistoryRows,
        reenteredView,
      });
      assert.equal(badRes.ok, false, `脏并发/刷新异常 ${s.invalidKind} 必须被拦截`);
    }
  );
});

test('P2.6 真实采集器重复请求风暴计数（duplicateApis）与草稿问答防旧消息/防回显重放守卫属性 (220 cases)', async () => {
  await assertPropertyAsync(
    {
      name: 'P2.6 IsolatedCdpPage duplicateApis storm threshold & classifyDraftTurnState replay guards',
      seed: 0x52020007,
      runs: 220,
      file: FILE,
      generate(rng) {
        return {
          identicalRepeatCount: rng.int(1, 6),
          distinctPageCount: rng.int(1, 3),
          baselineAssistantCount: rng.int(0, 3),
          replayTrap: rng.pick(['user_question_echo', 'stale_baseline_only', 'still_streaming', 'fresh_valid_answer']),
        };
      },
      *shrink(s) {
        if (s.identicalRepeatCount > 3) yield { ...s, identicalRepeatCount: 3 };
        if (s.distinctPageCount > 1) yield { ...s, distinctPageCount: 1 };
      },
    },
    async s => {
      const cfg = { ...DEFAULT_CONFIG };
      const page = new IsolatedCdpPage(cfg);
      const step = 'p2-dup-storm';
      page.setStep(step);
      page.send = async () => ({ body: '{}' });
      page.evalJSON = async () => ({
        href: page.buildContextUrl('/context/processing'),
        visibleText: '加工记录 2026-11-25 14:10:00',
        frontendVersions: [],
      });

      let seq = 0;
      // 同一 payload 连续发 identicalRepeatCount 次
      for (let i = 0; i < s.identicalRepeatCount; i += 1) {
        const reqId = `dup-${++seq}`;
        page._onMessage(
          JSON.stringify({
            method: 'Network.requestWillBeSent',
            params: {
              requestId: reqId,
              timestamp: 10 + i * 0.1,
              type: 'Fetch',
              request: {
                url: 'https://console.volcengine.com/api/top/agentkit?Action=ListContextTasks',
                method: 'POST',
                postData: JSON.stringify({ WorkspaceId: cfg.workspaceId, PageNumber: 1 }),
              },
            },
          })
        );
        page._onMessage(
          JSON.stringify({
            method: 'Network.responseReceived',
            params: { requestId: reqId, response: { status: 200 } },
          })
        );
        page._onMessage(
          JSON.stringify({
            method: 'Network.loadingFinished',
            params: { requestId: reqId, timestamp: 10.05 + i * 0.1 },
          })
        );
      }

      // 不同分页参数各发 1 次，不应被误计入同一签名风暴
      for (let p = 2; p < 2 + s.distinctPageCount; p += 1) {
        const reqId = `page-${++seq}`;
        page._onMessage(
          JSON.stringify({
            method: 'Network.requestWillBeSent',
            params: {
              requestId: reqId,
              timestamp: 20 + p * 0.1,
              type: 'Fetch',
              request: {
                url: 'https://console.volcengine.com/api/top/agentkit?Action=ListContextTasks',
                method: 'POST',
                postData: JSON.stringify({ WorkspaceId: cfg.workspaceId, PageNumber: p }),
              },
            },
          })
        );
        page._onMessage(
          JSON.stringify({
            method: 'Network.loadingFinished',
            params: { requestId: reqId, timestamp: 20.05 + p * 0.1 },
          })
        );
      }

      const oracle = await page.collectStepOracle(step);
      if (s.identicalRepeatCount >= 3) {
        assert.equal(oracle.duplicateApis.length, 1);
        assert.equal(oracle.duplicateApis[0].action, 'ListContextTasks');
        assert.equal(oracle.duplicateApis[0].count, s.identicalRepeatCount);
      } else {
        assert.equal(oracle.duplicateApis.length, 0);
      }

      // 验证草稿调试轮次分类器对旧消息重放、问题回显、流式未完结的幂等防假绿
      const expectedAsset = 'codex-e2e-orders-1125';
      const oldAssistants = Array.from({ length: s.baselineAssistantCount }, (_, idx) => ({
        cleanText: `历史回答 #${idx} 已提到 ${expectedAsset}`,
        artifactText: '',
        alerts: [],
        pending: false,
      }));
      const oldUsers = Array.from({ length: s.baselineAssistantCount }, (_, idx) => ({
        text: `历史提问 #${idx}`,
      }));

      let newAssistants = [];
      let composerSending = false;
      if (s.replayTrap === 'user_question_echo') {
        newAssistants = [{ cleanText: DRAFT_DEBUG_QUESTION, artifactText: '', alerts: [] }];
      } else if (s.replayTrap === 'stale_baseline_only') {
        newAssistants = [];
      } else if (s.replayTrap === 'still_streaming') {
        composerSending = true;
        newAssistants = [{ cleanText: `正在查询 ${expectedAsset}`, artifactText: '', alerts: [], pending: true }];
      } else {
        newAssistants = [{ cleanText: `当前草稿包含合成表 ${expectedAsset}。`, artifactText: '', alerts: [], pending: false }];
      }

      const turnVerdict = classifyDraftTurnState({
        dom: {
          composerSending,
          waitHintText: '',
          userMessages: [...oldUsers, { text: DRAFT_DEBUG_QUESTION }],
          assistantMessages: [...oldAssistants, ...newAssistants],
        },
        baseline: {
          userCount: oldUsers.length,
          assistantCount: oldAssistants.length,
          assistantTexts: oldAssistants.map(m => m.cleanText),
        },
        expectedAssets: [expectedAsset],
      });

      if (s.replayTrap === 'fresh_valid_answer') {
        assert.equal(turnVerdict.state, 'passed');
      } else {
        assert.equal(turnVerdict.state, 'pending');
      }
    }
  );
});
