// 模块 05：知识加工页面、评测状态展示（CTX-002）与建议引用来源检查（CTX-011）

export async function run(t, page, cfg) {
  const procPath = `/context/domains/${encodeURIComponent(cfg.baselineDomainId)}/processing`;

  await t.check('领域知识加工页与运行历史正常渲染且无崩溃', async () => {
    const step = '05-domain-processing';
    const nav = await page.gotoContext(procPath, {
      stepName: step,
      readyFn: () => {
        const txt = document.body?.innerText || '';
        return /加工|报告|运行|建议|提炼/.test(txt) ? txt.slice(0, 240) : false;
      },
    });
    const oracle = await page.collectStepOracle(step);
    if (!nav.settledOk) {
      throw new Error(`知识加工页加载超时 (${nav.firstContentMs}ms)`);
    }
    if (!oracle.urlWorkspaceOk) {
      throw new Error(`知识加工页丢失 workspaceId (${oracle.href})`);
    }
    if (oracle.pageErrors.length > 0) {
      throw new Error(`知识加工页未捕获异常: ${oracle.pageErrors[0].text}`);
    }
    return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
  });
}
