// 单标签页隔离型 CDP 会话驱动与全局 Context Oracle 探针（Node v22+ 原生 WebSocket，零外部依赖）。
// 核心特性：
// 1. 每次运行在 127.0.0.1:9223 新开一个独立测试 Tab，结束后自动关闭该 Tab，绝不触碰或挂死在其他后台标签页。
// 2. 自动注入前端灰度头 x-forward-fe 与后端泳道头 x-lane-env。
// 3. 自动采集所有 /context/control/* 与 /context/data/* 请求的 Action、HTTP 状态、耗时 ms、RequestId 与业务错误码（零敏感正文落盘）。
// 4. 内置五大全局不变量守卫（Console 未捕获崩溃、workspaceId 防丢/防串、1970 脏时间戳、重复请求风暴、接口慢响应红线）。

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const TARGET_FE_HEADER = 'feat_M_7387129035_agentkit_context';
const feGrayHeader = process.env.FE_GRAY_HEADER || TARGET_FE_HEADER;

export const DEFAULT_CONFIG = {
  cdpHttpBase: process.env.CDP_HTTP_BASE || 'http://127.0.0.1:9223',
  consoleBaseUrl:
    process.env.CONTEXT_CONSOLE_BASE ||
    'https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2',
  workspaceId: process.env.CONTEXT_WORKSPACE_ID || '800e2e0a-bb05-4591-8cd2-f8df54be0ebe',
  forbiddenWorkspaceId: 'ws-7710414566965542920',
  projectName: process.env.CONTEXT_PROJECT_NAME || 'default',
  feGrayHeader,
  expectedFrontendVersion: process.env.CONTEXT_E2E_EXPECTED_FE_VERSION ||
    (feGrayHeader === TARGET_FE_HEADER && !process.env.CONTEXT_CONSOLE_BASE ? '1.0.0.2257' : ''),
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
  'GetContextTask',
  'GetConnectionIndexSummary',
]);

function actionLimit(action, slo) {
  if (action === 'ExploreContextSource') return slo.exploreSourceMaxMs;
  if (POLL_ACTIONS.has(action)) return slo.pollApiMaxMs;
  return /^(Create|Update|Delete|Review|Confirm|Withdraw|Publish)/.test(action)
    ? slo.writeApiMaxMs
    : slo.standardApiMaxMs;
}

function parseRequestBody(raw = '') {
  const text = raw.trim();
  if (!text) return null;
  if (!text.startsWith('{')) return new URLSearchParams(text);
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function extractActionName(urlStr, postData, resourceType) {
  if (resourceType === 'Document') return null;
  try {
    const u = new URL(urlStr);
    const isAgentkitTop = /\/api\/top\/agentkit/i.test(u.pathname) || /agentkit/i.test(u.search);
    const qAction = u.searchParams.get('Action');
    if (qAction && (isAgentkitTop || /Context|Domain|Knowledge|Workbench|MCP/i.test(qAction))) {
      return qAction;
    }
    const restAction = u.pathname.match(/\/context\/(?:control|data\/v1)\/([^/?#]+)/)?.[1];
    if (restAction) return restAction;
    if (isAgentkitTop) {
      const lastSegment = u.pathname.split('/').filter(Boolean).at(-1);
      if (/^[A-Z][A-Za-z0-9]+$/.test(lastSegment || '')) return lastSegment;
    }
    const body = parseRequestBody(postData);
    const bodyAction = body instanceof URLSearchParams ? body.get('Action') : body?.Action;
    if (typeof bodyAction === 'string' && bodyAction &&
        (isAgentkitTop || /Context|Domain|Knowledge|Workbench|MCP/i.test(bodyAction))) {
      return bodyAction;
    }
  } catch {
    // 忽略无法归因的请求。
  }
  return null;
}

export function assertFrontendBuild(versions, expectedVersion) {
  const actual = [...new Set(versions)];
  if (actual.length !== 1 || actual[0] !== expectedVersion) {
    throw new Error(`静态资源版本预期 ${expectedVersion}，实际 ${actual.join('、') || '未取得'}`);
  }
  return actual[0];
}

const WORKSPACE_KEYS = ['workspaceId', 'WorkspaceId', 'workspace_id', 'contextWorkspaceId'];
const PROJECT_KEYS = ['project', 'ProjectName', 'project_name', 'projectName'];
const CATALOG_FILTER_KEYS = [
  'source', 'q', 'name', 'assetType', 'domain', 'folder', 'page', 'preview', 'dirq', 'search',
  'tree', 'view', 'entry', 'connect',
];
const ENTRY_TYPES = new Set(['DataAsset', 'Page', 'DATA_ASSET', 'PAGE', 'UNSTRUCTURED_DOC', 'SEMANTIC_PAGE']);

function cursorFingerprint(value) {
  if (typeof value !== 'string') return null;
  return value ? createHash('sha256').update(value).digest('hex') : '';
}

// Keep only the allowlisted filter values and pagination shape, never the raw request or cursor.
function inspectListEntriesRequest(url, rawBody) {
  const search = new URL(url).searchParams;
  const body = parseRequestBody(rawBody);
  const fields = key => [
    ...search.getAll(key),
    ...(body instanceof URLSearchParams ? body.getAll(key) : Object.hasOwn(body || {}, key) ? [body[key]] : []),
  ];
  return {
    hasEntryCategory: ['EntryCategory', 'entryCategory'].some(key => fields(key).length > 0),
    entryTypes: fields('EntryType').map(value => ENTRY_TYPES.has(value) ? value : null),
    maxResults: fields('MaxResults').map(value => {
      if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
      return Number.isSafeInteger(value) ? value : null;
    }),
    nextTokens: fields('NextToken').map(cursorFingerprint),
  };
}

function inspectListEntriesResponse(result) {
  return {
    itemsCount: Array.isArray(result?.Items) ? result.Items.length : null,
    entriesCount: Array.isArray(result?.Entries) ? result.Entries.length : null,
    nextToken: result && Object.hasOwn(result, 'NextToken') ? cursorFingerprint(result.NextToken) : '',
  };
}

function scopeValues(url, keys, body) {
  const bodyValues = body instanceof URLSearchParams
    ? keys.flatMap(key => body.getAll(key))
    : [...keys.map(key => body?.[key]), ...keys.map(key => body?.Meta?.Scope?.[key])];
  return [
    ...bodyValues,
    ...keys.flatMap(key => url.searchParams.getAll(key)),
  ].filter(value => typeof value === 'string' && value !== '');
}

function extractSafePayloadMeta(urlStr, postData) {
  const url = new URL(urlStr);
  const body = parseRequestBody(postData);
  const workspaceIds = scopeValues(url, WORKSPACE_KEYS, body);
  const projectNames = scopeValues(url, PROJECT_KEYS, body);
  return {
    workspaceIds,
    projectNames,
    workspaceId: workspaceIds[0] ?? null,
    projectName: projectNames[0] ?? null,
    // 内存中的摘要用于区分同一 Action 的不同对象或分页。
    signatureKey: createHash('sha256').update(url.search).update('\n').update(postData || '').digest('hex'),
  };
}

function matchesUrlScope(url, keys, value) {
  return url.searchParams.get(keys[0]) === value &&
    scopeValues(url, keys).every(item => item === value);
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
    this.responseMetadata = new Map();
    this.wireLaneMatches = new Map();
    this.scopeViolations = [];
    this.frontendVersions = new Set();
    this.pageErrors = [];
    this.consoleErrors = [];
  }

  async open() {
    if (!this.config.workspaceId || this.config.workspaceId === this.config.forbiddenWorkspaceId) {
      throw new Error('测试工作区为空或位于禁区');
    }
    const cdpUrl = new URL(this.config.cdpHttpBase);
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(cdpUrl.hostname)) {
      throw new Error('隔离浏览器 CDP 入口必须使用本机地址');
    }
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
    const base = new URL(this.config.consoleBaseUrl);
    const origin = base.origin;
    await this.send('Fetch.enable', {
      patterns: [
        { urlPattern: `${origin}${base.pathname}/context/*`, resourceType: 'Document' },
        { urlPattern: `${origin}/api/top/agentkit*` },
        { urlPattern: `${origin}/context/*` },
      ],
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
    if (method === 'Fetch.requestPaused') {
      const { requestId, request, resourceType } = params;
      const { workspaceIds, projectNames } = extractSafePayloadMeta(request.url, request.postData || '');
      const action = extractActionName(request.url, request.postData, resourceType);
      const forbidden = workspaceIds.includes(this.config.forbiddenWorkspaceId);
      // 控制台外围接口可读取工作区元数据，Context 的路由和业务请求必须保留测试范围。
      const isContext = resourceType === 'Document' || /Context|Domain|Knowledge|Workbench|MCP/i.test(action || '') ||
        /\/context\/(?:control|data)\//.test(new URL(request.url).pathname);
      const mismatched = isContext && (
        workspaceIds.some(id => id !== this.config.workspaceId) ||
        projectNames.some(name => name !== this.config.projectName)
      );
      if (forbidden || mismatched) {
        this.scopeViolations.push({ step: this.currentStep, action: action || resourceType, forbidden });
        void this.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => {});
      } else {
        void this.send('Fetch.continueRequest', { requestId }).catch(() => {});
      }
    } else if (method === 'Runtime.exceptionThrown') {
      const details = params?.exceptionDetails;
      const text =
        details?.exception?.description || details?.text || 'Uncaught Runtime Exception';
      // 第三方导航条与埋点异常独立于 Context 请求。
      if (/res\.gcloudcache\.com\/volc-fe\/navbar|slardar|tea-sdk/i.test(`${details?.url || ''} ${text}`)) {
        return;
      }
      this.pageErrors.push({ step: this.currentStep, text: String(text).slice(0, 400), ts: Date.now() });
    } else if (method === 'Runtime.consoleAPICalled' && params?.type === 'error') {
      const text = (params.args || [])
        .map(a => a.description || a.value || '')
        .join(' ')
        .slice(0, 400);
      if (text) this.consoleErrors.push({ step: this.currentStep, text, ts: Date.now() });
    } else if (method === 'Network.requestWillBeSentExtraInfo') {
      // This event shows the wire headers. Keep only the result of comparing the lane.
      const lanes = Object.entries(params.headers || {})
        .filter(([name]) => name.toLowerCase() === 'x-lane-env')
        .map(([, value]) => value);
      this.wireLaneMatches.set(params.requestId, lanes.length === 1 && lanes[0] === this.config.laneEnv);
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
        ...(action === 'ListContextEntries' && { listEntriesRequest: inspectListEntriesRequest(url, postData) }),
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
      const responseMetadata = this.send('Network.getResponseBody', { requestId: params.requestId }, 3000)
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
          if (rec.listEntriesRequest) rec.listEntriesResponse = inspectListEntriesResponse(parsed.Result ?? parsed);
        })
        .catch(() => {})
        .finally(() => this.responseMetadata.delete(params.requestId));
      this.responseMetadata.set(params.requestId, { step: rec.step, promise: responseMetadata });
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

  async flushResponseMetadata(stepName) {
    await Promise.all(
      [...this.responseMetadata.values()]
        .filter(entry => !stepName || entry.step === stepName)
        .map(entry => entry.promise)
    );
  }

  evidenceRecords() {
    const now = Date.now();
    return [...this.networkRecords, ...this.inflight.values()].map(record => {
      const { step, action, httpStatus, durationMs, requestId, errorCode, workspaceId, projectName, url, method } = record;
      const pending = this.inflight.get(record.cdpReqId) === record;
      return {
        step, action, httpStatus, requestId, errorCode, workspaceId, projectName, url, method, pending,
        targetLaneSent: this.wireLaneMatches.get(record.cdpReqId) ?? null,
        durationMs: pending ? now - record.startWallMs : durationMs,
        sloLimitMs: actionLimit(action, this.config.slo),
      };
    });
  }

  stepPageErrors(stepName = this.currentStep) {
    return this.pageErrors.filter(e => e.step === stepName);
  }

  buildContextUrl(subpath, { includeWorkspace = true } = {}) {
    const clean = subpath.startsWith('/') ? subpath : `/${subpath}`;
    const u = new URL(`${this.config.consoleBaseUrl}${clean}`);
    if (includeWorkspace) {
      for (const alias of [...WORKSPACE_KEYS.slice(1), ...PROJECT_KEYS.slice(1)]) {
        u.searchParams.delete(alias);
      }
      u.searchParams.set('workspaceId', this.config.workspaceId);
      u.searchParams.set('project', this.config.projectName);
    }
    return u.toString();
  }

  async evalJSON(fnOrExpr, timeoutMs = 15000) {
    const expression =
      typeof fnOrExpr === 'function' ? `(${fnOrExpr.toString()})()` : String(fnOrExpr);
    const res = await this.send(
      'Runtime.evaluate',
      { expression, awaitPromise: true, returnByValue: true },
      timeoutMs
    );
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
      const remainingMs = timeoutMs - (Date.now() - start);
      try {
        lastVal = await this.evalJSON(predicateFn, Math.max(1, remainingMs));
      } catch (error) {
        if (Date.now() - start >= timeoutMs && /CDP 调用超时/.test(error.message)) break;
        throw error;
      }
      if (lastVal) return { ok: true, elapsedMs: Date.now() - start, value: lastVal };
      await this.sleep(Math.max(0, Math.min(intervalMs, timeoutMs - (Date.now() - start))));
    }
    return { ok: false, elapsedMs: Date.now() - start, value: lastVal };
  }

  async gotoContext(
    subpath,
    { stepName, includeWorkspace = true, readyFn, timeoutMs = 18000 } = {}
  ) {
    if (stepName) this.setStep(stepName);
    const url = this.buildContextUrl(subpath, { includeWorkspace });
    const expected = new URL(url);
    const expectedKeys = new Set(expected.searchParams.keys());
    if (expected.pathname.endsWith('/context/catalog')) {
      for (const key of CATALOG_FILTER_KEYS) expectedKeys.add(key);
    }
    const filters = [...expectedKeys].map(key => [key, expected.searchParams.getAll(key)]);
    const legacyConnection = /\/context\/connections\/[^/]+\/detail$/.test(expected.pathname);
    const navStart = Date.now();
    const navigation = await this.send('Page.navigate', { url }, timeoutMs);
    if (navigation?.errorText) {
      throw new Error(`页面导航失败 ${navigation.errorText}`);
    }
    const defaultReady = () => {
      const bodyText = (document.body?.innerText || '').trim();
      if (!bodyText) return false;
      const hasMainLayout = Boolean(
        document.querySelector('main, [class*="Context"], .arco-table, .arco-tabs, button')
      );
      return hasMainLayout && bodyText.length > 20 ? bodyText.slice(0, 300) : false;
    };
    const readyPredicate = (readyFn || defaultReady).toString();
    const settled = await this.waitFor(`(() => {
      const actual = new URL(window.location.href);
      if (/signin\\.volcengine\\.com|\\/auth\\/login/i.test(actual.href)) return { signin: true };
      if (actual.origin !== ${JSON.stringify(expected.origin)}) return false;
      const matchingPath = actual.pathname === ${JSON.stringify(expected.pathname)} ||
        (${legacyConnection} && /\\/context\\/catalog\\/[^/]+\\/detail$/.test(actual.pathname));
      if (!matchingPath || document.readyState === 'loading') return false;
      const expectedFilters = ${JSON.stringify(filters)};
      if (!expectedFilters.every(([key, values]) =>
        JSON.stringify(actual.searchParams.getAll(key)) === JSON.stringify(values)
      )) return false;
      if (${includeWorkspace} && (
        actual.searchParams.get('workspaceId') !== ${JSON.stringify(this.config.workspaceId)} ||
        actual.searchParams.get('project') !== ${JSON.stringify(this.config.projectName)}
      )) return false;
      const value = (${readyPredicate})();
      return value ? { value } : false;
    })()`, {
      timeoutMs: Math.max(1, timeoutMs - (Date.now() - navStart)),
      intervalMs: 250,
      label: subpath,
    });
    const firstContentMs = Date.now() - navStart;
    if (settled.value?.signin) {
      throw new Error('隔离浏览器已跳到火山控制台登录页，当前会话未执行资产验证');
    }
    // 给刚完成的响应留 250ms 完成 getResponseBody RequestId 提取
    await this.sleep(250);
    const loc = await this.evalJSON(() => ({
      href: window.location.href,
      title: document.title,
      bodySample: (document.body?.innerText || '').slice(0, 800),
    }));
    if (/signin\.volcengine\.com|\/auth\/login/i.test(loc.href)) {
      throw new Error('隔离浏览器已跳到火山控制台登录页，当前会话未执行资产验证');
    }
    const finalUrl = new URL(loc.href);
    const finalPathOk = finalUrl.origin === expected.origin && (
      finalUrl.pathname === expected.pathname ||
      (legacyConnection && /\/context\/catalog\/[^/]+\/detail$/.test(finalUrl.pathname))
    );
    const finalScopeOk = !includeWorkspace || (
      matchesUrlScope(finalUrl, WORKSPACE_KEYS, this.config.workspaceId) &&
      matchesUrlScope(finalUrl, PROJECT_KEYS, this.config.projectName)
    );
    const finalFiltersOk = filters.every(([key, values]) =>
      JSON.stringify(finalUrl.searchParams.getAll(key)) === JSON.stringify(values)
    );
    const settledOk = settled.ok && finalPathOk && finalScopeOk && finalFiltersOk;
    return {
      url,
      finalHref: loc.href,
      title: loc.title,
      bodySample: loc.bodySample,
      firstContentMs,
      settledOk,
      settledValue: settledOk ? settled.value?.value : undefined,
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
      frontendVersions: Array.from(document.scripts, script =>
        script.src.match(/\/vconsole-agentkit\/static\/js\/(1\.0\.0\.\d+)\//)?.[1]
      ).filter(Boolean),
    }));
    for (const version of state.frontendVersions || []) this.frontendVersions.add(version);
    const u = new URL(state.href);
    const urlWs = u.searchParams.get('workspaceId');
    await this.flushResponseMetadata(stepName);
    const records = this.stepRecords(stepName);
    const pendingApis = this.evidenceRecords().filter(r => r.pending && r.step === stepName);
    const scopeViolations = this.scopeViolations.filter(item => item.step === stepName);

    const slowApis = [];
    const dupCounter = new Map();
    for (const r of records) {
      dupCounter.set(r.signatureKey, (dupCounter.get(r.signatureKey) || 0) + 1);
      const limit = actionLimit(r.action, this.config.slo);
      if (typeof r.durationMs === 'number' && r.durationMs > limit) {
        slowApis.push({ ...r, sloLimitMs: limit });
      }
    }
    const duplicateApis = [...dupCounter.entries()]
      .filter(([, count]) => count >= 3)
      .map(([sig, count]) => ({ action: sig.split('|')[0], count }));

    return {
      href: state.href,
      frontendVersions: state.frontendVersions || [],
      urlWorkspaceId: urlWs,
      urlWorkspaceOk: matchesUrlScope(u, WORKSPACE_KEYS, this.config.workspaceId),
      urlProjectOk: matchesUrlScope(u, PROJECT_KEYS, this.config.projectName),
      forbiddenWorkspaceHit:
        scopeValues(u, WORKSPACE_KEYS).includes(this.config.forbiddenWorkspaceId) ||
        scopeViolations.some(item => item.forbidden),
      scopeViolations,
      pageErrors: this.stepPageErrors(stepName),
      has1970Timestamp: /1970-01-01/.test(state.visibleText),
      slowApis,
      duplicateApis,
      pendingApis,
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
