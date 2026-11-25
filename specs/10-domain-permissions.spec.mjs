import { cdpClickPoint, KNOWN_FIXTURES, validateStepTerminalState } from '../lib/ui-checks.mjs';

async function openTab(page, label) {
  const target = await page.waitFor(`(() => {
    const tab = [...document.querySelectorAll('[role="tab"]')].find(node =>
      node.textContent?.trim() === ${JSON.stringify(label)} &&
      node.getAttribute('aria-disabled') !== 'true' && node.getClientRects().length
    );
    if (!tab) return false;
    tab.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    const { x, y, width, height } = tab.getBoundingClientRect();
    return { x: x + width / 2, y: y + height / 2 };
  })()`, { timeoutMs: 5000 });
  if (!target.ok) throw new Error(`找不到可点击的「${label}」页签`);
  await cdpClickPoint(page, target.value.x, target.value.y);
  const selected = await page.waitFor(`[...document.querySelectorAll('[role="tab"][aria-selected="true"]')]
    .some(node => node.textContent?.trim() === ${JSON.stringify(label)} && node.getClientRects().length)`,
  { timeoutMs: 5000 });
  if (!selected.ok) throw new Error(`点击后未选中「${label}」`);
}

export async function run(t, page, cfg) {
  const title = 'AUTH-01 权限管控的三项配置与模拟表单在同一业务领域可用';
  if (cfg.workspaceId !== KNOWN_FIXTURES.workspaceId) {
    t.block(title, '当前工作区缺少已确认的合成权限管控对照领域');
    return;
  }
  const { domainId, domainName } = KNOWN_FIXTURES.r4Domain;
  const step = '10-domain-permissions';

  await t.check(title, async () => {
    const destination = `/context/domains/${encodeURIComponent(domainId)}/detail`;
    const result = await page.gotoContext(destination, {
      stepName: step,
      readyFn: () => [...document.querySelectorAll('[role="tab"]')].some(
        node => node.textContent?.trim() === '权限管控'
      ) && Boolean(document.body?.innerText.includes('codex-e2e-r4-domain-1125')),
    });
    if (!result.settledOk) throw new Error(`对照领域「${domainName}」的权限入口未就绪`);

    await openTab(page, '权限管控');
    const forms = [
      ['角色画像（Persona）', '保存角色画像', '角色说明'],
      ['数据权限策略', '保存权限策略', '策略名称'],
      ['权限与 SQL 模拟', '执行权限与 SQL 模拟', '测试只读 SQL'],
    ];
    for (const [tab, button, field] of forms) {
      await openTab(page, tab);
      const selector = `[aria-label=${JSON.stringify(field)}]`;
      const ready = await page.waitFor(`(() => {
        const input = [...document.querySelectorAll(${JSON.stringify(selector)})]
          .find(el => el.getClientRects().length && !el.disabled);
        const button = [...document.querySelectorAll('button')].find(el =>
          el.textContent.trim() === ${JSON.stringify(button)} && el.getClientRects().length && !el.disabled
        );
        return Boolean(input && button);
      })()`, { timeoutMs: 8000 });
      if (!ready.ok) throw new Error(`「${tab}」选中后表单控件不可用`);
    }

    const oracle = await page.collectStepOracle(step);
    if (!new URL(oracle.href).pathname.endsWith(destination)) {
      throw new Error('切换权限配置时离开了对照领域');
    }
    validateStepTerminalState(oracle, cfg, {
      stepLabel: '领域权限管控',
      requiredActions: ['ListContextAuthPersonas', 'ListContextDataAuthPolicies'],
    });
    return '角色与策略读取成功，三个页签的表单可用。未提交保存或模拟。';
  });
}
