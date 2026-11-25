import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { IsolatedCdpPage } from '../lib/cdpSession.mjs';
import { gateExitCode, TestContext } from '../lib/testContext.mjs';

test('已知问题只匹配已登记的故障表现', async () => {
  const context = new TestContext({ screenshot: async () => null }, 'smoke');
  await context.checkKnownBug('CTX-017', '数据血缘', () => {
    throw new Error('BindingRequired');
  });
  await context.checkKnownBug('CTX-017', '数据血缘其他失败', () => {
    throw new Error('环境登录超时');
  });
  await context.checkKnownBug('CTX-001', 'MCP 列表一般错误', () => {
    throw new Error('MCP 服务管理页出现错误提示（非 localeCompare 异常）');
  });
  await context.checkKnownBug('CTX-001', 'MCP 列表的已知崩溃', () => {
    throw new Error('TypeError: Cannot read properties of undefined (reading localeCompare)');
  });
  assert.deepEqual(context.results.map(row => row.status), [
    'KNOWN_BUG', 'REGRESSION_FAIL', 'REGRESSION_FAIL', 'KNOWN_BUG',
  ]);
  assert.equal(gateExitCode(context.results), 1);
});

test('缺少前置条件在回调内外均不生成通过', async () => {
  const context = new TestContext({}, 'smoke');
  context.block('缺预置资产', '未找到指定测试连接');
  await context.check('需要显式开关', () => context.block('缺执行条件', '默认只读'));
  assert.deepEqual(context.results.map(row => row.status), ['BLOCKED', 'BLOCKED']);
  assert.equal(gateExitCode(context.results), 2);
  assert.equal(gateExitCode([]), 2);
});

test('网络证据保留挂起请求和 HTTP 200 里的业务错误', async () => {
  const page = new IsolatedCdpPage();
  const emit = (method, params) => page._onMessage(JSON.stringify({ method, params }));
  page.setStep('catalog-open');
  for (const [requestId, action] of [
    ['slow', 'ListContextEntries'],
    ['blocked', 'GetContextTask'],
  ]) {
    emit('Network.requestWillBeSent', {
      requestId, timestamp: 1, type: 'Fetch',
      request: {
        url: `https://console.volcengine.com/api/top/agentkit?Action=${action}`,
        method: 'POST',
        postData: JSON.stringify({ WorkspaceId: page.config.workspaceId }),
      },
    });
  }
  page.send = async () => ({
    body: JSON.stringify({ ResponseMetadata: { RequestId: 'request-2', Error: { Code: 'FORBIDDEN' } } }),
  });
  emit('Network.responseReceived', { requestId: 'blocked', response: { status: 200 } });
  emit('Network.loadingFinished', { requestId: 'blocked', timestamp: 2 });
  page.evalJSON = async () => ({
    href: `https://console.volcengine.com/catalog?workspaceId=${page.config.workspaceId}&project=default`,
    visibleText: '',
  });
  const oracle = await page.collectStepOracle('catalog-open');
  assert.equal(oracle.urlProjectOk, true);
  assert.deepEqual(oracle.pendingApis.map(item => item.action), ['ListContextEntries']);
  const finished = page.evidenceRecords().find(item => !item.pending);
  assert.deepEqual(
    [finished.httpStatus, finished.errorCode, finished.requestId, finished.sloLimitMs],
    [200, 'FORBIDDEN', 'request-2', 800]
  );
});

test('禁区工作区的页面和嵌套 Scope 请求在发送前拦截', async () => {
  const page = new IsolatedCdpPage();
  const commands = [];
  page.send = async (method, params) => commands.push([method, params.requestId]);
  const emit = (requestId, url, postData, resourceType) =>
    page._onMessage(JSON.stringify({
      method: 'Fetch.requestPaused',
      params: { requestId, resourceType, request: { url, postData } },
    }));
  const origin = 'https://console.volcengine.com';
  const actionUrl = `${origin}/api/top/agentkit?Action=ListContextEntries`;
  emit('wrong-route', `${origin}/v2/context/catalog?workspaceId=${page.config.forbiddenWorkspaceId}`,
    undefined, 'Document');
  emit('wrong-request', actionUrl, JSON.stringify({
    Meta: { Scope: { WorkspaceId: page.config.forbiddenWorkspaceId } },
  }), 'Fetch');
  emit('correct-request', actionUrl, JSON.stringify({ WorkspaceId: page.config.workspaceId }), 'Fetch');
  assert.deepEqual(commands, [
    ['Fetch.failRequest', 'wrong-route'],
    ['Fetch.failRequest', 'wrong-request'],
    ['Fetch.continueRequest', 'correct-request'],
  ]);
  assert.equal(page.scopeViolations.length, 2);
});

test('路由等待在目标页提交之前忽略旧页面的相同就绪文案', async () => {
  const page = new IsolatedCdpPage();
  const previous = page.buildContextUrl('/context/workbench');
  const expected = page.buildContextUrl('/context/catalog');
  const observed = [];
  page.send = async method => {
    assert.equal(method, 'Page.navigate');
    return {};
  };
  page.sleep = async () => {};
  page.evalJSON = async predicate => {
    const href = observed.length === 0 ? previous : expected;
    const result = vm.runInNewContext(
      typeof predicate === 'function' ? `(${predicate.toString()})()` : predicate,
      { window: { location: { href } }, document: { title: 'STG', readyState: 'complete', body: { innerText: '所有资产' } }, URL }
    );
    observed.push(result);
    return result;
  };
  const navigation = await page.gotoContext('/context/catalog', {
    readyFn: () => document.body.innerText === '所有资产',
  });
  assert.equal(observed[0], false);
  assert.equal(navigation.settledOk, true);
  assert.equal(navigation.finalHref, expected);
});
