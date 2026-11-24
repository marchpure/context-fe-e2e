// 模块 03：单资产详情渲染、更新时间格式与发布后资产血缘加载检查（CTX-017）

export async function run(t, page, cfg) {
  const detailPath = `/context/catalog/${encodeURIComponent(cfg.baselineDocEntryId)}/detail`;

  await t.check('基准 Markdown 文档资产详情页正常加载且保持 workspaceId', async () => {
    const nav = await page.gotoContext(detailPath, {
      stepName: '03-asset-detail',
      readyFn: () => {
        const txt = document.body?.innerText || '';
        return /概览|数据血缘|预览|版本|来源/.test(txt) ? txt.slice(0, 240) : false;
      },
    });
    const oracle = await page.collectStepOracle('03-asset-detail');
    if (!nav.settledOk) {
      throw new Error(`资产详情页超时未就绪 (${nav.firstContentMs}ms)`);
    }
    if (!oracle.urlWorkspaceOk) {
      throw new Error(`资产详情页丢失 workspaceId (${oracle.href})`);
    }
    if (oracle.pageErrors.length > 0) {
      throw new Error(`资产详情页未捕获异常: ${oracle.pageErrors[0].text}`);
    }
    return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
  });

  await t.checkKnownBug(
    'CTX-017',
    '已发布领域绑定的资产打开「数据血缘」Tab 正常加载，不报 409 BindingRequired',
    async () => {
      const step = '03-asset-lineage-tab';
      page.setStep(step);
      const clicked = await page.evalJSON(() => {
        const tabs = Array.from(
          document.querySelectorAll('.arco-tabs-header-title, [role="tab"], button, span')
        );
        const lineageTab = tabs.find(el => (el.innerText || '').trim() === '数据血缘');
        if (!lineageTab) return false;
        lineageTab.click();
        return true;
      });
      if (!clicked) {
        return '当前资产类型未渲染「数据血缘」页签';
      }
      await page.sleep(2000);
      const oracle = await page.collectStepOracle(step);
      const err409 = oracle.records.find(r => r.httpStatus === 409 || /BindingRequired/i.test(r.errorCode || ''));
      if (/血缘加载失败|Recreate the domain binding/i.test(oracle.visibleText) || err409) {
        throw new Error(
          `资产血缘加载失败: HTTP=${err409?.httpStatus || 'UI报错'}, RequestId=${err409?.requestId || '—'}, 错误码=${err409?.errorCode || 'BindingRequired'}`
        );
      }
      return `血缘页签正常渲染 (APIs=${oracle.records.length})`;
    }
  );
}
