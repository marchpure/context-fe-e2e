// 模块 05：知识加工真实合成报告、前后建议对比、来源引用与跳转（CTX-011）、产物/执行日志、双轮效果评估逐题结果与未启用评测分离（CTX-002）

import {
  KNOWN_FIXTURES,
  assertOrderedBoxes,
  cdpClickPoint,
  cdpPressKey,
  classifyEvaluationReportView,
  classifyProposalCitationsView,
  restoreSafeWorkspace,
  validateStepTerminalState,
  waitForTerminalDom,
} from '../lib/ui-checks.mjs';

async function closeAnyDrawer(page) {
  const pos = await page.evalJSON(() => {
    const drawers = [...document.querySelectorAll('.arco-drawer')];
    const top = drawers[drawers.length - 1];
    if (!top) return null;
    const btn =
      top.querySelector('.arco-drawer-close-icon') ||
      [...top.querySelectorAll('button')].find(el =>
        /^(返回报告|关闭|取消|×)$/.test((el.textContent || '').trim())
      ) ||
      top.querySelector('button[aria-label*="关闭"], button[aria-label*="close" i]');
    if (!btn) return null;
    const r = btn.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  });
  if (pos) {
    await cdpClickPoint(page, pos.x, pos.y);
  } else {
    await cdpPressKey(page, 'Escape', 'Escape', 27).catch(() => {});
  }
  await waitForTerminalDom(page, () => !document.querySelector('.arco-drawer'), {
    timeoutMs: 6000,
    settleMs: 100,
  });
}

async function openKnownRunReport(page, cfg, domainId, taskId, stepName) {
  const path = `/context/domains/${encodeURIComponent(domainId)}/processing?taskId=${encodeURIComponent(taskId)}`;
  await page.gotoContext(path, {
    stepName,
    timeoutMs: 18000,
    readyFn: () => {
      if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
      const txt = document.body?.innerText || '';
      if (/无法读取知识加工运行报告/.test(txt)) return 'LOAD_ERROR';
      if (/正在加载本次运行的变更建议/.test(txt)) return false;
      const hasReportTabs = ['概览', '效果评估', '产物与来源', '执行日志'].every(label =>
        [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].some(
          el => (el.textContent || '').trim() === label
        )
      );
      return hasReportTabs ? 'READY' : false;
    },
  });

  const settled = await waitForTerminalDom(
    page,
    () => {
      if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
      const txt = document.body?.innerText || '';
      if (/无法读取知识加工运行报告/.test(txt)) return 'LOAD_ERROR';
      if (/正在加载本次运行的变更建议/.test(txt)) return false;
      const tabs = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].filter(
        el => ['概览', '效果评估', '产物与来源', '执行日志'].includes((el.textContent || '').trim())
      );
      return tabs.length >= 4 ? 'READY' : false;
    },
    { timeoutMs: 14000 }
  );

  const oracle = await page.collectStepOracle(stepName);
  validateStepTerminalState(oracle, cfg, {
    stepLabel: `打开运行报告 ${taskId}`,
    requiredActions: [/Get.*Task/i],
    forbidWrite: true,
    allowErrorCodes: settled.value === 'LOAD_ERROR' ? ['NotFound', 'ResourceNotFound'] : [],
  });

  return { settled, oracle, unreadable: settled.value === 'LOAD_ERROR' };
}

async function switchReportTab(page, tabTitle) {
  const tabBox = await page.evalJSON(`(() => {
    const target = ${JSON.stringify(tabTitle)};
    const el = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ].find(
      node => (node.textContent || '').trim() === target
    );
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
  })()`);
  if (!tabBox) {
    throw new Error(`加工运行报告缺少「${tabTitle}」页签`);
  }
  await cdpClickPoint(page, tabBox.x, tabBox.y);
  await page.sleep(250);
}

async function scrapeEvaluationTabView(page) {
  await switchReportTab(page, '效果评估');
  const evalSettled = await waitForTerminalDom(
    page,
    () => {
      if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
      const content = document.querySelector('.console-content-wrapper-v2') || document.body;
      const txt = content.innerText || '';
      return /问答效果评估|DeepEval 双轮 MCP 盲测与双归因报告/.test(txt) ? true : false;
    },
    { timeoutMs: 10000 }
  );
  if (!evalSettled.ok) {
    throw new Error('切换「效果评估」页签后评估面板未就绪');
  }

  return page.evalJSON(() => {
    const root = document.querySelector('.console-content-wrapper-v2') || document.body;
    const cards = [...root.querySelectorAll('section')];
    const evalSection =
      cards.find(sec => /问答效果评估|DeepEval 双轮 MCP 盲测/.test(sec.innerText || '')) || root;
    const badges = [...evalSection.querySelectorAll('.arco-tag, [class*="tag" i]')]
      .map(el => (el.textContent || '').trim())
      .filter(Boolean);
    const table = evalSection.querySelector('table');
    const rows = table
      ? [...table.querySelectorAll('tbody tr')]
          .filter(tr => !tr.querySelector('.arco-empty'))
          .map(tr => {
            const tds = [...tr.querySelectorAll('td')].map(td => (td.innerText || '').trim());
            return {
              question: tds[0] || '',
              verdict: tds[1] || '',
              attribution: tds.length >= 5 ? tds[2] : '',
              matched: tds.length >= 5 ? tds[3] : tds[2] || '',
              reason: tds[tds.length - 1] || '',
            };
          })
      : [];
    return {
      text: (evalSection.innerText || '').slice(0, 4000),
      badges,
      rows,
    };
  });
}

export async function run(t, page, cfg) {
  const isBaselineWs = cfg.workspaceId === KNOWN_FIXTURES.workspaceId;
  const targetDomainId = isBaselineWs ? KNOWN_FIXTURES.r4Domain.domainId : cfg.baselineDomainId;
  let openedReportActive = false;

  await t.check(
    '知识加工记录页终态加载并真实点击进入有合成建议产物的运行报告',
    async () => {
      const step = '05-processing-hub-and-open-report';
      const procPath = `/context/domains/${encodeURIComponent(targetDomainId)}/processing`;
      const nav = await page.gotoContext(procPath, {
        stepName: step,
        readyFn: () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          if (/正在加载加工记录/.test(document.body?.innerText || '')) return false;
          return Boolean(
            document.querySelector('table') ||
              document.querySelector('.arco-empty') ||
              document.querySelector('.arco-alert')
          );
        },
      });

      const settled = await waitForTerminalDom(
        page,
        () =>
          !document.querySelector('.spin-center, .arco-spin-loading') &&
          !/正在加载加工记录/.test(document.body?.innerText || ''),
        { timeoutMs: 12000 }
      );
      const listOracle = await page.collectStepOracle(step);
      validateStepTerminalState(listOracle, cfg, {
        stepLabel: '领域知识加工记录页',
        requiredActions: [/List.*Tasks/i],
        forbidWrite: true,
      });
      if (!nav.settledOk || !settled.ok) {
        throw new Error(`知识加工记录列表加载超时或持续 loading (${nav.firstContentMs}ms)`);
      }
      if (/无法读取知识加工记录/.test(listOracle.visibleText)) {
        throw new Error('知识加工记录页展示「无法读取知识加工记录」错误提示');
      }

      const hubInfo = await page.evalJSON(() => {
        const topTabs = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ]
          .map(el => {
            const r = el.getBoundingClientRect();
            return { label: (el.textContent || '').trim(), x: r.x, y: r.y, width: r.width, height: r.height };
          })
          .filter(x => ['加工记录', '已保存任务'].includes(x.label));

        const preferredSuffixes = ['#73b2bd', '#e167e6', '#fdd82b', '#c805a2'];
        const trs = [...document.querySelectorAll('table tbody tr')];
        const candidates = [];
        for (const tr of trs) {
          const rowText = (tr.innerText || '').trim();
          const reportBtn = [...tr.querySelectorAll('button, a')].find(el =>
            /查看报告/.test((el.textContent || '').trim())
          );
          if (!reportBtn) continue;
          const r = reportBtn.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) continue;
          const prefRank = preferredSuffixes.findIndex(suf => rowText.includes(suf));
          const hasProposals = /待审核|已采纳/.test(rowText) && !/未生成建议/.test(rowText);
          candidates.push({
            rowText: rowText.slice(0, 180),
            prefRank: prefRank >= 0 ? prefRank : 99,
            hasProposals,
            x: r.x + r.width / 2,
            y: r.y + r.height / 2,
          });
        }
        candidates.sort(
          (a, b) => a.prefRank - b.prefRank || Number(b.hasProposals) - Number(a.hasProposals)
        );
        return { topTabs, chosen: candidates[0] || null, totalCompleted: candidates.length };
      });

      assertOrderedBoxes(hubInfo.topTabs, ['加工记录', '已保存任务'], {
        axis: 'x',
        contextLabel: '知识加工主页页签',
      });

      if (!hubInfo.chosen) {
        t.block(
          '知识加工记录页终态加载并真实点击进入有合成建议产物的运行报告',
          `领域 ${targetDomainId} 当前无状态为已完成（「查看报告 →」）的合成加工运行记录`
        );
        return;
      }

      const openStep = '05-click-open-run-report';
      page.setStep(openStep);
      await cdpClickPoint(page, hubInfo.chosen.x, hubInfo.chosen.y);

      const reportSettled = await waitForTerminalDom(
        page,
        () => {
          if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
          const txt = document.body?.innerText || '';
          if (/正在加载本次运行的变更建议/.test(txt)) return false;
          const reportTabs = [
          ...document.querySelectorAll('[role="tab"], .arco-tabs-header-title'),
          ...Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
            [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])]),
        ]
            .map(el => {
              const r = el.getBoundingClientRect();
              return { label: (el.textContent || '').trim(), x: r.x, y: r.y, width: r.width, height: r.height };
            })
            .filter(x => ['概览', '效果评估', '产物与来源', '执行日志'].includes(x.label));
          if (reportTabs.length < 4) return false;
          const detailBtns = [...document.querySelectorAll('button, a')].filter(el =>
            /查看详情/.test((el.textContent || '').trim())
          );
          return {
            reportTabs,
            proposalButtons: detailBtns.length,
            hasLoadErr: /变更建议加载失败|无法读取知识加工运行报告/.test(txt),
          };
        },
        { timeoutMs: 16000 }
      );

      const reportOracle = await page.collectStepOracle(openStep);
      validateStepTerminalState(reportOracle, cfg, {
        stepLabel: '点击进入知识加工运行报告',
        requiredActions: [/Get.*Task/i],
        forbidWrite: true,
      });

      if (!reportSettled.ok || !reportSettled.value) {
        throw new Error('点击「查看报告 →」后运行报告超时未完成建议加载');
      }
      if (reportSettled.value.hasLoadErr) {
        throw new Error('运行报告出现「变更建议加载失败 / 无法读取报告」错误提示');
      }
      assertOrderedBoxes(
        reportSettled.value.reportTabs,
        ['概览', '效果评估', '产物与来源', '执行日志'],
        { axis: 'x', contextLabel: '运行报告四页签' }
      );
      if (reportSettled.value.proposalButtons < 1) {
        t.block(
          '知识加工记录页终态加载并真实点击进入有合成建议产物的运行报告',
          `已打开报告（${hubInfo.chosen.rowText}），但该次运行未产出可检视的合成变更建议`
        );
        return;
      }

      openedReportActive = true;
      return `completedRuns=${hubInfo.totalCompleted}, proposals=${reportSettled.value.proposalButtons}, reportSettled=${reportSettled.elapsedMs}ms`;
    }
  );

  await t.check(
    '运行报告「产物与来源」与「执行日志」页签展示真实输入来源快照、产物汇总与阶段事件（零写请求）',
    async () => {
      if (!openedReportActive) {
        t.block(
          '运行报告「产物与来源」与「执行日志」页签展示真实输入来源快照、产物汇总与阶段事件（零写请求）',
          '前置已完成合成加工报告未就绪，跳过报告内来源快照与执行日志页签核验'
        );
        return;
      }

      const step = '05-report-artifacts-and-logs';
      page.setStep(step);

      try {
        await switchReportTab(page, '产物与来源');
        const artSettled = await waitForTerminalDom(
          page,
          () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const root = document.querySelector('.console-content-wrapper-v2') || document.body;
            const txt = root.innerText || '';
            if (!/输入来源快照|计划读取的来源/.test(txt) || !/加工产物/.test(txt)) return false;
            const tables = [...root.querySelectorAll('table')];
            const srcRows = tables[0]
              ? [...tables[0].querySelectorAll('tbody tr')].filter(
                  tr => !tr.querySelector('.arco-empty') && !/未记录具体输入来源/.test(tr.innerText || '')
                )
              : [];
            const snapBtn = [...root.querySelectorAll('button, a')].find(el => {
              const bTxt = (el.textContent || '').trim();
              const r = el.getBoundingClientRect();
              const disabled =
                el.disabled || el.getAttribute('aria-disabled') === 'true' || /disabled/i.test(el.className || '');
              return bTxt === '查看来源快照' && !disabled && r.width > 0 && r.height > 0;
            });
            const br = snapBtn?.getBoundingClientRect();
            return {
              sourceCount: srcRows.length,
              hasProposalBundle: /建议包/.test(txt) && /[1-9]\d*\s*条变更建议/.test(txt),
              hasConfidenceBundle: /置信度报告/.test(txt),
              snapBtnPos: snapBtn && br ? { x: br.x + br.width / 2, y: br.y + br.height / 2 } : null,
            };
          },
          { timeoutMs: 10000 }
        );

        if (!artSettled.ok || !artSettled.value) {
          throw new Error('切换「产物与来源」后来源与产物表格未完成挂载');
        }
        if (artSettled.value.sourceCount < 1) {
          throw new Error('「产物与来源」未展示具体的输入来源快照行');
        }
        if (!artSettled.value.hasProposalBundle || !artSettled.value.hasConfidenceBundle) {
          throw new Error('「加工产物」缺少非空的「建议包」或「置信度报告」条目');
        }

        if (artSettled.value.snapBtnPos) {
          await cdpClickPoint(page, artSettled.value.snapBtnPos.x, artSettled.value.snapBtnPos.y);
          const snapDrawer = await waitForTerminalDom(
            page,
            () => {
              const drawer = document.querySelector('.arco-drawer');
              if (!drawer) return false;
              const r = drawer.getBoundingClientRect();
              return r.width >= 300 && r.height >= 180 && (drawer.innerText || '').trim().length > 10
                ? { w: Math.round(r.width), h: Math.round(r.height) }
                : false;
            },
            { timeoutMs: 6000 }
          );
          if (!snapDrawer.ok) {
            throw new Error('点击「查看来源快照」后快照抽屉未打开或内容为空');
          }
          await closeAnyDrawer(page);
        }

        await switchReportTab(page, '执行日志');
        const logsSettled = await waitForTerminalDom(
          page,
          () => {
            if (document.querySelector('.spin-center, .arco-spin-loading')) return false;
            const root = document.querySelector('.console-content-wrapper-v2') || document.body;
            const table = root.querySelector('table');
            if (!table) return false;
            const rows = [...table.querySelectorAll('tbody tr')].filter(
              tr => !tr.querySelector('.arco-empty') && !/暂无执行日志记录/.test(tr.innerText || '')
            );
            return rows.length > 0
              ? {
                  eventCount: rows.length,
                  sample: [...rows[0].querySelectorAll('td')].map(td => (td.textContent || '').trim()),
                }
              : false;
          },
          { timeoutMs: 10000 }
        );

        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '报告来源快照与执行日志核验',
          forbidWrite: true,
        });

        if (!logsSettled.ok || !logsSettled.value) {
          throw new Error('「执行日志」页签为空（显示「暂无执行日志记录」或表格未渲染）');
        }
        const [eventTime, eventStage, eventMsg] = logsSettled.value.sample;
        if (!eventStage || !eventMsg) {
          throw new Error(`「执行日志」首行缺少阶段或说明内容: ${JSON.stringify(logsSettled.value.sample)}`);
        }

        await switchReportTab(page, '概览');
        return `inputSources=${artSettled.value.sourceCount}, logEvents=${logsSettled.value.eventCount} (首条: ${eventTime || '—'} ${eventStage})`;
      } finally {
        await closeAnyDrawer(page).catch(() => {});
      }
    }
  );

  await t.check(
    '建议审核抽屉只读展示前后建议对比视图（加工时版本 vs 建议版本）且不触发审核或认证写接口',
    async () => {
      const step = '05-proposal-before-after-diff';
      try {
        if (isBaselineWs) {
          const { unreadable } = await openKnownRunReport(
            page,
            cfg,
            KNOWN_FIXTURES.r4Domain.domainId,
            KNOWN_FIXTURES.r4Domain.enrichmentTasks.rebuildUpdateId,
            step
          );
          if (unreadable) {
            t.block(
              '建议审核抽屉只读展示前后建议对比视图（加工时版本 vs 建议版本）且不触发审核或认证写接口',
              `已知更新建议合成任务 ${KNOWN_FIXTURES.r4Domain.enrichmentTasks.rebuildUpdateId} 在当前环境不可读`
            );
            return;
          }
        } else if (!openedReportActive) {
          t.block(
            '建议审核抽屉只读展示前后建议对比视图（加工时版本 vs 建议版本）且不触发审核或认证写接口',
            '当前工作区缺少已打开的已完成合成报告，无法检视前后建议对比视图'
          );
          return;
        } else {
          page.setStep(step);
          await switchReportTab(page, '概览');
        }

        // 查找「更新」类型的知识页建议行以验证双栏变更对比（加工时版本 vs 建议版本）
        const updateProposal = await page.evalJSON(() => {
          const rows = [...document.querySelectorAll('[class*="itemRow"]')];
          const matched = rows.find(row => {
            const tags = [...row.querySelectorAll('.arco-tag')].map(t => (t.textContent || '').trim());
            return tags.includes('更新');
          });
          if (!matched) return null;
          const btn = [...matched.querySelectorAll('button, a')].find(el =>
            /查看详情/.test((el.textContent || '').trim())
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return r.width > 0 && r.height > 0
            ? {
                title: (matched.querySelector('strong')?.textContent || '').trim(),
                x: r.x + r.width / 2,
                y: r.y + r.height / 2,
              }
            : null;
        });

        if (!updateProposal) {
          if (isBaselineWs) {
            throw new Error(
              `已知重跑任务 ${KNOWN_FIXTURES.r4Domain.enrichmentTasks.rebuildUpdateId} 未找到「更新」类型的知识页建议行`
            );
          }
          t.block(
            '建议审核抽屉只读展示前后建议对比视图（加工时版本 vs 建议版本）且不触发审核或认证写接口',
            '当前工作区报告仅有新增建议、缺少「更新」类型合成建议，无法验证双栏前后对比视图'
          );
          return;
        }

        await cdpClickPoint(page, updateProposal.x, updateProposal.y);
        const drawerSettled = await waitForTerminalDom(
          page,
          () => {
            const drawer = document.querySelector('.arco-drawer');
            if (!drawer) return false;
            const r = drawer.getBoundingClientRect();
            if (!(r.width >= 680 && r.height >= 360)) return false;
            const navBtns = [...drawer.querySelectorAll('nav[aria-label="建议内容导航"] label, nav[aria-label="建议内容导航"] [role="radio"]')]
              .map(el => {
                const br = el.getBoundingClientRect();
                return { label: (el.textContent || '').trim(), x: br.x, y: br.y, width: br.width, height: br.height };
              })
              .filter(b => b.width > 0 && b.height > 0);
            const bodySec = drawer.querySelector('#proposal-body-section');
            if (!bodySec) return false;
            const cols = [...bodySec.querySelectorAll('[class*="diffCol"]')].map(col => {
              const cr = col.getBoundingClientRect();
              return {
                text: (col.innerText || '').trim(),
                x: cr.x,
                width: Math.round(cr.width),
                height: Math.round(cr.height),
              };
            });
            return {
              drawerWidth: Math.round(r.width),
              drawerHeight: Math.round(r.height),
              navBtns,
              hasDiffHeading: /变更对比/.test(bodySec.innerText || ''),
              cols,
            };
          },
          { timeoutMs: 10000 }
        );

        if (!drawerSettled.ok || !drawerSettled.value) {
          throw new Error('点击「查看详情 →」后宽幅建议审核抽屉未打开或尺寸异常');
        }
        const dv = drawerSettled.value;
        assertOrderedBoxes(dv.navBtns, ['正文变更', '来源依据', '变更影响', '审核记录'], {
          axis: 'x',
          contextLabel: '建议审核抽屉锚点导航',
        });

        if (!dv.hasDiffHeading || dv.cols.length < 2) {
          throw new Error(`「更新」建议未渲染双栏「变更对比」视图 (cols=${dv.cols.length})`);
        }
        const [beforeCol, afterCol] = dv.cols;
        if (
          !(beforeCol.width >= 160 && afterCol.width >= 160 && beforeCol.x < afterCol.x) ||
          !/加工时版本/.test(beforeCol.text) ||
          !/建议版本/.test(afterCol.text) ||
          afterCol.text.replace(/^建议版本\s*/, '').trim().length === 0
        ) {
          throw new Error(
            `双栏前后对比尺寸、左右顺序或正文异常: left=${beforeCol.width}px@x=${Math.round(beforeCol.x)}, right=${afterCol.width}px@x=${Math.round(afterCol.x)}`
          );
        }

        // 绝不点击「采纳到领域草稿」或「拒绝建议」，只读关闭抽屉
        await closeAnyDrawer(page);
        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '建议前后对比只读抽屉检视',
          forbidWrite: true,
        });

        return `drawer=${dv.drawerWidth}x${dv.drawerHeight}, proposal="${updateProposal.title}", 双栏前后对比正常且 0 写请求`;
      } finally {
        await closeAnyDrawer(page).catch(() => {});
      }
    }
  );

  await t.check(
    '建议抽屉「来源依据」正确标注 Markdown 文档类型并具备「查看资产 ↗」有效跳转',
    async () => {
      const step = '05-proposal-citations-link';
      try {
        if (isBaselineWs) {
          const { unreadable } = await openKnownRunReport(
            page,
            cfg,
            KNOWN_FIXTURES.r4Domain.domainId,
            KNOWN_FIXTURES.r4Domain.enrichmentTasks.rebuildUpdateId,
            step
          );
          if (unreadable) {
            t.block(
              '建议抽屉「来源依据」正确标注 Markdown 文档类型并具备「查看资产 ↗」有效跳转',
              `已知合成任务 ${KNOWN_FIXTURES.r4Domain.enrichmentTasks.rebuildUpdateId} 在当前环境不可读`
            );
            return;
          }
        } else if (!openedReportActive) {
          t.block(
            '建议抽屉「来源依据」正确标注 Markdown 文档类型并具备「查看资产 ↗」有效跳转',
            '当前工作区缺少已打开的合成加工报告，无法检视建议引用来源'
          );
          return;
        } else {
          page.setStep(step);
        }

        // 打开知识页分组中的首条建议抽屉检查 #proposal-source-section
        const firstEntryProposal = await page.evalJSON(() => {
          const rows = [...document.querySelectorAll('[class*="itemRow"]')];
          const entryRow =
            rows.find(r => !/条目关系/.test(r.innerText || '')) || rows[0];
          if (!entryRow) return null;
          const btn = [...entryRow.querySelectorAll('button, a')].find(el =>
            /查看详情/.test((el.textContent || '').trim())
          );
          if (!btn) return null;
          const r = btn.getBoundingClientRect();
          return r.width > 0 && r.height > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
        });

        if (!firstEntryProposal) {
          throw new Error('运行报告概览中缺少可点击「查看详情 →」的知识页建议');
        }

        await cdpClickPoint(page, firstEntryProposal.x, firstEntryProposal.y);
        const sourceReady = await waitForTerminalDom(
          page,
          () => {
            const sec = document.querySelector('.arco-drawer #proposal-source-section');
            if (!sec) return false;
            const cards = [...sec.querySelectorAll('[class*="sourceCard"]')].map(card => {
              const titleRaw = (card.querySelector('strong')?.textContent || '').trim();
              const title = titleRaw.replace(/^\[\d+\]\s*/, '').trim();
              const tags = [...card.querySelectorAll('.arco-tag')].map(t => (t.textContent || '').trim());
              const assetBtn = [...card.querySelectorAll('button, a')].find(el =>
                /查看资产/.test((el.textContent || '').trim())
              );
              const snapBtn = [...card.querySelectorAll('button, a')].find(el =>
                /查看快照信息/.test((el.textContent || '').trim())
              );
              const ar = assetBtn?.getBoundingClientRect();
              const sr = snapBtn?.getBoundingClientRect();
              return {
                title,
                kindLabel: tags[0] || '',
                revision: tags[1] || '',
                hasAssetLink: Boolean(assetBtn && ar && ar.width > 0 && ar.height > 0),
                assetPos:
                  assetBtn && ar && ar.width > 0 ? { x: ar.x + ar.width / 2, y: ar.y + ar.height / 2 } : null,
                snapPos:
                  snapBtn && sr && sr.width > 0 ? { x: sr.x + sr.width / 2, y: sr.y + sr.height / 2 } : null,
              };
            });
            return { cards, emptyHint: /未附带原文引用切片/.test(sec.innerText || '') };
          },
          { timeoutMs: 10000 }
        );

        if (!sourceReady.ok || !sourceReady.value) {
          throw new Error('建议审核抽屉未渲染「来源依据」区块');
        }
        if (sourceReady.value.cards.length === 0 && sourceReady.value.emptyHint && !isBaselineWs) {
          await closeAnyDrawer(page);
          t.block(
            '建议抽屉「来源依据」正确标注 Markdown 文档类型并具备「查看资产 ↗」有效跳转',
            '当前报告首条建议未附带原文引用切片，缺少源文档引用 fixture'
          );
          return;
        }

        const citCount = classifyProposalCitationsView(sourceReady.value.cards);
        const firstCard = sourceReady.value.cards[0];

        // 展开快照信息验证纯前端状态可读
        if (firstCard?.snapPos) {
          await cdpClickPoint(page, firstCard.snapPos.x, firstCard.snapPos.y);
          const snapExpanded = await waitForTerminalDom(
            page,
            () => /来源版本：/.test(document.querySelector('#proposal-source-section')?.innerText || ''),
            { timeoutMs: 4000, settleMs: 100 }
          );
          if (!snapExpanded.ok) {
            throw new Error('点击「查看快照信息」后未展示来源版本快照元数据');
          }
        }

        // 点击「查看资产 ↗」验证真实跳转到 /context/catalog/:Id/detail 且保持 workspaceId 与 project
        if (firstCard?.assetPos) {
          // 重新获取展开后的最新按钮坐标
          const freshPos = await page.evalJSON(() => {
            const sec = document.querySelector('#proposal-source-section');
            const btn = sec && [...sec.querySelectorAll('button, a')].find(el => /查看资产/.test((el.textContent || '').trim()));
            if (!btn) return null;
            const r = btn.getBoundingClientRect();
            return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
          });
          if (freshPos) {
            await cdpClickPoint(page, freshPos.x, freshPos.y);
            const jumped = await waitForTerminalDom(
              page,
              () =>
                /\/context\/catalog\/[^/]+\/detail/.test(window.location.pathname) &&
                !document.querySelector('.spin-center, .arco-spin-loading'),
              { timeoutMs: 12000 }
            );
            const jumpOracle = await page.collectStepOracle(step);
            validateStepTerminalState(jumpOracle, cfg, {
              stepLabel: '点击建议来源「查看资产 ↗」跳转',
              forbidWrite: true,
            });
            if (!jumped.ok) {
              throw new Error(`点击「查看资产 ↗」后未成功跳转至资产详情终态 (${jumpOracle.href})`);
            }
            return `citations=${citCount}, kind=${firstCard.kindLabel}, 跳转资产详情成功 (${jumpOracle.href})`;
          }
        }

        await closeAnyDrawer(page);
        const oracle = await page.collectStepOracle(step);
        validateStepTerminalState(oracle, cfg, {
          stepLabel: '建议来源依据检查',
          forbidWrite: true,
        });
        return `citations=${citCount}, kind=${firstCard?.kindLabel || '—'}`;
      } finally {
        await closeAnyDrawer(page).catch(() => {});
        await restoreSafeWorkspace(page, cfg, '05-citations-restore');
      }
    }
  );

  await t.check(
    '双轮问答效果评估报告展示真实逐题评估结果，且「评测未通过 / 降级」与加工执行成功严格分离',
    async () => {
      if (!isBaselineWs) {
        t.block(
          '双轮问答效果评估报告展示真实逐题评估结果，且「评测未通过 / 降级」与加工执行成功严格分离',
          `当前工作区 ${cfg.workspaceId} 非回归基线工作区，缺少已知双轮问答评测合成任务 ${KNOWN_FIXTURES.r4Domain.enrichmentTasks.dualEvalFailedId}`
        );
        return;
      }

      const step = '05-dual-pass-eval-report';
      const evalTaskId = KNOWN_FIXTURES.r4Domain.enrichmentTasks.dualEvalFailedId;
      const { unreadable } = await openKnownRunReport(
        page,
        cfg,
        KNOWN_FIXTURES.r4Domain.domainId,
        evalTaskId,
        step
      );
      if (unreadable) {
        t.block(
          '双轮问答效果评估报告展示真实逐题评估结果，且「评测未通过 / 降级」与加工执行成功严格分离',
          `已知双轮评测任务 ${evalTaskId} 在当前环境不可读`
        );
        return;
      }

      const headerStatus = await page.evalJSON(() => {
        const head = document.querySelector('[class*="pageHead"]') || document.body;
        return (head.innerText || '').slice(0, 300);
      });
      if (!/成功|已完成/.test(headerStatus)) {
        throw new Error(`双轮评测对照任务 ${evalTaskId} 顶栏加工状态异常: ${headerStatus}`);
      }

      // 切到「效果评估」页签（严禁点击「重新评测」按钮以免发起新沙箱任务）
      const evalView = await scrapeEvaluationTabView(page);
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '双轮问答效果评估核验',
        forbidWrite: true,
      });

      const classified = classifyEvaluationReportView(evalView);
      if (classified.kind !== 'failed' || classified.rowCount < 2) {
        throw new Error(
          `对照任务 ${evalTaskId} 应呈现「评测未通过」及至少 2 道逐题评估结果，实际 kind=${classified.kind}, rows=${classified.rowCount}, badges=[${classified.badges.join(', ')}]`
        );
      }
      const hasInputGapItem = evalView.rows.some(
        r => /待改进/.test(r.verdict) && /输入源资料缺失/.test(r.attribution)
      );
      const hasPassItem = evalView.rows.some(
        r => /已覆盖通过/.test(r.verdict) && /双轮通过/.test(r.attribution)
      );
      if (!hasInputGapItem || !hasPassItem) {
        throw new Error(
          `对照任务 ${evalTaskId} 逐题归因结果与基线不符: ${JSON.stringify(evalView.rows)}`
        );
      }

      return `task=${evalTaskId}, evalKind=${classified.kind}, rows=${classified.rowCount}（含「待改进/输入源资料缺失」与「已覆盖通过/双轮通过」逐题对照）`;
    }
  );

  await t.check(
    '未启用或未配置评测集的加工报告与通过/失败态严格分离且不误渲染 0% 命中率',
    async () => {
      if (!isBaselineWs) {
        t.block(
          '未启用或未配置评测集的加工报告与通过/失败态严格分离且不误渲染 0% 命中率',
          `当前工作区 ${cfg.workspaceId} 非回归基线工作区，缺少未启用评测的对照运行任务 ${KNOWN_FIXTURES.r4Domain.enrichmentTasks.incrementalV2Id}`
        );
        return;
      }

      const step = '05-disabled-eval-separation';
      const nonEvalTaskId = KNOWN_FIXTURES.r4Domain.enrichmentTasks.incrementalV2Id;
      const { unreadable } = await openKnownRunReport(
        page,
        cfg,
        KNOWN_FIXTURES.r4Domain.domainId,
        nonEvalTaskId,
        step
      );
      if (unreadable) {
        t.block(
          '未启用或未配置评测集的加工报告与通过/失败态严格分离且不误渲染 0% 命中率',
          `对照任务 ${nonEvalTaskId} 在当前环境不可读`
        );
        return;
      }

      const overviewEvalText = await page.evalJSON(() => {
        const root = document.querySelector('.console-content-wrapper-v2') || document.body;
        return (root.innerText || '').slice(0, 1200);
      });
      const evalView = await scrapeEvaluationTabView(page);
      const oracle = await page.collectStepOracle(step);
      validateStepTerminalState(oracle, cfg, {
        stepLabel: '未启用评测运行报告检查',
        forbidWrite: true,
      });

      const mergedView = {
        ...evalView,
        text: `${overviewEvalText}\n${evalView.text}`,
      };
      const classified = classifyEvaluationReportView(mergedView);
      if (classified.kind !== 'unconfigured') {
        throw new Error(
          `未关联评测集的运行 ${nonEvalTaskId} 未归入未配置/已关闭态，实际 kind=${classified.kind}, badges=[${classified.badges.join(', ')}]`
        );
      }

      return `task=${nonEvalTaskId}, kind=${classified.kind}, badges=[${classified.badges.join(', ') || '无数值命中率'}]`;
    }
  );
}
