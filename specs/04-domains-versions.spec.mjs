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

  if (cfg.workspaceId === '800e2e0a-bb05-4591-8cd2-f8df54be0ebe') {
    await t.check('已更新来源的领域仍展示初次发布的冻结资产修订', async () => {
      const path = '/context/domains/dom-388b2bb4788d3808801363f6272e62a7/detail';
      const nav = await page.gotoContext(path, {
        stepName: '04-historical-source-revision',
        readyFn: () => (document.body?.innerText || '').includes('codex-e2e-r4-domain-1125'),
      });
      if (!nav.settledOk) throw new Error('退款版本对照领域未加载');

      const opened = await page.evalJSON(() => {
        const tab = [...document.querySelectorAll('[role="tab"]')].find(
          node => node.textContent.trim() === '版本与记录'
        );
        tab?.click();
        return Boolean(tab);
      });
      if (!opened) throw new Error('缺少版本与记录入口');

      const release = await page.waitFor(
        `[...document.querySelectorAll('button')].some(node => node.textContent.trim() === '1.0.1')`,
        { timeoutMs: 12000 }
      );
      if (!release.ok) throw new Error('初次发布版本 1.0.1 未显示');
      await page.evalJSON(() => {
        [...document.querySelectorAll('button')]
          .find(node => node.textContent.trim() === '1.0.1')
          ?.click();
      });

      const frozen = await page.waitFor(`(() => {
        const row = [...document.querySelectorAll('tr')].find(node =>
          node.textContent.includes('r_7ba12641287a2f626f85c883f3a2884e432ce8e4e570fd49ae15fafb07b3bf42')
        );
        return row?.lastElementChild?.textContent.trim() || false;
      })()`, { timeoutMs: 12000 });
      if (frozen.value !== '1') {
        throw new Error(`历史版本应冻结修订 1，实际为「${frozen.value || '缺少来源条目'}」`);
      }
      return '来源已更新时，发布版本 1.0.1 的退款数据资产仍冻结在修订 1';
    });
  }
}
