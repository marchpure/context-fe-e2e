#!/usr/bin/env node
// AgentKit Context 前端固化用例统一执行器。
// 用法：
//   ./run-e2e.sh                  # 跑全部 specs/*.spec.mjs（默认只读安全模式）
//   ./run-e2e.sh 06-mcp           # 按文件名关键词过滤只跑指定模块用例

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { IsolatedCdpPage, DEFAULT_CONFIG } from './lib/cdpSession.mjs';
import { KNOWN_ISSUES } from './lib/knownIssues.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const specsDir = path.join(__dirname, 'specs');
const reportsDir = path.join(__dirname, 'reports');
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

class TestContext {
  constructor(page, specFile) {
    this.page = page;
    this.specFile = specFile;
    this.results = [];
  }

  async check(title, fn) {
    const start = Date.now();
    try {
      const detail = await fn();
      this.results.push({
        spec: this.specFile,
        title,
        status: 'PASS',
        bugId: null,
        elapsedMs: Date.now() - start,
        detail: detail || 'OK',
        screenshot: null,
      });
      console.log(`  [PASS] ${title} (${Date.now() - start}ms)`);
    } catch (err) {
      const shot = await this.page.screenshot(`fail_${this.specFile}_${this.results.length + 1}`).catch(() => null);
      this.results.push({
        spec: this.specFile,
        title,
        status: 'REGRESSION_FAIL',
        bugId: null,
        elapsedMs: Date.now() - start,
        detail: err?.message || String(err),
        screenshot: shot,
      });
      console.log(`  [REGRESSION_FAIL] ${title}: ${err?.message || err}`);
    }
  }

  async checkKnownBug(bugId, title, fn) {
    const known = KNOWN_ISSUES[bugId];
    const start = Date.now();
    try {
      const detail = await fn();
      const status = known ? 'FIXED_CANDIDATE' : 'PASS';
      this.results.push({
        spec: this.specFile,
        title,
        status,
        bugId,
        elapsedMs: Date.now() - start,
        detail: detail || (known ? `原登记缺陷 ${bugId} 当前已实测通过，可移出 knownIssues.mjs！` : 'OK'),
        screenshot: null,
      });
      console.log(`  [${status}] ${title} (${bugId}) (${Date.now() - start}ms)`);
    } catch (err) {
      const shot = await this.page.screenshot(`known_${bugId}`).catch(() => null);
      const status = known ? 'KNOWN_BUG' : 'REGRESSION_FAIL';
      this.results.push({
        spec: this.specFile,
        title,
        status,
        bugId,
        elapsedMs: Date.now() - start,
        detail: err?.message || String(err),
        screenshot: shot,
      });
      console.log(`  [${status}] ${title} (${bugId}): ${err?.message || err}`);
    }
  }
}

async function main() {
  fs.mkdirSync(screenshotsDir, { recursive: true });
  const runStart = Date.now();
  const page = new IsolatedCdpPage(DEFAULT_CONFIG, screenshotsDir);
  const allResults = [];

  console.log(`=== AgentKit Context 前端固化验证套件启动 (${specFiles.length} 个模块文件) ===`);
  console.log(`目标工作区: ${DEFAULT_CONFIG.workspaceId} | 灰度头: ${DEFAULT_CONFIG.feGrayHeader} | 泳道: ${DEFAULT_CONFIG.laneEnv}`);

  try {
    await page.open();
    for (const file of specFiles) {
      console.log(`\n▶ 执行模块: ${file}`);
      const mod = await import(path.join(specsDir, file));
      const t = new TestContext(page, file);
      await mod.run(t, page, DEFAULT_CONFIG);
      allResults.push(...t.results);
    }
  } finally {
    await page.close();
  }

  const totalWallMs = Date.now() - runStart;
  const counts = {
    PASS: allResults.filter(r => r.status === 'PASS').length,
    FIXED_CANDIDATE: allResults.filter(r => r.status === 'FIXED_CANDIDATE').length,
    KNOWN_BUG: allResults.filter(r => r.status === 'KNOWN_BUG').length,
    REGRESSION_FAIL: allResults.filter(r => r.status === 'REGRESSION_FAIL').length,
  };

  const lines = [
    '# AgentKit Context 前端固化验证报告（自动生成）',
    '',
    `- **执行时间**：${new Date().toISOString()}`,
    `- **总墙钟耗时**：${(totalWallMs / 1000).toFixed(1)}s`,
    `- **测试工作区**：\`${DEFAULT_CONFIG.workspaceId}\`（前端灰度 \`${DEFAULT_CONFIG.feGrayHeader}\` / 后端泳道 \`${DEFAULT_CONFIG.laneEnv}\`）`,
    `- **统计汇总**：PASS **${counts.PASS}** | 新修复转正候选 (FIXED_CANDIDATE) **${counts.FIXED_CANDIDATE}** | 已知未修缺陷 (KNOWN_BUG) **${counts.KNOWN_BUG}** | 新增回归失败 (REGRESSION_FAIL) **${counts.REGRESSION_FAIL}**`,
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
    '| 步骤模块 | Action | HTTP | 耗时 (ms) | RequestId | 错误码 | WorkspaceId 携带 | 慢响应判定 |',
    '|---|---|---:|---:|---|---|---|---|',
    ...page.networkRecords.map(r => {
      const limit =
        r.action === 'ExploreContextSource'
          ? DEFAULT_CONFIG.slo.exploreSourceMaxMs
          : DEFAULT_CONFIG.slo.standardApiMaxMs;
      const slowFlag = typeof r.durationMs === 'number' && r.durationMs > limit ? `超红线 (>${limit}ms)` : '达标';
      return `| \`${r.step}\` | \`${r.action}\` | ${r.httpStatus ?? '—'} | ${r.durationMs ?? '—'} | \`${r.requestId || '—'}\` | ${r.errorCode || '—'} | ${r.workspaceId || '—'} | ${slowFlag} |`;
    }),
    '',
  ];

  const reportPath = path.join(reportsDir, 'latest-report.md');
  fs.writeFileSync(reportPath, lines.join('\n'));
  console.log(`\n=== 执行完毕 (${(totalWallMs / 1000).toFixed(1)}s) ===`);
  console.log(`PASS=${counts.PASS}, FIXED_CANDIDATE=${counts.FIXED_CANDIDATE}, KNOWN_BUG=${counts.KNOWN_BUG}, REGRESSION_FAIL=${counts.REGRESSION_FAIL}`);
  console.log(`完整报告（含全量 RequestId 与耗时表）已写入: ${reportPath}`);

  if (counts.REGRESSION_FAIL > 0) {
    process.exit(1);
  }
}

main().catch(err => {
  console.error('执行器致命异常:', err);
  process.exit(2);
});
