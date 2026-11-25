import { readFileSync } from 'node:fs';
import { dispatchRealMouseClick } from '../lib/catalog-checks.mjs';
import {
  assertFrozenRowsUnchanged,
  assertMergedReview,
  assertPinnedCitation,
  assertScanRow,
  assertScopedRoute,
  assertViewerDenial,
} from '../lib/regression-checks.mjs';
import { findWriteActions, KNOWN_FIXTURES, validateStepTerminalState, waitForTerminalDom } from '../lib/ui-checks.mjs';
import { readVersionDrawerSnapshot } from './04-domains-versions.spec.mjs';

const pg = {
  sourceId: 'res-01a21278ed7472dfbe6cb5caf4a882bc',
  name: 'codex-e2e-loop-1125-pg-discovery',
  table: 'public.events',
};
const dialog = '.arco-modal, [role="dialog"]';
const ids = /^[a-zA-Z0-9_-]{1,128}$/;
const versionPattern = /^\d+\.\d+\.\d+$/;
const synthetic = name => /^codex-e2e-[a-zA-Z0-9_-]+$/.test(name || '');
const domainPath = id => '/context/domains/' + id + '/detail';
const assetPath = id => '/context/catalog/' + id + '/detail';
const q = JSON.stringify;

function click(page, label, { within = '', selector = 'button, ve-button, a, [role="button"], [role="tab"], [role="option"], li.arco-select-option', match = 'exact' } = {}) {
  return dispatchRealMouseClick(page, '(() => {' +
    'const root = ' + (within ? 'document.querySelector(' + q(within) + ')' : 'document') + ';' +
    'const value = ' + q(label) + '; return [...(root?.querySelectorAll(' + q(selector) + ') || [])].find(el => {' +
    'const candidates = [el.innerText, el.getAttribute("aria-label"), el.title].map(v => String(v || "").trim());' +
    'return el.getClientRects().length && !el.disabled && el.getAttribute("aria-disabled") !== "true" && ' +
    'candidates.some(t => ' + (match === 'prefix' ? 't.startsWith(value)' : 't === value') + '); }); })()', label);
}

async function wait(page, expression, label, timeoutMs = 15000) {
  const state = await waitForTerminalDom(page, expression, { timeoutMs });
  if (!state.ok) throw new Error(label + '未到可验证终态');
  return state.value;
}

function textIn(selector, terms) {
  return '(() => {const text = document.querySelector(' + q(selector) + ')?.innerText || ""; return ' +
    q(terms) + '.every(word => text.includes(word)) ? text : false; })()';
}

async function open(page, path, step) {
  const result = await page.gotoContext(path, { stepName: step });
  if (!result.settledOk) throw new Error(step + '路由或初始加载失败');
}

async function oracle(page, cfg, step, requiredActions = [], writes = []) {
  if (writes.length) {
    await wait(page, 'Boolean(document.body?.innerText)', '写操作请求收敛');
  }
  const result = await page.collectStepOracle(step);
  validateStepTerminalState(result, cfg, { stepLabel: step, requiredActions, forbidWrite: !writes.length });
  const unexpected = findWriteActions(result.records).find(record => !writes.includes(record.action));
  if (unexpected) throw new Error('发现非预期写入 ' + unexpected.action);
  for (const action of writes) {
    const matches = result.records.filter(record => record.action === action);
    if (matches.length !== 1 || !matches[0].requestId ||
        matches[0].httpStatus !== 200 || matches[0].errorCode) {
      throw new Error(action + '未观察到唯一成功写入和 RequestId');
    }
  }
  return result;
}

function historyRowsExpr() {
  return '(() => [...document.querySelectorAll(".arco-drawer tr")].filter(row => row.querySelector("td"))' +
    '.map(row => (row.getAttribute("data-row-key") || "") + " " + row.innerText.replace(/\\s+/g, " ").trim()))()';
}

async function showHistory(page) {
  await click(page, '更多');
  await click(page, '查看记录', { selector: '[role="menuitem"], .arco-dropdown-menu-item' });
  await wait(page, 'document.querySelector(".arco-drawer")?.innerText.includes("处理记录")', '来源处理记录');
}

async function waitNewScan(page, oldRows, kind) {
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    const rows = await page.evalJSON(historyRowsExpr());
    // New jobs are prepended; compare the complete observation, not an old matching success row.
    const current = rows[0];
    if (current?.includes(kind) && JSON.stringify(rows) !== JSON.stringify(oldRows)) {
      if (current.includes('成功')) return current;
      if (/失败|取消|超时/.test(current)) throw new Error(kind + '终态失败');
    }
    await page.sleep(1200);
    await click(page, '刷新', { within: '.arco-drawer' });
  }
  throw new Error(kind + '未读到新的成功任务');
}

async function openPg(page) {
  await open(page, '/context/catalog?source=' + pg.sourceId, '11-pg-source');
  await wait(page, textIn('main', [pg.name, pg.table]), '专用 PG 来源');
}

async function appendChooser(page) {
  await click(page, '添加表');
  await wait(page, textIn('.arco-modal', ['添加表', pg.name]), 'PG 目录发现');
}

async function readFrozenPg(page, cfg, fixture) {
  await open(page, domainPath(fixture.domainId), '11-pg-freeze');
  await wait(page, textIn('main', [fixture.domainName]), '专用 PG 发布领域');
  await dispatchRealMouseClick(page, `Array.from(document.querySelectorAll('ve-tabs')).flatMap(host =>
    [...(host.shadowRoot?.querySelectorAll('[role="tab"], [part~="tab"]') || [])])
    .find(tab => tab.textContent.trim() === 'MCP 服务')`, 'MCP 服务');
  await wait(page, textIn('main', [fixture.version]), 'PG 发布版本');
  const snapshot = await readVersionDrawerSnapshot(page, fixture.version, null);
  const rows = snapshot.rows.map(cells => JSON.stringify(cells));
  if (!rows.some(row => row.includes(fixture.tableEntryId))) throw new Error('发布快照未包含待验 PG 表');
  await oracle(page, cfg, '11-pg-freeze');
  return rows;
}

function pgRowExpr(action) {
  return '(() => {const row = [...document.querySelectorAll("main tr")].find(tr => [...tr.cells]' +
    '.some(td => td.querySelector("button")?.innerText.trim() === ' + q(pg.table) + '));' +
    'return ' + action + ';})()';
}

export async function run(t, page, cfg) {
  const fixturePath = process.env.CONTEXT_E2E_SEAL_FIXTURES;
  const fixtures = fixturePath ? JSON.parse(readFileSync(fixturePath, 'utf8')) : {};
  const testScope = cfg.workspaceId === KNOWN_FIXTURES.workspaceId &&
    cfg.projectName === KNOWN_FIXTURES.projectName;
  const writes = process.env.CONTEXT_E2E_ENABLE_WRITES === '1';
  const need = (title, ready) => {
    if (testScope && ready) return true;
    t.block(title, '缺少封板用例的专用合成夹具、允许写入开关或授权测试工作区');
    return false;
  };

  for (const [key, version, days] of [['r1', 1, 7], ['r2', 2, 15]]) {
    const title = 'USE-03/07 ' + key.toUpperCase() + ' 引文打开冻结详情并回到原会话';
    const data = fixtures.citations;
    const pin = data?.[key];
    if (!need(title, data && [data.entryId, data.domainId, pin?.sessionId, pin?.releaseId].every(v => ids.test(v || '')))) continue;
    await t.check(title, async () => {
      const chat = '/context/workbench?tab=chat&sessionId=' + pin.sessionId;
      const cardSelector = '.context-workbench-chatkit li[data-context-entry-id="' + data.entryId + '"]';
      const messageExpr = 'document.querySelector(' + q(cardSelector) + ')?.closest(' + q('[data-role="assistant"]') + ')';
      const answerState = '(() => { const message = ' + messageExpr + '; return ' +
        '[...(message?.querySelectorAll(".chatkit-assistant-message-content .chatkit-md") || [])]' +
        '.map(el => el.innerText.trim()).filter(Boolean).join("\\n") || false; })()';
      await open(page, chat, '11-citation-session-' + key);
      const answer = await wait(page, answerState, '同一消息中的真实回答');
      const source = await wait(page, 'document.querySelector(' + q(cardSelector) + ')?.innerText', '冻结引文卡片');
      // 1) 先用真实鼠标点击消息内联引文卡片，验证「资产预览」侧栏直接按本轮固定发布修订展示原文
      await dispatchRealMouseClick(
        page,
        '(() => { const card = document.querySelector(' + q(cardSelector) + '); return card?.querySelector("button, a, [role=\\"button\\"]") || card; })()',
        '历史回答内联引文卡片'
      );
      const inlinePreview = await wait(
        page,
        '(() => { const panel = document.querySelector(".arco-drawer, [aria-label=\\"资产预览\\"]"); ' +
          'if (!panel || panel.querySelector(".arco-spin-loading")) return false; ' +
          'const txt = (panel.innerText || "").trim(); return /(?:7|15)\\s*天/.test(txt) ? txt : false; })()',
        '内联引文侧栏预览原文'
      );
      const closePreviewBtn = await page.evalJSON(
        '(() => { const btn = document.querySelector(".arco-drawer .arco-drawer-close-icon, [aria-label=\\"资产预览\\"] button[aria-label*=\\"关闭\\"]"); ' +
          'if (!btn) return null; const r = btn.getBoundingClientRect(); return r.width > 0 ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null; })()'
      );
      if (closePreviewBtn) {
        await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...closePreviewBtn });
        await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...closePreviewBtn });
        await page.sleep(200);
      }
      // 2) 再从同一回答点击「查看图谱 → 目标节点 → 打开详情 → 返回资源列表」核对完整往返
      await dispatchRealMouseClick(page, '(() => [...((' + messageExpr + ')?.querySelectorAll("button") || [])]' +
        '.find(button => button.innerText.trim() === "查看图谱"))()', '同一回答的查看图谱');
      const graph = '[aria-label="检索图谱"]';
      const node = graph + ' button[data-context-entry-id="' + data.entryId + '"]';
      await wait(page, 'document.querySelector(' + q(node) + ')?.getClientRects().length', '冻结引文图谱节点');
      await dispatchRealMouseClick(page, 'document.querySelector(' + q(node) + ')', '目标引文图谱节点');
      page.setStep('11-citation-detail-' + key);
      await click(page, '打开详情', { within: graph });
      const detail = await wait(page,
        'document.querySelector(' + q('article[aria-label="发布版本资产详情"] section[aria-label="发布版本原文"]') + ')?.innerText.trim()',
        '可读的冻结原文');
      const before = await oracle(page, cfg, '11-citation-detail-' + key, ['GetContextEntry']);
      page.setStep('11-citation-return-' + key);
      await click(page, '返回资源列表', { within: 'article[aria-label="发布版本资产详情"]' });
      const returned = await wait(page, answerState, '原会话恢复');
      const back = await oracle(page, cfg, '11-citation-return-' + key);
      assertPinnedCitation({ answer, source, inlinePreview, href: before.href, detail,
        returned: { href: back.href, answer: returned } }, cfg, { ...data, ...pin, version, days });
      return '内联预览、图谱冻结原文与原会话一致，' + days + ' 天';
    });
  }

  const owner = fixtures.owner;
  const ownerTitle = 'NAV-03 知识页在所属领域编辑保留 workspaceId 和 project';
  if (need(ownerTitle, synthetic(owner?.domainName) &&
      [owner.entryId, owner.domainId, owner.knowledgeId].every(v => ids.test(v || '')))) {
    await t.check(ownerTitle, async () => {
      await open(page, assetPath(owner.entryId), '11-owner-entry');
      await wait(page, textIn('main', ['在所属领域编辑']), '知识页编辑入口');
      page.setStep('11-owner-domain');
      await click(page, '在所属领域编辑');
      const editor = await wait(page, '(() => {const panel = document.querySelector(".arco-drawer, .arco-modal");' +
        'return panel && panel.querySelector("input, textarea, [contenteditable]") && panel.innerText.includes("编辑");})()',
        '真实知识页编辑表单');
      if (!editor) throw new Error('知识页编辑器未打开');
      await wait(page, textIn('main', [owner.domainName]), '编辑器所属合成领域');
      const result = await oracle(page, cfg, '11-owner-domain');
      const href = assertScopedRoute(result.href, cfg, domainPath(owner.domainId), {
        tab: 'knowledge', editKnowledge: owner.knowledgeId,
      });
      assertScopedRoute(href.searchParams.get('knowledgeReturnTo'), cfg, assetPath(owner.entryId));
      return '所属领域编辑器、scope 及返回目标均正确';
    });
  }

  const review = fixtures.review;
  const reviewTitle = 'REL-02 新增建议冲突可合并编辑并持久采纳';
  if (need(reviewTitle, writes && synthetic(review?.domainName) && review.proposalTitle &&
      [review.domainId, review.taskId].every(v => ids.test(v || '')))) {
    await t.check(reviewTitle, async () => {
      const reportPath = '/context/domains/' + review.domainId + '/processing?taskId=' + review.taskId;
      const openProposal = async () => {
        await open(page, reportPath, '11-review-proposal');
        await wait(page, textIn('main', [review.domainName, review.proposalTitle]), '合成报告的目标新增建议');
        const row = '[class*="itemRow"]';
        await dispatchRealMouseClick(page, '(() => [...document.querySelectorAll(' + q(row) + ')].filter(el => ' +
          '[...el.querySelectorAll("strong, span, div")].some(label => label.textContent.trim() === ' +
          q(review.proposalTitle) + ')).at(0)?.querySelector("button, a"))()', '目标建议详情');
      };
      await openProposal();
      await wait(page, textIn('.arco-drawer', ['新增', '冲突', '基于当前草稿合并编辑']), 'CREATE 草稿冲突');
      const directDisabled = await page.evalJSON('(() => [...document.querySelectorAll(".arco-drawer button")]' +
        '.some(el => el.textContent.trim() === "采纳到领域草稿" && (el.disabled || el.getAttribute("aria-disabled") === "true")))()');
      if (!directDisabled) throw new Error('冲突时仍能直接覆盖草稿');
      await click(page, '基于当前草稿合并编辑', { within: '.arco-drawer' });
      const marker = 'SEAL-REL02-' + Date.now();
      const current = await wait(page, 'document.querySelector(\'textarea[aria-label="合并编辑正文"]\')?.value', '合并编辑正文');
      const focused = await page.evalJSON('(() => {const el = document.querySelector(\'textarea[aria-label="合并编辑正文"]\');' +
        'if (!el) return false; el.focus(); el.setSelectionRange(el.value.length, el.value.length); return document.activeElement === el;})()');
      if (!focused || !current.trim()) throw new Error('未读到当前草稿正文');
      await page.send('Input.insertText', { text: '\n' + marker });
      page.setStep('11-review-merge-submit');
      await click(page, '合并编辑后采纳', { within: '.arco-drawer' });
      await wait(page, textIn('body', ['已合并编辑并采纳到领域草稿']), '合并采纳确认');
      const submitted = await oracle(page, cfg, '11-review-merge-submit',
        ['ReviewContextChangeRequest'], ['ReviewContextChangeRequest']);
      await openProposal();
      const reopened = await wait(page, textIn('.arco-drawer', ['已采纳到领域草稿', '只读快照', marker]), '重新打开已采纳审核结果与正文');
      assertMergedReview({ directDisabled, currentDraft: current, reopened, marker,
        submitted: submitted.records.find(record => record.action === 'ReviewContextChangeRequest') });
      await oracle(page, cfg, '11-review-proposal');
      return '真实合并请求已成功，刷新重开仍为已采纳只读状态';
    });
  }

  const discoveryTitle = 'SRC-06/07 存量 PG 连接发现超过一页的真实表（CTX-003 转正）';
  if (need(discoveryTitle, true)) {
    await t.check(discoveryTitle, async () => {
      await openPg(page);
      page.setStep('11-pg-discovery');
      await appendChooser(page);
      await wait(page, '(() => {const modal = document.querySelector(".arco-modal");' +
        'const count = modal?.querySelectorAll("tbody tr").length || 0;' +
        'const total = Number(modal?.innerText.match(/共\\s*(\\d+)\\s*条/)?.[1]);' +
        'return Math.max(count, total || 0) > 100;})()', 'PG 多页发现');
      await oracle(page, cfg, '11-pg-discovery', ['ExploreContextSource']);
      await click(page, '取消', { within: dialog });
      return '可用 PG 表发现超过 100 张';
    });
  }

  const frozen = fixtures.postgres;
  const pgTitle = 'SRC-07 停止纳管、只读重刷、冻结快照和重新纳管';
  if (need(pgTitle, writes && synthetic(frozen?.domainName) && versionPattern.test(frozen.version || '') &&
      [frozen.domainId, frozen.tableEntryId].every(v => ids.test(v || '')))) {
    await t.check(pgTitle, async () => {
      const before = await readFrozenPg(page, cfg, frozen);
      await openPg(page);
      await showHistory(page);
      const oldRows = await page.evalJSON(historyRowsExpr());
      await click(page, '关闭', { within: '.arco-drawer' });
      await dispatchRealMouseClick(page, pgRowExpr('[...(row?.querySelectorAll("button") || [])]' +
        '.find(el => el.innerText.trim() === "停止纳管")'), pg.table + ' 停止纳管');
      await wait(page, textIn('.arco-modal', ['后续元数据刷新', '已发布版本', '恢复']), '已发布影响说明');
      try {
        page.setStep('11-pg-unmanage');
        await click(page, '确认停止纳管', { within: dialog });
        await wait(page, pgRowExpr('row?.innerText.includes("已停止纳管")'), '停止纳管回读');
        await oracle(page, cfg, '11-pg-unmanage', ['UpdateContextConnection', 'GetContextConnection'], ['UpdateContextConnection']);
        await openPg(page);
        await wait(page, pgRowExpr('row?.innerText.includes("已停止纳管")'), '重新打开仍未纳管');
        page.setStep('11-pg-refresh');
        await click(page, '同步元数据');
        await showHistory(page);
        const refreshed = await waitNewScan(page, oldRows, 'RefreshMetadata');
        assertScanRow(refreshed, 'RefreshMetadata', { discovered: 2, unchanged: 2 });
        await oracle(page, cfg, '11-pg-refresh', ['CreateContextTask'], ['CreateContextTask']);
      } finally {
        // Re-read persisted state before restoration. An unconfirmed mutation never justifies a second write.
        await openPg(page);
        if (await page.evalJSON(pgRowExpr('row?.innerText.includes("已停止纳管")'))) {
          const during = await readFrozenPg(page, cfg, frozen).catch(error => error);
          await openPg(page);
          await showHistory(page);
          const existing = await page.evalJSON(historyRowsExpr());
          await click(page, '关闭', { within: '.arco-drawer' });
          await appendChooser(page);
          const table = await wait(page, '(() => [...document.querySelectorAll(".arco-modal tr")]' +
            '.some(row => row.cells[1]?.textContent.trim() === "events" && row.cells[2]?.textContent.trim() === "public"' +
            ' && !row.querySelector("input")?.disabled))()', '同一表可恢复');
          if (!table) throw new Error('恢复目标不明确');
          await dispatchRealMouseClick(page, '(() => [...document.querySelectorAll(".arco-modal tr")]' +
            '.find(row => row.cells[1]?.textContent.trim() === "events" && row.cells[2]?.textContent.trim() === "public")' +
            '?.querySelector("label.arco-checkbox"))()', '只勾选 public.events');
          page.setStep('11-pg-restore');
          await click(page, '添加', { within: dialog });
          await wait(page, pgRowExpr('row && !row.innerText.includes("已停止纳管")'), '重新纳管范围回读');
          await showHistory(page);
          assertScanRow(await waitNewScan(page, existing, 'AddObjects'), 'AddObjects', { discovered: 1, unchanged: 1 });
          await oracle(page, cfg, '11-pg-restore', ['CreateContextTask'], ['CreateContextTask']);
          const after = await readFrozenPg(page, cfg, frozen);
          if (during instanceof Error) throw during;
          assertFrozenRowsUnchanged(before, during, after);
          await openPg(page);
          const count = await page.evalJSON('([...document.querySelectorAll("main tr")].filter(row =>' +
            '[...row.querySelectorAll("button")].some(el => el.innerText.trim() === "public.events"))).length');
          if (count !== 1 || await page.evalJSON(pgRowExpr('row?.innerText.includes("已停止纳管")'))) {
            throw new Error('重新打开后 public.events 缺失、重复或未恢复纳管');
          }
        } else {
          throw new Error('未回读到确切的停止纳管状态，未触发恢复');
        }
      }
      return '既有快照不变，刷新两表，重纳管发现一张旧表且零新增';
    });
  }

  const viewer = fixtures.viewer;
  const denyTitle = 'AUTH-02/USE-06 Viewer 标签 DENY 与工作台 403 正文隔离';
  if (need(denyTitle, synthetic(viewer?.domainName) && viewer.persona && viewer.protectedMarker?.length >= 12 &&
      [viewer.domainId, viewer.documentEntryId, viewer.derivedEntryId, viewer.sessionId].every(v => ids.test(v || '')))) {
    await t.check(denyTitle, async () => {
      await open(page, domainPath(viewer.domainId), '11-viewer-sim');
      await wait(page, textIn('main', [viewer.domainName, '权限管控']), '合成权限领域');
      await click(page, '权限管控');
      await click(page, '权限与 SQL 模拟');
      await dispatchRealMouseClick(page, 'document.querySelector(\'[aria-label="模拟扮演角色画像"]\')', '模拟身份');
      await click(page, viewer.persona);
      await click(page, '执行权限与 SQL 模拟');
      const simulation = await wait(page, textIn('main', ['DOCUMENT_FILTERED', '被拒条目与拦截原因']), 'Viewer 标签 DENY');
      await oracle(page, cfg, '11-viewer-sim', ['EvaluateContextDataAccess']);
      await open(page, '/context/workbench?tab=chat&sessionId=' + viewer.sessionId, '11-viewer-workbench');
      await wait(page, textIn('.context-workbench-chatkit', [viewer.documentEntryId]), '预置 Viewer 拒绝会话');
      await click(page, '多工具调用', { match: 'prefix', within: '.context-workbench-chatkit' });
      const tool = await wait(page, '(() => [...document.querySelectorAll(\'[class*="toolDetail"]\')]' +
        '.map(el => el.innerText).find(text => /403\\s*[:：·-]?\\s*DOCUMENT_ACCESS_FORBIDDEN/.test(text)))()', '真实工具 403');
      const result = await oracle(page, cfg, '11-viewer-workbench', ['GetContextWorkbenchSession']);
      assertScopedRoute(result.href, cfg, '/context/workbench', { tab: 'chat', sessionId: viewer.sessionId });
      const visible = await page.evalJSON(() => document.body.innerText);
      assertViewerDenial({ simulation, tool, visible, protectedMarker: viewer.protectedMarker }, viewer);
      return '标签 DENY 拒绝原文和派生条目；Viewer 工具 403，正文不可见';
    });
  }
}

