// 用真实用户入口走各来源表单，直到返回／取消。
import { findWriteActions, validateStepTerminalState } from '../lib/ui-checks.mjs';

const modal = '.arco-modal';

async function clickControl(page, parent, candidates, label, timeoutMs) {
  const target = await page.waitFor(`(() => {
    const container = ${parent ? `document.querySelector(${JSON.stringify(parent)})` : 'document'};
    const matches = [...(container?.querySelectorAll(${JSON.stringify(candidates)}) || [])]
      .filter(node => node.getClientRects().length && !node.disabled &&
        ((node.getAttribute('aria-label') || '').trim() === ${JSON.stringify(label)} ||
         (node.innerText || '').trim() === ${JSON.stringify(label)} ||
         [...node.querySelectorAll('span')].some(child =>
           child.getClientRects().length && child.innerText.trim() === ${JSON.stringify(label)})));
    const control = matches[0];
    if (!control) return false;
    control.scrollIntoView({ block: 'center', inline: 'center' });
    const rect = control.getBoundingClientRect();
    const x = rect.x + rect.width / 2;
    const y = rect.y + rect.height / 2;
    return control.contains(document.elementFromPoint(x, y)) ? { x, y } : false;
  })()`, { timeoutMs });
  if (!target.ok) throw new Error(`控制项无法点击 ${label}`);
  await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...target.value });
  await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...target.value });
}

async function waitForm(page, expected, timeoutMs) {
  const result = await page.waitFor(`(() => {
    const dialog = document.querySelector(${JSON.stringify(modal)});
    return Boolean(dialog?.getClientRects().length &&
      (dialog.innerText || '').includes('连接数据') &&
      ${JSON.stringify(expected)}.every(text => dialog.innerText.includes(text)));
  })()`, { timeoutMs });
  if (!result.ok) throw new Error(`连接向导缺少表单内容 ${expected.join('、')}`);
}

export async function run(t, page, cfg) {
  const ms = cfg.slo.pageFirstContentMaxMs;
  const chooser = await page.gotoContext('/context/catalog', {
    stepName: '09-wizard-entry',
    readyFn: () => [...document.querySelectorAll('main button')]
      .some(button => button.getClientRects().length && button.innerText.trim() === '添加资产'),
  });
  if (!chooser.settledOk) {
    t.block('数据源向导入口', '资产目录中的「添加资产」不可用，需确认工作区与接入权限');
    return;
  }
  const btn = (text, parent = modal) => clickControl(page, parent, 'button, ve-button', text, ms);
  const choose = text => clickControl(page, modal, 'label, [role="radio"]', text, ms);
  const start = async (category, step) => {
    page.setStep(step);
    if (await page.evalJSON(`Boolean(document.querySelector(${JSON.stringify(modal)})?.getClientRects().length)`)) {
      await close();
    }
    const entry = await page.gotoContext('/context/catalog?connect=1', { stepName: step });
    if (!entry.settledOk) throw new Error('受控连接兼容入口未保留工作区和项目');
    await waitForm(page, ['知识库', '数据库', '业务应用', '代码仓'], ms);
    await choose(category);
    await btn('下一步');
  };
  const close = async () => {
    await btn('取消');
    if (!(await page.waitFor(`!document.querySelector(${JSON.stringify(modal)})`, { timeoutMs: ms })).ok) {
      throw new Error('点击取消后向导仍在显示');
    }
    const oracle = await page.collectStepOracle();
    if (!oracle.urlWorkspaceOk || !oracle.urlProjectOk || oracle.forbiddenWorkspaceHit) {
      throw new Error('取消或返回后工作区与项目发生变化');
    }
    validateStepTerminalState(oracle, cfg, { stepLabel: '接入向导关闭', forbidWrite: true });
    const [submitted] = findWriteActions([...oracle.records, ...oracle.pendingApis]);
    if (submitted) throw new Error(`只浏览表单时触发了 ${submitted.action}`);
  };

  const openIntake = async (choice, step) => {
    page.setStep(step);
    await btn('添加资产', 'main');
    await clickControl(page, null, '[role="menuitem"], .arco-dropdown-menu-item', choice, ms);
  };

  const verifyIntake = async (title, fields) => {
    const ready = await page.waitFor(`(() => {
      const dialog = document.querySelector(${JSON.stringify(modal)});
      const text = dialog?.innerText || '';
      return dialog?.getClientRects().length && !dialog.querySelector('.arco-spin-loading') &&
        ${JSON.stringify([title, ...fields])}.every(label => text.includes(label));
    })()`, { timeoutMs: ms });
    if (!ready.ok) throw new Error(`「${title}」未加载完整表单 ${fields.join('、')}`);
  };

  await t.check('SRC-01 从添加资产进入本地文件和目标知识库表单，再取消', async () => {
    await openIntake('上传本地', '09-upload-local');
    await verifyIntake('上传本地文件', ['选择文件和存放方式', '上传到知识库']);
    await close();
    return '本地选择文件与存放方式已渲染';
  });

  await t.check('SRC-03/09 在线来源进入外部 OpenViking 配置，再取消', async () => {
    await openIntake('接入在线来源', '09-connect-online');
    await verifyIntake('接入在线来源', ['数据库', '引用已有知识库', '外部 OpenViking', '飞书文档']);
    await choose('外部 OpenViking');
    await btn('下一步');
    await verifyIntake('连接外部 OpenViking', ['服务地址']);
    await close();
    return '在线来源与外部服务配置已渲染';
  });

  await t.check('SRC-01/03/08/09 从知识库向导切换本地、飞书、TOS 和 OpenViking', async () => {
    await start('知识库', '09-knowledge-source-options');
    await waitForm(page, ['内置知识库', '用户托管知识库 (OpenViking)'], ms);
    await choose('内置知识库');
    for (const [option, field] of [
      ['上传本地文档', '空间标识（可选）'],
      ['飞书文档/Wiki空间', '飞书链接直达定位'],
      ['火山 TOS', 'TOS Bucket 名称'],
      ['用户托管知识库 (OpenViking)', '集合名称'],
    ]) {
      await choose(option);
      await waitForm(page, [field], ms);
    }
    await btn('上一步');
    await waitForm(page, ['数据库', '业务应用'], ms);
    await close();
    return '四种来源分别出现自己的字段，返回和取消成功';
  });

  await t.check('SRC-06 数据库向导可以切换手填表名并返回', async () => {
    await start('数据库', '09-database-manual-tables');
    await waitForm(page, ['PostgreSQL', '测试连接并发现表'], ms);
    await btn('手动输入表名');
    await waitForm(page, ['已切换为手动指定白名单数据表'], ms);
    await btn('上一步');
    await close();
    return '手填表名区域可见，未提交连接';
  });

  for (const [category, field] of [
    ['代码仓', 'Git 仓库地址'],
    ['业务应用', '选择业务应用或分析数据集类型'],
  ]) {
    await t.check(`SRC-10 从${category}进入对应表单并取消`, async () => {
      await start(category, `09-source-${category}`);
      await waitForm(page, [field], ms);
      await close();
      return `${category}表单和取消行为可用`;
    });
  }
}
