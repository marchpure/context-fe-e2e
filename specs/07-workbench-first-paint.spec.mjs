// 模块 07：工作台（Workbench）首屏加载耗时红线（CTX-013）与核心交互区就绪检查

export async function run(t, page, cfg) {
  const step = '07-workbench-first-paint';

  await t.checkKnownBug(
    'CTX-013',
    `工作台 (/context/workbench) 首屏在 ${cfg.slo.pageFirstContentMaxMs}ms 红线内渲染出「概览 / 调试台」核心交互区`,
    async () => {
      const nav = await page.gotoContext('/context/workbench', {
        stepName: step,
        timeoutMs: 20000,
        readyFn: () => {
          const txt = document.body?.innerText || '';
          return /调试台|开始提问|输入问题|概览|业务领域/.test(txt) ? txt.slice(0, 240) : false;
        },
      });
      const oracle = await page.collectStepOracle(step);
      if (oracle.pageErrors.length > 0) {
        throw new Error(`工作台抛未捕获异常: ${oracle.pageErrors[0].text}`);
      }
      if (!oracle.urlWorkspaceOk) {
        throw new Error(`工作台丢失 workspaceId (${oracle.href})`);
      }
      if (!nav.settledOk || nav.firstContentMs > cfg.slo.pageFirstContentMaxMs) {
        throw new Error(
          `工作台首屏渲染耗时超标: 实测=${nav.firstContentMs}ms (红线 <= ${cfg.slo.pageFirstContentMaxMs}ms)`
        );
      }
      return `工作台首屏达标: ${nav.firstContentMs}ms (APIs=${oracle.records.length})`;
    }
  );
}
