import assert from 'node:assert/strict';
import test from 'node:test';
import { assertFrontendBuild, IsolatedCdpPage } from '../lib/cdpSession.mjs';
import { evaluateCatalogViewSettlement } from '../lib/catalog-checks.mjs';
import { assertListEntriesContinuation, assertListEntriesPage } from '../lib/list-entries-contract.mjs';
import { assertProperty } from './support/propHarness.mjs';

test('NAV-01 只有唯一预期产物才能通过静态资源检查', () => {
  assertProperty({
    name: '拒绝旧包、缺失版本及混包', seed: 0x73871290, runs: 90,
    file: 'test/target-routing.property.test.mjs',
    generate: rng => ({ hash: rng.int(0, 200), scenario: rng.pick(['right', 'old', 'mixed', 'missing']) }),
  }, ({ hash, scenario }) => {
    const expected = `1.0.0.${2257 + hash}`;
    const stale = `1.0.0.${2268 + hash}`;
    const versions = { right: [expected, expected], old: [stale], mixed: [expected, stale], missing: [] };
    if (scenario === 'right') assert.equal(assertFrontendBuild(versions[scenario], expected), expected);
    else assert.throws(() => assertFrontendBuild(versions[scenario], expected), /静态资源版本/);
  });
});

test('目录分页证据保留请求字段和响应形状，游标和资产正文只作内存比较', async () => {
  const page = new IsolatedCdpPage();
  const emit = (method, params) => page._onMessage(JSON.stringify({ method, params }));
  page.setStep('catalog-page');
  page.send = async () => ({ body: JSON.stringify({
    ResponseMetadata: { RequestId: 'fixture-request-1' },
    Result: { Items: [{ Name: 'fixture-entry-body' }], NextToken: 'fixture-next-page' },
  }) });
  const actionUrl = 'https://console.volcengine.com/api/top/agentkit?Action=ListContextEntries';
  const sendList = (requestId, params) => emit('Network.requestWillBeSent', {
    requestId, timestamp: 1, type: 'Fetch',
    request: { url: actionUrl, method: 'POST', postData: JSON.stringify(params) },
  });
  emit('Network.requestWillBeSentExtraInfo', {
    requestId: 'first', headers: { 'X-Lane-Env': page.config.laneEnv, 'X-Unrelated': 'fixture-private-header' },
  });
  sendList('first', { MaxResults: 10, EntryType: 'DATA_ASSET', WorkspaceId: page.config.workspaceId });
  emit('Network.responseReceived', { requestId: 'first', response: { status: 200 } });
  emit('Network.loadingFinished', { requestId: 'first', timestamp: 2 });
  await page.flushResponseMetadata('catalog-page');

  sendList('next', { MaxResults: 10, EntryCategory: '', NextToken: 'fixture-next-page' });
  emit('Network.requestWillBeSentExtraInfo', { requestId: 'next', headers: { 'x-lane-env': 'fixture-other-lane' } });
  const [first] = page.stepRecords('catalog-page');
  const next = page.inflight.get('next').listEntriesRequest;
  assert.deepEqual(first.listEntriesRequest, {
    hasEntryCategory: false, entryTypes: ['DATA_ASSET'], maxResults: [10], nextTokens: [],
  });
  assert.equal(first.listEntriesResponse.itemsCount, 1);
  assert.equal(first.listEntriesResponse.entriesCount, null);
  assert.equal(next.hasEntryCategory, true);
  assert.match(first.listEntriesResponse.nextToken, /^[\da-f]{64}$/);
  assert.deepEqual(next.nextTokens, [first.listEntriesResponse.nextToken]);
  const evidence = page.evidenceRecords();
  assert.deepEqual(evidence.map(record => record.targetLaneSent), [true, false]);
  assert.doesNotMatch(JSON.stringify([first, next, evidence]),
    /fixture-next-page|fixture-entry-body|fixture-private-header|fixture-other-lane/);
});

test('Context 归属工作区参数不能覆盖预期控制台范围', () => {
  const page = new IsolatedCdpPage();
  const requests = [];
  page.send = async (method, { requestId }) => requests.push([method, requestId]);
  const base = page.buildContextUrl('/context/catalog');
  for (const id of [page.config.workspaceId, 'another-workspace', page.config.forbiddenWorkspaceId]) {
    const url = new URL(base);
    url.searchParams.set('contextWorkspaceId', id);
    page._onMessage(JSON.stringify({ method: 'Fetch.requestPaused', params: {
      resourceType: 'Document', requestId: id, request: { url: url.href },
    } }));
  }
  assert.deepEqual(requests, [
    ['Fetch.continueRequest', page.config.workspaceId],
    ['Fetch.failRequest', 'another-workspace'],
    ['Fetch.failRequest', page.config.forbiddenWorkspaceId],
  ]);
  assert.deepEqual(page.scopeViolations.map(item => item.forbidden), [false, true]);
});

test('分页拒绝旧筛选字段、DTO 形状错误、错误游标和过量结果', () => {
  assertProperty({
    name: '保留筛选范围、页大小与游标来源', seed: 0x73871291, runs: 180,
    file: 'test/target-routing.property.test.mjs',
    generate: rng => ({
      size: rng.int(1, 10), cursor: rng.slug('cursor'), count: rng.int(0, 10),
      fault: rng.pick(['none', 'legacy', 'type', 'size', 'count', 'dto', 'wrong-cursor', 'replay']),
    }),
  }, ({ size, count, cursor, fault }) => {
    const previous = { listEntriesResponse: { nextToken: cursor } };
    const record = {
      requestId: 'fixture-list-request',
      listEntriesRequest: {
        hasEntryCategory: fault === 'legacy',
        entryTypes: fault === 'type' ? [] : ['DATA_ASSET'],
        maxResults: [fault === 'size' ? 11 : size],
        nextTokens: [fault === 'wrong-cursor' ? `${cursor}-other` : cursor],
      },
      listEntriesResponse: {
        itemsCount: fault === 'dto' ? null : fault === 'count' ? size + 1 : Math.min(size, count),
        entriesCount: fault === 'dto' ? count : null,
        nextToken: fault === 'replay' ? cursor : '',
      },
    };
    const check = () => {
      assertListEntriesPage(record, { pageSize: 10, entryType: 'DATA_ASSET' });
      assertListEntriesContinuation(previous, record);
    };
    if (fault === 'none') assert.doesNotThrow(check);
    else assert.throws(check);
  });
});

test('独立检索结果的错误或在途请求覆盖同时可见的空态', () => {
  assertProperty({
    name: '卡片检索的真实空态、失败和加载相互独立', seed: 0x73871292, runs: 145,
    file: 'test/target-routing.property.test.mjs',
    generate: rng => ({ keyword: rng.slug('检索'), pending: rng.bool(), error: rng.bool() }),
  }, ({ keyword, pending, error }) => {
    const snapshot = {
      dataDirectory: true, pathname: '/context/catalog',
      search: `?${new URLSearchParams({ q: keyword })}`,
      assetRows: [], hasAssetTable: true, assetTableEmptyText: '请调整搜索或筛选条件',
      pendingActions: pending ? ['SearchContextEntries'] : [], pendingApiCount: Number(pending),
      mainErrorTexts: error ? ['搜索失败，请重试。'] : [],
    };
    const result = evaluateCatalogViewSettlement(snapshot, { mode: 'search', expectedQuery: keyword });
    assert.equal(result.status, pending ? 'LOADING' : error ? 'ERROR' : 'EMPTY');
  });
});
