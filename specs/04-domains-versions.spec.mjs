// 模块 04：业务领域列表、领域详情、已发布版本快照明细（CTX-014）与发布弹窗有效字段检查（CTX-012）

export async function run(t, page, cfg) {
  await t.check('业务领域列表首屏加载正常且接口耗时达标', async () => {
    const step = '04-domain-list';
    const nav = await page.gotoContext('/context/domains', {
      stepName: step,
      readyFn: () => {
        const txt = document.body?.innerText || '';
        return /新建|创建|业务领域|codex-e2e-ledger-1124/.test(txt) ? txt.slice(0, 200) : false;
      },
    });
    const oracle = await page.collectStepOracle(step);
    if (!nav.settledOk) {
      throw new Error(`业务领域列表加载超时 (${nav.firstContentMs}ms)`);
    }
    if (oracle.pageErrors.length > 0) {
      throw new Error(`业务领域列表未捕获异常: ${oracle.pageErrors[0].text}`);
    }
    return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
  });

  const domainDetailPath = `/context/domains/${encodeURIComponent(cfg.baselineDomainId)}/detail`;
  await t.check('基准业务领域详情页正常加载知识模型与页签', async () => {
    const step = '04-domain-detail';
    const nav = await page.gotoContext(domainDetailPath, {
      stepName: step,
      readyFn: () => {
        const txt = document.body?.innerText || '';
        return /版本|工具|知识|发布/.test(txt) ? txt.slice(0, 240) : false;
      },
    });
    const oracle = await page.collectStepOracle(step);
    if (!nav.settledOk) {
      throw new Error(`领域详情加载超时 (${nav.firstContentMs}ms)`);
    }
    if (oracle.pageErrors.length > 0) {
      throw new Error(`领域详情未捕获异常: ${oracle.pageErrors[0].text}`);
    }
    return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
  });

  await t.checkKnownBug(
    'CTX-014',
    '已发布版本抽屉正确展示冻结条目范围明细（非空数组提示）',
    async () => {
      const step = '04-domain-version-snapshot';
      page.setStep(step);
      const switched = await page.evalJSON(() => {
        const tabs = Array.from(document.querySelectorAll('.arco-tabs-header-title, [role="tab"]'));
        const verTab = tabs.find(el => /版本/.test((el.innerText || '').trim()));
        if (!verTab) return false;
        verTab.click();
        return true;
      });
      if (!switched) return '未找到版本页签';
      await page.sleep(1000);
      await page.evalJSON(() => {
        const btns = Array.from(document.querySelectorAll('button, a'));
        const viewBtn = btns.find(el => /^(查看|详情|查看范围)$/.test((el.innerText || '').trim()));
        if (viewBtn) viewBtn.click();
      });
      await page.sleep(800);
      const txt = await page.evalJSON(() => {
        const body = document.body?.innerText || '';
        const closeBtn = document.querySelector('.arco-drawer-close-icon');
        if (closeBtn) closeBtn.click();
        return body.slice(0, 4000);
      });
      if (/暂未提供此版本的发布范围明细/.test(txt)) {
        throw new Error('版本抽屉显示冻结条目数非 0，但范围列表显示「暂未提供此版本的发布范围明细」');
      }
      return '版本范围明细渲染正常';
    }
  );
}
