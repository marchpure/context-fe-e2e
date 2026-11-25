import assert from 'node:assert/strict';
import test from 'node:test';
import {
  UNIFIED_ONLINE_SOURCES,
  assertOnlineSourceBackRoundTrip,
  assertOnlineSourceStep2Form,
  assertUnifiedOnlineSourceStep1,
} from '../lib/regression-checks.mjs';
import { KNOWN_FIXTURES } from '../lib/ui-checks.mjs';
import { assertProperty } from './support/propHarness.mjs';

const CFG = {
  consoleBaseUrl: 'https://console.volcengine.com',
  workspaceId: KNOWN_FIXTURES.workspaceId,
  forbiddenWorkspaceId: KNOWN_FIXTURES.forbiddenWorkspaceId,
  projectName: 'default',
};

const CANONICAL_STEP1_CARDS = [
  { key: 'database', label: '数据库', desc: '使用只读连接接入 MySQL、PostgreSQL 或 StarRocks 的数据表' },
  { key: 'knowledge', label: '引用已有知识库', desc: '从 AgentKit 可用的知识库中选择' },
  { key: 'viking_kb', label: '外部 OpenViking', desc: '使用服务地址和凭据连接外部知识库' },
  { key: 'feishu', label: '飞书文档 / Wiki', desc: '经 Identity OAuth 授权接入飞书文档或 Wiki 空间' },
  { key: 'tos', label: '火山 TOS', desc: '经受控角色增量接入 TOS Bucket 对象' },
  { key: 'coderepo', label: '代码仓', desc: '接入 Git 仓库并生成只读代码索引与 RepoMap' },
];

const VALID_STEP2_FIXTURES = {
  database: {
    text: '接入在线来源\n配置来源\n数据库类型 PostgreSQL MySQL StarRocks\n手动输入表名\n上一步 下一步',
    controls: [
      { kind: 'input', label: '连接名称', disabled: false },
      { kind: 'button', label: '测试连接并发现表', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
    ],
  },
  knowledge: {
    text: '引用已有知识库\n选择知识库\n上一步 下一步',
    controls: [
      { kind: 'input', label: '搜索知识库', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
    ],
  },
  viking_kb: {
    text: '连接外部 OpenViking\n服务地址\n集合名称 (CollectionName)\n上一步 下一步',
    controls: [
      { kind: 'input', label: '服务地址', disabled: false },
      { kind: 'button', label: '验证连接', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
    ],
  },
  feishu: {
    text: '接入飞书文档\n飞书身份授权（Identity OAuth 2.0 联邦）\n飞书 Wiki 链接或节点标识\n支持粘贴飞书链接自动解析 SpaceId / RootNodeToken\n上一步 下一步',
    controls: [
      { kind: 'input', label: '连接名称', disabled: false },
      { kind: 'input', label: '粘贴飞书文档或 Wiki 链接', disabled: false },
      { kind: 'button', label: '检测并加载目录树', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
      { kind: 'button', label: '下一步', disabled: false },
    ],
  },
  tos: {
    text: '接入火山 TOS\n火山 TOS Bucket 存储桶名称\n前缀 Prefix\n上一步 下一步',
    controls: [
      { kind: 'input', label: '连接名称', disabled: false },
      { kind: 'input', label: 'TOS Bucket', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
    ],
  },
  coderepo: {
    text: '接入代码仓\nGit 仓库地址 (RepoUrl)\n受控路径排除规则\n上一步 下一步',
    controls: [
      { kind: 'input', label: '资产单元名称', disabled: false },
      { kind: 'input', label: 'Git 仓库地址', disabled: false },
      { kind: 'button', label: '上一步', disabled: false },
    ],
  },
};

test('性质：统一在线接入第 1 步必须完整覆盖 6 类可用来源，且严禁暴露已下线的业务应用/Meego/风神', () => {
  assertProperty(
    {
      name: '统一接入向导第 1 步完整性与死入口屏蔽',
      seed: 0x20261126,
      runs: 200,
      file: 'test/source-wizard-flow.property.test.mjs',
      generate(rng) {
        const ordered = rng.shuffle(CANONICAL_STEP1_CARDS);
        const picked = rng.pick(ordered);
        const mode = rng.pick(['valid', 'missing_one', 'dead_meego', 'disabled_next']);
        const droppedKey = rng.pick(CANONICAL_STEP1_CARDS).key;
        const deadLabel = rng.pick(['业务应用', '飞书项目 (Meego)', '风神 Aeolus']);
        return { ordered, pickedKey: picked.key, mode, droppedKey, deadLabel };
      },
    },
    ({ ordered, pickedKey, mode, droppedKey, deadLabel }) => {
      let cards = ordered.map(item => ({
        label: item.label,
        checked: item.key === pickedKey,
        disabled: false,
        visible: true,
      }));
      let extraText = '';
      let nextDisabled = false;

      if (mode === 'missing_one') {
        cards = cards.filter(
          item => !UNIFIED_ONLINE_SOURCES[droppedKey].labelPattern.test(item.label)
        );
      } else if (mode === 'dead_meego') {
        cards.push({ label: deadLabel, checked: false, disabled: false, visible: true });
        extraText = deadLabel;
      } else if (mode === 'disabled_next') {
        nextDisabled = true;
      }

      const selected = cards.find(item => item.checked)?.label || '数据库';
      const snap = {
        text: `接入在线来源\n${cards.map(c => c.label).join('\n')}\n${extraText}`,
        options: cards,
        selectedLabel: selected,
        nextDisabled,
      };

      if (mode === 'valid') {
        const keys = assertUnifiedOnlineSourceStep1(snap);
        assert.equal(keys.length, 6);
      } else if (mode === 'missing_one') {
        assert.throws(() => assertUnifiedOnlineSourceStep1(snap), /缺少可用数据源入口/);
      } else if (mode === 'dead_meego') {
        assert.throws(() => assertUnifiedOnlineSourceStep1(snap), /仍暴露 Meego \/ 风神入口卡片/);
      } else {
        assert.throws(() => assertUnifiedOnlineSourceStep1(snap), /「下一步」按钮仍处于禁用态/);
      }
    }
  );
});

test('性质：从第 1 步点下一步必须直达对应可操作表单，严禁飞书死胡同占位页或 ?connect=1 二次跳回重选', () => {
  assertProperty(
    {
      name: '接入向导第 1 步 → 第 2 步单调前进与防回跳死锁',
      seed: 0x51fe15be,
      runs: 240,
      file: 'test/source-wizard-flow.property.test.mjs',
      generate(rng) {
        const sourceKey = rng.pick(Object.keys(UNIFIED_ONLINE_SOURCES));
        const fault = rng.pick([
          'none',
          'feishu_dead_end_placeholder',
          'feishu_disabled_auth_button',
          'legacy_connect_1_redirect',
          'remount_step1_chooser',
          'forbidden_workspace',
        ]);
        return { sourceKey, fault };
      },
    },
    ({ sourceKey, fault }) => {
      const baseHref = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/catalog?workspaceId=${CFG.workspaceId}&project=${CFG.projectName}&connect=online`;
      const baseView = VALID_STEP2_FIXTURES[sourceKey];
      let snap = {
        href: baseHref,
        text: baseView.text,
        controls: baseView.controls.map(c => ({ ...c })),
        step1Remounted: false,
      };

      if (fault === 'feishu_dead_end_placeholder') {
        snap = {
          href: baseHref,
          text: '接入飞书文档\n单篇飞书文档\n暂无法通过链接校验单篇飞书文档。\n接入飞书 Wiki 空间\n检查授权',
          controls: [
            { kind: 'input', label: '文档链接', disabled: false },
            { kind: 'input', label: '文档名称', disabled: false },
            { kind: 'button', label: '检查授权', disabled: true },
            { kind: 'button', label: '下一步', disabled: true },
          ],
          step1Remounted: false,
        };
        assert.throws(() => assertOnlineSourceStep2Form('feishu', snap, CFG), /死胡同占位/);
        return;
      }

      if (fault === 'feishu_disabled_auth_button') {
        snap = {
          href: baseHref,
          text: VALID_STEP2_FIXTURES.feishu.text,
          controls: VALID_STEP2_FIXTURES.feishu.controls.map(ctrl =>
            /检测并加载目录树|检查授权/.test(ctrl.label) ? { ...ctrl, disabled: true } : ctrl
          ),
          step1Remounted: false,
        };
        assert.throws(() => assertOnlineSourceStep2Form('feishu', snap, CFG), /禁用死锁态/);
        return;
      }

      if (fault === 'legacy_connect_1_redirect') {
        snap.href = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/catalog?workspaceId=${CFG.workspaceId}&project=${CFG.projectName}&connect=1`;
        assert.throws(() => assertOnlineSourceStep2Form(sourceKey, snap, CFG), /\?connect=1 旧弹窗重定向/);
        return;
      }

      if (fault === 'remount_step1_chooser') {
        snap.text = '连接数据\n选择受控资产单元类别\n知识库\n代码仓\n数据库\n业务应用';
        snap.step1Remounted = true;
        assert.throws(() => assertOnlineSourceStep2Form(sourceKey, snap, CFG), /回退或重挂载到了数据源选择第 1 步/);
        return;
      }

      if (fault === 'forbidden_workspace') {
        snap.href = `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/catalog?workspaceId=${CFG.forbiddenWorkspaceId}&project=${CFG.projectName}&connect=online`;
        assert.throws(() => assertOnlineSourceStep2Form(sourceKey, snap, CFG), /workspaceId/);
        return;
      }

      const url = assertOnlineSourceStep2Form(sourceKey, snap, CFG);
      assert.equal(url.searchParams.get('workspaceId'), CFG.workspaceId);
      assert.equal(url.searchParams.get('project'), CFG.projectName);
    }
  );
});

test('性质：从第 2 步点击「上一步」往返第 1 步必须保留原选中数据源与作用域，严禁重置回默认数据库', () => {
  assertProperty(
    {
      name: '接入向导第 2 步 → 上一步往返一致性',
      seed: 0x09ba6ca1,
      runs: 200,
      file: 'test/source-wizard-flow.property.test.mjs',
      generate(rng) {
        const sourceKey = rng.pick(['knowledge', 'viking_kb', 'feishu', 'tos', 'coderepo']);
        const resetToDatabase = rng.bool(0.5);
        return { sourceKey, resetToDatabase };
      },
    },
    ({ sourceKey, resetToDatabase }) => {
      const effectiveKey = resetToDatabase ? 'database' : sourceKey;
      const options = CANONICAL_STEP1_CARDS.map(item => ({
        label: item.label,
        checked: item.key === effectiveKey,
        disabled: false,
        visible: true,
      }));
      const selectedLabel = options.find(item => item.checked)?.label || '';
      const backSnap = {
        href: `https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/catalog?workspaceId=${CFG.workspaceId}&project=${CFG.projectName}&connect=online`,
        text: `接入在线来源\n${options.map(o => o.label).join('\n')}`,
        options,
        selectedLabel,
        nextDisabled: false,
      };

      if (resetToDatabase) {
        assert.throws(
          () => assertOnlineSourceBackRoundTrip(sourceKey, backSnap, CFG),
          /选中项丢失或被重置为「数据库」/
        );
      } else {
        const preserved = assertOnlineSourceBackRoundTrip(sourceKey, backSnap, CFG);
        assert.match(preserved, UNIFIED_ONLINE_SOURCES[sourceKey].labelPattern);
      }
    }
  );
});

test('02 与 09 向导规格模块语法干净且导出异步 run(t, page, cfg)', async () => {
  for (const rel of ['../specs/02-catalog-explorer.spec.mjs', '../specs/09-source-wizard.spec.mjs']) {
    const mod = await import(rel);
    assert.equal(typeof mod.run, 'function', `${rel} 必须导出 run()`);
  }
});

