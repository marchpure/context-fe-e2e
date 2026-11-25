// Property Suite 1：IsolatedCdpPage 范围隔离、模拟 CDP Fetch/Network/Nav 多形态放置、
// 未完成请求先于终态与 HTTP 200 ResponseMetadata.Error 守卫、以及真实列表/计数/索引/ACL 校验函数属性测试。

import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import {
  DEFAULT_CONFIG,
  IsolatedCdpPage,
  extractActionName,
} from '../lib/cdpSession.mjs';
import {
  ACL_DENIED_ALERT_SUBSTRING,
  CATALOG_ALL_UNITS_LABEL,
  KNOWN_FIXED_FIXTURES,
  VALID_INDEX_LABELS,
  assertStepOracleHealthy,
  evaluateAssetDetailSettlement,
  evaluateCatalogViewSettlement,
  evaluateFixedFixtureRow,
  evaluateLineageSettlement,
  evaluateSourceHistorySettlement,
  getInflightActions,
  isValidDisplayTimestamp,
  pickDedicatedSourceFixture,
  verifyTreeAndOverviewCounts,
} from '../lib/catalog-checks.mjs';
import {
  evaluateSidebarTargetSafety,
  validateStepTerminalState,
} from '../lib/ui-checks.mjs';
import { assertProperty, assertPropertyAsync } from './support/propHarness.mjs';

const FILE = 'test/scope-cdp-oracles.property.test.mjs';

const CONTEXT_READ_ACTIONS = [
  'ListContextEntries',
  'ListContextConnections',
  'GetContextEntry',
  'ListContextEntryLinks',
  'ListContextDomains',
  'GetContextDomain',
  'GetContextTask',
  'ExploreContextSource',
];

const CONTEXT_WRITE_ACTIONS = [
  'CreateContextDomain',
  'UpdateContextConnection',
  'DeleteContextConnection',
  'PublishContextDomain',
  'TriggerContextScan',
  'StartContextEnrichment',
  'SendContextWorkbenchMessage',
];

const SUBPATHS = [
  '/context/catalog',
  '/context/workbench',
  '/context/domains',
  '/context/domains/mcp',
  '/context/processing',
  '/context/catalog/r_doc_1125/detail',
  '/context/domains/dom-1125/detail',
];

function emitCdpEvent(page, method, params) {
  page._onMessage(JSON.stringify({ method, params }));
}

function independentUrlScopeOracle(href, cfg) {
  const parsed = new URL(href);
  const wsValues = parsed.searchParams.getAll('workspaceId');
  const projValues = parsed.searchParams.getAll('project');
  const primaryWs = parsed.searchParams.get('workspaceId');
  const primaryProj = parsed.searchParams.get('project');
  const hitsForbidden =
    wsValues.includes(cfg.forbiddenWorkspaceId) || href.includes(cfg.forbiddenWorkspaceId);
  return {
    origin: parsed.origin,
    pathname: parsed.pathname,
    workspaceId: primaryWs,
    project: primaryProj,
    urlWorkspaceOk: primaryWs === cfg.workspaceId && !hitsForbidden,
    urlProjectOk: primaryProj === cfg.projectName,
    forbiddenWorkspaceHit: hitsForbidden,
  };
}

test('P1.1 IsolatedCdpPage.buildContextUrl 与 collectStepOracle 在重排参数、自定义空间与禁区 URL 下与独立 URL 预言机一致 (260 cases)', async () => {
  await assertPropertyAsync(
    {
      name: 'P1.1 URL scope & permuted workspace/project oracle',
      seed: 0x51010001,
      runs: 260,
      file: FILE,
      generate(rng) {
        const workspaceId = `ws-safe-${rng.hex(8)}`;
        const forbiddenWorkspaceId = DEFAULT_CONFIG.forbiddenWorkspaceId;
        const projectName = rng.pick(['default', 'proj-alpha', '财务项目_01', 'team+core']);
        const subpath = rng.pick(SUBPATHS);
        const urlMode = rng.pick([
          'built_with_ws',
          'built_without_ws',
          'permuted_query',
          'wrong_ws',
          'wrong_project',
          'forbidden_ws',
        ]);
        const extraKey = rng.pick(['tab', 'source', 'q']);
        const extraVal = rng.pick(['chat', 'res-01', '退款口径']);
        return { workspaceId, forbiddenWorkspaceId, projectName, subpath, urlMode, extraKey, extraVal };
      },
      *shrink(s) {
        if (s.projectName !== 'default') yield { ...s, projectName: 'default' };
        if (s.subpath !== '/context/catalog') yield { ...s, subpath: '/context/catalog' };
        if (s.extraVal !== 'chat') yield { ...s, extraKey: 'tab', extraVal: 'chat' };
      },
    },
    async scenario => {
      const cfg = {
        ...DEFAULT_CONFIG,
        workspaceId: scenario.workspaceId,
        forbiddenWorkspaceId: scenario.forbiddenWorkspaceId,
        projectName: scenario.projectName,
      };
      const page = new IsolatedCdpPage(cfg);
      page.setStep('p1-url-scope');

      const built = page.buildContextUrl(`${scenario.subpath}?${scenario.extraKey}=${encodeURIComponent(scenario.extraVal)}`, {
        includeWorkspace: scenario.urlMode !== 'built_without_ws',
      });
      const builtParsed = new URL(built);
      assert.equal(builtParsed.searchParams.get(scenario.extraKey), scenario.extraVal);
      if (scenario.urlMode !== 'built_without_ws') {
        assert.equal(builtParsed.searchParams.get('workspaceId'), cfg.workspaceId);
        assert.equal(builtParsed.searchParams.get('project'), cfg.projectName);
      } else {
        assert.equal(builtParsed.searchParams.has('workspaceId'), false);
      }

      let activeHref = built;
      if (scenario.urlMode === 'permuted_query') {
        const u = new URL(`${cfg.consoleBaseUrl}${scenario.subpath}`);
        u.searchParams.set(scenario.extraKey, scenario.extraVal);
        u.searchParams.set('project', cfg.projectName);
        u.searchParams.set('workspaceId', cfg.workspaceId);
        activeHref = u.toString();
      } else if (scenario.urlMode === 'wrong_ws') {
        const u = new URL(built);
        u.searchParams.set('workspaceId', 'ws-other-tenant');
        activeHref = u.toString();
      } else if (scenario.urlMode === 'wrong_project') {
        const u = new URL(built);
        u.searchParams.set('project', 'other-proj');
        activeHref = u.toString();
      } else if (scenario.urlMode === 'forbidden_ws') {
        const u = new URL(built);
        u.searchParams.set('workspaceId', cfg.forbiddenWorkspaceId);
        activeHref = u.toString();
      }

      page.evalJSON = async () => ({
        href: activeHref,
        visibleText: '正常业务内容 2026-11-25 12:00:00',
        frontendVersions: ['1.0.0.42'],
      });

      const oracle = await page.collectStepOracle('p1-url-scope');
      const expected = independentUrlScopeOracle(activeHref, cfg);

      assert.equal(oracle.urlWorkspaceOk, expected.urlWorkspaceOk);
      assert.equal(oracle.urlProjectOk, expected.urlProjectOk);
      assert.equal(oracle.forbiddenWorkspaceHit, expected.forbiddenWorkspaceHit);
    }
  );
});

test('P1.2 CDP Fetch.requestPaused 与 Network 请求解析在多形态 Action/Scope 放置、表单请求体及查询/正文冲突禁区下精确拦截 (300 cases)', () => {
  assertProperty(
    {
      name: 'P1.2 Diverse Action/Workspace/Project placements & banned workspace interception',
      seed: 0x51010002,
      runs: 300,
      file: FILE,
      generate(rng) {
        return {
          action: rng.pick(CONTEXT_READ_ACTIONS),
          endpointStyle: rng.pick([
            'top_query_action',
            'top_version_path_json_action',
            'top_region_path_json_action',
            'top_form_urlencoded',
            'control_rest_path',
            'data_v1_rest_path',
          ]),
          scopePlacement: rng.pick([
            'query_camel',
            'query_pascal',
            'query_snake',
            'json_top',
            'json_meta_scope',
            'form_body',
            'query_forbidden_body_safe_conflict',
            'query_safe_body_forbidden_conflict',
            'duplicate_query_safe_then_forbidden',
          ]),
          targetBanned: rng.bool(0.35),
          projectKey: rng.pick(['ProjectName', 'project_name', 'project']),
          projectVal: rng.pick(['default', 'proj-cn-1']),
        };
      },
      *shrink(s) {
        if (s.action !== 'ListContextEntries') yield { ...s, action: 'ListContextEntries' };
        if (s.projectKey !== 'project') yield { ...s, projectKey: 'project' };
        if (s.projectVal !== 'default') yield { ...s, projectVal: 'default' };
        if (s.targetBanned) yield { ...s, targetBanned: false };
      },
    },
    scenario => {
      const cfg = { ...DEFAULT_CONFIG };
      const page = new IsolatedCdpPage(cfg);
      page.setStep('p1-fetch-network');
      const intercepted = [];
      page.send = async (method, params) => {
        intercepted.push({ method, requestId: params.requestId });
        return {};
      };

      const chosenWs = scenario.targetBanned ? cfg.forbiddenWorkspaceId : cfg.workspaceId;
      const origin = 'https://console.volcengine.com';
      let baseUrl = `${origin}/api/top/agentkit`;
      if (scenario.endpointStyle === 'top_version_path_json_action') {
        baseUrl = `${origin}/api/top/agentkit/2025-10-30`;
      } else if (scenario.endpointStyle === 'top_region_path_json_action') {
        baseUrl = `${origin}/api/top/agentkit_stg/cn-beijing?Version=2025-10-30`;
      } else if (scenario.endpointStyle === 'control_rest_path') {
        baseUrl = `${origin}/context/control/${scenario.action}`;
      } else if (scenario.endpointStyle === 'data_v1_rest_path') {
        baseUrl = `${origin}/context/data/v1/${scenario.action}`;
      }

      const u = new URL(baseUrl);
      let postData = '';
      const bodyObj = {};

      if (scenario.endpointStyle === 'top_query_action') {
        u.searchParams.set('Action', scenario.action);
      } else if (
        scenario.endpointStyle === 'top_version_path_json_action' ||
        scenario.endpointStyle === 'top_region_path_json_action'
      ) {
        bodyObj.Action = scenario.action;
      }

      let expectedHitsBanned = false;
      if (scenario.scopePlacement === 'query_camel') {
        u.searchParams.set('workspaceId', chosenWs);
        u.searchParams.set(scenario.projectKey, scenario.projectVal);
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'query_pascal') {
        u.searchParams.set('WorkspaceId', chosenWs);
        u.searchParams.set(scenario.projectKey, scenario.projectVal);
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'query_snake') {
        u.searchParams.set('workspace_id', chosenWs);
        u.searchParams.set(scenario.projectKey, scenario.projectVal);
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'json_top') {
        bodyObj.WorkspaceId = chosenWs;
        bodyObj[scenario.projectKey] = scenario.projectVal;
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'json_meta_scope') {
        bodyObj.Meta = { Scope: { WorkspaceId: chosenWs, ProjectName: scenario.projectVal } };
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'form_body') {
        const form = new URLSearchParams();
        if (scenario.endpointStyle.startsWith('top_')) form.set('Action', scenario.action);
        form.set('WorkspaceId', chosenWs);
        form.set(scenario.projectKey, scenario.projectVal);
        postData = form.toString();
        expectedHitsBanned = chosenWs === cfg.forbiddenWorkspaceId;
      } else if (scenario.scopePlacement === 'query_forbidden_body_safe_conflict') {
        u.searchParams.set('workspaceId', cfg.forbiddenWorkspaceId);
        bodyObj.WorkspaceId = cfg.workspaceId;
        bodyObj.ProjectName = scenario.projectVal;
        expectedHitsBanned = true;
      } else if (scenario.scopePlacement === 'query_safe_body_forbidden_conflict') {
        u.searchParams.set('workspaceId', cfg.workspaceId);
        bodyObj.WorkspaceId = cfg.forbiddenWorkspaceId;
        bodyObj.ProjectName = scenario.projectVal;
        expectedHitsBanned = true;
      } else if (scenario.scopePlacement === 'duplicate_query_safe_then_forbidden') {
        u.searchParams.append('WorkspaceId', cfg.workspaceId);
        u.searchParams.append('workspaceId', cfg.forbiddenWorkspaceId);
        u.searchParams.set(scenario.projectKey, scenario.projectVal);
        expectedHitsBanned = true;
      }

      if (!postData && scenario.endpointStyle === 'top_form_urlencoded') {
        // 表单可保留平坦的字段，嵌套 Scope 在同一个 TOP 入口使用 JSON。
        postData = bodyObj.Meta
          ? JSON.stringify({ Action: scenario.action, ...bodyObj })
          : new URLSearchParams({ Action: scenario.action, ...bodyObj }).toString();
      } else if (!postData && Object.keys(bodyObj).length > 0) {
        postData = JSON.stringify(bodyObj);
      }

      const finalUrl = u.toString();
      const extractedAction = extractActionName(finalUrl, postData, 'Fetch');
      assert.equal(
        extractedAction,
        scenario.action,
        `extractActionName 应解析出 ${scenario.action}，实际得到 ${extractedAction} (url=${finalUrl}, postData=${postData})`
      );

      emitCdpEvent(page, 'Fetch.requestPaused', {
        requestId: 'pause-1',
        resourceType: 'Fetch',
        request: { url: finalUrl, postData },
      });

      const offScope = expectedHitsBanned || scenario.projectVal !== cfg.projectName;
      const expectedCommand = offScope ? 'Fetch.failRequest' : 'Fetch.continueRequest';
      assert.equal(
        intercepted[0]?.method,
        expectedCommand,
        `偏离测试范围=${offScope} 时期望 ${expectedCommand}，实际调用 ${intercepted[0]?.method} (url=${finalUrl}, postData=${postData})`
      );

      if (!expectedHitsBanned) {
        emitCdpEvent(page, 'Network.requestWillBeSent', {
          requestId: 'net-1',
          timestamp: 10,
          type: 'Fetch',
          request: { url: finalUrl, method: postData ? 'POST' : 'GET', postData },
        });
        const ev = page.evidenceRecords();
        assert.equal(ev.length, 1);
        assert.equal(ev[0].action, scenario.action);
        assert.equal(ev[0].workspaceId, cfg.workspaceId);
        assert.equal(ev[0].projectName, scenario.projectVal);
      }
    }
  );
});

test('P1.3 IsolatedCdpPage.gotoContext 在连续路由切换、同路径查询切换、刷新与禁区恢复序列下绝不在新导航提交前误认旧页面就绪 (220 cases)', async () => {
  await assertPropertyAsync(
    {
      name: 'P1.3 Route sequence navigation waits for target URL query/scope commit',
      seed: 0x51010003,
      runs: 220,
      file: FILE,
      generate(rng) {
        const prevState = rng.pick([
          'different_path_workbench',
          'same_path_stale_source',
          'same_path_missing_workspace',
          'same_path_forbidden_workspace',
          'same_processing_stale_task',
        ]);
        const preCommitPolls = rng.int(1, 2);
        const sourceId = `res-${rng.hex(6)}`;
        const nextTaskId = `enr-${rng.hex(6)}`;
        return { prevState, preCommitPolls, sourceId, nextTaskId };
      },
      *shrink(s) {
        if (s.preCommitPolls > 1) yield { ...s, preCommitPolls: 1 };
        if (s.sourceId !== 'res-1') yield { ...s, sourceId: 'res-1' };
        if (s.nextTaskId !== 'enr-2') yield { ...s, nextTaskId: 'enr-2' };
      },
    },
    async scenario => {
      const cfg = { ...DEFAULT_CONFIG };
      const page = new IsolatedCdpPage(cfg);
      page.sleep = async () => {};

      let previousHref;
      let targetSubpath;
      let staleBodyText = '所有资产单元 知识库 数据库 正常已加载旧视图超过二十个字符';
      let committedBodyText = '所有资产单元 知识库 数据库 目标新视图已完成渲染超过二十个字符';

      if (scenario.prevState === 'different_path_workbench') {
        previousHref = page.buildContextUrl('/context/workbench');
        targetSubpath = '/context/catalog';
      } else if (scenario.prevState === 'same_path_stale_source') {
        previousHref = page.buildContextUrl('/context/catalog?source=res-old-stale');
        targetSubpath = `/context/catalog?source=${encodeURIComponent(scenario.sourceId)}`;
      } else if (scenario.prevState === 'same_path_missing_workspace') {
        previousHref = `${cfg.consoleBaseUrl}/context/catalog`;
        targetSubpath = '/context/catalog';
      } else if (scenario.prevState === 'same_path_forbidden_workspace') {
        previousHref = `${cfg.consoleBaseUrl}/context/catalog?workspaceId=${cfg.forbiddenWorkspaceId}&project=${cfg.projectName}`;
        targetSubpath = '/context/catalog';
      } else {
        previousHref = page.buildContextUrl('/context/domains/dom-1/processing?taskId=enr-old');
        targetSubpath = `/context/domains/dom-1/processing?taskId=${encodeURIComponent(scenario.nextTaskId)}`;
      }

      const expectedCommittedHref = page.buildContextUrl(targetSubpath);
      let navDispatched = false;
      let predicatePolls = 0;

      page.send = async (method, params) => {
        if (method === 'Page.navigate') {
          navDispatched = true;
          assert.equal(params.url, expectedCommittedHref);
        }
        return {};
      };

      page.evalJSON = async fnOrExpr => {
        const committed = navDispatched && predicatePolls >= scenario.preCommitPolls;
        const currentHref = committed ? expectedCommittedHref : previousHref;
        const currentBody = committed ? committedBodyText : staleBodyText;
        predicatePolls += 1;

        const expr =
          typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : String(fnOrExpr);
        return vm.runInNewContext(expr, {
          URL,
          window: { location: { href: currentHref } },
          document: {
            title: 'Context',
            readyState: 'complete',
            body: { innerText: currentBody },
            querySelector: () => ({ tagName: 'MAIN' }),
          },
        });
      };

      const navRes = await page.gotoContext(targetSubpath, {
        stepName: 'p1-nav-seq',
        readyFn: () => document.body.innerText,
      });

      assert.equal(navRes.settledOk, true);
      assert.equal(
        navRes.settledValue,
        committedBodyText,
        `gotoContext 在新 URL 提交前误采信了旧页面 DOM (prev=${previousHref}, target=${expectedCommittedHref})`
      );
      assert.equal(navRes.finalHref, expectedCommittedHref);
    }
  );
});

test('P1.4 在途请求先于迟到终态事件：目录/详情/血缘判定器与单请求 validateStepTerminalState 拒绝未完成与 HTTP 200 ResponseMetadata.Error (240 cases)', async () => {
  await assertPropertyAsync(
    {
      name: 'P1.4 In-flight request precedes late HTTP 200 ResponseMetadata.Error',
      seed: 0x51010004,
      runs: 240,
      file: FILE,
      generate(rng) {
        return {
          action: rng.pick(['ListContextEntries', 'GetContextEntry', 'ListContextEntryLinks', 'ListContextDomains']),
          base64Body: rng.bool(0.4),
          outcome: rng.pick(['http200_biz_error', 'http500_error', 'network_failed', 'http200_ok']),
          errorCode: rng.pick(['AccessDenied', 'BindingRequired', 'InternalError', 'FlowLimitExceeded']),
          reqId: `20261125REQ${rng.hex(6).toUpperCase()}`,
          durationSec: rng.int(1, 12) / 10,
        };
      },
      *shrink(s) {
        if (s.base64Body) yield { ...s, base64Body: false };
        if (s.errorCode !== 'AccessDenied') yield { ...s, errorCode: 'AccessDenied' };
        if (s.action !== 'ListContextEntries') yield { ...s, action: 'ListContextEntries' };
      },
    },
    async scenario => {
      const cfg = { ...DEFAULT_CONFIG };
      const page = new IsolatedCdpPage(cfg);
      const step = 'p1-pending-then-terminal';
      page.setStep(step);

      const responseEnvelope =
        scenario.outcome === 'http200_biz_error'
          ? {
              ResponseMetadata: {
                RequestId: scenario.reqId,
                Error: { Code: scenario.errorCode, Message: 'Simulated business error on HTTP 200' },
              },
            }
          : {
              ResponseMetadata: { RequestId: scenario.reqId },
              Result: { Items: [] },
            };

      const serializedBody = JSON.stringify(responseEnvelope);
      page.send = async method => {
        if (method === 'Network.getResponseBody') {
          return {
            body: scenario.base64Body
              ? Buffer.from(serializedBody, 'utf8').toString('base64')
              : serializedBody,
            base64Encoded: scenario.base64Body,
          };
        }
        return {};
      };

      const safeHref = page.buildContextUrl('/context/catalog');
      page.evalJSON = async () => ({
        href: safeHref,
        visibleText: '所有资产单元 2026-11-25 14:00:00',
        frontendVersions: [],
      });

      // 阶段 A：请求刚发出尚在飞行中（pending=true）
      emitCdpEvent(page, 'Network.requestWillBeSent', {
        requestId: 'cdp-req-1',
        timestamp: 100,
        type: 'Fetch',
        request: {
          url: `https://console.volcengine.com/api/top/agentkit?Action=${scenario.action}`,
          method: 'POST',
          postData: JSON.stringify({ WorkspaceId: cfg.workspaceId, ProjectName: cfg.projectName }),
        },
      });

      const inflight = getInflightActions(page);
      assert.deepEqual(inflight, [scenario.action]);

      const pendingOracle = await page.collectStepOracle(step);
      assert.equal(pendingOracle.pendingApis.length, 1);
      assert.equal(pendingOracle.records.length, 0);

      // 终态校验器在阶段 A 绝不能把未完成判为通过
      assert.throws(
        () =>
          validateStepTerminalState(pendingOracle, cfg, {
            stepLabel: '阶段A未完成校验',
            requiredActions: [scenario.action],
          }),
        /尚未返回的飞行中接口/
      );

      const catWhilePending = evaluateCatalogViewSettlement({
        pathname: '/v2/context/catalog',
        search: `?workspaceId=${cfg.workspaceId}&project=${cfg.projectName}`,
        headerTitle: CATALOG_ALL_UNITS_LABEL,
        selectedTreeTitle: `${CATALOG_ALL_UNITS_LABEL}\n1`,
        treeAllCount: 1,
        hasOverviewTable: true,
        overviewRows: [{ name: 'codex-e2e-local-kb-1125', category: '知识库', scaleText: '2 篇文档' }],
        hasAssetTable: true,
        assetRows: [{ name: 'doc-1', typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
        pendingApiCount: inflight.length,
        pendingActions: inflight,
      });
      assert.equal(catWhilePending.settled, false);
      assert.equal(catWhilePending.status, 'LOADING');

      const detailWhilePending = evaluateAssetDetailSettlement({
        pathname: '/v2/context/catalog/doc-1/detail',
        headerTitle: 'doc-1',
        markdownText: '# 正文已局部渲染但接口未结束',
        pendingApiCount: inflight.length,
      });
      assert.equal(detailWhilePending.settled, false);
      assert.equal(detailWhilePending.status, 'LOADING');

      const lineageWhilePending = evaluateLineageSettlement(
        {
          hintText: '2 个节点 · 1 条关系',
          nodeCardCount: 2,
          visibleText: '2 个节点 · 1 条关系',
          pendingApiCount: inflight.length,
        },
        []
      );
      assert.equal(lineageWhilePending.settled, false);
      assert.equal(lineageWhilePending.status, 'LOADING');

      // 阶段 B：迟到终态事件到达
      if (scenario.outcome === 'network_failed') {
        emitCdpEvent(page, 'Network.loadingFailed', {
          requestId: 'cdp-req-1',
          errorText: 'net::ERR_CONNECTION_RESET',
        });
      } else {
        const status = scenario.outcome === 'http500_error' ? 500 : 200;
        emitCdpEvent(page, 'Network.responseReceived', {
          requestId: 'cdp-req-1',
          response: { status, headers: { 'x-tt-logid': `hdr-${scenario.reqId}` } },
        });
        emitCdpEvent(page, 'Network.loadingFinished', {
          requestId: 'cdp-req-1',
          timestamp: 100 + scenario.durationSec,
        });
      }

      const terminalOracle = await page.collectStepOracle(step);
      assert.equal(terminalOracle.pendingApis.length, 0);
      assert.equal(terminalOracle.records.length, 1);

      if (scenario.outcome === 'http200_ok') {
        assert.equal(terminalOracle.records[0].httpStatus, 200);
        assert.equal(terminalOracle.records[0].errorCode, null);
        assert.equal(terminalOracle.records[0].requestId, scenario.reqId);
        assert.doesNotThrow(() =>
          validateStepTerminalState(terminalOracle, cfg, {
            stepLabel: '阶段B正常完成',
            requiredActions: [scenario.action],
          })
        );
      } else {
        if (scenario.outcome === 'http200_biz_error') {
          assert.equal(terminalOracle.records[0].httpStatus, 200);
          assert.equal(terminalOracle.records[0].errorCode, scenario.errorCode);
          assert.equal(terminalOracle.records[0].requestId, scenario.reqId);
        }
        assert.throws(
          () =>
            validateStepTerminalState(terminalOracle, cfg, {
              stepLabel: '阶段B异常完成',
              requiredActions: [scenario.action],
            }),
          /未达成功终态/
        );
      }
    }
  );
});

test('P1.5 步级健康预言机（assertStepOracleHealthy 与同动作多次请求 validateStepTerminalState）不得放行在途请求、写请求或末尾 HTTP 200 业务错误 (240 cases)', () => {
  assertProperty(
    {
      name: 'P1.5 Step terminal oracles reject pending APIs, pending/scan writes, and trailing HTTP 200 errors',
      seed: 0x51010005,
      runs: 240,
      file: FILE,
      generate(rng) {
        return {
          defectMode: rng.pick([
            'catalog_oracle_has_pending_read',
            'catalog_oracle_has_pending_write',
            'catalog_oracle_has_scan_or_enrichment_write',
            'ui_oracle_second_call_http200_error',
            'clean_terminal_step',
          ]),
          readAction: rng.pick(CONTEXT_READ_ACTIONS),
          writeAction: rng.pick(CONTEXT_WRITE_ACTIONS),
          errorCode: rng.pick(['InternalError', 'AccessDenied', 'InvalidParameter']),
        };
      },
      *shrink(s) {
        if (s.readAction !== 'ListContextEntries') yield { ...s, readAction: 'ListContextEntries' };
        if (s.errorCode !== 'InternalError') yield { ...s, errorCode: 'InternalError' };
      },
    },
    scenario => {
      const cfg = { ...DEFAULT_CONFIG };
      const href = `https://console.volcengine.com/v2/context/catalog?workspaceId=${cfg.workspaceId}&project=${cfg.projectName}`;
      const baseOracle = {
        href,
        urlWorkspaceId: cfg.workspaceId,
        urlWorkspaceOk: true,
        urlProjectOk: true,
        forbiddenWorkspaceHit: false,
        pageErrors: [],
        has1970Timestamp: false,
        slowApis: [],
        duplicateApis: [],
        pendingApis: [],
        records: [
          {
            action: scenario.readAction,
            httpStatus: 200,
            durationMs: 120,
            workspaceId: cfg.workspaceId,
            requestId: 'req-ok-1',
            errorCode: null,
          },
        ],
      };

      if (scenario.defectMode === 'clean_terminal_step') {
        assert.doesNotThrow(() => assertStepOracleHealthy(baseOracle));
        assert.doesNotThrow(() =>
          validateStepTerminalState(baseOracle, cfg, { requiredActions: [scenario.readAction] })
        );
        return;
      }

      if (scenario.defectMode === 'catalog_oracle_has_pending_read') {
        const incompleteOracle = {
          ...baseOracle,
          pendingApis: [
            {
              action: scenario.readAction,
              pending: true,
              durationMs: 450,
              workspaceId: cfg.workspaceId,
            },
          ],
        };
        assert.throws(
          () => assertStepOracleHealthy(incompleteOracle),
          /未完成|在途|飞行中|pending/i,
          'assertStepOracleHealthy 不应将在途请求未收敛的 oracle 判为健康'
        );
      } else if (scenario.defectMode === 'catalog_oracle_has_pending_write') {
        const pendingWriteOracle = {
          ...baseOracle,
          pendingApis: [
            {
              action: 'DeleteContextConnection',
              pending: true,
              durationMs: 100,
              workspaceId: cfg.workspaceId,
            },
          ],
        };
        assert.throws(
          () => assertStepOracleHealthy(pendingWriteOracle),
          /写|禁止|未完成|DeleteContextConnection/,
          'assertStepOracleHealthy 必须拦截尚在飞行中的写请求'
        );
      } else if (scenario.defectMode === 'catalog_oracle_has_scan_or_enrichment_write') {
        const triggerWriteOracle = {
          ...baseOracle,
          records: [
            ...baseOracle.records,
            {
              action: scenario.writeAction,
              httpStatus: 200,
              durationMs: 180,
              workspaceId: cfg.workspaceId,
              requestId: 'req-mut-1',
            },
          ],
        };
        assert.throws(
          () => assertStepOracleHealthy(triggerWriteOracle),
          /写|禁止|副作用/,
          `assertStepOracleHealthy 必须拦截写/触发动作 ${scenario.writeAction}`
        );
      } else if (scenario.defectMode === 'ui_oracle_second_call_http200_error') {
        const trailingErrorOracle = {
          ...baseOracle,
          records: [
            ...baseOracle.records,
            {
              action: scenario.readAction,
              httpStatus: 200,
              durationMs: 210,
              workspaceId: cfg.workspaceId,
              requestId: 'req-err-2',
              errorCode: scenario.errorCode,
            },
          ],
        };
        assert.throws(
          () =>
            validateStepTerminalState(trailingErrorOracle, cfg, {
              stepLabel: '二次刷新或翻页',
              requiredActions: [scenario.readAction],
            }),
          new RegExp(`${scenario.errorCode}|未达成功终态|错误`),
          '同一步骤内后续同动作请求返回 HTTP 200 ResponseMetadata.Error 时不得因早期成功记录而放行'
        );
      }
    }
  );
});

test('P1.6 目录来源挑选、固定夹具规模、时间戳、血缘与历史记录纯判定器随机正反例属性 (280 cases)', () => {
  assertProperty(
    {
      name: 'P1.6 Fixture selection, timestamp format, lineage & source history verdicts',
      seed: 0x51010006,
      runs: 280,
      file: FILE,
      generate(rng) {
        const forbiddenCount = rng.int(1, 3);
        const forbiddenItems = Array.from({ length: forbiddenCount }, (_, idx) => ({
          name: `${rng.pick(['p0-wave3-', 'p0-stageE-'])}${rng.slug('src', 3, 6)}-${idx}`,
          scaleText: '9 篇文档',
        }));
        const hasOwn = rng.bool(0.65);
        const ownName = `codex-e2e-${rng.slug('kb', 3, 6)}`;
        const hasFallback = rng.bool(0.5);
        const fallbackName = `codex-ui-${rng.slug('ro', 3, 6)}`;
        const year = rng.int(2024, 2029);
        const month = String(rng.int(1, 12)).padStart(2, '0');
        const day = String(rng.int(1, 28)).padStart(2, '0');
        const hour = String(rng.int(0, 23)).padStart(2, '0');
        const min = String(rng.int(0, 59)).padStart(2, '0');
        const validTs = `${year}-${month}-${day} ${hour}:${min}`;
        const badTs = rng.pick([
          '1970-01-01 08:00:00',
          '1970-01-01 00:00',
          'Invalid Date',
          'NaN-NaN-NaN',
          'undefined',
          '',
          '—',
        ]);
        const nodeCount = rng.int(1, 12);
        const edgeCount = rng.int(0, 15);
        return {
          forbiddenItems,
          hasOwn,
          ownName,
          hasFallback,
          fallbackName,
          orderSeed: rng.int(0, 1000),
          validTs,
          badTs,
          nodeCount,
          edgeCount,
        };
      },
    },
    s => {
      const pool = [...s.forbiddenItems];
      if (s.hasFallback) pool.push({ name: s.fallbackName, scaleText: '1 篇文档' });
      if (s.hasOwn) pool.push({ name: s.ownName, scaleText: '2 篇文档' });
      if (s.orderSeed % 2 === 1) pool.reverse();

      const picked = pickDedicatedSourceFixture(pool);
      if (s.hasOwn) {
        assert.equal(picked.tier, 'own');
        assert.equal(picked.fixture.name, s.ownName);
      } else if (s.hasFallback) {
        assert.equal(picked.tier, 'readonly_fallback');
        assert.equal(picked.fixture.name, s.fallbackName);
      } else {
        assert.equal(picked.tier, 'none');
        assert.equal(picked.fixture, null);
      }

      assert.equal(isValidDisplayTimestamp(s.validTs).valid, true);
      assert.equal(isValidDisplayTimestamp(s.badTs, { allowDash: false }).valid, false);
      assert.equal(isValidDisplayTimestamp('—', { allowDash: true }).valid, true);

      const spec = KNOWN_FIXED_FIXTURES[0];
      assert.equal(
        evaluateFixedFixtureRow([{ name: spec.name, scaleText: spec.expectedScale }], spec).ok,
        true
      );
      assert.equal(
        evaluateFixedFixtureRow([{ name: spec.name, scaleText: '999 篇文档' }], spec).ok,
        false
      );

      const okLineage = evaluateLineageSettlement(
        {
          lineageSpinning: false,
          pendingApiCount: 0,
          hintText: `${s.nodeCount} 个节点 · ${s.edgeCount} 条关系`,
          nodeCardCount: s.nodeCount,
          visibleText: `${s.nodeCount} 个节点 · ${s.edgeCount} 条关系`,
        },
        [{ action: 'ListContextEntryLinks', httpStatus: 200 }]
      );
      assert.equal(okLineage.settled, true);
      assert.equal(okLineage.status, 'READY');
      assert.equal(okLineage.nodeCount, s.nodeCount);
      assert.equal(okLineage.edgeCount, s.edgeCount);

      const errHistory = evaluateSourceHistorySettlement({
        drawerOpen: true,
        tableSpinning: false,
        pendingApiCount: 0,
        rows: [{ name: '增量扫描', status: '已完成', time: s.badTs === '—' ? '1970-01-01 08:00' : s.badTs }],
      });
      assert.equal(errHistory.settled, true);
      assert.equal(errHistory.status, 'ERROR');
    }
  );
});

test('P1.7 计数/ACL/侧栏安全守卫拒绝刻意构造的不一致（汇总行数超树总数、NaN/小数计数、ACL 受限泄露字段/片段、URL 编码禁区空间） (260 cases)', () => {
  assertProperty(
    {
      name: 'P1.7 Strict rejection of deliberate count, ACL leak, and encoded-sidebar inconsistencies',
      seed: 0x51010007,
      runs: 260,
      file: FILE,
      generate(rng) {
        const g = {
          knowledge: rng.int(0, 4),
          coderepo: rng.int(0, 3),
          database: rng.int(0, 4),
          app_mcp: rng.int(0, 2),
        };
        const total = g.knowledge + g.coderepo + g.database + g.app_mcp;
        const mode = rng.pick([
          'valid_consistent',
          'group_sum_mismatch',
          'overview_badge_nan',
          'fractional_group_counts',
          'overview_rows_exceed_tree_total',
          'acl_denied_clean',
          'acl_denied_leaks_table_fields',
          'acl_denied_leaks_snippet_sample',
          'sidebar_percent_encoded_forbidden_ws',
        ]);
        return { g, total, mode, extraRows: rng.int(1, 3), leakedFields: rng.int(1, 8) };
      },
      *shrink(s) {
        if (s.extraRows > 1) yield { ...s, extraRows: 1 };
        if (s.leakedFields > 1) yield { ...s, leakedFields: 1 };
        if (s.total > 2) {
          yield {
            ...s,
            g: { knowledge: 1, coderepo: 0, database: 1, app_mcp: 0 },
            total: 2,
          };
        }
      },
    },
    s => {
      if (s.mode === 'valid_consistent') {
        const res = verifyTreeAndOverviewCounts({
          treeAllCount: s.total,
          treeGroupCounts: s.g,
          overviewTotalBadge: s.total,
          overviewRows: Array.from({ length: Math.min(s.total, 2) }, (_, i) => ({
            name: `codex-e2e-src-${i}`,
          })),
        });
        assert.equal(res.ok, true);
        assert.equal(VALID_INDEX_LABELS.has('已就绪'), true);
        return;
      }

      if (s.mode === 'group_sum_mismatch') {
        const res = verifyTreeAndOverviewCounts({
          treeAllCount: s.total + 1,
          treeGroupCounts: s.g,
          overviewTotalBadge: s.total + 1,
        });
        assert.equal(res.ok, false);
      } else if (s.mode === 'overview_badge_nan') {
        const res = verifyTreeAndOverviewCounts({
          treeAllCount: s.total,
          treeGroupCounts: s.g,
          overviewTotalBadge: Number.NaN,
        });
        assert.equal(res.ok, false, 'overviewTotalBadge 为 NaN 时计数校验必须拒绝');
      } else if (s.mode === 'fractional_group_counts') {
        const res = verifyTreeAndOverviewCounts({
          treeAllCount: 2,
          treeGroupCounts: { knowledge: 1.5, coderepo: 0.5, database: 0, app_mcp: 0 },
          overviewTotalBadge: 2,
        });
        assert.equal(res.ok, false, '目录树分组计数出现非整数小数时必须拒绝');
      } else if (s.mode === 'overview_rows_exceed_tree_total') {
        const res = verifyTreeAndOverviewCounts({
          treeAllCount: s.total,
          treeGroupCounts: s.g,
          overviewTotalBadge: s.total,
          overviewRows: Array.from({ length: s.total + s.extraRows }, (_, i) => ({
            name: `codex-e2e-unit-${i}`,
          })),
        });
        assert.equal(
          res.ok,
          false,
          `汇总表实际渲染行数 (${s.total + s.extraRows}) 大于所有资产单元总数 (${s.total}) 时必须拒绝`
        );
      } else if (s.mode === 'acl_denied_clean') {
        const verdict = evaluateAssetDetailSettlement({
          pathname: '/context/catalog/doc-acl/detail',
          headerTitle: '受控飞书文档',
          assetTypeTag: '文件集合',
          aclDeniedAlert: ACL_DENIED_ALERT_SUBSTRING,
          markdownText: '',
          snippetCount: 0,
          snippetSample: '',
          fieldRowCount: 0,
        });
        assert.equal(verdict.settled, true);
        assert.equal(verdict.status, 'READY_ACL_DENIED');
      } else if (s.mode === 'acl_denied_leaks_table_fields') {
        const verdict = evaluateAssetDetailSettlement({
          pathname: '/context/catalog/tbl-acl/detail',
          headerTitle: '受控数据表',
          assetTypeTag: '数据表',
          aclDeniedAlert: ACL_DENIED_ALERT_SUBSTRING,
          markdownText: '',
          snippetCount: 0,
          fieldRowCount: s.leakedFields,
        });
        assert.equal(
          verdict.status,
          'ERROR',
          `ACL_DENIED 下仍泄露 ${s.leakedFields} 行数据表字段时应判为 ERROR 而非 ${verdict.status}`
        );
      } else if (s.mode === 'acl_denied_leaks_snippet_sample') {
        const verdict = evaluateAssetDetailSettlement({
          pathname: '/context/catalog/doc-acl/detail',
          headerTitle: '受控飞书文档',
          assetTypeTag: '文件集合',
          aclDeniedAlert: ACL_DENIED_ALERT_SUBSTRING,
          markdownText: '',
          snippetCount: 0,
          snippetSample: '机密退款审批内部原文片段',
        });
        assert.equal(
          verdict.status,
          'ERROR',
          `ACL_DENIED 下 snippetSample 仍含敏感正文片段时应判为 ERROR 而非 ${verdict.status}`
        );
      } else if (s.mode === 'sidebar_percent_encoded_forbidden_ws') {
        const encodedForbidden = DEFAULT_CONFIG.forbiddenWorkspaceId.replace('-', '%2D');
        const safety = evaluateSidebarTargetSafety(
          {
            found: true,
            label: '工作台',
            visible: true,
            disabled: false,
            href: `/context/workbench?workspaceId=${encodedForbidden}&project=default`,
            scopeBannerText: '测试空间',
            rect: { x: 16, y: 180, width: 176, height: 36 },
          },
          DEFAULT_CONFIG
        );
        assert.equal(
          safety.safe,
          false,
          `侧栏 href 使用百分号编码指向禁区工作区 (${encodedForbidden}) 时必须拦截`
        );
        assert.equal(safety.forbidden, true);
      }
    }
  );
});
