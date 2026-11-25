import assert from 'node:assert/strict';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { IsolatedCdpPage } from '../lib/cdpSession.mjs';
import { assertStepOracleHealthy } from '../lib/catalog-checks.mjs';
import { validateStepTerminalState } from '../lib/ui-checks.mjs';
import { assertProperty, assertPropertyAsync } from './support/propHarness.mjs';

const file = 'test/network-property-review.test.mjs';
const origin = 'https://example.invalid';
const action = 'ListContextEntries';
const config = { consoleBaseUrl: origin, workspaceId: 'test-space', projectName: '订单 + BI' };

function emit(page, method, params) {
  page._onMessage(JSON.stringify({ method, params }));
}

test('性质：查询串与正文的作用域冲突会在发送前被拦截', () => {
  assertProperty({
    name: '请求作用域冲突',
    file,
    seed: 0x7202f87a,
    runs: 160,
    generate: rng => ({
      location: rng.pick(['query', 'duplicate query', 'body', 'nested body']),
      scope: rng.pick(['same', 'other project', 'other workspace', 'forbidden']),
      word: rng.pick(['空间 字段', '+%&=', '', '📚/测试']),
    }),
  }, ({ location, scope, word }) => {
    const page = new IsolatedCdpPage(config);
    const calls = [];
    page.send = async method => calls.push(method);
    const url = new URL(`/api/top/agentkit/${action}`, origin);
    url.searchParams.set('name', word);
    url.searchParams.set('workspaceId', config.workspaceId);
    url.searchParams.set('project', config.projectName);
    const body = { WorkspaceId: config.workspaceId, ProjectName: config.projectName };

    const isProject = scope === 'other project';
    const queryKey = isProject ? 'project' : 'workspaceId';
    const bodyKey = isProject ? 'ProjectName' : 'WorkspaceId';
    const candidate = ({
      same: config.workspaceId,
      'other project': '未授权项目 +',
      'other workspace': 'other-test-workspace',
      forbidden: page.config.forbiddenWorkspaceId,
    })[scope];
    if (location === 'query') url.searchParams.set(queryKey, candidate);
    if (location === 'duplicate query') url.searchParams.append(queryKey, candidate);
    if (location === 'body') body[bodyKey] = candidate;
    if (location === 'nested body') body.Meta = { Scope: { [bodyKey]: candidate } };

    emit(page, 'Fetch.requestPaused', {
      requestId: 'fixture',
      resourceType: 'Fetch',
      request: { url: url.href, postData: JSON.stringify(body) },
    });
    assert.deepEqual(calls, [scope === 'same' ? 'Fetch.continueRequest' : 'Fetch.failRequest']);
  });
});

test('性质：HTTP 200 必须等回执信封读完，挂起或含业务错误的请求都不能通过', async () => {
  await assertPropertyAsync({
    name: 'HTTP 200 与业务终态',
    file,
    seed: 0x18075bdd,
    runs: 96,
    generate: rng => ({
      errorCode: rng.pick([null, 'PermissionDenied', 'ScanSourceReadFailed', 'ScopeMismatch']),
      requestId: rng.slug('request'),
      base64Encoded: rng.bool(),
    }),
  }, async ({ errorCode, requestId, base64Encoded }) => {
    const page = new IsolatedCdpPage(config);
    page.setStep('read-assets');
    page.evalJSON = async () => ({ href: page.buildContextUrl('/context/catalog'), visibleText: '资产已加载' });
    // Delay only the body receipt. The transport has already delivered status and headers.
    let deliver;
    const responseBody = new Promise(resolve => { deliver = resolve; });
    page.send = method => {
      assert.equal(method, 'Network.getResponseBody');
      return responseBody;
    };
    emit(page, 'Network.requestWillBeSent', {
      requestId: 'cdp',
      timestamp: 1,
      type: 'Fetch',
      request: { url: `${origin}/api/top/agentkit/${action}` },
    });
    emit(page, 'Network.responseReceived', { requestId: 'cdp', response: { status: 200 } });
    const pending = await page.collectStepOracle();
    assert.equal(pending.pendingApis.length, 1);
    assert.throws(() => assertStepOracleHealthy(pending), /尚未返回/);
    assert.throws(() => validateStepTerminalState(pending, config, { requiredActions: [action] }), /尚未返回/);

    emit(page, 'Network.loadingFinished', { requestId: 'cdp', timestamp: 1.1 });
    let oracleCompleted = false;
    const oracleWait = page.collectStepOracle().then(result => { oracleCompleted = true; return result; });
    await setImmediate();
    try {
      assert.equal(oracleCompleted, false, '业务回执未返回时不能提前完成');
    } finally {
      const json = JSON.stringify({
        ResponseMetadata: { RequestId: requestId, ...(errorCode && { Error: { Code: errorCode } }) },
      });
      deliver({ body: base64Encoded ? Buffer.from(json).toString('base64') : json, base64Encoded });
    }
    const oracle = await oracleWait;
    assert.equal(oracle.records[0].requestId, requestId);
    assert.equal(oracle.records[0].errorCode, errorCode);
    const check = () => validateStepTerminalState(oracle, config, { requiredActions: [action] });
    if (errorCode) assert.throws(check, new RegExp(errorCode));
    else assert.doesNotThrow(check);
  });
});
