// 统一从真实用户入口「添加资产 → 接入在线来源」验证全部受支持在线数据源的进入、第 2 步配置表单、上一步往返与取消，严禁偷跑 ?connect=1 绕过死胡同。
import {
  UNIFIED_ONLINE_SOURCES,
  assertOnlineSourceBackRoundTrip,
  assertOnlineSourceStep2Form,
  assertUnifiedOnlineSourceStep1,
} from '../lib/regression-checks.mjs';
import { findWriteActions, validateStepTerminalState } from '../lib/ui-checks.mjs';

const modal = '.arco-modal';

async function clickControl(page, parent, candidates, matcher, timeoutMs) {
  const isRegex = matcher instanceof RegExp;
  const target = await page.waitFor(`(() => {
    const container = ${parent ? `document.querySelector(${JSON.stringify(parent)})` : 'document'};
    const testLabel = text => ${isRegex ? `new RegExp(${JSON.stringify(matcher.source)}, ${JSON.stringify(matcher.flags)}).test(text)` : `text === ${JSON.stringify(matcher)}`};
    const matches = [...(container?.querySelectorAll(${JSON.stringify(candidates)}) || [])]
      .filter(node => node.getClientRects().length && !node.disabled &&
        (testLabel((node.getAttribute('aria-label') || '').trim()) ||
         testLabel((node.innerText || '').trim()) ||
         [...node.querySelectorAll('span')].some(child =>
           child.getClientRects().length && testLabel(child.innerText.trim()))));
    const control = matches[0];
    if (!control) return false;
    control.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = control.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return control.contains(document.elementFromPoint(x, y)) ? { x, y } : false;
  })()`, { timeoutMs });
  if (!target.ok) throw new Error(`控制项无法点击 ${String(matcher)}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...target.value });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...target.value });
}

async function readStep1Snapshot(page) {
  return page.evalJSON(`(() => {
    const dialog = document.querySelector(${JSON.stringify(modal)});
    if (!dialog || !dialog.getClientRects().length) return null;
    const radios = [...dialog.querySelectorAll('input[type="radio"], [role="radio"]')];
    const options = radios.map(input => {
      const card = input.closest('label') || input.parentElement;
      const heading = card?.querySelector('[id]')?.innerText || card?.innerText || '';
      const label = heading.split('\\n').map(s => s.trim()).filter(Boolean)[0] || '';
      const checked = input.matches('input[type="radio"]')
        ? input.checked
        : input.getAttribute('aria-checked') === 'true';
      return {
        label,
        checked,
        disabled: Boolean(input.disabled || input.getAttribute('aria-disabled') === 'true'),
        visible: Boolean((card || input).getClientRects().length),
      };
    });
    const nextBtn = [...dialog.querySelectorAll('button, ve-button')]
      .find(b => b.getClientRects().length && (b.innerText || '').trim() === '下一步');
    const selected = options.find(opt => opt.checked);
    return {
      href: window.location.href,
      text: dialog.innerText || '',
      options,
      selectedLabel: selected ? selected.label : '',
      nextDisabled: Boolean(!nextBtn || nextBtn.disabled || nextBtn.getAttribute('aria-disabled') === 'true'),
    };
  })()`);
}

async function readStep2Snapshot(page) {
  return page.evalJSON(`(() => {
    const dialog = document.querySelector(${JSON.stringify(modal)});
    if (!dialog || !dialog.getClientRects().length) return null;
    const controls = [
      ...[...dialog.querySelectorAll('input:not([type="radio"]):not([type="checkbox"]), textarea, [role="combobox"], .arco-select')]
        .filter(el => el.getClientRects().length)
        .map(el => ({
          kind: 'input',
          label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').trim(),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true' || el.classList.contains('arco-select-disabled')),
        })),
      ...[...dialog.querySelectorAll('button, ve-button')]
        .filter(el => el.getClientRects().length)
        .map(el => ({
          kind: 'button',
          label: (el.innerText || el.getAttribute('aria-label') || '').trim(),
          disabled: Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true'),
        })),
    ];
    const radioCount = [...dialog.querySelectorAll('fieldset input[type="radio"]')].filter(el => el.getClientRects().length).length;
    return {
      href: window.location.href,
      text: dialog.innerText || '',
      controls,
      step1Remounted: radioCount >= 4 && !controls.some(c => c.kind === 'button' && c.label === '上一步'),
    };
  })()`);
}

export async function run(t, page, cfg) {
  const ms = cfg.slo.pageFirstContentMaxMs;
  const entry = await page.gotoContext('/context/catalog', {
    stepName: '09-wizard-entry',
    readyFn: () => [...document.querySelectorAll('main button')]
      .some(button => button.getClientRects().length && button.innerText.trim() === '添加资产'),
  });
  if (!entry.settledOk) {
    t.block('数据源向导入口', '资产目录中的「添加资产」不可用，需确认工作区与接入权限');
    return;
  }

  const btn = (matcher, parent = modal) => clickControl(page, parent, 'button, ve-button', matcher, ms);
  const choose = matcher => clickControl(page, modal, 'label, [role="radio"]', matcher, ms);

  const closeModal = async stepLabel => {
    const hasCancel = await page.evalJSON(`(() => {
      const dialog = document.querySelector(${JSON.stringify(modal)});
      return [...(dialog?.querySelectorAll('button, ve-button') || [])]
        .some(b => b.getClientRects().length && !b.disabled && (b.innerText || '').trim() === '取消');
    })()`);
    if (hasCancel) {
      await btn('取消');
    } else {
      await clickControl(page, modal, '.arco-modal-close-icon, button[aria-label="Close"]', /.*/, ms);
    }
    if (!(await page.waitFor(`!document.querySelector(${JSON.stringify(modal)})`, { timeoutMs: ms })).ok) {
      throw new Error('关闭接入向导后弹窗仍在显示');
    }
    const oracle = await page.collectStepOracle();
    if (!oracle.urlWorkspaceOk || !oracle.urlProjectOk || oracle.forbiddenWorkspaceHit) {
      throw new Error('关闭接入向导后工作区或项目发生变化');
    }
    validateStepTerminalState(oracle, cfg, { stepLabel, forbidWrite: true });
    const [submitted] = findWriteActions([...oracle.records, ...oracle.pendingApis]);
    if (submitted) throw new Error(`只读浏览向导表单时触发了写接口 ${submitted.action}`);
  };

  const openIntake = async (choice, step) => {
    page.setStep(step);
    if (await page.evalJSON(`Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length)`)) {
      await closeModal(`${step}-cleanup`);
    }
    await btn('添加资产', 'main');
    await clickControl(page, null, '[role="menuitem"], .arco-dropdown-menu-item', choice, ms);
    const opened = await page.waitFor(
      `Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length && !document.querySelector('${modal} .arco-spin-loading'))`,
      { timeoutMs: ms }
    );
    if (!opened.ok) throw new Error(`点击「${choice}」后向导弹窗未就绪`);
  };

  await t.check('SRC-01 从添加资产进入本地文件和目标知识库表单，再取消', async () => {
    await openIntake('上传本地', '09-upload-local');
    const ready = await page.waitFor(`(() => {
      const dialog = document.querySelector(${JSON.stringify(modal)});
      const text = dialog?.innerText || '';
      return dialog?.getClientRects().length &&
        ['上传本地文件', '选择文件和存放方式', '上传到知识库'].every(label => text.includes(label));
    })()`, { timeoutMs: ms });
    if (!ready.ok) throw new Error('「上传本地文件」未加载完整表单');
    await closeModal('本地文件向导关闭');
    return '本地选择文件与存放方式已渲染';
  });

  await t.check('SRC-01/03/06/08/09/10 接入在线来源第 1 步完整展示 6 类可用数据源并屏蔽已下线入口', async () => {
    await openIntake('接入在线来源', '09-online-step1-sources');
    const snap = await readStep1Snapshot(page);
    if (!snap) throw new Error('未读取到接入在线来源第 1 步弹窗');
    const keys = assertUnifiedOnlineSourceStep1({ text: snap.text, options: snap.options });
    await closeModal('在线来源第 1 步核验关闭');
    return `统一在线接入第 1 步覆盖 ${keys.length} 类可用数据源且无下线死入口`;
  });

  await t.check('SRC-03 从接入在线来源选择飞书直接进入授权与链接配置表单（无死胡同占位、无二次回跳重选）', async () => {
    await openIntake('接入在线来源', '09-online-feishu-direct');
    await choose(UNIFIED_ONLINE_SOURCES.feishu.labelPattern);
    const beforeNext = await readStep1Snapshot(page);
    assertUnifiedOnlineSourceStep1(beforeNext);

    await btn('下一步');
    const settled = await page.waitFor(
      `Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length && !document.querySelector('${modal} .arco-spin-loading'))`,
      { timeoutMs: ms }
    );
    if (!settled.ok) throw new Error('飞书第 2 步表单加载超时');
    const step2 = await readStep2Snapshot(page);
    assertOnlineSourceStep2Form('feishu', step2, cfg);

    await btn('上一步');
    const backSnap = await readStep1Snapshot(page);
    assertOnlineSourceBackRoundTrip('feishu', backSnap, cfg);
    await closeModal('飞书在线接入往返关闭');
    return '飞书直达第 2 步授权与链接配置表单，上一步保留飞书选中且无 ?connect=1 二次跳转';
  });

  for (const sourceKey of ['database', 'knowledge', 'viking_kb', 'tos', 'coderepo']) {
    const spec = UNIFIED_ONLINE_SOURCES[sourceKey];
    await t.check(`SRC-06/08/09/10 从接入在线来源选择「${spec.label}」进入配置表单并往返返回`, async () => {
      await openIntake('接入在线来源', `09-online-${sourceKey}`);
      await choose(spec.labelPattern);
      const beforeNext = await readStep1Snapshot(page);
      assertUnifiedOnlineSourceStep1(beforeNext);

      await btn('下一步');
      const settled = await page.waitFor(
        `Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length && !document.querySelector('${modal} .arco-spin-loading'))`,
        { timeoutMs: ms }
      );
      if (!settled.ok) throw new Error(`「${spec.label}」第 2 步表单加载超时`);
      const step2 = await readStep2Snapshot(page);
      assertOnlineSourceStep2Form(sourceKey, step2, cfg);

      if (sourceKey === 'database') {
        await btn('手动输入表名');
        const manualReady = await page.waitFor(
          `Boolean((document.querySelector(${JSON.stringify(modal)})?.innerText || '').includes('手动指定白名单数据表'))`,
          { timeoutMs: ms }
        );
        if (!manualReady.ok) throw new Error('数据库向导切换手动输入表名未生效');
      }

      await btn('上一步');
      const backSnap = await readStep1Snapshot(page);
      assertOnlineSourceBackRoundTrip(sourceKey, backSnap, cfg);
      await closeModal(`${spec.label}向导关闭`);
      return `「${spec.label}」表单可操作，上一步保留选中且取消零副作用`;
    });
  }

  await t.check('兼容深链 ?connect=1 与统一在线向导收敛一致且不暴露已下线业务应用入口', async () => {
    page.setStep('09-legacy-connect-compat');
    const compat = await page.gotoContext('/context/catalog?connect=1', { stepName: '09-legacy-connect-compat' });
    if (!compat.settledOk) throw new Error('兼容连接入口未保留工作区和项目');
    const opened = await page.waitFor(
      `Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length)`,
      { timeoutMs: ms }
    );
    if (!opened.ok) throw new Error('兼容深链 ?connect=1 未打开接入向导');
    const snap = await readStep1Snapshot(page);
    assertUnifiedOnlineSourceStep1({ text: snap.text, options: snap.options });
    await closeModal('兼容深链向导关闭');
    return '兼容深链与统一向导一致，无业务应用死入口残留';
  });
}
