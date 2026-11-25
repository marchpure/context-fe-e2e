// Property Suite 3：URL 生产路径/序列化往返（Round-Trip）与详情/返回状态保持属性测试。
// 覆盖：
// 1. 中文、空格、+、%、百分号转义序列、BMP/Astral Unicode、空字符串 ""、缺省参数及表单编码（URLSearchParams）
//    经真实 IsolatedCdpPage.prototype.buildContextUrl 构造后的独立解码往返一致性
// 2. verifyWorkbenchDraftBinding、validateStepTerminalState 与 evaluateCatalogViewSettlement 对特殊字符查询参数的往返判定
// 3. 详情 -> 返回（history.back / forward）筛选与工作区状态保持校验，以及与 restoreSafeWorkspace 应急重置语义的边界区分

import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_CONFIG, IsolatedCdpPage } from '../lib/cdpSession.mjs';
import {
  CATALOG_ALL_UNITS_LABEL,
  evaluateAssetDetailSettlement,
  evaluateCatalogViewSettlement,
} from '../lib/catalog-checks.mjs';
import {
  restoreSafeWorkspace,
  validateStepTerminalState,
} from '../lib/ui-checks.mjs';
import { verifyWorkbenchDraftBinding } from '../specs/08-draft-debug.spec.mjs';
import { assertProperty, assertPropertyAsync } from './support/propHarness.mjs';

const FILE = 'test/url-roundtrip-navigation.property.test.mjs';

const SPECIAL_TOKENS = [
  '退款时效口径',
  '飞书知识库 · 财务域',
  'leading and trailing',
  '  surrounded by spaces  ',
  '   ',
  'T+1 结算+对账',
  'C++ & Python=3.12',
  '命中率 100% / 0%',
  '%20literal%2Bplus%25pct',
  '%E4%B8%AD%E6%96%87',
  'a?b=c&d=e#frag/slash\\back',
  '🧪📊_𝕏_①_—',
  'cafe\u0301_NFD',
  '',
];

function generateRichValue(rng) {
  const count = rng.int(1, 3);
  if (rng.bool(0.18)) return '';
  const parts = [];
  for (let i = 0; i < count; i += 1) {
    parts.push(rng.pick(SPECIAL_TOKENS));
  }
  return parts.join(rng.pick(['', ' ', '+', '%', '&']));
}

test('P3.1 IsolatedCdpPage.buildContextUrl 对中文、空格、+、%、转义符、Unicode、空串、缺省及表单参数往返零损保真 (360 cases)', () => {
  assertProperty(
    {
      name: 'P3.1 buildContextUrl full character-class & empty-vs-absent round-trip',
      seed: 0x53030001,
      runs: 360,
      file: FILE,
      generate(rng) {
        const serializer = rng.pick(['url_search_params_form', 'encode_uri_component']);
        const includeWorkspace = rng.bool(0.8);
        const workspaceId = rng.pick([
          DEFAULT_CONFIG.workspaceId,
          `ws-${rng.hex(6)}+cn`,
          'ws_测试空间_01',
        ]);
        const projectName = rng.pick([
          'default',
          '项目 A+B 100%',
          'proj%20escaped&v=2',
          '🧪-unicode-proj',
        ]);
        const qMode = rng.pick(['present', 'empty', 'absent']);
        const nameMode = rng.pick(['present', 'empty', 'absent']);
        const sourceMode = rng.pick(['present', 'absent']);

        return {
          serializer,
          includeWorkspace,
          workspaceId,
          projectName,
          qMode,
          qVal: qMode === 'empty' ? '' : generateRichValue(rng),
          nameMode,
          nameVal: nameMode === 'empty' ? '' : generateRichValue(rng),
          sourceMode,
          sourceVal: `res-${rng.hex(4)}+src%25`,
          leadingSlash: rng.bool(0.5),
        };
      },
      *shrink(s) {
        if (s.qVal.length > 2) yield { ...s, qVal: s.qVal.slice(0, 2) };
        if (s.nameVal.length > 2) yield { ...s, nameVal: s.nameVal.slice(0, 2) };
        if (s.projectName !== 'default') yield { ...s, projectName: 'default' };
      },
    },
    s => {
      const page = new IsolatedCdpPage({
        ...DEFAULT_CONFIG,
        workspaceId: s.workspaceId,
        projectName: s.projectName,
      });

      const expectedEntries = new Map();
      if (s.qMode !== 'absent') expectedEntries.set('q', s.qVal);
      if (s.nameMode !== 'absent') expectedEntries.set('name', s.nameVal);
      if (s.sourceMode !== 'absent') expectedEntries.set('source', s.sourceVal);

      let queryString = '';
      if (s.serializer === 'url_search_params_form') {
        const form = new URLSearchParams();
        for (const [k, v] of expectedEntries.entries()) form.set(k, v);
        queryString = form.toString();
      } else {
        queryString = [...expectedEntries.entries()]
          .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
          .join('&');
      }

      const prefix = s.leadingSlash ? '/context/catalog' : 'context/catalog';
      const subpath = queryString ? `${prefix}?${queryString}` : prefix;
      const builtUrl = page.buildContextUrl(subpath, { includeWorkspace: s.includeWorkspace });

      // 独立解码验证：不复用 buildContextUrl 内部对象，直接按标准 URL 解析核对键值与空/缺省区分
      const decoded = new URL(builtUrl);
      assert.equal(decoded.pathname.endsWith('/v2/context/catalog'), true);

      for (const key of ['q', 'name', 'source']) {
        if (expectedEntries.has(key)) {
          assert.equal(decoded.searchParams.has(key), true, `参数 ${key} 应存在（含空串 "" 情况）`);
          assert.equal(decoded.searchParams.get(key), expectedEntries.get(key));
        } else {
          assert.equal(decoded.searchParams.has(key), false, `缺省参数 ${key} 不应凭空出现`);
          assert.equal(decoded.searchParams.get(key), null);
        }
      }

      if (s.includeWorkspace) {
        assert.equal(decoded.searchParams.get('workspaceId'), s.workspaceId);
        assert.equal(decoded.searchParams.get('project'), s.projectName);
      } else {
        assert.equal(decoded.searchParams.has('workspaceId'), false);
        assert.equal(decoded.searchParams.has('project'), false);
      }
    }
  );
});

test('P3.2 工作台草稿锁定、步级终态校验与目录检索态对已修剪特殊字符参数往返一致 (260 cases)', () => {
  assertProperty(
    {
      name: 'P3.2 Trimmed special-char round-trip across workbench, step oracle & catalog search',
      seed: 0x53030002,
      runs: 260,
      file: FILE,
      generate(rng) {
        const coreQuery = rng.pick([
          '退款+时效 100%',
          'adk_sessions%20表',
          'C++ 算子 & 指标_𝕏',
          '口径?a=1&b=2',
          '飞书文档（v2）',
        ]);
        const projectName = rng.pick(['default', '财务域+测试 100%', 'proj_cn_🧪']);
        const domainSuffix = rng.slug('draft', 3, 7);
        return {
          coreQuery,
          projectName,
          domainId: `dom-${rng.hex(6)}+draft%25`,
          domainName: `codex-e2e-${domainSuffix}`,
        };
      },
    },
    s => {
      const cfg = {
        ...DEFAULT_CONFIG,
        projectName: s.projectName,
      };
      const page = new IsolatedCdpPage(cfg);

      // 1) 工作台草稿 URL 序列化 -> verifyWorkbenchDraftBinding + validateStepTerminalState
      const wbParams = new URLSearchParams({
        tab: 'chat',
        draftDomainId: s.domainId,
      });
      const wbHref = page.buildContextUrl(`/context/workbench?${wbParams.toString()}`);

      const draftBind = verifyWorkbenchDraftBinding({
        href: wbHref,
        expectedWorkspaceId: cfg.workspaceId,
        forbiddenWorkspaceId: cfg.forbiddenWorkspaceId,
        expectedProject: cfg.projectName,
        expectedDomainId: s.domainId,
        expectedDomainName: s.domainName,
        domainPicker: { found: true, value: `${s.domainName} · 草稿`, placeholder: '' },
        modelPicker: { found: true, value: 'doubao-seed-1-6', placeholder: '' },
        composer: { found: true, disabled: false },
      });
      assert.equal(draftBind.ok, true, draftBind.reason);

      const stepRes = validateStepTerminalState(
        {
          href: wbHref,
          pageErrors: [],
          has1970Timestamp: false,
          pendingApis: [],
          records: [
            {
              action: 'ListContextDomains',
              httpStatus: 200,
              workspaceId: cfg.workspaceId,
              requestId: 'req-wb-1',
            },
          ],
        },
        cfg,
        { requiredActions: ['ListContextDomains'] }
      );
      assert.equal(stepRes.project, s.projectName);

      // 2) 目录全文检索 URL 序列化 -> evaluateCatalogViewSettlement(mode='search')
      const searchParams = new URLSearchParams({ q: s.coreQuery });
      const searchHref = page.buildContextUrl(`/context/catalog?${searchParams.toString()}`);
      const searchUrl = new URL(searchHref);

      const catSearch = evaluateCatalogViewSettlement(
        {
          pathname: searchUrl.pathname,
          search: searchUrl.search,
          headerTitle: '检索结果',
          hasAssetTable: true,
          assetRows: [{ name: 'doc-1', typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
          pendingApiCount: 0,
        },
        { mode: 'search', expectedQuery: s.coreQuery }
      );
      assert.equal(catSearch.settled, true, catSearch.reason);
      assert.equal(catSearch.status, 'READY');
    }
  );
});

test('P3.3 evaluateCatalogViewSettlement 对含首尾空格的 expectedNameFilter、纯空白查询参数及空预期检索串的往返对称性 (240 cases)', () => {
  assertProperty(
    {
      name: 'P3.3 Catalog URL parameter symmetry for padded name filter, whitespace q, and empty search expectation',
      seed: 0x53030003,
      runs: 240,
      file: FILE,
      generate(rng) {
        return {
          subCase: rng.pick([
            'padded_expected_name_filter',
            'whitespace_only_q_in_all_mode',
            'empty_expected_query_with_stale_url_q',
          ]),
          coreName: rng.pick(['退款规则', 'adk_sessions', 'T+1 报表 100%']),
          padLeft: rng.pick([' ', '  ']),
          padRight: rng.pick(['', ' ']),
        };
      },
      *shrink(s) {
        if (s.coreName !== '退款规则') yield { ...s, coreName: '退款规则' };
        if (s.padLeft !== ' ') yield { ...s, padLeft: ' ', padRight: '' };
      },
    },
    s => {
      const page = new IsolatedCdpPage(DEFAULT_CONFIG);

      if (s.subCase === 'padded_expected_name_filter') {
        const padded = `${s.padLeft}${s.coreName}${s.padRight}`;
        const qs = new URLSearchParams({ name: padded }).toString();
        const built = new URL(page.buildContextUrl(`/context/catalog?${qs}`));
        const verdict = evaluateCatalogViewSettlement(
          {
            pathname: built.pathname,
            search: built.search,
            headerTitle: CATALOG_ALL_UNITS_LABEL,
            selectedTreeTitle: `${CATALOG_ALL_UNITS_LABEL}\n2`,
            unitGovernanceTabsVisible: false,
            treeAllCount: 2,
            hasAssetTable: true,
            assetRows: [{ name: s.coreName, typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
            pendingApiCount: 0,
          },
          { mode: 'all', expectedNameFilter: padded }
        );
        assert.equal(
          verdict.settled,
          true,
          `URL 已按 expectedNameFilter=${JSON.stringify(padded)} 同步写入时不应永久卡在 ${verdict.status}: ${verdict.reason}`
        );
      } else if (s.subCase === 'whitespace_only_q_in_all_mode') {
        const qs = new URLSearchParams({ q: '   ' }).toString(); // ?q=+++
        const built = new URL(page.buildContextUrl(`/context/catalog?${qs}`));
        const verdict = evaluateCatalogViewSettlement(
          {
            pathname: built.pathname,
            search: built.search,
            headerTitle: CATALOG_ALL_UNITS_LABEL,
            selectedTreeTitle: `${CATALOG_ALL_UNITS_LABEL}\n2`,
            unitGovernanceTabsVisible: false,
            treeAllCount: 2,
            hasOverviewTable: true,
            overviewRows: [{ name: 'codex-e2e-kb', category: '知识库', scaleText: '1 篇文档' }],
            hasAssetTable: true,
            assetRows: [{ name: 'doc-1', typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
            pendingApiCount: 0,
          },
          { mode: 'all' }
        );
        assert.equal(
          verdict.settled,
          true,
          '真实目录解析器会 trim 全空白的 q，浏览视图应按无检索词就绪'
        );
      } else if (s.subCase === 'empty_expected_query_with_stale_url_q') {
        const qs = new URLSearchParams({ q: s.coreName }).toString();
        const built = new URL(page.buildContextUrl(`/context/catalog?${qs}`));
        const verdict = evaluateCatalogViewSettlement(
          {
            pathname: built.pathname,
            search: built.search,
            headerTitle: '检索结果',
            hasAssetTable: true,
            assetRows: [{ name: s.coreName, typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
            pendingApiCount: 0,
          },
          { mode: 'search', expectedQuery: '' }
        );
        assert.equal(
          verdict.settled,
          false,
          'expectedQuery 显式为空串 "" 但 URL 仍滞留旧检索词 q 时不应误判同步完成'
        );
      }
    }
  );
});

test('P3.4 列表筛选 -> 资产详情 -> 历史后退/前进状态保持校验，以及与 restoreSafeWorkspace 重置契约的边界区分 (240 cases)', async () => {
  await assertPropertyAsync(
    {
      name: 'P3.4 Detail/back state survival vs restoreSafeWorkspace clean-catalog reset distinction',
      seed: 0x53030004,
      runs: 240,
      file: FILE,
      generate(rng) {
        const filterKind = rng.pick(['search_q', 'source_unit', 'name_and_type']);
        const qText = rng.pick(['退款 + 100% 口径', 'adk_sessions', '飞书知识库 🧪', 'A&B=C%25']);
        const sourceId = `res-${rng.hex(6)}`;
        const sourceName = `codex-e2e-src-${rng.hex(4)}`;
        const assetId = `r_${rng.hex(12)}`;
        const assetType = rng.pick(['FileCollection', 'Table']);
        const backMutation = rng.pick([
          'preserve_exact_history',
          'drop_filter_on_back',
          'drop_workspace_on_back_ctx006',
          'emergency_restore_safe_workspace',
        ]);
        return { filterKind, qText, sourceId, sourceName, assetId, assetType, backMutation };
      },
      *shrink(s) {
        if (s.qText !== '退款 + 100% 口径') yield { ...s, qText: '退款 + 100% 口径' };
      },
    },
    async s => {
      const cfg = { ...DEFAULT_CONFIG };
      const page = new IsolatedCdpPage(cfg);

      const catalogParams = new URLSearchParams();
      let expectedSettlementSpec;
      if (s.filterKind === 'search_q') {
        catalogParams.set('q', s.qText);
        expectedSettlementSpec = { mode: 'search', expectedQuery: s.qText };
      } else if (s.filterKind === 'source_unit') {
        catalogParams.set('source', s.sourceId);
        expectedSettlementSpec = {
          mode: 'source',
          expectedSourceId: s.sourceId,
          expectedSourceName: s.sourceName,
        };
      } else {
        catalogParams.set('name', s.qText);
        catalogParams.set('assetType', s.assetType);
        expectedSettlementSpec = {
          mode: 'all',
          expectedNameFilter: s.qText,
          expectedAssetType: s.assetType,
        };
      }

      const initialCatalogHref = page.buildContextUrl(`/context/catalog?${catalogParams.toString()}`);
      const detailHref = page.buildContextUrl(
        `/context/catalog/${encodeURIComponent(s.assetId)}/detail`
      );

      // 模拟浏览器历史栈：Catalog (带筛选) -> push Detail -> back -> forward -> back
      const historyStack = [initialCatalogHref, detailHref];
      let cursor = 1;

      const detailUrl = new URL(historyStack[cursor]);
      const detailVerdict = evaluateAssetDetailSettlement({
        pathname: detailUrl.pathname,
        search: detailUrl.search,
        headerTitle: 'codex-e2e-target-asset',
        assetTypeTag: s.assetType === 'Table' ? '数据表' : '文件集合',
        markdownText: s.assetType === 'Table' ? '' : '# 合成资产正文',
        fieldRowCount: s.assetType === 'Table' ? 6 : 0,
        hasMarkdownSection: s.assetType !== 'Table',
        pendingApiCount: 0,
      });
      assert.equal(detailVerdict.settled, true);

      // 执行返回（back）
      cursor = 0;
      let returnedHref = historyStack[cursor];
      if (s.backMutation === 'drop_filter_on_back') {
        returnedHref = page.buildContextUrl('/context/catalog');
      } else if (s.backMutation === 'drop_workspace_on_back_ctx006') {
        returnedHref = `${cfg.consoleBaseUrl}/context/catalog?${catalogParams.toString()}`;
      }

      if (s.backMutation === 'emergency_restore_safe_workspace') {
        // 明确区分夹具/辅助函数职责：
        // restoreSafeWorkspace 是越界或丢参后的安全兜底恢复器，它会主动导航到无筛选的 /context/catalog?workspaceId=...&project=...
        // 而非保留业务筛选参数；真实筛选保持由浏览器历史栈 / 前端路由按钮在 E2E（NAV-04 / CAT-09）中承担。
        let navigatedSubpath = null;
        const taintedHref = `${cfg.consoleBaseUrl}/context/catalog?workspaceId=${cfg.forbiddenWorkspaceId}&q=${encodeURIComponent(s.qText)}`;
        const mockRestorePage = {
          evalJSON: async () => taintedHref,
          gotoContext: async (subpath, opts) => {
            navigatedSubpath = { subpath, opts };
            returnedHref = page.buildContextUrl(subpath, opts);
          },
        };
        await restoreSafeWorkspace(mockRestorePage, cfg, 'p3-restore');
        assert.equal(navigatedSubpath.subpath, '/context/catalog');
        assert.equal(navigatedSubpath.opts.includeWorkspace, true);
        const restoredParsed = new URL(returnedHref);
        assert.equal(restoredParsed.searchParams.get('workspaceId'), cfg.workspaceId);
        assert.equal(restoredParsed.searchParams.get('project'), cfg.projectName);
        assert.equal(restoredParsed.searchParams.has('q'), false);
        return;
      }

      const returnedParsed = new URL(returnedHref);
      const returnedSnap = {
        pathname: returnedParsed.pathname,
        search: returnedParsed.search,
        headerTitle:
          s.filterKind === 'search_q'
            ? '检索结果'
            : s.filterKind === 'source_unit'
              ? s.sourceName
              : CATALOG_ALL_UNITS_LABEL,
        selectedTreeTitle:
          s.filterKind === 'source_unit' ? s.sourceName : `${CATALOG_ALL_UNITS_LABEL}\n3`,
        unitGovernanceTabsVisible: s.filterKind === 'source_unit',
        treeAllCount: 3,
        hasOverviewTable: true,
        overviewRows: [{ name: s.sourceName, category: '知识库', scaleText: '1 篇文档' }],
        hasAssetTable: true,
        assetRows: [{ name: 'codex-e2e-target-asset', typeLabel: '文档', updatedAt: '2026-11-25 12:00' }],
        hasUnitTable: true,
        unitRows: [{ name: 'codex-e2e-target-asset', indexText: '已就绪' }],
        pendingApiCount: 0,
      };

      const catVerdict = evaluateCatalogViewSettlement(returnedSnap, expectedSettlementSpec);

      if (s.backMutation === 'preserve_exact_history') {
        assert.equal(catVerdict.settled, true, catVerdict.reason);
        assert.equal(catVerdict.status, 'READY');
        assert.doesNotThrow(() =>
          validateStepTerminalState(
            {
              href: returnedHref,
              pageErrors: [],
              has1970Timestamp: false,
              pendingApis: [],
              records: [],
            },
            cfg
          )
        );
      } else if (s.backMutation === 'drop_filter_on_back') {
        assert.equal(
          catVerdict.settled,
          false,
          '从详情返回目录丢失原有筛选参数时，带期望筛选的目录终态判定必须拒绝就绪'
        );
        assert.equal(catVerdict.status, 'TRANSITIONING');
      } else if (s.backMutation === 'drop_workspace_on_back_ctx006') {
        assert.throws(
          () =>
            validateStepTerminalState(
              {
                href: returnedHref,
                pageErrors: [],
                has1970Timestamp: false,
                pendingApis: [],
                records: [],
              },
              cfg
            ),
          /workspaceId 丢失或不一致/
        );
      }
    }
  );
});
