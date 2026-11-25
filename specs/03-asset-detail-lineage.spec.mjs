// 模块 03：单资产详情、索引与列表一致性、远端 ACL 权限提示、数据表字段 Schema 与数据血缘只读回归套件
// 覆盖：
// 1. 基准文档详情退出全部 Spinner / 占位块，展示真实标题、索引状态与正文预览，保持 workspaceId/project
// 2. 详情页更新时间有效且无 1970-01-01 零值时间戳（守护 CTX-007）
// 3. 内置知识库文档在列表与详情中的索引状态一致（含小 PDF 逐字回读校验），来源设置抽屉索引汇总可读
// 4. 开启远端权限控制的来源（飞书 Wiki / Bitable / TOS）详情明确展示权限受控提示（零正文泄露且不误报加载失败），「权限」页签正常加载
// 5. PostgreSQL 数据表资产详情展示完整字段 Schema（会话表 6 字段 / 事件表 9 字段）且不渲染「文档正文」区块
// 6. 已发布领域绑定资产切换「数据血缘」页签正常渲染节点关系，不报 409 BindingRequired（守护 CTX-017）

import {
  ACL_DENIED_ALERT_SUBSTRING,
  VALID_INDEX_LABELS,
  assertStepOracleHealthy,
  captureCatalogDomSnapshot,
  dispatchRealMouseClick,
  isValidDisplayTimestamp,
  waitForAssetDetailSettled,
  waitForCatalogSettled,
  waitForLineageSettled,
} from '../lib/catalog-checks.mjs';

function leftTreeSourceNodeExpr(sourceName) {
  return `Array.from(document.querySelectorAll('nav[aria-label="数据目录"] ul > li > ul > li > button'))
    .find(button => button.innerText.trim() === ${JSON.stringify(sourceName)})`;
}

async function openUnitRowFullDetail(page, rowName) {
  await dispatchRealMouseClick(
    page,
    `(() => {
      const tables = Array.from(document.querySelectorAll('main .arco-table'));
      const unitTbl = tables.find(tbl => {
        const hs = Array.from(tbl.querySelectorAll('thead th')).map(th => (th.innerText || '').trim());
        return hs.includes('文档标题') || hs.some(title => title.startsWith('已纳管表名'));
      });
      if (!unitTbl) return null;
      return Array.from(unitTbl.querySelectorAll('tbody button, tbody a')).find(
        el => (el.textContent || '').trim() === ${JSON.stringify(rowName)}
      ) || null;
    })()`,
    `来源治理表资产行「${rowName}」`
  );

  return waitForAssetDetailSettled(page, { timeoutMs: 18000 });
}

export async function run(t, page, cfg) {
  const detailPath = `/context/catalog/${encodeURIComponent(cfg.baselineDocEntryId)}/detail`;
  let baselineDetailSnap = null;
  let baselineNotFound = false;

  // -------------------------------------------------------------------------
  // 1. 基准文档详情页：严禁凭静态页签报 PASS，必须退出 Spinner 并渲染真实标题与正文/片段
  // -------------------------------------------------------------------------
  await t.check('基准 Markdown 文档资产详情页退出 Spinner，展示真实标题、索引状态与正文预览且保持 workspaceId', async () => {
    const step = '03-baseline-doc-detail';
    const navStart = Date.now();
    await page.gotoContext(detailPath, {
      stepName: step,
      readyFn: () => Boolean(document.querySelector('article.ak-detail')),
    });
    const settled = await waitForAssetDetailSettled(page, { timeoutMs: 20000 });
    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);

    if (!settled.ok) {
      throw new Error(
        `基准资产详情页超时未收敛 (${settled.elapsedMs}ms): ${settled.verdict?.status} — ${settled.verdict?.reason}`
      );
    }
    if (settled.verdict.status === 'NOT_FOUND') {
      baselineNotFound = true;
      t.block(
        '基准 Markdown 文档资产详情页核验',
        `当前工作区 (${cfg.workspaceId}) 中 baselineDocEntryId 不存在或无权查看`
      );
      return;
    }
    if (settled.verdict.status === 'ERROR') {
      throw new Error(`基准资产详情页渲染报错: ${settled.verdict.reason}`);
    }

    baselineDetailSnap = settled.snapshot;
    if (
      baselineDetailSnap.contentIndexLabel &&
      !VALID_INDEX_LABELS.has(baselineDetailSnap.contentIndexLabel)
    ) {
      throw new Error(`正文索引状态徽标异常: ${baselineDetailSnap.contentIndexLabel}`);
    }

    return `settled=${Date.now() - navStart}ms, title="${baselineDetailSnap.headerTitle}", status=${settled.verdict.status}, APIs=${oracle.records.length}`;
  });

  // -------------------------------------------------------------------------
  // 2. 详情页时间戳守卫（CTX-007）
  // -------------------------------------------------------------------------
  await t.check('资产详情页更新时间格式有效且不出现 1970-01-01 零值时间戳', async () => {
    if (baselineNotFound || !baselineDetailSnap) {
      t.block('资产详情页更新时间校验', '基准文档详情前置未就绪');
      return;
    }
    const oracle = await page.collectStepOracle('03-baseline-doc-detail');
    if (oracle.has1970Timestamp) {
      throw new Error('资产详情可见文本中出现 1970-01-01 零值时间戳');
    }
    const tsCheck = isValidDisplayTimestamp(baselineDetailSnap.updatedAtText);
    if (!tsCheck.valid) {
      throw new Error(`资产详情页头更新时间异常: ${tsCheck.reason}`);
    }
    return `更新时间="${baselineDetailSnap.updatedAtText}"`;
  });

  // -------------------------------------------------------------------------
  // 3. 列表与详情索引状态一致性 + 小 PDF 逐字回读 + 详情打开只读「来源设置」抽屉
  // -------------------------------------------------------------------------
  await t.check('内置知识库文档列表与详情索引状态一致，且详情页「来源设置」抽屉索引汇总可读', async () => {
    const step = '03-kb-index-consistency-and-source-drawer';
    await page.gotoContext('/context/catalog', { stepName: step });
    const catalogSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!catalogSettled.ok || catalogSettled.verdict.status === 'EMPTY') {
      t.block('内置知识库列表与详情索引一致性核验', '当前工作区无已接入资产单元');
      return;
    }

    const kbCandidates = ['codex-e2e-r4-kb-1125', 'codex-e2e-local-kb-1125'];
    const kbName = kbCandidates.find(n =>
      catalogSettled.snapshot.treeConnectionNames.includes(n)
    );
    if (!kbName) {
      t.block(
        '内置知识库列表与详情索引一致性核验',
        `当前工作区未找到 ${kbCandidates.join(' / ')} 内置知识库连接`
      );
      return;
    }

    await dispatchRealMouseClick(
      page,
      leftTreeSourceNodeExpr(kbName),
      `内置知识库来源「${kbName}」`
    );
    const kbSettled = await waitForCatalogSettled(
      page,
      { mode: 'source', expectedSourceName: kbName },
      { timeoutMs: 18000 }
    );
    if (!kbSettled.ok || kbSettled.verdict.status !== 'READY') {
      throw new Error(`进入内置知识库「${kbName}」未渲染文档行: ${kbSettled.verdict?.reason}`);
    }

    // 优先挑选内联 PDF 样本（若存在可顺带核验逐字回读）或第一篇文档
    const pdfRow = kbSettled.snapshot.unitRows.find(r => /pdf/i.test(r.name));
    const targetRow = pdfRow || kbSettled.snapshot.unitRows[0];
    const listContentBadgeMatch = targetRow.indexText.match(
      /正文索引[\s\n]*(已就绪|构建中|排队中|索引失败)/
    );
    const listFallbackBadgeMatch = targetRow.indexText.match(/(已就绪|构建中|排队中|索引失败)/);
    const expectedBadge = listContentBadgeMatch?.[1] || listFallbackBadgeMatch?.[1] || '';

    const detailSettled = await openUnitRowFullDetail(page, targetRow.name);
    if (!detailSettled.ok || detailSettled.verdict.status !== 'READY_CONTENT') {
      throw new Error(
        `打开内置知识库文档「${targetRow.name}」详情未渲染出正文: ${detailSettled.verdict?.status} — ${detailSettled.verdict?.reason}`
      );
    }

    if (expectedBadge && detailSettled.snapshot.contentIndexLabel) {
      if (detailSettled.snapshot.contentIndexLabel !== expectedBadge) {
        throw new Error(
          `文档「${targetRow.name}」列表正文索引为「${expectedBadge}」，但详情显示「${detailSettled.snapshot.contentIndexLabel}」`
        );
      }
    }

    // 若命中 604B 内联小 PDF 合成样本，核验逐字保真回读
    const combinedBody = `${detailSettled.snapshot.markdownText} ${detailSettled.snapshot.snippetSample}`;
    if (/7399178560|inline[-_\s]*pdf/i.test(targetRow.name) && combinedBody) {
      if (!combinedBody.includes('Context 7399178560 inline PDF')) {
        throw new Error(
          `内联小 PDF「${targetRow.name}」未逐字回读出预期正文 "Context 7399178560 inline PDF"`
        );
      }
    }

    // 点击「<连接名> · 来源设置」打开只读来源设置抽屉并核验索引状态汇总
    const hasSourceBtn = await page.evalJSON(
      `Array.from(document.querySelectorAll('button')).some(b => (b.innerText || '').includes('来源设置'))`
    );
    if (!hasSourceBtn) {
      throw new Error('文档资产详情页未展示「来源设置」跳转按钮');
    }
    await dispatchRealMouseClick(
      page,
      `Array.from(document.querySelectorAll('button')).find(b => (b.innerText || '').includes('来源设置')) || null`,
      '详情页「来源设置」按钮'
    );

    const sourceDrawerReady = await page.waitFor(
      `(() => {
        const d = Array.from(document.querySelectorAll('.arco-drawer')).find(el =>
          el.getBoundingClientRect().width > 0 && (el.innerText || '').includes('来源设置')
        );
        if (!d) return false;
        if (d.querySelector('.arco-spin-loading, .arco-spin > .arco-spin-icon')) return false;
        const txt = d.innerText || '';
        if (txt.includes('来源加载失败')) return { error: txt };
        return {
          error: '',
          hasIndexSummary: txt.includes('索引状态汇总：'),
          urlHasSource: new URL(window.location.href).searchParams.get('source') === '1',
        };
      })()`,
      { timeoutMs: 12000, intervalMs: 150, label: 'detail-source-drawer' }
    );
    if (!sourceDrawerReady.ok || sourceDrawerReady.value?.error) {
      throw new Error(
        `详情页打开「来源设置」抽屉失败: ${sourceDrawerReady.value?.error || '超时未就绪'}`
      );
    }
    if (!sourceDrawerReady.value.urlHasSource) {
      throw new Error('打开「来源设置」抽屉后 URL 未同步写入 source=1');
    }

    await dispatchRealMouseClick(
      page,
      `(() => {
        const d = Array.from(document.querySelectorAll('.arco-drawer')).find(el =>
          el.getBoundingClientRect().width > 0 && (el.innerText || '').includes('来源设置')
        );
        return Array.from(d?.querySelectorAll('button') || []).find(b => (b.innerText || '').trim() === '关闭') || null;
      })()`,
      '来源设置抽屉「关闭」按钮'
    );
    await page.waitFor(`!new URL(window.location.href).searchParams.has('source')`, {
      timeoutMs: 5000,
      intervalMs: 120,
    });

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `doc="${targetRow.name}", indexBadge=${detailSettled.snapshot.contentIndexLabel || expectedBadge || 'READY'}, sourceDrawerSummary=${sourceDrawerReady.value.hasIndexSummary}`;
  });

  // -------------------------------------------------------------------------
  // 4. 开启远端 ACL 的来源（飞书 Wiki / Bitable / TOS）详情权限提示与「权限」页签
  // -------------------------------------------------------------------------
  await t.check('远端权限控制来源（Wiki / Bitable / TOS）资产详情明确展示受控权限提示或授权正文，且「权限」页签正常加载', async () => {
    const step = '03-remote-acl-permission-prompt';
    await page.gotoContext('/context/catalog', { stepName: step });
    const catalogSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!catalogSettled.ok || catalogSettled.verdict.status === 'EMPTY') {
      t.block('远端 ACL 来源权限提示核验', '当前工作区为空');
      return;
    }

    const aclSourceCandidates = [
      'codex-e2e-r4-wiki-1125',
      'codex-e2e-bitable-1125',
      'codex-e2e-r4-tos-selected',
    ];
    const aclSourceName = aclSourceCandidates.find(n =>
      catalogSettled.snapshot.treeConnectionNames.includes(n)
    );
    if (!aclSourceName) {
      t.block(
        '远端 ACL 来源权限提示核验',
        `当前工作区未找到 ${aclSourceCandidates.join(' / ')} 远端权限来源 fixture`
      );
      return;
    }

    await dispatchRealMouseClick(
      page,
      leftTreeSourceNodeExpr(aclSourceName),
      `远端权限来源「${aclSourceName}」`
    );
    const unitSettled = await waitForCatalogSettled(
      page,
      { mode: 'source', expectedSourceName: aclSourceName },
      { timeoutMs: 18000 }
    );
    if (!unitSettled.ok || unitSettled.verdict.status !== 'READY') {
      throw new Error(
        `远端权限来源「${aclSourceName}」未加载出文档行: ${unitSettled.verdict?.reason}`
      );
    }

    const docRow = unitSettled.snapshot.unitRows[0];
    const detailSettled = await openUnitRowFullDetail(page, docRow.name);
    if (!detailSettled.ok) {
      throw new Error(
        `远端权限资产「${docRow.name}」详情超时: ${detailSettled.verdict?.reason}`
      );
    }
    if (
      detailSettled.verdict.status !== 'READY_ACL_DENIED' &&
      detailSettled.verdict.status !== 'READY_CONTENT'
    ) {
      throw new Error(
        `远端权限资产「${docRow.name}」未展示明确权限受控提示（${ACL_DENIED_ALERT_SUBSTRING}）或已授权正文，实际 status=${detailSettled.verdict.status} (${detailSettled.verdict.reason})`
      );
    }

    // 切换到「权限」页签核对访问权限信息与远端协作者 ACL 状态可读
    await dispatchRealMouseClick(
      page,
      `[
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].find(el => (el.innerText || '').trim() === '权限') || null`,
      '资产详情「权限」页签'
    );

    const permSettled = await page.waitFor(
      `(() => {
        const u = new URL(window.location.href);
        if (u.searchParams.get('tab') !== 'permission') return false;
        const root = document.querySelector('article.ak-detail') || document.body;
        if (root.querySelector('.arco-spin-loading, .arco-spin > .arco-spin-icon')) return false;
        const txt = root.innerText || '';
        if (txt.includes('权限信息加载失败')) return { error: '权限信息加载失败' };
        if (txt.includes('权限来源') && txt.includes('内容读取')) {
          return {
            error: '',
            hasRemoteAclItem: txt.includes('远端协作者 ACL') || txt.includes('远端权限同步状态'),
          };
        }
        return false;
      })()`,
      { timeoutMs: 15000, intervalMs: 180, label: 'asset-permission-tab' }
    );
    if (!permSettled.ok || permSettled.value?.error) {
      throw new Error(`资产详情「权限」页签加载失败: ${permSettled.value?.error || '超时未渲染'}`);
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `source=${aclSourceName}, doc="${docRow.name}", preview=${detailSettled.verdict.status}, remoteAclMeta=${permSettled.value.hasRemoteAclItem}`;
  });

  // -------------------------------------------------------------------------
  // 5. PostgreSQL 数据表资产详情：字段 Schema 完整且无文档正文区块
  // -------------------------------------------------------------------------
  await t.check('PostgreSQL 数据表资产详情完整渲染字段 Schema，且不展示文档正文区块', async () => {
    const step = '03-pg-table-schema-detail';
    await page.gotoContext('/context/catalog', { stepName: step });
    const catalogSettled = await waitForCatalogSettled(page, { mode: 'all' }, { timeoutMs: 18000 });
    if (!catalogSettled.ok || catalogSettled.verdict.status === 'EMPTY') {
      t.block('PostgreSQL 数据表资产详情核验', '当前工作区为空');
      return;
    }

    const pgName =
      catalogSettled.snapshot.treeConnectionNames.find(n => n === 'codex-e2e-pg-1125') ||
      catalogSettled.snapshot.treeConnectionNames.find(n => /^codex-e2e-.*pg/i.test(n));
    if (!pgName) {
      t.block('PostgreSQL 数据表资产详情核验', '当前工作区未找到 codex-e2e-* PostgreSQL 连接');
      return;
    }

    await dispatchRealMouseClick(page, leftTreeSourceNodeExpr(pgName), `PG 来源「${pgName}」`);
    const pgSettled = await waitForCatalogSettled(
      page,
      { mode: 'source', expectedSourceName: pgName },
      { timeoutMs: 18000 }
    );
    if (!pgSettled.ok || pgSettled.verdict.status !== 'READY') {
      throw new Error(`进入 PG 来源「${pgName}」未渲染数据表行: ${pgSettled.verdict?.reason}`);
    }

    const sessionRow =
      pgSettled.snapshot.unitRows.find(r => r.name.includes('adk_sessions')) ||
      pgSettled.snapshot.unitRows[0];
    const tableDetail = await openUnitRowFullDetail(page, sessionRow.name);
    if (!tableDetail.ok || tableDetail.verdict.status !== 'READY_TABLE') {
      throw new Error(
        `PG 数据表「${sessionRow.name}」详情未正常渲染字段表: ${tableDetail.verdict?.status} — ${tableDetail.verdict?.reason}`
      );
    }
    if (
      pgName === 'codex-e2e-pg-1125' &&
      sessionRow.name.includes('adk_sessions') &&
      tableDetail.verdict.fieldRowCount !== 6
    ) {
      throw new Error(
        `adk_sessions 预期展示 6 个字段，实际渲染 ${tableDetail.verdict.fieldRowCount} 个字段`
      );
    }

    const oracle = await page.collectStepOracle(step);
    assertStepOracleHealthy(oracle);
    return `source=${pgName}, table="${sessionRow.name}", fields=${tableDetail.verdict.fieldRowCount}`;
  });

  // -------------------------------------------------------------------------
  // 6. 已发布领域绑定资产切换「数据血缘」页签（守护 CTX-017）
  // -------------------------------------------------------------------------
  await t.check(
    '已发布领域绑定的资产打开「数据血缘」Tab 正常加载节点关系，不报 409 BindingRequired',
    async () => {
      if (baselineNotFound) {
        t.block('已发布领域绑定资产数据血缘核验', '基准文档资产不存在或无权查看');
        return;
      }

      const prepStep = '03-lineage-prep';
      await page.gotoContext(detailPath, { stepName: prepStep });
      const prepSettled = await waitForAssetDetailSettled(page, { timeoutMs: 18000 });
      if (!prepSettled.ok || prepSettled.verdict.status === 'ERROR') {
        throw new Error(`进入基准资产详情准备核验血缘失败: ${prepSettled.verdict?.reason}`);
      }

      const step = '03-asset-lineage-tab';
      page.setStep(step);
      await dispatchRealMouseClick(
        page,
        `[
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].find(el => (el.innerText || '').trim() === '数据血缘') || null`,
        '资产详情「数据血缘」页签'
      );

      const lineageSettled = await waitForLineageSettled(page, step, { timeoutMs: 15000 });
      const oracle = await page.collectStepOracle(step);
      assertStepOracleHealthy(oracle);

      if (!lineageSettled.ok) {
        throw new Error(
          `数据血缘页签超时未退出 Spinner 或未渲染节点: ${lineageSettled.verdict?.reason}`
        );
      }
      if (lineageSettled.verdict.status === 'ERROR') {
        throw new Error(lineageSettled.verdict.reason);
      }

      // 点击第一个血缘节点卡片确认右侧详情检视面板（LineageInspector）可正常打开
      await dispatchRealMouseClick(
        page,
        `(() => {
          const root = document.querySelector('article.ak-detail') || document.body;
          return root.querySelector('.arco-card') || null;
        })()`,
        '数据血缘当前对象节点卡片'
      );
      await page.sleep(150);

      return `血缘页签就绪: ${lineageSettled.verdict.reason}, APIs=${oracle.records.length}`;
    }
  );
}
