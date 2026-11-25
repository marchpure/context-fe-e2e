import assert from 'node:assert/strict';
import test from 'node:test';
import { TestContext, gateExitCode } from '../lib/testContext.mjs';
import {
  DRAFT_DEBUG_QUESTION,
  MAX_DRAFT_DEBUG_BUDGET_MS,
  STAGE_TITLES,
  clampBudgetMs,
  classifyDraftTurnState,
  evaluateSendGate,
  extractTurnPayloadDiagnostics,
  formatSanitizedApiEvidence,
  isSyntheticDomainName,
  redactSensitiveText,
  resolveDraftDebugFixture,
  run,
  verifyWorkbenchDraftBinding,
} from '../specs/08-draft-debug.spec.mjs';

class FakeWs extends EventTarget {
  emitCdp(method, params) {
    this.dispatchEvent(
      new MessageEvent('message', {
        data: JSON.stringify({ method, params }),
      })
    );
  }
}

function createHarnessPage({
  workspaceId = '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
  project = 'default',
  scenario = 'gateway_forbidden_behind_ui_incomplete',
  domainId = 'dom-draft-001',
  sentDomainId = domainId,
  domainName = 'codex-e2e-draft-ledger',
  expectedAsset = 'codex-e2e-orders-table',
} = {}) {
  const ws = new FakeWs();
  const cdpCalls = [];
  const evalExpressions = [];
  const stepRecordsMap = new Map();
  const responseBodies = new Map();

  let currentStep = 'init';
  let href = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/domains/${domainId}/detail?workspaceId=${workspaceId}&project=${project}`;
  let activeDetailTab = 'tool';
  let composerText = '';
  let sendClickCount = 0;
  let pollAfterSend = 0;

  const pushRecord = rec => {
    const arr = stepRecordsMap.get(currentStep) || [];
    arr.push(rec);
    stepRecordsMap.set(currentStep, arr);
  };

  const page = {
    ws,
    cdpCalls,
    evalExpressions,
    getSendClickCount: () => sendClickCount,
    setStep(step) {
      currentStep = step;
    },
    stepRecords(step = currentStep) {
      return stepRecordsMap.get(step) || [];
    },
    async flushResponseMetadata() {},
    async screenshot(name) {
      return `/tmp/mock_${name}.webp`;
    },
    async sleep() {},
    async gotoContext(subpath, { stepName } = {}) {
      if (stepName) currentStep = stepName;
      href = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2${subpath}?workspaceId=${workspaceId}&project=${project}`;
      pushRecord({
        step: currentStep,
        action: subpath.includes('/detail') ? 'GetContextDomain' : 'ListContextDomains',
        httpStatus: 200,
        durationMs: 180,
        requestId: 'req-nav-001',
        errorCode: null,
      });
      return {
        url: href,
        finalHref: href,
        title: 'Context',
        bodySample: domainName,
        firstContentMs: 320,
        settledOk: true,
        settledValue: domainName,
      };
    },
    async collectStepOracle(step = currentStep) {
      const u = new URL(href);
      return {
        href,
        urlWorkspaceId: u.searchParams.get('workspaceId'),
        urlWorkspaceOk: u.searchParams.get('workspaceId') === workspaceId,
        urlProjectOk: u.searchParams.get('project') === project,
        forbiddenWorkspaceHit: href.includes('ws-7710414566965542920'),
        pageErrors: [],
        has1970Timestamp: false,
        slowApis: [],
        duplicateApis: [],
        pendingApis: [],
        records: page.stepRecords(step),
        visibleText: '',
      };
    },
    async waitFor(predicateFn) {
      const val = await page.evalJSON(predicateFn);
      return { ok: Boolean(val), elapsedMs: 25, value: val };
    },
    async send(method, params = {}) {
      cdpCalls.push({ method, params });
      if (method === 'Network.getResponseBody') {
        return responseBodies.get(params.requestId) || { body: '', base64Encoded: false };
      }
      if (method === 'Input.insertText') {
        composerText += params.text || '';
        return {};
      }
      if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
        const { x, y } = params;
        // MCP 服务 Tab 坐标区 (x: 200..300, y: 120..160)
        if (x >= 200 && x <= 300 && y >= 120 && y <= 160) {
          activeDetailTab = 'versions';
          pushRecord({
            step: currentStep,
            action: 'ListContextDomainReleases',
            httpStatus: 200,
            durationMs: 145,
            requestId: 'req-releases-001',
            errorCode: null,
          });
        }
        // 独立草稿行「调试」按钮坐标区 (x: 760..820, y: 240..280)
        if (x >= 760 && x <= 820 && y >= 240 && y <= 280) {
          href = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/workbench?workspaceId=${workspaceId}&project=${project}&tab=chat&draftDomainId=${domainId}`;
          pushRecord({
            step: currentStep,
            action: 'ListContextDomains',
            httpStatus: 200,
            durationMs: 210,
            requestId: 'req-wb-domains-001',
            errorCode: null,
          });
          pushRecord({
            step: currentStep,
            action: 'ListContextModels',
            httpStatus: 200,
            durationMs: 130,
            requestId: 'req-wb-models-001',
            errorCode: null,
          });
        }
        // 工作台发送按钮坐标区 (x: 820..870, y: 760..810)
        if (x >= 820 && x <= 870 && y >= 760 && y <= 810) {
          sendClickCount += 1;
          composerText = '';
          pollAfterSend = 0;

          pushRecord({
            step: currentStep,
            action: 'SendContextWorkbenchMessage',
            httpStatus: 200,
            durationMs: 265,
            requestId: 'req-send-msg-001',
            errorCode: null,
          });
          pushRecord({
            step: currentStep,
            action: 'GetContextWorkbenchTurn',
            httpStatus: 200,
            durationMs: 1840,
            requestId: 'req-turn-001',
            errorCode: null,
          });

          ws.emitCdp('Network.requestWillBeSent', {
            requestId: 'cdp-send-1',
            request: {
              url: 'https://console.volcengine.com/api/top/agentkit_stg/cn-beijing/2025-10-30/SendContextWorkbenchMessage',
              postData: JSON.stringify({
                Action: 'SendContextWorkbenchMessage',
                WorkspaceId: workspaceId,
                ProjectName: project,
                DomainId: sentDomainId,
                TargetKind: 'DRAFT',
                ExpectedDraftRevision: 3,
                Question: DRAFT_DEBUG_QUESTION,
                ArkApiKey: 'sk-super-secret-do-not-leak',
              }),
            },
          });
          responseBodies.set('cdp-send-1', {
            base64Encoded: false,
            body: JSON.stringify({
              ResponseMetadata: { RequestId: 'req-send-msg-001' },
              Result: {
                RunId: 'turn-draft-1',
                TurnId: 'turn-draft-1',
                Session: {
                  SessionId: 'sess-draft-1',
                  TargetKind: 'DRAFT',
                  DraftRevision: 3,
                  DomainIds: [domainId],
                  PinnedDomainReleases: {},
                },
                Turn: { TurnId: 'turn-draft-1', Status: 'RUNNING' },
              },
            }),
          });
          ws.emitCdp('Network.loadingFinished', { requestId: 'cdp-send-1' });

          if (scenario === 'gateway_forbidden_behind_ui_incomplete') {
            ws.emitCdp('Network.requestWillBeSent', {
              requestId: 'cdp-turn-1',
              request: {
                url: 'https://console.volcengine.com/api/top/agentkit_stg/cn-beijing/2025-10-30/GetContextWorkbenchTurn?stream=1',
                postData: '',
              },
            });
            responseBodies.set('cdp-turn-1', {
              base64Encoded: false,
              body: [
                'event: ready',
                'data: {"ok":true}',
                '',
                'event: agent',
                `data: ${JSON.stringify({
                  id: 'ev-1',
                  runId: 'turn-draft-1',
                  type: 'failed',
                  code: 'AGENT_RUN_FAILED',
                  message:
                    'Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id=dr-003 Bearer secret-tok-999',
                })}`,
                '',
                'event: end',
                'data: {"end":"done"}',
                '',
              ].join('\n'),
            });
            ws.emitCdp('Network.loadingFinished', { requestId: 'cdp-turn-1' });
          } else if (scenario === 'pass_with_synthetic_asset') {
            ws.emitCdp('Network.requestWillBeSent', {
              requestId: 'cdp-turn-ok',
              request: {
                url: 'https://console.volcengine.com/api/top/agentkit?Action=GetContextWorkbenchTurn',
                postData: '',
              },
            });
            responseBodies.set('cdp-turn-ok', {
              base64Encoded: false,
              body: JSON.stringify({
                ResponseMetadata: { RequestId: 'req-turn-001' },
                Result: {
                  Done: true,
                  Turn: {
                    TurnId: 'turn-draft-1',
                    Status: 'SUCCEEDED',
                    AnswerMarkdown: `当前草稿领域包含合成数据表 ${expectedAsset} 及关联口径文档。`,
                    Steps: [],
                  },
                  Events: [{ id: 'ev-idle', runId: 'turn-draft-1', type: 'idle', durationMs: 1840 }],
                },
              }),
            });
            ws.emitCdp('Network.loadingFinished', { requestId: 'cdp-turn-ok' });
          }
        }
      }
      return {};
    },
    async evalJSON(fnOrExpr) {
      const exprStr = typeof fnOrExpr === 'function' ? fnOrExpr.toString() : String(fnOrExpr);
      evalExpressions.push(exprStr);

      // 断言只读契约：任何 evalJSON 表达式不得包含 .click( 或直接改写 input.value
      assert.equal(
        /\.click\s*\(/.test(exprStr),
        false,
        `evalJSON 必须保持只读，禁止在页面脚本内调用 .click(): ${exprStr.slice(0, 140)}`
      );

      if (exprStr.includes('window.location.href') && exprStr.length < 80) {
        return href;
      }
      if (exprStr.includes('versionsTabRect')) {
        return {
          notFound: false,
          title: domainName,
          versionsTabRect: { x: 220, y: 130, width: 60, height: 24 },
        };
      }
      if (exprStr.includes('领域版本') && exprStr.includes('arco-spin-loading')) {
        return activeDetailTab === 'versions';
      }
      if (exprStr.includes('draftRow') && exprStr.includes('releaseVersions')) {
        if (scenario === 'missing_draft_debug_button') {
          return {
            loadError: false,
            rowCount: 2,
            draftRow: {
              idx: 0,
              cells: ['草稿', '—', '待发布', '—', '—', '—'],
              buttons: [],
            },
            releaseVersions: ['1.0.0'],
          };
        }
        return {
          loadError: false,
          rowCount: 2,
          draftRow: {
            idx: 0,
            cells: ['草稿', '—', '待发布', '—', '—', '调试 发布'],
            buttons: [
              {
                text: '调试',
                disabled: false,
                rect: { x: 770, y: 250, width: 40, height: 24 },
              },
            ],
          },
          releaseVersions: ['1.0.0'],
        };
      }
      if (exprStr.includes('加载领域') && exprStr.includes('加载模型')) {
        return href.includes('/context/workbench');
      }
      if (exprStr.includes('queryWorkbenchDomSnapshot') || exprStr.includes('业务领域与版本')) {
        const selectedDomainLabel =
          scenario === 'workbench_selects_release_by_mistake'
            ? `${domainName} · 1.0.0`
            : scenario === 'workbench_rejects_draft_entry'
              ? ''
              : `${domainName} · 草稿`;

        const baseSnap = {
          href,
          domainPicker: {
            found: true,
            value: selectedDomainLabel,
            placeholder: selectedDomainLabel ? '' : '选择领域版本',
            disabled: false,
          },
          modelPicker: {
            found: true,
            value: 'doubao-seed-1-6',
            placeholder: '',
            disabled: false,
          },
          composer: {
            found: true,
            disabled: scenario === 'workbench_rejects_draft_entry',
            text: composerText,
            rect: { x: 420, y: 740, width: 380, height: 48 },
            focused: true,
          },
          sendButton: {
            found: true,
            disabled: composerText.length === 0,
            ariaLabel: 'send',
            rect: { x: 830, y: 770, width: 32, height: 32 },
          },
          composerSending: false,
          waitHintText: '',
          threadAlerts: [],
          toasts:
            scenario === 'workbench_rejects_draft_entry'
              ? ['当前领域的草稿不可调试，请重新选择领域']
              : [],
          userMessages: [],
          assistantMessages: [],
        };

        if (sendClickCount === 0) {
          return baseSnap;
        }

        pollAfterSend += 1;
        baseSnap.userMessages = [{ text: DRAFT_DEBUG_QUESTION }];

        if (pollAfterSend === 1 || scenario === 'stuck_streaming_until_timeout') {
          // 模拟仍在流式生成中（测试防假阳性与超时兜底：绝不能在 streaming 时提前通过）
          return {
            ...baseSnap,
            composerSending: true,
            sendButton: { ...baseSnap.sendButton, ariaLabel: 'stop', disabled: false },
            waitHintText: '正在签发租户隔离凭证并连接领域工具 · 2 秒',
            assistantMessages: [
              {
                cleanText: `正在检索 ${expectedAsset}`,
                artifactText: '',
                alerts: [],
                toolErrors: [],
                pending: true,
                runningIndicator: true,
                flowRunning: true,
              },
            ],
          };
        }

        if (scenario === 'gateway_forbidden_behind_ui_incomplete') {
          return {
            ...baseSnap,
            assistantMessages: [
              {
                cleanText: '',
                artifactText: '',
                alerts: [
                  {
                    title: '本轮执行未完成',
                    content: '本轮执行未完成，请稍后重试',
                  },
                ],
                toolErrors: [],
                pending: false,
                runningIndicator: false,
                flowRunning: false,
              },
            ],
          };
        }

        if (scenario === 'ui_incomplete_only') {
          return {
            ...baseSnap,
            assistantMessages: [
              {
                cleanText: '',
                artifactText: '',
                alerts: [
                  {
                    title: '本轮执行未完成',
                    content: '模型连接暂时不可用，请稍后重试',
                  },
                ],
                toolErrors: [],
                pending: false,
                runningIndicator: false,
                flowRunning: false,
              },
            ],
          };
        }

        // pass_with_synthetic_asset
        return {
          ...baseSnap,
          assistantMessages: [
            {
              cleanText: `当前草稿领域包含合成数据表 ${expectedAsset} 及关联口径文档。`,
              artifactText: `参考来源\n${expectedAsset}`,
              alerts: [],
              toolErrors: [],
              pending: false,
              runningIndicator: false,
              flowRunning: false,
            },
          ],
        };
      }

      return true;
    },
  };

  return page;
}

test('发送门禁校验：默认只读或缺任一环境变量、或领域名非 codex-e2e- 开头时严禁放行发送', () => {
  const defaultFixture = resolveDraftDebugFixture({}, {});
  assert.equal(defaultFixture.runDraftQuery, false);
  assert.equal(defaultFixture.maxBudgetMs, MAX_DRAFT_DEBUG_BUDGET_MS);

  const defaultGate = evaluateSendGate(defaultFixture);
  assert.equal(defaultGate.allowed, false);
  assert.match(defaultGate.reason, /CONTEXT_E2E_RUN_DRAFT_QUERY=1/);
  assert.match(defaultGate.reason, /CONTEXT_E2E_DRAFT_DOMAIN_ID/);
  assert.match(defaultGate.reason, /CONTEXT_E2E_DRAFT_DOMAIN_NAME/);
  assert.match(defaultGate.reason, /CONTEXT_E2E_DRAFT_EXPECTED_ASSET/);

  // 名称未以 codex-e2e- 开头必须拦截
  const nonSynthetic = resolveDraftDebugFixture(
    {},
    {
      CONTEXT_E2E_RUN_DRAFT_QUERY: '1',
      CONTEXT_E2E_DRAFT_DOMAIN_ID: 'dom-123',
      CONTEXT_E2E_DRAFT_DOMAIN_NAME: 'prod-finance-domain',
      CONTEXT_E2E_DRAFT_EXPECTED_ASSET: 'orders',
    }
  );
  assert.equal(isSyntheticDomainName(nonSynthetic.explicitDomainName), false);
  const nonSyntheticGate = evaluateSendGate(nonSynthetic);
  assert.equal(nonSyntheticGate.allowed, false);
  assert.match(nonSyntheticGate.reason, /codex-e2e-/);

  // 预算上限封顶 120s
  assert.equal(clampBudgetMs(999_000), 120_000);
  assert.equal(clampBudgetMs('45000'), 45_000);

  // 四项条件齐全且名称以 codex-e2e- 开头才放行
  const validFixture = resolveDraftDebugFixture(
    {},
    {
      CONTEXT_E2E_RUN_DRAFT_QUERY: '1',
      CONTEXT_E2E_DRAFT_DOMAIN_ID: 'dom-123',
      CONTEXT_E2E_DRAFT_DOMAIN_NAME: 'codex-e2e-sales-draft',
      CONTEXT_E2E_DRAFT_EXPECTED_ASSET: 'codex-e2e-orders',
    }
  );
  const validGate = evaluateSendGate(validFixture, {
    workspaceValid: true,
    resolvedDomainId: 'dom-123',
    resolvedDomainName: 'codex-e2e-sales-draft',
    workbenchLockedSameDraft: true,
  });
  assert.equal(validGate.allowed, true);
});

test('脱敏工具：抹除凭据/Token/密码，但完整保留 Gateway MCP draft_version_id 错误证据', () => {
  const raw =
    'Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id=dr-9 Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig99999999 password="my-pwd" {"ArkApiKey":"sk-abc123"}';
  const sanitized = redactSensitiveText(raw, 400);
  assert.match(sanitized, /Workspace Gateway MCP tools\/list FORBIDDEN: draft_version_id=dr-9/);
  assert.equal(sanitized.includes('sk-abc123'), false);
  assert.equal(sanitized.includes('my-pwd'), false);
  assert.equal(sanitized.includes('eyJhbGciOiJIUzI1NiJ9'), false);
  assert.match(sanitized, /\[REDACTED/);

  const ev = formatSanitizedApiEvidence(
    [
      {
        action: 'GetContextWorkbenchTurn',
        httpStatus: 200,
        durationMs: 1520,
        requestId: '20261125REQ01',
        errorCode: null,
      },
    ],
    [
      {
        action: 'GetContextWorkbenchTurn',
        transport: 'sse',
        turnStatus: 'FAILED',
        sentTargetKind: 'DRAFT',
      },
    ]
  );
  assert.match(ev, /GetContextWorkbenchTurn HTTP=200 1520ms reqId=20261125REQ01/);
  assert.match(ev, /reqTarget=DRAFT/);
  assert.match(ev, /turnStatus=FAILED/);
});

test('工作台目标核验：严防误选已发布版本、跨工作区越界或丢失 draftDomainId', () => {
  const baseArgs = {
    href: 'https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/workbench?workspaceId=ws-safe&project=default&tab=chat&draftDomainId=dom-draft-1',
    expectedWorkspaceId: 'ws-safe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    expectedProject: 'default',
    expectedDomainId: 'dom-draft-1',
    expectedDomainName: 'codex-e2e-draft-1',
    domainPicker: { found: true, value: 'codex-e2e-draft-1 · 草稿', placeholder: '' },
    modelPicker: { found: true, value: 'doubao-seed-1-6', placeholder: '' },
    composer: { found: true, disabled: false },
    releaseVersions: ['1.0.0', '1.0.1'],
  };

  assert.equal(verifyWorkbenchDraftBinding(baseArgs).ok, true);

  const mistakenRelease = verifyWorkbenchDraftBinding({
    ...baseArgs,
    domainPicker: { found: true, value: 'codex-e2e-draft-1 · 1.0.1', placeholder: '' },
  });
  assert.equal(mistakenRelease.ok, false);
  assert.match(mistakenRelease.reason, /误将草稿串选为已发布版本/);

  const unselectableDraft = verifyWorkbenchDraftBinding({
    ...baseArgs,
    domainPicker: { found: true, value: '', placeholder: '选择领域版本' },
    toasts: ['当前领域的草稿不可调试，请重新选择领域'],
  });
  assert.equal(unselectableDraft.ok, false);
  assert.match(unselectableDraft.reason, /具备「调试」入口，但工作台拒绝识别该草稿/);

  const disabledPicker = verifyWorkbenchDraftBinding({
    ...baseArgs,
    domainPicker: { found: true, value: 'codex-e2e-draft-1 · 草稿', placeholder: '', disabled: true },
  });
  assert.equal(disabledPicker.ok, false);
  assert.match(disabledPicker.reason, /业务领域与版本.*禁用/);
});

test('轮次分类防假阳性：拒绝将用户原提问、旧消息、流式生成中或缺失合成资产的泛化回答判为通过', () => {
  // 1. 用户自己的提问回显不能判为通过
  const echoVerdict = classifyDraftTurnState({
    dom: {
      composerSending: false,
      waitHintText: '',
      userMessages: [{ text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [{ cleanText: DRAFT_DEBUG_QUESTION, artifactText: '', alerts: [] }],
    },
    baseline: { userCount: 0, assistantCount: 0, assistantTexts: [] },
    expectedAssets: ['codex-e2e-orders'],
  });
  assert.equal(echoVerdict.state, 'pending');

  // 2. 只有基线旧消息、没有新增助手回答时不能判为通过
  const staleVerdict = classifyDraftTurnState({
    dom: {
      composerSending: false,
      waitHintText: '',
      userMessages: [{ text: '旧问题' }, { text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [{ cleanText: '旧消息包含 codex-e2e-orders', artifactText: '', alerts: [] }],
    },
    baseline: {
      userCount: 1,
      assistantCount: 1,
      assistantTexts: ['旧消息包含 codex-e2e-orders'],
    },
    expectedAssets: ['codex-e2e-orders'],
  });
  assert.equal(staleVerdict.state, 'pending');

  // 3. 即使已出现资产名，但仍在流式生成（composerSending / pending）时严禁提前通过
  const streamingVerdict = classifyDraftTurnState({
    dom: {
      composerSending: true,
      waitHintText: '',
      userMessages: [{ text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [
        {
          cleanText: '正在输出 codex-e2e-orders…',
          artifactText: '',
          alerts: [],
          pending: true,
        },
      ],
    },
    baseline: { userCount: 0, assistantCount: 0, assistantTexts: [] },
    expectedAssets: ['codex-e2e-orders'],
  });
  assert.equal(streamingVerdict.state, 'pending');

  // 4. 回复已完成但未命中预期合成资产必须判为失败
  const missingAssetVerdict = classifyDraftTurnState({
    dom: {
      composerSending: false,
      waitHintText: '',
      userMessages: [{ text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [
        {
          cleanText: '抱歉，当前暂时没有查询到任何可用表或知识。',
          artifactText: '',
          alerts: [],
          pending: false,
        },
      ],
    },
    baseline: { userCount: 0, assistantCount: 0, assistantTexts: [] },
    expectedAssets: ['codex-e2e-orders'],
  });
  assert.equal(missingAssetVerdict.state, 'failed');
  assert.equal(missingAssetVerdict.failureKind, 'MISSING_EXPECTED_SYNTHETIC_ASSET');
});

test('失败证据区分：清晰拆分页面错误「本轮执行未完成」与执行端 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id', () => {
  const sseDiag = extractTurnPayloadDiagnostics(
    'GetContextWorkbenchTurn',
    [
      'event: ready',
      'data: {}',
      '',
      'event: agent',
      'data: {"id":"1","runId":"r1","type":"failed","code":"AGENT_RUN_FAILED","message":"Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id"}',
      '',
    ].join('\n')
  );
  assert.equal(sseDiag.turnStatus, 'FAILED');

  // 同时存在页面「本轮执行未完成」与执行端 FORBIDDEN: draft_version_id
  const both = classifyDraftTurnState({
    dom: {
      composerSending: false,
      userMessages: [{ text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [
        {
          cleanText: '',
          alerts: [{ title: '本轮执行未完成', content: '本轮执行未完成，请稍后重试' }],
          pending: false,
        },
      ],
    },
    baseline: { userCount: 0, assistantCount: 0, assistantTexts: [] },
    expectedAssets: ['codex-e2e-orders'],
    turnDiagnostics: [sseDiag],
  });
  assert.equal(both.state, 'failed');
  assert.equal(both.failureKind, 'UI_INCOMPLETE_AND_GATEWAY_DRAFT_FORBIDDEN');
  assert.equal(both.hasUiIncompleteError, true);
  assert.equal(both.hasGatewayDraftForbidden, true);
  assert.match(both.reason, /\[页面错误\].*本轮执行未完成/);
  assert.match(both.reason, /\[执行端证据\].*Workspace Gateway MCP tools\/list FORBIDDEN: draft_version_id/);

  // 仅有页面「本轮执行未完成」，无执行端 draft_version_id FORBIDDEN
  const uiOnly = classifyDraftTurnState({
    dom: {
      composerSending: false,
      userMessages: [{ text: DRAFT_DEBUG_QUESTION }],
      assistantMessages: [
        {
          cleanText: '',
          alerts: [{ title: '本轮执行未完成', content: '上游模型超时' }],
          pending: false,
        },
      ],
    },
    baseline: { userCount: 0, assistantCount: 0, assistantTexts: [] },
    expectedAssets: ['codex-e2e-orders'],
    turnDiagnostics: [],
  });
  assert.equal(uiOnly.state, 'failed');
  assert.equal(uiOnly.failureKind, 'UI_TURN_INCOMPLETE');
  assert.equal(uiOnly.hasUiIncompleteError, true);
  assert.equal(uiOnly.hasGatewayDraftForbidden, false);
  assert.match(uiOnly.reason, /未检出 Workspace Gateway MCP tools\/list FORBIDDEN: draft_version_id/);
});

test('端到端编排（只读默认模式）：前两段草稿导航与锁定 PASS，第三段缺发送门禁显式登记 BLOCKED（退出码非 0，绝不当 PASS）', async () => {
  const page = createHarnessPage({ scenario: 'pass_with_synthetic_asset' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: false,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(t.results.length, 3);
  assert.equal(t.results[0].status, 'PASS');
  assert.equal(t.results[1].status, 'PASS');
  assert.equal(t.results[2].title, STAGE_TITLES.queryAnswer);
  assert.equal(t.results[2].status, 'BLOCKED');
  assert.equal(page.getSendClickCount(), 0, '只读模式下严禁点击发送按钮');
  assert.equal(gateExitCode(t.results), 2, '存在 BLOCKED 时退出码应为 2 而非 0 PASS');
});

test('端到端编排（复现同一草稿具备入口却无法出答案）：阶段一、二 PASS，阶段三单次提交并精准捕获页面「本轮执行未完成」与 Gateway draft_version_id FORBIDDEN', async () => {
  const page = createHarnessPage({ scenario: 'gateway_forbidden_behind_ui_incomplete' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(page.getSendClickCount(), 1, '必须严格只提交一次，避免重复建测试会话');
  assert.equal(t.results.length, 3);
  assert.equal(t.results[0].status, 'PASS');
  assert.equal(t.results[1].status, 'PASS');
  assert.equal(t.results[2].status, 'REGRESSION_FAIL');
  assert.match(t.results[2].detail, /具备「调试」入口且工作台已锁定草稿/);
  assert.match(t.results[2].detail, /\[页面错误\].*本轮执行未完成/);
  assert.match(
    t.results[2].detail,
    /\[执行端证据\].*Workspace Gateway MCP tools\/list FORBIDDEN: draft_version_id/
  );
  assert.match(t.results[2].detail, /turnElapsed=\d+ms/);
  assert.match(t.results[2].detail, /apiEvidence=\[.*SendContextWorkbenchMessage.*GetContextWorkbenchTurn/);
  assert.equal(t.results[2].detail.includes('sk-super-secret-do-not-leak'), false);
  assert.equal(t.results[2].detail.includes('secret-tok-999'), false);
  assert.equal(gateExitCode(t.results), 1);
});

test('端到端编排（真实草稿回答通过）：历经流式等待稳定后验证命中预期合成资产并 PASS', async () => {
  const page = createHarnessPage({ scenario: 'pass_with_synthetic_asset' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(page.getSendClickCount(), 1);
  assert.equal(t.results.length, 3);
  assert.equal(t.results[0].status, 'PASS');
  assert.equal(t.results[1].status, 'PASS');
  assert.equal(t.results[2].status, 'PASS');
  assert.match(t.results[2].detail, /codex-e2e-orders-table/);
  assert.equal(gateExitCode(t.results), 0);
});

test('页面看似回答正确时，实际请求指向另一个领域仍失败', async () => {
  const page = createHarnessPage({
    scenario: 'pass_with_synthetic_asset',
    sentDomainId: 'dom-wrong-fixture',
  });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(page.getSendClickCount(), 1);
  assert.deepEqual(t.results.map(row => row.status), ['PASS', 'PASS', 'REGRESSION_FAIL']);
  assert.match(t.results[2].detail, /发送请求确实指向同一领域的草稿/);
});

test('端到端编排（工作台误选已发布版本）：阶段二直接拦截失败，阶段三阻断不误发消息', async () => {
  const page = createHarnessPage({ scenario: 'workbench_selects_release_by_mistake' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(page.getSendClickCount(), 0, '工作台误选发布版本时绝不能向发布版本发送测试提问');
  assert.equal(t.results[0].status, 'PASS');
  assert.equal(t.results[1].status, 'REGRESSION_FAIL');
  assert.match(t.results[1].detail, /误将草稿串选为已发布版本/);
  assert.equal(t.results[2].status, 'BLOCKED');
});

test('端到端编排（版本表具备调试入口但工作台提示草稿不可调试）：阶段一 PASS，阶段二精准捕获前后不一致，阶段三阻断', async () => {
  const page = createHarnessPage({ scenario: 'workbench_rejects_draft_entry' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    env: {},
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
  });

  assert.equal(page.getSendClickCount(), 0);
  assert.equal(t.results[0].status, 'PASS');
  assert.equal(t.results[1].status, 'REGRESSION_FAIL');
  assert.match(t.results[1].detail, /具备「调试」入口，但工作台拒绝识别该草稿/);
  assert.equal(t.results[2].status, 'BLOCKED');
});

test('端到端编排（非 codex-e2e- 合成领域名称保护）：三阶段全部登记 BLOCKED，零页面访问与零发送', async () => {
  const page = createHarnessPage({ scenario: 'pass_with_synthetic_asset' });
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    env: {},
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-prod-001',
    draftDomainName: 'customer-real-domain',
    draftExpectedAsset: 'orders',
  });

  assert.equal(page.getSendClickCount(), 0);
  assert.equal(page.cdpCalls.length, 0);
  assert.deepEqual(
    t.results.map(r => r.status),
    ['BLOCKED', 'BLOCKED', 'BLOCKED']
  );
  assert.equal(gateExitCode(t.results), 2);
});

test('端到端编排（流式超时预算保护）：超出预算仍处于流式生成中时判为 REGRESSION_FAIL 且只提交过一次', async () => {
  const start = Date.now();
  const page = createHarnessPage({ scenario: 'stuck_streaming_until_timeout' });
  // 让 sleep 推进少量真实时间以触发 1000ms 测试最小预算上限
  page.sleep = async ms => new Promise(r => setTimeout(r, Math.min(220, ms)));
  const t = new TestContext(page, '08-draft-debug.spec.mjs');

  await run(t, page, {
    env: {},
    workspaceId: '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
    forbiddenWorkspaceId: 'ws-7710414566965542920',
    projectName: 'default',
    runDraftQuery: true,
    draftDomainId: 'dom-draft-001',
    draftDomainName: 'codex-e2e-draft-ledger',
    draftExpectedAsset: 'codex-e2e-orders-table',
    draftQueryTimeoutMs: 1_000,
  });

  const wallMs = Date.now() - start;
  assert.equal(page.getSendClickCount(), 1, '超时等待期间严禁二次重发');
  assert.equal(t.results[2].status, 'REGRESSION_FAIL');
  assert.match(t.results[2].detail, /在最大预算 1000ms 内未完成有效回答/);
  assert.ok(wallMs < 5_000);
});
