import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { IsolatedCdpPage } from '../lib/cdpSession.mjs';

const origin = 'https://example.invalid';
const routes = [
  '/context/catalog',
  '/context/catalog/asset/detail',
  '/context/domains/domain/detail',
  '/context/domains/domain/processing',
  '/context/processing',
  '/context/workbench',
];

function simulateNavigation(page, before, committed, finalHref) {
  const document = { readyState: 'complete', body: { innerText: '业务内容已加载' } };
  page.send = async (method, { url }) => {
    assert.equal(method, 'Page.navigate');
    assert.equal(url, committed);
    return {};
  };

  // Drive the real readiness expression through the old page and the committed page.
  page.waitFor = async expression => {
    for (const href of [before, committed]) {
      const window = { location: { href } };
      const value = vm.runInNewContext(expression, { URL, document, window });
      if (value) return { ok: true, value };
    }
    return { ok: false };
  };
  page.sleep = async () => {};
  page.evalJSON = async () => ({ href: finalHref, title: 'Context', bodySample: document.body.innerText });
}

test('性质：相同路径和内容的旧页面不能为其他工作区、项目或筛选导航报就绪', async () => {
  for (const route of routes) {
    const previousKeys = route === '/context/catalog' ? ['workspaceId', 'project', 'q', 'source'] : ['workspaceId', 'project'];
    for (const key of previousKeys) {
      for (const previous of ['旧域', 'a+b & #', '']) {
        const page = new IsolatedCdpPage({
          consoleBaseUrl: origin,
          workspaceId: 'isolated-fixture',
          projectName: '测试 + /? #',
        });
        const committed = page.buildContextUrl(route);
        const before = new URL(committed);
        before.searchParams.set(key, previous);
        simulateNavigation(page, before.href, committed, committed);
        const visit = await page.gotoContext(route, { readyFn: () => window.location.href });
        const witness = JSON.stringify({ route, key, previous });
        assert.equal(visit.settledOk, true, witness);
        assert.equal(visit.settledValue, committed, witness);
      }
    }
  }
});

test('性质：确认就绪后，回退到旧页或出现重复的冲突范围时，旧结果立即失效', async () => {
  for (const route of routes) {
    const page = new IsolatedCdpPage({
      consoleBaseUrl: origin,
      workspaceId: 'isolated-fixture',
      projectName: 'fixture-project',
    });
    const committed = page.buildContextUrl(route);
    for (const field of ['pathname', 'origin', 'workspaceId', 'project']) {
      const late = new URL(committed);
      if (field === 'pathname') late.pathname = '/context/other';
      else if (field === 'origin') late.hostname = 'elsewhere.invalid';
      else late.searchParams.append(field, 'stale-value');
      simulateNavigation(page, committed, committed, late.href);
      const visit = await page.gotoContext(route, { readyFn: () => '就绪' });
      const witness = JSON.stringify({ route, field });
      assert.equal(visit.settledOk, false, witness);
      assert.equal(visit.settledValue, undefined, witness);
    }
  }
});
