// 模块 01：全局导航可达性、workspaceId 严格保持与旧连接路由兼容重定向检查

export async function run(t, page, cfg) {
  const routes = [
    { name: '资产目录 (/context/catalog)', path: '/context/catalog' },
    { name: '业务领域 (/context/domains)', path: '/context/domains' },
    { name: '知识加工 (/context/processing)', path: '/context/processing' },
  ];

  for (const r of routes) {
    await t.check(`导航进入 ${r.name} 保持 workspaceId 且无未捕获异常`, async () => {
      const nav = await page.gotoContext(r.path, { stepName: `01-nav:${r.path}` });
      const oracle = await page.collectStepOracle(`01-nav:${r.path}`);
      if (oracle.forbiddenWorkspaceHit) {
        throw new Error(`严重越界：地址跳入了禁区工作区 ${cfg.forbiddenWorkspaceId} (${oracle.href})`);
      }
      if (!oracle.urlWorkspaceOk) {
        throw new Error(`地址栏 workspaceId 丢失或被篡改: 期望=${cfg.workspaceId}, 实际=${oracle.urlWorkspaceId} (${oracle.href})`);
      }
      if (oracle.pageErrors.length > 0) {
        throw new Error(`页面未捕获异常: ${oracle.pageErrors[0].text}`);
      }
      return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
    });
  }

  await t.checkKnownBug(
    'CTX-006',
    '旧连接路由 /context/connections/:Id/detail 自动重定向到资产详情且不丢 workspaceId',
    async () => {
      const step = '01-legacy-conn-redirect';
      await page.gotoContext(`/context/connections/${cfg.baselineLocalKbConnId}/detail`, {
        stepName: step,
        timeoutMs: 10000,
      });
      await page.sleep(1000);
      const info = await page.evalJSON(() => ({
        href: window.location.href,
        text: (document.body?.innerText || '').slice(0, 800),
      }));
      // 无论成功与否，确保测试后立即回到安全测试工作区目录页
      const redirectedToCatalogDetail = /\/context\/catalog\/[^/]+\/detail/.test(info.href);
      const hasNotFoundError = /来源不存在或无权查看/.test(info.text);
      await page.gotoContext('/context/catalog', { stepName: '01-restore-safe-ws' });
      if (!redirectedToCatalogDetail || hasNotFoundError) {
        throw new Error(
          `未成功重定向至资产详情: href=${info.href}, 错误提示=${hasNotFoundError ? '来源不存在或无权查看' : '无'}`
        );
      }
      return `成功重定向至 ${info.href}`;
    }
  );
}
