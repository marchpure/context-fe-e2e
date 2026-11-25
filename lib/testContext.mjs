import { KNOWN_ISSUES } from './knownIssues.mjs';

// A fixture or infrastructure problem must never be hidden as a known product bug.
const knownSymptoms = {
  'CTX-001': /localeCompare TypeError|TypeError[^\n]*localeCompare|localeCompare is not a function/i,
  'CTX-006': /仍停留在旧连接路由|来源不存在或无权查看|未成功重定向至资产详情.*\/context\/connections\//,
  'CTX-012': /仍.*(?:网关|认证|服务名).*(?:可编辑|编辑项)|冗余.*(?:网关|认证)编辑项/,
  'CTX-013': /工作台首屏渲染耗时超标|工作台.*调试台.*超时/,
  'CTX-016': /(?:ExploreContextSource|TOS.*(?:目录|探测)).*(?:超时|超红线|耗时超标)/i,
  'CTX-020': /仍暴露.*(?:Meego|风神|Aeolus)/i,
  'CTX-021': /(?:24h|24 小时|24小时|调用统计).*(?:UNAVAILABLE|暂时无法获取)/i,
};

export function gateExitCode(results) {
  if (results.some(row => row.status === 'REGRESSION_FAIL')) return 1;
  if (results.length === 0 || results.some(row => row.status === 'BLOCKED')) return 2;
  return 0;
}

export class TestContext {
  constructor(page, specFile) {
    this.page = page;
    this.specFile = specFile;
    this.results = [];
  }

  record(title, status, detail, { bugId = null, elapsedMs = 0, screenshot = null } = {}) {
    detail = String(detail)
      .replace(/\bBearer\s+[^\s,;]+/gi, 'Bearer [已隐藏]')
      .replace(/\b(authorization|cookie|set-cookie|token|api[_-]?key|password|secret)\b(["']?\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s&,;]+)/gi, '$1$2[已隐藏]');
    this.results.push({ spec: this.specFile, title, status, bugId, elapsedMs, detail, screenshot });
    console.log(`  [${status}] ${title}${bugId ? ` (${bugId})` : ''} — ${detail}`);
  }

  block(title, reason) {
    this.record(title, 'BLOCKED', reason);
  }

  check(title, fn) {
    return this.evaluate(title, fn, null);
  }

  checkKnownBug(bugId, title, fn, options) {
    return this.evaluate(title, fn, bugId, options);
  }

  async evaluate(title, fn, bugId, { matches } = {}) {
    const start = Date.now();
    const known = bugId && KNOWN_ISSUES[bugId];
    const resultCount = this.results.length;
    try {
      const detail = await fn();
      if (this.results.length !== resultCount) return;
      this.record(title, known ? 'FIXED_CANDIDATE' : 'PASS', detail || '断言通过', {
        bugId,
        elapsedMs: Date.now() - start,
      });
    } catch (error) {
      const detail = error?.message || String(error);
      const matchesSymptom = matches ? matches(error) : knownSymptoms[bugId]?.test(detail);
      const status = known && matchesSymptom ? 'KNOWN_BUG' : 'REGRESSION_FAIL';
      const screenshot = await this.page
        .screenshot(`fail_${this.specFile}_${resultCount + 1}`)
        .catch(() => null);
      this.record(title, status, detail, { bugId, elapsedMs: Date.now() - start, screenshot });
    }
  }
}
