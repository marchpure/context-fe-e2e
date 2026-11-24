// 单标签页隔离型 CDP 会话驱动与全局 Context Oracle 探针（Node v22+ 原生 WebSocket，零外部依赖）。
// 核心特性：
// 1. 每次运行在 127.0.0.1:9223 新开一个独立测试 Tab，结束后自动关闭该 Tab，绝不触碰或挂死在其他后台标签页。
// 2. 自动注入前端灰度头 x-forward-fe 与后端泳道头 x-lane-env。
// 3. 自动采集所有 /context/control/* 与 /context/data/* 请求的 Action、HTTP 状态、耗时 ms、RequestId 与业务错误码（零敏感正文落盘）。
// 4. 内置五大全局不变量守卫（Console 未捕获崩溃、workspaceId 防丢/防串、1970 脏时间戳、重复请求风暴、接口慢响应红线）。

import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_CONFIG = {
  cdpHttpBase: process.env.CDP_HTTP_BASE || 'http://127.0.0.1:9223',
  consoleBaseUrl:
    process.env.CONTEXT_CONSOLE_BASE ||
    'https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2',
  workspaceId: process.env.CONTEXT_WORKSPACE_ID || '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
  forbiddenWorkspaceId: 'ws-7710414566965542920',
  projectName: process.env.CONTEXT_PROJECT_NAME || 'default',
  feGrayHeader: process.env.FE_GRAY_HEADER || 'deploy_context_stg_7399178560',
  laneEnv: process.env.LANE_ENV || '7399178560',
  baselineLocalKbConnId: 'res-01a20d5afab17c8fa64fbbcedf492414',
  baselineDocEntryId: 'r_65f5835dbd19a08236467e6acd7bf32eac5801ec52f6f584b87d22847fab5e39',
  baselineDomainId: 'dom-61a07705c778406af7257e19137f011d',
  baselineTosConnId: 'res-01a20cd199e87f1b89c6411fc443942b',
  slo: {
    standardApiMaxMs: 1500,
    writeApiMaxMs: 2000,
    exploreSourceMaxMs: 4000,
    pollApiMaxMs: 800,
    pageFirstContentMaxMs: 5000,
  },
};

const POLL_ACTIONS = new Set([
  'GetContextScanJob',
  'GetContextEnrichmentRun',
  'GetConnectionIndexSummary',
]);

function extractActionName(urlStr, postData, resourceType) {
  if (resourceType === 'Document') return null;
  try {
    const u = new URL(urlStr);
    const isAgentkitTop = /\/api\/top\/agentkit/i.test(u.pathname) || /agentkit/i.test(u.search);
    const qAction = u.searchParams.get('Action');
    if (qAction && (isAgentkitTop || /Context|Domain|Knowledge|Workbench|MCP/i.test(qAction))) {
      return qAction;
    }
    if (isAgentkitTop) {
      const segs = u.pathname.split('/').filter(Boolean);
      const last = segs[segs.length - 1];
      if (last && !/^202\d-/.test(last) && !/^agentkit/i.test(last)) return last;
    }
    const m = u.pathname.match(/\/context\/(?:control|data\/v1)\/([^/?#]+)/);
    if (m) return m[1];
    if (postData && postData.trim().startsWith('{')) {
      const parsed = JSON.parse(postData);
      if (typeof parsed.Action === 'string' && (isAgentkitTop || /Context|Domain|Knowledge|Workbench|MCP/i.test(parsed.Action))) {
        return parsed.Action;
      }
    }
  } catch {
    // ignore malformed URL/JSON
  }
  return null;
}

function extractSafePayloadMeta(urlStr, postData) {
  const meta = { workspaceId: null, projectName: null, signatureKey: '' };
  try {
    const u = new URL(urlStr);
    meta.workspaceId = u.searchParams.get('WorkspaceId') || u.searchParams.get('workspace_id');
    meta.projectName = u.searchParams.get('ProjectName') || u.searchParams.get('project_name');
    if (postData && postData.trim().startsWith('{')) {
      const obj = JSON.parse(postData);
      meta.workspaceId = obj.WorkspaceId || obj.workspace_id || meta.workspaceId;
      meta.projectName = obj.ProjectName || obj.project_name || meta.projectName;
      // 构造去敏去重签名（严禁纳入 AuthSecret/Token 等敏感字段）
      const safeClone = {};
      for (const [k, v] of Object.entries(obj)) {
        if (/secret|token|password|key|credential|auth/i.test(k)) continue;
        safeClone[k] = v;
      }
      meta.signatureKey = JSON.stringify(safeClone);
    } else {
      meta.signatureKey = u.search;
    }
  } catch {
    meta.signatureKey = '';
  }
  return meta;
}

export class IsolatedCdpPage {
  constructor(config = DEFAULT_CONFIG, screenshotDir = '') {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.screenshotDir = screenshotDir;
    this.targetId = null;
    this.ws = null;
    this.seq = 0;
    this.pending = new Map();
    this.currentStep = 'init';
    this.networkRecords = [];
    this.inflight = new Map();
    this.pageErrors = [];
    this.consoleErrors = [];
  }

  async open() {
    let target;
    const putResp = await fetch(`${this.config.cdpHttpBase}/json/new?about:blank`, { method: 'PUT' });
    if (putResp.ok) {
      target = await putResp.json();
    } else {
      const getResp = await fetch(`${this.config.cdpHttpBase}/json/new?about:blank`);
      if (!getResp.ok) {
        throw new Error(`无法连接 ${this.config.cdpHttpBase}/json/new (HTTP ${getResp.status})，请确认 9223 浏览器在运行`);
      }
      target = await getResp.json();
    }
    this.targetId = target.id;
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      this.ws = ws;
      const timer = setTimeout(() => reject(new Error('CDP WebSocket 连接超时')), 8000);
      ws.addEventListener('open', () => {
        clearTimeout(timer);
        resolve();
      });
      ws.addEventListener('error', err => {
        clearTimeout(timer);
        reject(new Error(`CDP WebSocket 错误: ${err?.message || 'unknown'}`));
      });
      ws.addEventListener('message', ev => this._onMessage(String(ev.data)));
    });

    await this.send('Page.enable');
    await this.send('Runtime.enable');
    await this.send('Network.enable', { maxPostDataSize: 65536 });
    await this.send('Emulation.setDeviceMetricsOverride', {
      width: 1440,
      height: 900,
      deviceScaleFactor: 2,
      mobile: false,
    });
    await this.send('Network.setExtraHTTPHeaders', {
      headers: {
        'x-forward-fe': this.config.feGrayHeader,
        'x-lane-env': this.config.laneEnv,
      },
    });
  }

  _onMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    if (msg.id) {
      const entry = this.pending.get(msg.id);
      if (entry) {
        this.pending.delete(msg.id);
        clearTimeout(entry.timer);
        if (msg.error) entry.reject(new Error(`${entry.method}: ${msg.error.message}`));
        else entry.resolve(msg.result);
      }
      return;
    }
    const { method, params } = msg;
    if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails;
      const text =
        details?.exception?.description || details?.text || 'Uncaught Runtime Exception';
      // 忽略第三方跨域导航条/监控埋点因自定义泳道头触发的非业务 CORS Network Error
      if (/Network Error|res\.gcloudcache\.com\/volc-fe\/navbar|slardar|tea-sdk/i.test(String(text))) {
        return;
      }
      this.pageErrors.push({ step: this.currentStep, text: String(text).slice(0, 400), ts: Date.now() });
    } else if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
      const text = (params.args || [])
        .map(a => a.description || a.value || '')
        .join(' ')
        .slice(0, 400);
      if (text) this.consoleErrors.push({ step: this.currentStep, text, ts: Date.now() });
    } else if (method === 'Network.requestWillBeSent') {
      const url = params?.request?.url || '';
      const postData = params?.request?.postData || '';
      const action = extractActionName(url, postData, params?.type);
      if (!action) return;
      const meta = extractSafePayloadMeta(url, postData);
      this.inflight.set(params.requestId, {
        cdpReqId: params.requestId,
        step: this.currentStep,
        action,
        method: params?.request?.method || 'GET',
        url: url.split('?')[0],
        workspaceId: meta.workspaceId,
        projectName: meta.projectName,
        signatureKey: `${action}|${meta.signatureKey}`,
        startWallMs: Date.now(),
        startMonoSec: params.timestamp,
        httpStatus: null,
        durationMs: null,
        requestId: null,
        errorCode: null,
      });
    } else if (method === 'Network.responseReceived') {
      const rec = this.inflight.get(params.requestId);
      if (!rec) return;
      rec.httpStatus = params?.response?.status ?? null;
      const hdrs = params?.response?.headers || {};
      for (const [hk, hv] of Object.entries(hdrs)) {
        if (/^(x-tt-logid|x-request-id)$/i.test(hk) && !rec.requestId) {
          rec.requestId = String(hv);
        }
      }
    } else if (method === 'Network.loadingFinished') {
      const rec = this.inflight.get(params.requestId);
      if (!rec) return;
      this.inflight.delete(params.requestId);
      rec.durationMs =
        typeof params.timestamp === 'number' && typeof rec.startMonoSec === 'number'
          ? Math.max(1, Math.round((params.timestamp - rec.startMonoSec) * 1000))
          : Date.now() - rec.startWallMs;
      this.networkRecords.push(rec);
      // 异步提取响应信封里的真实 RequestId 与业务 ErrorCode（绝不落盘业务正文）
      this.send('Network.getResponseBody', { requestId: params.requestId }, 3000)
        .then(res => {
          if (!res?.body) return;
          const rawBody = res.base64Encoded
            ? Buffer.from(res.body, 'base64').toString('utf8')
            : res.body;
          if (!rawBody.trim().startsWith('{')) return;
          const parsed = JSON.parse(rawBody);
          const rm = parsed.ResponseMetadata || parsed.response_metadata || {};
          if (rm.RequestId) rec.requestId = rm.RequestId;
          if (rm.Error?.Code) rec.errorCode = rm.Error.Code;
          else if (parsed.error?.code) rec.errorCode = parsed.error.code;
        })
        .catch(() => {});
    } else if (method === 'Network.loadingFailed') {
      const rec = this.inflight.get(params.requestId);
      if (!rec) return;
      this.inflight.delete(params.requestId);
      rec.durationMs = Date.now() - rec.startWallMs;
      rec.httpStatus = rec.httpStatus || 0;
      rec.errorCode = params?.errorText || 'NETWORK_FAILED';
      this.networkRecords.push(rec);
    }
  }

  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP 调用超时 (${timeoutMs}ms): ${method}`));
      }, timeoutMs);
      this.pending.set(id, { method, resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  setStep(stepName) {
    this.currentStep = stepName;
  }

  stepRecords(stepName = this.currentStep) {
    return this.networkRecords.filter(r => r.step === stepName);
  }

  stepPageErrors(stepName = this.currentStep) {
    return this.pageErrors.filter(e => e.step === stepName);
  }

  buildContextUrl(subpath, { includeWorkspace = true } = {}) {
    const clean = subpath.startsWith('/') ? subpath : `/${subpath}`;
    const u = new URL(`${this.config.consoleBaseUrl}${clean}`);
    if (includeWorkspace) {
      u.searchParams.set('workspaceId', this.config.workspaceId);
      u.searchParams.set('project', this.config.projectName);
    }
    return u.toString();
  }

  async evalJSON(fnOrExpr) {
    const expression =
      typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : String(fnOrExpr);
    const res = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (res?.exceptionDetails) {
      throw new Error(
        `页面脚本执行报错: ${res.exceptionDetails.exception?.description || res.exceptionDetails.text}`
      );
    }
    return res?.result?.value;
  }

  async sleep(ms) {
    await new Promise(r => setTimeout(r, ms));
  }

  async waitFor(predicateFn, { timeoutMs = 15000, intervalMs = 250, label = 'condition' } = {}) {
    const start = Date.now();
    let lastVal = null;
    while (Date.now() - start < timeoutMs) {
      lastVal = await this.evalJSON(predicateFn);
      if (lastVal) return { ok: true, elapsedMs: Date.now() - start, value: lastVal };
      await this.sleep(intervalMs);
    }
    return { ok: false, elapsedMs: Date.now() - start, value: lastVal };
  }

  async gotoContext(
    subpath,
    { stepName, includeWorkspace = true, readyFn, timeoutMs = 18000 } = {}
  ) {
    if (stepName) this.setStep(stepName);
    const url = this.buildContextUrl(subpath, { includeWorkspace });
    const navStart = Date.now();
    await this.send('Page.navigate', { url });
    const defaultReady = () => {
      const bodyText = (document.body?.innerText || '').trim();
      if (!bodyText) return false;
      const hasMainLayout = Boolean(
        document.querySelector('main, [class*="Context"], .arco-table, .arco-tabs, button')
      );
      return hasMainLayout && bodyText.length > 20 ? bodyText.slice(0, 300) : false;
    };
    const settled = await this.waitFor(readyFn || defaultReady, {
      timeoutMs,
      intervalMs: 250,
      label: subpath,
    });
    // 给刚完成的响应留 250ms 完成 getResponseBody RequestId 提取
    await this.sleep(250);
    const loc = await this.evalJSON(() => ({
      href: window.location.href,
      title: document.title,
      bodySample: (document.body?.innerText || '').slice(0, 800),
    }));
    if (/signin\.volcengine\.com|\/auth\/login/i.test(loc.href)) {
      throw new Error(`9223 浏览器当前未登录火山控制台（已跳转登录页: ${loc.href}），请先在 9223 窗口完成登录`);
    }
    return {
      url,
      finalHref: loc.href,
      title: loc.title,
      bodySample: loc.bodySample,
      firstContentMs: settled.elapsedMs || Date.now() - navStart,
      settledOk: settled.ok,
      settledValue: settled.value,
    };
  }

  async screenshot(name) {
    if (!this.screenshotDir) return null;
    fs.mkdirSync(this.screenshotDir, { recursive: true });
    const safe = name.replace(/[^a-zA-Z0-9._-]+/g, '_');
    const filePath = path.join(this.screenshotDir, `${safe}.webp`);
    const res = await this.send('Page.captureScreenshot', { format: 'webp', quality: 80 });
    if (res?.data) {
      fs.writeFileSync(filePath, Buffer.from(res.data, 'base64'));
      return filePath;
    }
    return null;
  }

  // 全局不变量扫描：返回 { urlWorkspaceOk, forbiddenWorkspaceHit, pageErrors, has1970Timestamp, slowApis, duplicateApis }
  async collectStepOracle(stepName = this.currentStep) {
    const state = await this.evalJSON(() => ({
      href: window.location.href,
      visibleText: (document.body?.innerText || '').slice(0, 12000),
    }));
    const u = new URL(state.href);
    const urlWs = u.searchParams.get('workspaceId');
    const records = this.stepRecords(stepName);

    const slowApis = [];
    const dupCounter = new Map();
    for (const r of records) {
      dupCounter.set(r.signatureKey, (dupCounter.get(r.signatureKey) || 0) + 1);
      const limit =
        r.action === 'ExploreContextSource'
          ? this.config.slo.exploreSourceMaxMs
          : POLL_ACTIONS.has(r.action)
            ? this.config.slo.pollApiMaxMs
            : /^(Create|Update|Delete|Review|Confirm|Withdraw|Publish)/.test(r.action)
              ? this.config.slo.writeApiMaxMs
              : this.config.slo.standardApiMaxMs;
      if (typeof r.durationMs === 'number' && r.durationMs > limit) {
        slowApis.push({ ...r, sloLimitMs: limit });
      }
    }
    const duplicateApis = [...dupCounter.entries()]
      .filter(([, count]) => count >= 3)
      .map(([sig, count]) => ({ action: sig.split('|')[0], count }));

    return {
      href: state.href,
      urlWorkspaceId: urlWs,
      urlWorkspaceOk: urlWs === this.config.workspaceId,
      forbiddenWorkspaceHit: state.href.includes(this.config.forbiddenWorkspaceId),
      pageErrors: this.stepPageErrors(stepName),
      has1970Timestamp: /1970-01-01/.test(state.visibleText),
      slowApis,
      duplicateApis,
      records,
      visibleText: state.visibleText,
    };
  }

  async close() {
    try {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
      }
    } catch {
      // ignore
    }
    if (this.targetId) {
      await fetch(`${this.config.cdpHttpBase}/json/close/${this.targetId}`).catch(() => {});
      this.targetId = null;
    }
  }
}
