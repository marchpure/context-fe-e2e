#!/usr/bin/env node
// AgentKit Context 前端固化用例统一执行器。
// 用法：
//   ./run-e2e.sh                  # 跑全部 specs/*.spec.mjs（默认只读安全模式）
//   ./run-e2e.sh 06-mcp           # 按文件名关键词过滤只跑指定模块用例

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertFrontendBuild, IsolatedCdpPage, DEFAULT_CONFIG } from './lib/cdpSession.mjs';
import { gateExitCode, TestContext } from './lib/testContext.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(__dirname, 'specs');
const reportsDir = path.resolve(process.env.CONTEXT_E2E_REPORT_DIR || path.join(__dirname, 'reports'));
const screenshotsDir = path.join(reportsDir, 'screenshots');

const filterArg = (process.argv[2] || '').trim();
const specFiles = fs
  .readdirSync(specsDir)
  .filter(f => f.endsWith('.spec.mjs') && (!filterArg || f.includes(filterArg)))
  .sort();

if (specFiles.length === 0) {
  console.error(`未匹配到任何用例文件 (filter="${filterArg}")`);
  process.exit(2);
}

async function main() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const runStart = Date.now();
  const page = new IsolatedCdpPage(DEFAULT_CONFIG, screenshotsDir);
  const allResults = [];

  console.log(`=== AgentKit Context 前端固化验证套件启动 (${specFiles.length} 个模块文件) ===`);
  console.log(`目标工作区: ${DEFAULT_CONFIG.workspaceId} | 灰度头: ${DEFAULT_CONFIG.feGrayHeader} | 泳道: ${DEFAULT_CONFIG.laneEnv}`);

  try {
    try {
      await page.open();
    } catch (error) {
      const startup = new TestContext(page, 'bootstrap');
      startup.block('连接隔离浏览器', error?.cause?.code === 'ECONNREFUSED'
        ? 'CDP 入口拒绝连接，业务用例未执行'
        : error?.message || '隔离浏览器启动失败');
      allResults.push(...startup.results);
    }
    if (allResults.length === 0 && DEFAULT_CONFIG.expectedFrontendVersion) {
      const startup = new TestContext(page, 'bootstrap');
      const step = '00-frontend-build';
      try {
        await page.send('Network.setCacheDisabled', { cacheDisabled: true });
        const entry = await page.gotoContext('/context/catalog', { stepName: step });
        const oracle = await page.collectStepOracle(step);
        const build = assertFrontendBuild(oracle.frontendVersions, DEFAULT_CONFIG.expectedFrontendVersion);
        if (!entry.settledOk || !oracle.urlWorkspaceOk || !oracle.urlProjectOk ||
            oracle.forbiddenWorkspaceHit || oracle.scopeViolations.length) {
          throw new Error('目录入口未保持指定工作区和项目');
        }
        await page.send('Network.setCacheDisabled', { cacheDisabled: false });
        console.log(`入口静态资源版本: ${build}`);
      } catch (error) {
        startup.block('NAV-01 静态资源与测试入口', error.message);
        allResults.push(...startup.results);
      }
    }
    if (allResults.length === 0) {
      for (const file of specFiles) {
        console.log(`\n▶ 执行模块: ${file}`);
        const t = new TestContext(page, file);
        const blockedScopeCount = page.scopeViolations.length;
        try {
          const mod = await import(path.join(specsDir, file));
          await mod.run(t, page, DEFAULT_CONFIG);
          if (t.results.length === 0) t.block('执行模块', '模块没有产生任何结果');
        } catch (error) {
          t.block('模块执行中断', error?.message || String(error));
        }
        const scopeViolations = page.scopeViolations.slice(blockedScopeCount);
        if (scopeViolations.length) {
          t.record('请求保持在安全测试范围内', 'REGRESSION_FAIL',
            `拦截偏离测试范围的请求 ${scopeViolations.map(item => item.action).join('、')}`);
        }
        allResults.push(...t.results);
      }
      if (DEFAULT_CONFIG.expectedFrontendVersion) {
        const routing = new TestContext(page, 'bootstrap');
        const origin = new URL(DEFAULT_CONFIG.consoleBaseUrl).origin;
        const observed = page.evidenceRecords().filter(record => new URL(record.url).origin === origin);
        const mismatches = observed.filter(record => record.targetLaneSent === false);
        if (mismatches.length) {
          const actions = [...new Set(mismatches.map(record => record.action))];
          routing.record('NAV-01 实际发送的后端泳道', 'REGRESSION_FAIL',
            `${mismatches.length} 个请求未发送目标泳道头 ${DEFAULT_CONFIG.laneEnv}（${actions.join('、')}）`);
        } else if (observed.every(record => record.targetLaneSent === null)) {
          routing.block('NAV-01 实际发送的后端泳道', '未采集到 Context 请求的实际泳道头');
        }
        allResults.push(...routing.results);
      }
    }
    await page.flushResponseMetadata();
  } finally {
    await page.close();
  }

  const totalWallMs = Date.now() - runStart;
  const counts = {
    PASS: allResults.filter(r => r.status === 'PASS').length,
    FIXED_CANDIDATE: allResults.filter(r => r.status === 'FIXED_CANDIDATE').length,
    KNOWN_BUG: allResults.filter(r => r.status === 'KNOWN_BUG').length,
    REGRESSION_FAIL: allResults.filter(r => r.status === 'REGRESSION_FAIL').length,
    BLOCKED: allResults.filter(r => r.status === 'BLOCKED').length,
  };

  const lines = [
    '# AgentKit Context 前端固化验证报告（自动生成）',
    '',
    `- **执行时间**：${new Date().toISOString()}`,
    `- **总墙钟耗时**：${(totalWallMs / 1000).toFixed(1)}s`,
    `- **测试工作区**：\`${DEFAULT_CONFIG.workspaceId}\`（前端灰度 \`${DEFAULT_CONFIG.feGrayHeader}\` / 后端泳道 \`${DEFAULT_CONFIG.laneEnv}\`）`,
    `- **浏览器实际静态资源版本**：${[...page.frontendVersions].join('、') || '未取得'}`,
    `- **统计汇总**：PASS **${counts.PASS}** | 新修复转正候选 (FIXED_CANDIDATE) **${counts.FIXED_CANDIDATE}** | 已知未修缺陷 (KNOWN_BUG) **${counts.KNOWN_BUG}** | 新增回归失败 (REGRESSION_FAIL) **${counts.REGRESSION_FAIL}** | 未完成验证 (BLOCKED) **${counts.BLOCKED}**`,
    '',
    '---',
    '',
    '## 一、用例断言明细',
    '',
    '| 模块文件 | 状态 | 关联缺陷号 | 用例断言 | 耗时 (ms) | 实测证据 / 详情 |',
    '|---|---|---|---|---:|---|',
    ...allResults.map(
      r =>
        `| \`${r.spec}\` | **${r.status}** | ${r.bugId || '—'} | ${r.title} | ${r.elapsedMs} | ${String(r.detail).replace(/\|/g, '\\|').replace(/\n/g, ' ')}${r.screenshot ? ` ([截图](${r.screenshot}))` : ''} |`
    ),
    '',
    '---',
    '',
    '## 二、全量接口耗时与 RequestId 采集全景表',
    '',
    '| 步骤模块 | Action | HTTP | 耗时 (ms) | RequestId | 错误码 | WorkspaceId 携带 | 目标泳道头 | 慢响应判定 |',
    '|---|---|---:|---:|---|---|---|---|---|',
    ...page.evidenceRecords().map(r => {
      const slowFlag = r.pending
        ? '未完成'
        : r.errorCode || (r.httpStatus !== null && r.httpStatus >= 400)
          ? '请求失败'
          : typeof r.durationMs !== 'number'
            ? '未测量'
            : r.durationMs > r.sloLimitMs
              ? `超红线 (>${r.sloLimitMs}ms)`
              : '达标';
      const lane = r.targetLaneSent === null ? '未取得' : r.targetLaneSent ? '匹配' : '缺失或不符';
      return `| \`${r.step}\` | \`${r.action}\` | ${r.httpStatus ?? '—'} | ${r.durationMs ?? '—'} | \`${r.requestId || '—'}\` | ${r.errorCode || '—'} | ${r.workspaceId || '—'} | ${lane} | ${slowFlag} |`;
    }),
    '',
  ];

  const reportPath = path.join(reportsDir, 'latest-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n=== 执行完毕 (${(totalWallMs / 1000).toFixed(1)}s) ===`);
  console.log(`PASS=${counts.PASS}, FIXED_CANDIDATE=${counts.FIXED_CANDIDATE}, KNOWN_BUG=${counts.KNOWN_BUG}, REGRESSION_FAIL=${counts.REGRESSION_FAIL}, BLOCKED=${counts.BLOCKED}`);
  console.log(`完整报告（含全量 RequestId 与耗时表）已写入: ${reportPath}`);

  process.exitCode = gateExitCode(allResults);
}

main().catch(err => {
  console.error('执行器致命异常:', err);
  process.exit(2);
});
