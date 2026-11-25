// 模块 02：资产目录渲染、新建向导死入口检查（CTX-020）与连接探测耗时检查

export async function run(t, page, cfg) {
  const step = '02-catalog-list';
  await t.check('资产目录列表首屏加载成功且常规接口耗时达标', async () => {
    const nav = await page.gotoContext('/context/catalog', {
      stepName: step,
      readyFn: () => {
        const text = document.body?.innerText || '';
        return /添加资产|全部资产|知识库|数据表/.test(text) ? text.slice(0, 200) : false;
      },
    });
    const oracle = await page.collectStepOracle(step);
    if (!nav.settledOk) {
      throw new Error(`资产目录在超时窗口内未渲染出主体控件 (${nav.firstContentMs}ms)`);
    }
    if (oracle.pageErrors.length > 0) {
      throw new Error(`资产目录抛未捕获异常: ${oracle.pageErrors[0].text}`);
    }
    if (oracle.slowApis.length > 0) {
      const s = oracle.slowApis[0];
      throw new Error(`慢接口超红线: ${s.action} 耗时 ${s.durationMs}ms (> ${s.sloLimitMs}ms, RequestId=${s.requestId || '—'})`);
    }
    return `firstContent=${nav.firstContentMs}ms, APIs=${oracle.records.length}`;
  });

  await t.checkKnownBug('CTX-007', '资产目录列表不出现 1970-01-01 零值时间戳', async () => {
    const oracle = await page.collectStepOracle(step);
    if (oracle.has1970Timestamp) {
      throw new Error('资产目录可见文本中存在 1970-01-01 零值更新时间');
    }
    return '未发现 1970-01-01 零值时间';
  });

  if (cfg.workspaceId === '800e2e0a-bb05-4591-8cd2-f8df54be0ebe') {
    await t.check('已入库的内置文档与 PostgreSQL 表在资产单元汇总显示正确数量', async () => {
      const searchSelector = 'input[placeholder="搜索资产单元名称或工具"]';
      const ready = await page.waitFor(
        `Boolean(document.querySelector(${JSON.stringify(searchSelector)}))`,
        { timeoutMs: 18000 }
      );
      if (!ready.ok) throw new Error('资产单元汇总未加载');

      for (const [name, expected] of [
        ['codex-e2e-local-kb-1125', '2 篇文档'],
        ['codex-e2e-pg-1125', '2 张表'],
      ]) {
        await page.evalJSON(`(() => {
          const input = document.querySelector(${JSON.stringify(searchSelector)});
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(
            input, ${JSON.stringify(name)}
          );
          input.dispatchEvent(new Event('input', { bubbles: true }));
        })()`);
        const settled = await page.waitFor(`(() => {
          const row = [...document.querySelectorAll('tr')].find(tr =>
            [...tr.querySelectorAll('button')].some(button =>
              button.textContent.trim() === ${JSON.stringify(name)}
            )
          );
          return row?.querySelectorAll('td')[2]?.textContent.trim() || false;
        })()`, { timeoutMs: 12000 });
        if (settled.value !== expected) {
          throw new Error(`${name} 应显示「${expected}」，实际「${settled.value || '缺少汇总行'}」`);
        }
      }
      return '两篇已导入文档和两张已接入表均按实际资产数量显示';
    });
  }

  await t.checkKnownBug(
    'CTX-020',
    '添加资产向导不暴露数据面已下线在线能力的 Meego / 风神死入口',
    async () => {
      page.setStep('02-connect-modal-dead-sources');
      const opened = await page.evalJSON(() => {
        const btns = Array.from(document.querySelectorAll('button'));
        const addBtn = btns.find(b => /添加资产|新建连接|接入数据/.test((b.innerText || '').trim()));
        if (!addBtn) return { clicked: false };
        addBtn.click();
        return { clicked: true };
      });
      if (!opened?.clicked) {
        // 可能是下拉菜单，尝试点击下拉项
        return '当前视图未直接展示添加资产按钮，跳过弹窗检查';
      }
      await page.sleep(600);
      // 若弹出下拉菜单，点「连接外部来源 / 接入数据源」
      await page.evalJSON(() => {
        const items = Array.from(
          document.querySelectorAll('.arco-dropdown-menu-item, [role="menuitem"]')
        );
        const target = items.find(el => /连接|接入|外部/.test(el.innerText || ''));
        if (target) target.click();
      });
      await page.sleep(800);

      // 切换到「业务应用」分类（若存在）检查是否暴露 Meego / 风神
      const modalCheck = await page.evalJSON(() => {
        const modal = document.querySelector('.arco-modal');
        if (!modal) return { hasModal: false, text: '' };
        const tabsOrCards = Array.from(modal.querySelectorAll('*'));
        const appTab = tabsOrCards.find(el => (el.innerText || '').trim() === '业务应用');
        if (appTab) appTab.click();
        return { hasModal: true, text: (modal.innerText || '').slice(0, 1500) };
      });
      await page.sleep(400);
      const afterText = await page.evalJSON(() => {
        const modal = document.querySelector('.arco-modal');
        const txt = modal ? modal.innerText || '' : '';
        // 关闭弹窗，不留脏状态
        const closeBtn = document.querySelector('.arco-modal-close-icon, .arco-modal button');
        if (closeBtn) closeBtn.click();
        return txt.slice(0, 2000);
      });
      await page.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape' }).catch(() => {});
      await page.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape' }).catch(() => {});

      if (/Meego|风神|Aeolus/i.test(afterText)) {
        throw new Error('新建连接向导仍暴露 Meego / 风神入口卡片');
      }
      return modalCheck?.hasModal ? '向导已核验无死入口残留' : '未弹出模态框';
    }
  );
}
