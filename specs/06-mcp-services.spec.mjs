// 模块 06：MCP 服务管理页防崩溃（CTX-001）与 24h 指标接通检查（CTX-021）

export async function run(t, page) {
  const step = '06-mcp-services';

  await t.checkKnownBug(
    'CTX-001',
    'MCP 服务管理页正常渲染列表，不抛 localeCompare TypeError 或显示「加载失败，点击重试」',
    async () => {
      const nav = await page.gotoContext('/context/domains/mcp', {
        stepName: step,
        readyFn: () => {
          const txt = document.body?.innerText || '';
          return /MCP|服务|加载失败/.test(txt) ? txt.slice(0, 300) : false;
        },
      });
      await page.sleep(800);
      const oracle = await page.collectStepOracle(step);
      const consoleLocaleErr = page.consoleErrors.find(
        e => e.step === step && /localeCompare/i.test(e.text)
      );
      const pageLocaleErr = oracle.pageErrors.find(e => /localeCompare/i.test(e.text));

      if (/加载失败，点击重试/.test(oracle.visibleText) || consoleLocaleErr || pageLocaleErr) {
        throw new Error(
          `MCP 管理列表加载失败 (${nav.firstContentMs}ms): ${
            consoleLocaleErr?.text || pageLocaleErr?.text || '页面显示「加载失败，点击重试」'
          }`
        );
      }
      return `MCP 列表加载成功 (${nav.firstContentMs}ms, APIs=${oracle.records.length})`;
    }
  );
}
