// 模块 08：P0 草稿调试端到端旅程
// 旅程覆盖：
// 1. 只读阶段一：从合成测试领域（codex-e2e-*）详情进入「版本与记录」，核验独立草稿行（「草稿 / 待发布」）暴露可用「调试」按钮。
// 2. 只读阶段二：沿真实鼠标点击草稿行「调试」进入工作台调试台，核验 workspaceId / project / draftDomainId 及领域选择器锁定同一具体草稿（不串入已发布版本）。
// 3. 门禁发送阶段三：仅当 CONTEXT_E2E_RUN_DRAFT_QUERY=1 且 CONTEXT_E2E_DRAFT_DOMAIN_ID、CONTEXT_E2E_DRAFT_DOMAIN_NAME（codex-e2e-*）、
//    CONTEXT_E2E_DRAFT_EXPECTED_ASSET 全部明确配置时，在真实编辑器单次输入并提交「你有哪些数据」，预算 <= 120s 等待终态回答或错误；
//    缺任一条件显式登记 BLOCKED（绝不静默跳过当 PASS）。失败证据严格区分页面错误「本轮执行未完成」与执行端
//    `Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id`，并附耗时与脱敏 API evidence。

import { extractActionName } from '../lib/cdpSession.mjs';

export const SYNTHETIC_DOMAIN_PREFIX = 'codex-e2e-';
export const DRAFT_DEBUG_QUESTION = '你有哪些数据';
export const MAX_DRAFT_DEBUG_BUDGET_MS = 120_000;

export const STAGE_TITLES = {
  entry: '合成测试领域详情「版本与记录」独立草稿行暴露可用「调试」按钮',
  workbenchLock: '从独立草稿行点击「调试」进入工作台并锁定同一具体草稿（不串选已发布版本）',
  queryAnswer: '在工作台编辑器提交「你有哪些数据」并返回命中预期合成资产的真实草稿回答',
};

const SENSITIVE_KV_RE =
  /\b(authorization|cookie|set-cookie|x-csrf-token|x-tt-session|session[_-]?token|access[_-]?token|refresh[_-]?token|id[_-]?token|api[_-]?key|ark[_-]?api[_-]?key|access[_-]?key|secret[_-]?key|client[_-]?secret|private[_-]?key|auth[_-]?secret|password|passwd|pwd|secret|token|credential|ak|sk)\b(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;}\]]+)/gi;

const SENSITIVE_JSON_FIELD_RE =
  /"([^"]*(?:secret|token|password|passwd|credential|api[_-]?key|access[_-]?key|private[_-]?key|cookie|authorization)[^"]*)"\s*:\s*"[^"]*"/gi;

const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi;
const JWT_RE = /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL_USERINFO_RE = /\b(https?:\/\/)([^/\s:@]+:[^/\s@]+)@/gi;

const GATEWAY_DRAFT_FORBIDDEN_RE =
  /Workspace\s+Gateway\s+MCP\s+tools\/list\s+FORBIDDEN\s*:\s*draft_version_id|tools\/list[^\n]*FORBIDDEN[^\n]*draft_version_id|FORBIDDEN[^\n]*draft_version_id/i;

const UI_INCOMPLETE_ERROR_RE = /本轮执行未完成/;

const UI_ERROR_CARD_TITLES_RE =
  /^(?:本轮执行未完成|数据访问策略已拦截当前请求|领域草稿已更新|超出模型上下文长度上限|已停止本轮生成)$/;

const FALLBACK_FAILED_ANSWERS_RE =
  /^(?:本轮回答失败，请稍后重试。?|本轮回答超时，请在历史对话中确认执行状态，再决定是否重试。?|本轮回答超出模型 Token 预算.*|本轮回答已取消。?|当前身份已无权查看本轮回答。?|已完成本轮查询。?)$/;

const STREAMING_PLACEHOLDER_RE =
  /^(?:正在生成回答[….]*|正在签发租户隔离凭证.*|正在等待数据源或模型响应.*|正在检索领域上下文.*|查询涉及多步检索或复杂聚合.*)$/;

const WELCOME_NOISE_RE =
  /^(?:问个问题，看看回答效果|选择领域草稿或已发布版本.*|当前有哪些表可以查询？|有哪些可用的知识文档？|正在读取领域|配置业务领域后开始调试)$/;

export function isSyntheticDomainName(name) {
  const trimmed = String(name ?? '').trim();
  return (
    trimmed.startsWith(SYNTHETIC_DOMAIN_PREFIX) &&
    trimmed.length > SYNTHETIC_DOMAIN_PREFIX.length &&
    !/\s/.test(trimmed)
  );
}

export function clampBudgetMs(rawValue, hardMaxMs = MAX_DRAFT_DEBUG_BUDGET_MS) {
  const cap = Math.min(MAX_DRAFT_DEBUG_BUDGET_MS, Math.max(1_000, Number(hardMaxMs) || MAX_DRAFT_DEBUG_BUDGET_MS));
  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return cap;
  return Math.min(cap, Math.max(1_000, Math.round(parsed)));
}

export function redactSensitiveText(input, maxLen = 320) {
  if (input === null || input === undefined) return '';
  let text = String(input)
    .replace(URL_USERINFO_RE, '$1[REDACTED]@')
    .replace(BEARER_RE, '[REDACTED_BEARER]')
    .replace(JWT_RE, '[REDACTED_JWT]')
    .replace(SENSITIVE_JSON_FIELD_RE, '"$1":"[REDACTED]"')
    .replace(SENSITIVE_KV_RE, '$1$2[REDACTED]')
    .replace(/\s+/g, ' ')
    .trim();
  if (text.length > maxLen) {
    text = `${text.slice(0, maxLen)}…`;
  }
  return text;
}

export function resolveDraftDebugFixture(cfg = {}, env = process.env) {
  const rawRunFlag = cfg.runDraftQuery ?? env.CONTEXT_E2E_RUN_DRAFT_QUERY ?? '';
  const runDraftQuery = rawRunFlag === true || String(rawRunFlag).trim() === '1';

  const explicitDomainId = String(
    cfg.draftDomainId ?? env.CONTEXT_E2E_DRAFT_DOMAIN_ID ?? ''
  ).trim();
  const explicitDomainName = String(
    cfg.draftDomainName ?? env.CONTEXT_E2E_DRAFT_DOMAIN_NAME ?? ''
  ).trim();
  const expectedAsset = String(
    cfg.draftExpectedAsset ?? env.CONTEXT_E2E_DRAFT_EXPECTED_ASSET ?? ''
  ).trim();

  const expectedAssets = Array.isArray(cfg.draftExpectedAssets)
    ? cfg.draftExpectedAssets.map(item => String(item ?? '').trim()).filter(Boolean)
    : expectedAsset
      ? [expectedAsset]
      : [];

  const maxBudgetMs = clampBudgetMs(
    cfg.draftQueryTimeoutMs ?? env.CONTEXT_E2E_DRAFT_QUERY_TIMEOUT_MS,
    MAX_DRAFT_DEBUG_BUDGET_MS
  );

  return {
    runDraftQuery,
    explicitDomainId,
    explicitDomainName,
    expectedAsset: expectedAsset || expectedAssets[0] || '',
    expectedAssets,
    maxBudgetMs,
    question: DRAFT_DEBUG_QUESTION,
  };
}

export function evaluateSendGate(fixture, runtimeContext = {}) {
  const missing = [];
  if (!fixture?.runDraftQuery) {
    missing.push('CONTEXT_E2E_RUN_DRAFT_QUERY=1（当前默认只读模式）');
  }
  if (!fixture?.explicitDomainId) {
    missing.push('CONTEXT_E2E_DRAFT_DOMAIN_ID');
  }
  if (!fixture?.explicitDomainName) {
    missing.push('CONTEXT_E2E_DRAFT_DOMAIN_NAME');
  } else if (!isSyntheticDomainName(fixture.explicitDomainName)) {
    missing.push(
      `CONTEXT_E2E_DRAFT_DOMAIN_NAME 必须以 ${SYNTHETIC_DOMAIN_PREFIX} 开头（当前="${redactSensitiveText(fixture.explicitDomainName, 80)}"）`
    );
  }
  if (!fixture?.expectedAssets?.length) {
    missing.push('CONTEXT_E2E_DRAFT_EXPECTED_ASSET');
  }

  if (missing.length > 0) {
    return {
      allowed: false,
      missing,
      reason: `发送阶段门禁未满足，保持只读不发起提问：缺少或不符合 ${missing.join('、')}`,
    };
  }

  if (runtimeContext.workspaceValid === false) {
    return {
      allowed: false,
      missing: ['validWorkspace'],
      reason: '目标工作区校验未通过，阻断草稿提问发送',
    };
  }

  if (
    runtimeContext.resolvedDomainId &&
    runtimeContext.resolvedDomainId !== fixture.explicitDomainId
  ) {
    return {
      allowed: false,
      missing: ['domainIdMatch'],
      reason: `当前页面领域 ID (${runtimeContext.resolvedDomainId}) 与 CONTEXT_E2E_DRAFT_DOMAIN_ID (${fixture.explicitDomainId}) 不一致，阻断发送`,
    };
  }

  if (
    runtimeContext.resolvedDomainName &&
    runtimeContext.resolvedDomainName !== fixture.explicitDomainName
  ) {
    return {
      allowed: false,
      missing: ['domainNameMatch'],
      reason: `当前页面领域名称 (${runtimeContext.resolvedDomainName}) 与 CONTEXT_E2E_DRAFT_DOMAIN_NAME (${fixture.explicitDomainName}) 不一致，阻断发送`,
    };
  }

  if (runtimeContext.workbenchLockedSameDraft === false) {
    return {
      allowed: false,
      missing: ['workbenchDraftLock'],
      reason:
        runtimeContext.workbenchFailureReason ||
        '前置草稿入口或工作台草稿锁定未通过，禁止盲目向非目标草稿发送消息创建会话',
    };
  }

  return { allowed: true, missing: [], reason: '发送门禁校验通过' };
}

export function verifyWorkbenchDraftBinding({
  href,
  expectedWorkspaceId,
  forbiddenWorkspaceId,
  expectedProject,
  expectedDomainId,
  expectedDomainName,
  domainPicker,
  modelPicker,
  composer,
  alerts = [],
  toasts = [],
  releaseVersions = [],
  apiDomainDiagnostics = {},
}) {
  if (!href) {
    return { ok: false, reason: '工作台地址为空' };
  }
  if (forbiddenWorkspaceId && href.includes(forbiddenWorkspaceId)) {
    return {
      ok: false,
      reason: `严重越界：地址跳入禁区工作区 ${forbiddenWorkspaceId} (${redactSensitiveText(href, 200)})`,
    };
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(href);
  } catch {
    return { ok: false, reason: `工作台地址非法: ${redactSensitiveText(href, 200)}` };
  }

  if (!/\/context\/workbench\/?$/.test(parsedUrl.pathname)) {
    return {
      ok: false,
      reason: `点击草稿「调试」后未进入 /context/workbench，实际路径=${parsedUrl.pathname}`,
    };
  }

  const actualWs = parsedUrl.searchParams.get('workspaceId') || '';
  if (expectedWorkspaceId && actualWs !== expectedWorkspaceId) {
    return {
      ok: false,
      reason: `工作台 workspaceId 丢失或不一致：期望=${expectedWorkspaceId}，实际=${actualWs || '空'}`,
    };
  }

  const actualProject = parsedUrl.searchParams.get('project') || '';
  if (expectedProject && actualProject !== expectedProject) {
    return {
      ok: false,
      reason: `工作台 project 丢失或不一致：期望=${expectedProject}，实际=${actualProject || '空'}`,
    };
  }

  const actualTab = parsedUrl.searchParams.get('tab') || '';
  if (actualTab !== 'chat') {
    return {
      ok: false,
      reason: `工作台未激活调试台 tab=chat，实际 tab=${actualTab || '空'}`,
    };
  }

  const actualDraftDomainId = parsedUrl.searchParams.get('draftDomainId') || '';
  if (actualDraftDomainId !== expectedDomainId) {
    return {
      ok: false,
      reason: `工作台 URL draftDomainId 不匹配：期望=${expectedDomainId}，实际=${actualDraftDomainId || '空'}`,
    };
  }

  const expectedLabel = `${expectedDomainName} · 草稿`;
  const selectedLabel = String(domainPicker?.value || '').trim();
  const placeholder = String(domainPicker?.placeholder || '').trim();
  const combinedWarnings = [...alerts, ...toasts]
    .map(item => redactSensitiveText(item, 160))
    .filter(Boolean);
  const draftUnavailableNotice = combinedWarnings.find(text =>
    /草稿不可调试|该草稿已不可调试|草稿已更新/.test(text)
  );

  if (draftUnavailableNotice) {
    const listDiag = apiDomainDiagnostics.listDomain
      ? `ListContextDomains(CanPreviewDraft=${apiDomainDiagnostics.listDomain.canPreviewDraft}, DraftRevision=${apiDomainDiagnostics.listDomain.draftRevision})`
      : '';
    return {
      ok: false,
      reason: `同一草稿在「版本与记录」具备「调试」入口，但工作台拒绝识别该草稿：提示「${draftUnavailableNotice}」，领域选择器="${selectedLabel || placeholder || '空'}"${listDiag ? `，${listDiag}` : ''}`,
    };
  }

  if (!domainPicker?.found || domainPicker.disabled) {
    return {
      ok: false,
      reason: !domainPicker?.found
        ? '工作台调试台未挂载「业务领域与版本」选择器'
        : '工作台「业务领域与版本」选择器处于禁用状态',
    };
  }

  if (selectedLabel !== expectedLabel) {
    const matchedRelease = releaseVersions.find(
      ver => ver && selectedLabel === `${expectedDomainName} · ${ver}`
    );
    const looksLikeRelease =
      Boolean(matchedRelease) ||
      (selectedLabel.startsWith(`${expectedDomainName} · `) && !selectedLabel.endsWith('· 草稿'));
    if (looksLikeRelease) {
      return {
        ok: false,
        reason: `工作台误将草稿串选为已发布版本：期望锁定「${expectedLabel}」(draftDomainId=${expectedDomainId})，实际选中「${selectedLabel}」`,
      };
    }
    return {
      ok: false,
      reason: `工作台未锁定同一具体草稿：期望「${expectedLabel}」(draftDomainId=${expectedDomainId})，实际选中="${selectedLabel || '未选中'}"（placeholder="${placeholder || '—'}"）`,
    };
  }

  if (!modelPicker?.found || modelPicker.disabled || !String(modelPicker.value || '').trim()) {
    return {
      ok: false,
      reason: `工作台已选中「${expectedLabel}」，但无可用模型就绪或模型选择器禁用（model="${modelPicker?.value || modelPicker?.placeholder || '空'}", disabled=${Boolean(modelPicker?.disabled)}）`,
    };
  }

  if (!composer?.found || composer.disabled) {
    return {
      ok: false,
      reason: `工作台已选中「${expectedLabel}」，但对话输入编辑器不可用（found=${Boolean(composer?.found)}, disabled=${Boolean(composer?.disabled)}）`,
    };
  }

  return {
    ok: true,
    selectedLabel,
    modelId: String(modelPicker.value).trim(),
  };
}

export function parseSseDiagnosticEvents(rawSseText) {
  const events = [];
  if (!rawSseText || typeof rawSseText !== 'string') return events;
  const blocks = rawSseText.split(/\r?\n\r?\n/);
  for (const block of blocks) {
    const lines = block.split(/\r?\n/);
    let eventName = '';
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith('event:')) eventName = line.slice(6).trim();
      else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
    }
    if (!dataLines.length) continue;
    const rawData = dataLines.join('\n').trim();
    if (!rawData.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(rawData);
      if (eventName === 'agent' || eventName === 'error' || parsed.type) {
        events.push({ eventName: eventName || 'message', payload: parsed });
      }
    } catch {
      // ignore non-JSON frame
    }
  }
  return events;
}

export function extractTurnPayloadDiagnostics(action, rawBody) {
  if (!rawBody || typeof rawBody !== 'string') return null;
  const trimmed = rawBody.trim();

  if (!trimmed.startsWith('{') && /event:\s*(?:ready|agent|error|end)/.test(trimmed)) {
    const frames = parseSseDiagnosticEvents(trimmed);
    const findings = [];
    let sawIdle = false;
    for (const { eventName, payload } of frames) {
      if (payload?.type === 'idle') sawIdle = true;
      if (payload?.type === 'failed' || eventName === 'error') {
        findings.push({
          source: `sse.${payload?.type || eventName}`,
          code: redactSensitiveText(payload?.code || payload?.error?.code || '', 80),
          message: redactSensitiveText(payload?.message || payload?.error?.message || '', 260),
        });
      } else if (payload?.type === 'toolResult' && payload?.ok === false) {
        findings.push({
          source: 'sse.toolResult',
          toolName: redactSensitiveText(payload?.name || '', 64),
          code: redactSensitiveText(payload?.authzDecision || 'TOOL_FAILED', 80),
          message: redactSensitiveText(payload?.output || '', 260),
        });
      }
    }
    return {
      action,
      transport: 'sse',
      done: sawIdle || findings.some(f => f.source.startsWith('sse.failed')),
      turnStatus: findings.some(f => f.source.startsWith('sse.failed'))
        ? 'FAILED'
        : sawIdle
          ? 'SUCCEEDED'
          : null,
      findings,
    };
  }

  if (!trimmed.startsWith('{')) return null;

  let parsed;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  const rm = parsed.ResponseMetadata || parsed.response_metadata || {};
  const result = parsed.Result ?? parsed.result ?? parsed;
  const topError = rm.Error || parsed.error || null;
  const findings = [];

  if (topError && (topError.Code || topError.code || topError.Message || topError.message)) {
    findings.push({
      source: `${action}.topError`,
      code: redactSensitiveText(topError.Code || topError.code || '', 80),
      message: redactSensitiveText(topError.Message || topError.message || '', 260),
    });
  }

  if (action === 'GetContextDomain' && result?.Domain) {
    const d = result.Domain;
    return {
      action,
      requestId: rm.RequestId || null,
      domain: {
        domainId: d.DomainId || '',
        name: d.Name || '',
        draftRevision: d.DraftRevision ?? null,
        activeVersion: d.ActiveVersion || '',
        hasDraftChanges: d.HasDraftChanges ?? null,
        canPreviewDraft: d.CanPreviewDraft ?? null,
      },
      findings,
    };
  }

  if (action === 'ListContextDomains' && Array.isArray(result?.Domains || result?.Items)) {
    const list = result.Domains || result.Items;
    return {
      action,
      requestId: rm.RequestId || null,
      domains: list.map(d => ({
        domainId: d.DomainId || '',
        name: d.Name || '',
        draftRevision: d.DraftRevision ?? null,
        activeVersion: d.ActiveVersion || d.PublishedVersion || '',
        hasDraftChanges: d.HasDraftChanges ?? null,
        canPreviewDraft: d.CanPreviewDraft ?? null,
      })),
      findings,
    };
  }

  const session = result?.Session;
  const turn = result?.Turn;
  const streamEvents = Array.isArray(result?.Events) ? result.Events : [];
  const steps = Array.isArray(turn?.Steps) ? turn.Steps : [];

  for (const ev of streamEvents) {
    if (ev?.type === 'failed') {
      findings.push({
        source: 'turn.event.failed',
        code: redactSensitiveText(ev.code || '', 80),
        message: redactSensitiveText(ev.message || '', 260),
      });
    } else if (ev?.type === 'toolResult' && ev?.ok === false) {
      findings.push({
        source: 'turn.event.toolResult',
        toolName: redactSensitiveText(ev.name || '', 64),
        code: redactSensitiveText(ev.authzDecision || 'TOOL_FAILED', 80),
        message: redactSensitiveText(ev.output || '', 260),
      });
    }
  }

  for (const step of steps) {
    const stepStatus = String(step?.Status || '').toUpperCase();
    const rawStepSummary = step?.ToolOutputSummary || step?.Summary || '';
    if (
      stepStatus === 'FAILED' ||
      step?.ErrorCode ||
      GATEWAY_DRAFT_FORBIDDEN_RE.test(rawStepSummary) ||
      /\bFORBIDDEN\b/i.test(String(step?.AuthzDecision || ''))
    ) {
      findings.push({
        source: 'turn.step',
        toolName: redactSensitiveText(step?.ToolName || '', 64),
        code: redactSensitiveText(step?.ErrorCode || step?.AuthzDecision || stepStatus, 80),
        message: redactSensitiveText(rawStepSummary, 260),
      });
    }
  }

  if (
    turn &&
    (String(turn.Status || '').toUpperCase() === 'FAILED' || turn.ErrorCode) &&
    findings.length === 0
  ) {
    findings.push({
      source: 'turn.status',
      code: redactSensitiveText(turn.ErrorCode || turn.Status || 'FAILED', 80),
      message: redactSensitiveText(turn.ErrorMessage || turn.Message || '', 260),
    });
  }

  return {
    action,
    transport: 'json',
    requestId: rm.RequestId || null,
    done: Boolean(result?.Done) || /^(SUCCEEDED|FAILED|CANCELLED|NEEDS_CLARIFICATION)$/i.test(String(turn?.Status || '')),
    sessionId: session?.SessionId || turn?.SessionId || null,
    sessionTargetKind: session?.TargetKind || null,
    sessionDraftRevision: session?.DraftRevision ?? null,
    sessionPinnedReleases: session?.PinnedDomainReleases
      ? Object.keys(session.PinnedDomainReleases)
      : [],
    turnId: result?.TurnId || turn?.TurnId || result?.RunId || null,
    turnStatus: turn?.Status || result?.Status || null,
    turnErrorCode: turn?.ErrorCode || null,
    findings,
  };
}

export function formatSanitizedApiEvidence(records = [], turnDiagnostics = []) {
  const relevantActions = new Set([
    'GetContextDomain',
    'ListContextDomainReleases',
    'ListContextDomains',
    'ListContextModels',
    'SendContextWorkbenchMessage',
    'GetContextWorkbenchTurn',
    'GetContextWorkbenchSession',
  ]);

  const recordSummaries = records
    .filter(rec => relevantActions.has(rec.action))
    .slice(-8)
    .map(rec => {
      const parts = [
        rec.action,
        `HTTP=${rec.httpStatus ?? (rec.pending ? 'PENDING' : '—')}`,
        typeof rec.durationMs === 'number' ? `${rec.durationMs}ms` : null,
        rec.requestId ? `reqId=${redactSensitiveText(rec.requestId, 64)}` : null,
        rec.errorCode ? `err=${redactSensitiveText(rec.errorCode, 80)}` : null,
      ].filter(Boolean);
      return parts.join(' ');
    });

  const diagSummaries = turnDiagnostics.slice(-6).map(diag => {
    const parts = [
      `${diag.action}(${diag.transport || 'meta'})`,
      diag.requestId ? `reqId=${redactSensitiveText(diag.requestId, 64)}` : null,
      diag.sentTargetKind ? `reqTarget=${diag.sentTargetKind}` : null,
      diag.sentReleaseId ? `reqRelease=${redactSensitiveText(diag.sentReleaseId, 48)}` : null,
      diag.sessionTargetKind ? `sessTarget=${diag.sessionTargetKind}` : null,
      diag.turnStatus ? `turnStatus=${redactSensitiveText(diag.turnStatus, 40)}` : null,
      diag.turnErrorCode ? `turnErr=${redactSensitiveText(diag.turnErrorCode, 80)}` : null,
    ].filter(Boolean);
    return parts.join(' ');
  });

  const merged = [...recordSummaries, ...diagSummaries];
  return merged.length > 0 ? merged.join('; ') : '无相关 Context API 记录';
}

export function classifyDraftTurnState({
  dom,
  baseline = { userCount: 0, assistantCount: 0, assistantTexts: [] },
  question = DRAFT_DEBUG_QUESTION,
  expectedAssets = [],
  turnDiagnostics = [],
  inflightTurnActions = 0,
}) {
  const userMessages = Array.isArray(dom?.userMessages) ? dom.userMessages : [];
  const assistantMessages = Array.isArray(dom?.assistantMessages) ? dom.assistantMessages : [];
  const newUserMessages = userMessages.slice(baseline.userCount || 0);
  const newAssistants = assistantMessages.slice(baseline.assistantCount || 0);

  const userQuestionRendered = newUserMessages.some(
    msg => String(msg?.text || '').trim() === question || String(msg?.text || '').includes(question)
  );

  const allFindings = turnDiagnostics.flatMap(d => d?.findings || []);
  const domToolErrors = newAssistants.flatMap(m => m?.toolErrors || []);
  const domAlerts = [
    ...(dom?.threadAlerts || []),
    ...newAssistants.flatMap(m => m?.alerts || []),
  ];

  const uiIncompleteAlert = domAlerts.find(
    a => UI_INCOMPLETE_ERROR_RE.test(a?.title || '') || UI_INCOMPLETE_ERROR_RE.test(a?.content || '')
  );
  const otherUiAlert = domAlerts.find(
    a =>
      a !== uiIncompleteAlert &&
      (UI_ERROR_CARD_TITLES_RE.test(String(a?.title || '').trim()) ||
        /不可调试|拦截当前请求|草稿已更新|执行未完成/.test(`${a?.title || ''} ${a?.content || ''}`))
  );

  const gatewayForbiddenEvidence = [
    ...allFindings.map(f => `${f.code || ''} ${f.message || ''}`.trim()),
    ...domAlerts.map(a => `${a?.title || ''} ${a?.content || ''}`.trim()),
    ...domToolErrors.map(e => String(e || '').trim()),
  ]
    .map(item => redactSensitiveText(item, 260))
    .find(text => GATEWAY_DRAFT_FORBIDDEN_RE.test(text));

  const sentToReleaseDiag = turnDiagnostics.find(
    d =>
      (d?.sentReleaseId && d.sentTargetKind !== 'DRAFT') ||
      (Array.isArray(d?.sessionPinnedReleases) &&
        d.sessionPinnedReleases.length > 0 &&
        String(d?.sessionTargetKind || '').toUpperCase() !== 'DRAFT')
  );

  if (sentToReleaseDiag) {
    return {
      state: 'failed',
      failureKind: 'TARGET_MIXED_TO_RELEASE',
      hasUiIncompleteError: Boolean(uiIncompleteAlert),
      hasGatewayDraftForbidden: Boolean(gatewayForbiddenEvidence),
      uiErrorSummary: uiIncompleteAlert
        ? `${uiIncompleteAlert.title || '本轮执行未完成'}（${redactSensitiveText(uiIncompleteAlert.content, 160)}）`
        : '无',
      gatewayForbiddenDetail: gatewayForbiddenEvidence || null,
      reason: `草稿提问实际请求被串到已发布版本（reqTarget=${sentToReleaseDiag.sentTargetKind || '无'}, reqRelease=${redactSensitiveText(sentToReleaseDiag.sentReleaseId || sentToReleaseDiag.sessionPinnedReleases?.join(','), 64)}）`,
    };
  }

  const latestNewAssistant = newAssistants[newAssistants.length - 1] || null;
  const isComposerSending = Boolean(dom?.composerSending);
  const hasWaitHint = Boolean(dom?.waitHintText);
  const isAssistantStreaming = Boolean(
    latestNewAssistant &&
      (latestNewAssistant.pending ||
        latestNewAssistant.runningIndicator ||
        latestNewAssistant.flowRunning ||
        STREAMING_PLACEHOLDER_RE.test(String(latestNewAssistant.cleanText || '').trim()))
  );

  const backendFailedDiag = turnDiagnostics.find(
    d =>
      String(d?.turnStatus || '').toUpperCase() === 'FAILED' ||
      (d?.findings || []).some(
        f => f.source.endsWith('.failed') || f.source.endsWith('.topError')
      )
  );

  // 若页面或执行端已出现明确终态错误卡片且不再处于发送流式，立即判定终态失败
  if (
    !isComposerSending &&
    !isAssistantStreaming &&
    (uiIncompleteAlert || otherUiAlert || gatewayForbiddenEvidence || backendFailedDiag)
  ) {
    const primaryAlert = uiIncompleteAlert || otherUiAlert;
    const uiErrorSummary = primaryAlert
      ? `title="${redactSensitiveText(primaryAlert.title || '错误提示', 80)}" detail="${redactSensitiveText(primaryAlert.content || '', 180)}"`
      : '页面未展示「本轮执行未完成」错误卡';
    const execSummary = gatewayForbiddenEvidence
      ? `命中 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id（${gatewayForbiddenEvidence}）`
      : allFindings.length > 0
        ? `未命中 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id，执行端诊断=${allFindings
            .map(f => `${f.source}:${f.code || '—'}:${f.message || '—'}`)
            .join(' | ')}`
        : `未检出 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id（turnStatus=${backendFailedDiag?.turnStatus || '—'}, turnErrorCode=${backendFailedDiag?.turnErrorCode || '—'}）`;

    return {
      state: 'failed',
      failureKind:
        uiIncompleteAlert && gatewayForbiddenEvidence
          ? 'UI_INCOMPLETE_AND_GATEWAY_DRAFT_FORBIDDEN'
          : gatewayForbiddenEvidence
            ? 'GATEWAY_DRAFT_FORBIDDEN'
            : uiIncompleteAlert
              ? 'UI_TURN_INCOMPLETE'
              : 'TURN_EXECUTION_ERROR',
      hasUiIncompleteError: Boolean(uiIncompleteAlert),
      hasGatewayDraftForbidden: Boolean(gatewayForbiddenEvidence),
      uiErrorSummary,
      executionErrorSummary: execSummary,
      gatewayForbiddenDetail: gatewayForbiddenEvidence || null,
      reason: `[页面错误] ${uiErrorSummary} | [执行端证据] ${execSummary}`,
    };
  }

  // 仍在生成中、流式输出中、等待提示中或轮次请求在途：严禁提前判为通过
  if (
    isComposerSending ||
    hasWaitHint ||
    isAssistantStreaming ||
    inflightTurnActions > 0 ||
    !latestNewAssistant
  ) {
    return {
      state: 'pending',
      userQuestionRendered,
      pendingDetail: [
        isComposerSending ? 'composer=sending' : null,
        hasWaitHint ? `waitHint="${redactSensitiveText(dom.waitHintText, 80)}"` : null,
        isAssistantStreaming ? 'assistant=streaming' : null,
        inflightTurnActions > 0 ? `inflight=${inflightTurnActions}` : null,
        !latestNewAssistant ? 'waitingNewAssistantBubble' : null,
      ]
        .filter(Boolean)
        .join(', '),
    };
  }

  const cleanAnswer = String(latestNewAssistant.cleanText || '').trim();
  const artifactText = String(latestNewAssistant.artifactText || '').trim();
  const combinedCandidate = `${cleanAnswer}\n${artifactText}`.trim();

  // 防假阳性 1：绝不把用户自己的原问题回显、欢迎引导词或空文本判为通过
  if (
    !cleanAnswer ||
    cleanAnswer === question ||
    WELCOME_NOISE_RE.test(cleanAnswer) ||
    STREAMING_PLACEHOLDER_RE.test(cleanAnswer)
  ) {
    return {
      state: 'pending',
      userQuestionRendered,
      pendingDetail: `assistantTextNotSettled("${redactSensitiveText(cleanAnswer, 60)}")`,
    };
  }

  // 防假阳性 2：绝不把任意旧助手消息复刻判为通过（索引之外再做签名兜底）
  if (
    Array.isArray(baseline.assistantTexts) &&
    baseline.assistantCount > 0 &&
    newAssistants.length === 0
  ) {
    return {
      state: 'pending',
      userQuestionRendered,
      pendingDetail: 'onlyPreExistingAssistantMessages',
    };
  }

  // 防假阳性 3：兜底失败文案（「本轮回答失败，请稍后重试。」/「已完成本轮查询。」无实质内容）判为失败
  if (FALLBACK_FAILED_ANSWERS_RE.test(cleanAnswer) && !artifactText) {
    return {
      state: 'failed',
      failureKind: 'FALLBACK_EMPTY_OR_FAILED_ANSWER',
      hasUiIncompleteError: false,
      hasGatewayDraftForbidden: Boolean(gatewayForbiddenEvidence),
      uiErrorSummary: `助手仅返回兜底文案「${redactSensitiveText(cleanAnswer, 120)}」（非「本轮执行未完成」卡片）`,
      executionErrorSummary:
        gatewayForbiddenEvidence ||
        '未检出 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id',
      gatewayForbiddenDetail: gatewayForbiddenEvidence || null,
      reason: `[页面表现] 助手仅返回兜底文案「${redactSensitiveText(cleanAnswer, 120)}」 | [执行端证据] ${
        gatewayForbiddenEvidence || '无有效业务回答产出'
      }`,
    };
  }

  // 防假阳性 4：工具步骤报错且回答未包含预期合成资产
  const missingAssets = expectedAssets.filter(asset => !combinedCandidate.includes(asset));
  if (missingAssets.length > 0) {
    return {
      state: 'failed',
      failureKind: 'MISSING_EXPECTED_SYNTHETIC_ASSET',
      hasUiIncompleteError: false,
      hasGatewayDraftForbidden: Boolean(gatewayForbiddenEvidence),
      uiErrorSummary: '页面未报「本轮执行未完成」，但回答未命中预期合成资产',
      executionErrorSummary: gatewayForbiddenEvidence
        ? `命中 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id（${gatewayForbiddenEvidence}）`
        : domToolErrors.length > 0
          ? `工具调用异常：${redactSensitiveText(domToolErrors.join(' | '), 200)}`
          : '未命中 Workspace Gateway MCP tools/list FORBIDDEN: draft_version_id',
      gatewayForbiddenDetail: gatewayForbiddenEvidence || null,
      reason: `助手已结束回复但未包含预期合成资产 [${missingAssets.join(', ')}]${
        gatewayForbiddenEvidence ? ` | [执行端证据] ${gatewayForbiddenEvidence}` : ''
      }`,
    };
  }

  return {
    state: 'passed',
    answerText: combinedCandidate,
    matchedAssets: expectedAssets,
  };
}

async function cdpClickRect(page, rect, label = 'target') {
  if (!rect || !(rect.width > 0) || !(rect.height > 0)) {
    throw new Error(`无法执行真实鼠标点击（${label} 不可见或尺寸为 0）`);
  }
  const x = Math.round(rect.x + rect.width / 2);
  const y = Math.round(rect.y + rect.height / 2);
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x,
    y,
    button: 'none',
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  await page.send('Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x,
    y,
    button: 'left',
    clickCount: 1,
  });
  return { x, y };
}

async function cdpTypeInFocusedEditor(page, text) {
  await page.send('Input.insertText', { text });
}

function attachPassiveDraftInspector(page) {
  const state = {
    requestsById: new Map(),
    draftSubmissions: [],
    turnDiagnostics: [],
    latestGetDomain: null,
    latestListDomains: [],
    pendingBodyReads: new Set(),
    inflightTurnReqIds: new Set(),
  };

  const ws = page?.ws;
  if (!ws || typeof ws.addEventListener !== 'function') {
    return {
      state,
      inflightTurnCount: () => 0,
      flush: async () => {},
      detach: () => {},
    };
  }

  const onMessage = ev => {
    let msg;
    try {
      msg = JSON.parse(String(ev.data ?? ev));
    } catch {
      return;
    }
    const { method, params } = msg || {};
    if (method === 'Network.requestWillBeSent') {
      const url = params?.request?.url || '';
      const postData = params?.request?.postData || '';
      const action = extractActionName(url, postData, params?.type);
      if (
        ![
          'GetContextDomain',
          'ListContextDomains',
          'SendContextWorkbenchMessage',
          'GetContextWorkbenchTurn',
        ].includes(action)
      ) {
        return;
      }
      const meta = { action, sentTargetKind: null, sentReleaseId: null, sentDomainId: null };
      if (action === 'SendContextWorkbenchMessage' && postData.trim().startsWith('{')) {
        try {
          const parsed = JSON.parse(postData);
          meta.sentDomainId = parsed.DomainId || null;
          meta.sentTargetKind = parsed.TargetKind || null;
          meta.sentReleaseId = parsed.ReleaseId || null;
        } catch {
          // ignore
        }
      }
      if (action === 'SendContextWorkbenchMessage') state.draftSubmissions.push(meta);
      state.requestsById.set(params.requestId, meta);
      if (action === 'SendContextWorkbenchMessage' || action === 'GetContextWorkbenchTurn') {
        state.inflightTurnReqIds.add(params.requestId);
      }
    } else if (method === 'Network.eventSourceMessageReceived') {
      const reqMeta = state.requestsById.get(params?.requestId);
      if (!reqMeta) return;
      const rawData = String(params?.data || '').trim();
      if (!rawData.startsWith('{')) return;
      try {
        const payload = JSON.parse(rawData);
        if (payload?.type === 'failed' || (payload?.type === 'toolResult' && payload?.ok === false)) {
          state.turnDiagnostics.push({
            action: reqMeta.action,
            transport: 'eventsource',
            turnStatus: payload.type === 'failed' ? 'FAILED' : null,
            findings: [
              {
                source: `eventsource.${payload.type}`,
                code: redactSensitiveText(payload.code || payload.authzDecision || '', 80),
                message: redactSensitiveText(payload.message || payload.output || '', 260),
              },
            ],
          });
        }
      } catch {
        // ignore
      }
    } else if (method === 'Network.loadingFinished') {
      const reqId = params?.requestId;
      const reqMeta = state.requestsById.get(reqId);
      state.inflightTurnReqIds.delete(reqId);
      if (!reqMeta) return;
      const readTask = page
        .send('Network.getResponseBody', { requestId: reqId }, 3000)
        .then(res => {
          if (!res?.body) return;
          const rawBody = res.base64Encoded
            ? Buffer.from(res.body, 'base64').toString('utf8')
            : res.body;
          const diag = extractTurnPayloadDiagnostics(reqMeta.action, rawBody);
          if (!diag) return;
          if (reqMeta.action === 'GetContextDomain' && diag.domain) {
            state.latestGetDomain = diag.domain;
            return;
          }
          if (reqMeta.action === 'ListContextDomains' && diag.domains) {
            state.latestListDomains = diag.domains;
            return;
          }
          state.turnDiagnostics.push({
            ...diag,
            ...(reqMeta.sentDomainId ? { sentDomainId: reqMeta.sentDomainId } : {}),
            ...(reqMeta.sentTargetKind ? { sentTargetKind: reqMeta.sentTargetKind } : {}),
            ...(reqMeta.sentReleaseId ? { sentReleaseId: reqMeta.sentReleaseId } : {}),
          });
        })
        .catch(() => {})
        .finally(() => {
          state.pendingBodyReads.delete(readTask);
        });
      state.pendingBodyReads.add(readTask);
    } else if (method === 'Network.loadingFailed') {
      state.inflightTurnReqIds.delete(params?.requestId);
    }
  };

  ws.addEventListener('message', onMessage);

  return {
    state,
    inflightTurnCount: () => state.inflightTurnReqIds.size,
    flush: async () => {
      await Promise.all([...state.pendingBodyReads]);
      if (typeof page.flushResponseMetadata === 'function') {
        await page.flushResponseMetadata().catch(() => {});
      }
    },
    detach: () => {
      if (typeof ws.removeEventListener === 'function') {
        ws.removeEventListener('message', onMessage);
      }
    },
  };
}

function queryWorkbenchDomSnapshot() {
  const toRect = el => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  };

  const readSelect = label => {
    const el = document.querySelector(`[aria-label="${label}"]`);
    if (!el) return { found: false, value: '', placeholder: '', disabled: false };
    const root = el.closest('.arco-select') || el;
    const valNode = root.querySelector('.arco-select-view-value');
    const phNode = root.querySelector('.arco-select-view-placeholder');
    const disabled =
      root.classList.contains('arco-select-disabled') ||
      el.getAttribute('aria-disabled') === 'true' ||
      Boolean(el.disabled);
    return {
      found: true,
      value: valNode ? (valNode.textContent || '').trim() : '',
      placeholder: phNode ? (phNode.textContent || '').trim() : '',
      disabled,
    };
  };

  const chatRoot = document.querySelector('.context-workbench-chatkit') || document.body;
  const editorEl =
    document.querySelector('[data-chatkit-composer-rich-text-area] [contenteditable="true"]') ||
    document.querySelector('.chatkit-composer-rich-text-area [contenteditable="true"]') ||
    document.querySelector('.context-workbench-chatkit textarea');
  const editorDisabled =
    !editorEl ||
    editorEl.getAttribute('contenteditable') === 'false' ||
    editorEl.getAttribute('aria-disabled') === 'true' ||
    Boolean(editorEl.disabled);
  const editorText = editorEl
    ? ('value' in editorEl ? editorEl.value || '' : editorEl.innerText || '').replace(/\u200b/g, '').trim()
    : '';

  const sendBtn = document.querySelector('button[data-chatkit-composer-send-button]');
  const sendAria = sendBtn ? sendBtn.getAttribute('aria-label') || '' : '';
  const composerSending = Boolean(
    sendBtn && (sendBtn.getAttribute('data-sending') === 'true' || sendAria === 'stop')
  );

  const waitHintNode = chatRoot.querySelector('[role="status"]');
  const waitHintText = waitHintNode ? (waitHintNode.innerText || '').trim() : '';

  const extractAlerts = scopeEl =>
    Array.from(scopeEl.querySelectorAll('.arco-alert')).map(alertEl => {
      const titleEl = alertEl.querySelector('.arco-alert-title');
      const contentEl = alertEl.querySelector('.arco-alert-content');
      return {
        title: titleEl ? (titleEl.textContent || '').trim() : '',
        content: contentEl ? (contentEl.textContent || '').trim() : (alertEl.innerText || '').trim(),
      };
    });

  const toasts = Array.from(
    document.querySelectorAll('.arco-message, .arco-notification')
  ).map(el => (el.innerText || '').trim());

  const userMessages = Array.from(chatRoot.querySelectorAll('[data-role="user"]')).map(node => ({
    text: (node.innerText || '').trim(),
  }));

  const assistantMessages = Array.from(chatRoot.querySelectorAll('[data-role="assistant"]')).map(
    node => {
      const alerts = extractAlerts(node);
      const toolErrors = Array.from(
        node.querySelectorAll('[data-flow-step="tool-call"][data-flow-error="true"], [data-tone="error"]')
      ).map(el => (el.innerText || '').trim());

      const collectVisibleAnswerText = root => {
        const chunks = [];
        const walk = current => {
          if (!current) return;
          if (current.nodeType === 3) {
            const val = (current.nodeValue || '').replace(/\u200b/g, '');
            if (val.trim()) chunks.push(val.trim());
            return;
          }
          if (current.nodeType !== 1) return;
          const el = current;
          if (
            el.matches(
              '[data-chatkit-answer-pending], .chatkit-running-indicator, [data-flow-el="run-status"], [data-flow-step], .arco-alert, [class*="artifactWrap"], [aria-hidden="true"]'
            )
          ) {
            return;
          }
          const style = window.getComputedStyle(el);
          if (style.display === 'none' || style.visibility === 'hidden') return;
          for (const child of el.childNodes) walk(child);
        };
        walk(node);
        return chunks.join(' ').replace(/\s+/g, ' ').trim();
      };

      const artifactNodes = Array.from(
        node.querySelectorAll('.arco-table, [class*="artifactWrap"], [class*="sourceGroup"]')
      );
      const artifactText = artifactNodes.map(el => (el.innerText || '').trim()).join('\n');

      const runStatusEl = node.querySelector('[data-flow-el="run-status"]');
      const runState = runStatusEl ? runStatusEl.getAttribute('data-run-state') || '' : '';
      const turnPhase = runStatusEl ? runStatusEl.getAttribute('data-turn-phase') || '' : '';

      return {
        cleanText: collectVisibleAnswerText(node),
        artifactText,
        alerts,
        toolErrors,
        pending: Boolean(
          node.querySelector('[data-chatkit-answer-pending]') ||
            node.getAttribute('data-chatkit-compact-loading') === 'true'
        ),
        runningIndicator: Boolean(node.querySelector('.chatkit-running-indicator')),
        flowRunning:
          Boolean(node.querySelector('[data-flow-running="true"], [data-flow-state="running"]')) ||
          /^(running|starting|streaming|attaching)$/i.test(runState) ||
          /^(running|starting|streaming)$/i.test(turnPhase),
      };
    }
  );

  // 顶层（非 assistant 气泡内）的横幅告警，例如草稿已更新 / 草稿不可调试
  const threadAlerts = Array.from(
    document.querySelectorAll('.context-workbench-chatkit .arco-alert, main .arco-alert')
  )
    .filter(el => !el.closest('[data-role="assistant"]'))
    .map(alertEl => {
      const titleEl = alertEl.querySelector('.arco-alert-title');
      const contentEl = alertEl.querySelector('.arco-alert-content');
      return {
        title: titleEl ? (titleEl.textContent || '').trim() : '',
        content: contentEl ? (contentEl.textContent || '').trim() : (alertEl.innerText || '').trim(),
      };
    });

  return {
    href: window.location.href,
    domainPicker: readSelect('业务领域与版本'),
    modelPicker: readSelect('模型'),
    composer: {
      found: Boolean(editorEl),
      disabled: editorDisabled,
      text: editorText,
      rect: toRect(editorEl),
      focused: Boolean(editorEl && (document.activeElement === editorEl || editorEl.contains(document.activeElement))),
    },
    sendButton: {
      found: Boolean(sendBtn),
      disabled: Boolean(!sendBtn || sendBtn.disabled),
      ariaLabel: sendAria,
      rect: toRect(sendBtn),
    },
    composerSending,
    waitHintText,
    threadAlerts,
    toasts,
    userMessages,
    assistantMessages,
  };
}

export async function run(t, page, cfg = {}) {
  const journeyStartMs = Date.now();
  const fixture = resolveDraftDebugFixture(cfg, cfg.env ?? process.env);
  const remainingMs = (floorMs = 1_000) =>
    Math.max(floorMs, fixture.maxBudgetMs - (Date.now() - journeyStartMs));
  const budgetExhausted = () => Date.now() - journeyStartMs >= fixture.maxBudgetMs;

  if (!cfg.workspaceId || cfg.workspaceId === cfg.forbiddenWorkspaceId) {
    const reason = `工作区配置非法或命中禁区 (${redactSensitiveText(cfg.workspaceId || '空', 64)})`;
    t.block(STAGE_TITLES.entry, reason);
    t.block(STAGE_TITLES.workbenchLock, reason);
    t.block(STAGE_TITLES.queryAnswer, reason);
    return;
  }

  if (fixture.explicitDomainName && !isSyntheticDomainName(fixture.explicitDomainName)) {
    const reason = `拒绝访问非合成测试领域：CONTEXT_E2E_DRAFT_DOMAIN_NAME 必须以 ${SYNTHETIC_DOMAIN_PREFIX} 开头（当前="${redactSensitiveText(fixture.explicitDomainName, 80)}"）`;
    t.block(STAGE_TITLES.entry, reason);
    t.block(STAGE_TITLES.workbenchLock, reason);
    t.block(STAGE_TITLES.queryAnswer, reason);
    return;
  }

  const inspector = attachPassiveDraftInspector(page);
  let resolvedDomainId = fixture.explicitDomainId;
  let resolvedDomainName = fixture.explicitDomainName;
  let draftDebugButtonRect = null;
  let releaseVersions = [];
  let stage1Outcome = 'NOT_RUN';
  let stage2Outcome = 'NOT_RUN';
  let stage2FailureReason = '';
  let submittedOnce = false;

  try {
    // 若未显式传入 CONTEXT_E2E_DRAFT_DOMAIN_ID，在只读模式下尝试从 /context/domains 发现可只读验证的 codex-e2e-* 待发布草稿领域
    if (!resolvedDomainId) {
      const discoverStep = '08-discover-synthetic-draft';
      const listNav = await page.gotoContext('/context/domains', {
        stepName: discoverStep,
        timeoutMs: Math.min(18_000, remainingMs()),
        readyFn: () => {
          const txt = document.body?.innerText || '';
          return /业务领域|创建业务领域|暂无业务领域/.test(txt) ? txt.slice(0, 200) : false;
        },
      });
      const listOracle = await page.collectStepOracle(discoverStep);
      if (listOracle.forbiddenWorkspaceHit || !listOracle.urlWorkspaceOk) {
        const reason = `业务领域列表工作区校验异常 (${redactSensitiveText(listOracle.href, 180)})`;
        t.block(STAGE_TITLES.entry, reason);
        t.block(STAGE_TITLES.workbenchLock, reason);
        t.block(STAGE_TITLES.queryAnswer, reason);
        return;
      }
      if (!listNav.settledOk) {
        const reason = `业务领域列表首屏未就绪 (${listNav.firstContentMs}ms)，无法只读定位合成草稿领域`;
        t.block(STAGE_TITLES.entry, reason);
        t.block(STAGE_TITLES.workbenchLock, reason);
        t.block(STAGE_TITLES.queryAnswer, reason);
        return;
      }

      const candidate = await page.evalJSON(`(() => {
        const expectedName = ${JSON.stringify(resolvedDomainName || '')};
        const cards = Array.from(document.querySelectorAll('[class*="card"]')).filter(el => {
          const r = el.getBoundingClientRect();
          return r.width > 120 && r.height > 80;
        });
        for (const card of cards) {
          const lines = (card.innerText || '').split(/\\n+/).map(s => s.trim()).filter(Boolean);
          const nameLine = lines.find(line => line.startsWith('codex-e2e-'));
          if (!nameLine) continue;
          if (expectedName && nameLine !== expectedName) continue;
          const cardText = card.innerText || '';
          const hasDraftBadge = /未发布|待发布|有待发布修改/.test(cardText);
          if (!expectedName && !hasDraftBadge) continue;
          const titleNode = Array.from(card.querySelectorAll('*')).find(
            n => n.children.length === 0 && (n.textContent || '').trim() === nameLine
          ) || card;
          const rect = titleNode.getBoundingClientRect();
          if (rect.width > 0 && rect.height > 0) {
            return {
              name: nameLine,
              rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
            };
          }
        }
        return null;
      })()`);

      if (!candidate) {
        const missingReason = resolvedDomainName
          ? `未在当前工作区业务领域列表找到合成领域「${resolvedDomainName}」（建议同时显式配置 CONTEXT_E2E_DRAFT_DOMAIN_ID）`
          : '未显式配置 CONTEXT_E2E_DRAFT_DOMAIN_ID / CONTEXT_E2E_DRAFT_DOMAIN_NAME，且当前工作区未发现带草稿状态的 codex-e2e-* 合成领域';
        t.block(STAGE_TITLES.entry, missingReason);
        t.block(STAGE_TITLES.workbenchLock, missingReason);
        const sendGate = evaluateSendGate(fixture, { workbenchLockedSameDraft: false });
        t.block(STAGE_TITLES.queryAnswer, sendGate.reason);
        return;
      }

      await cdpClickRect(page, candidate.rect, `合成领域卡片 ${candidate.name}`);
      const enteredDetail = await page.waitFor(
        () => {
          const m = window.location.pathname.match(/\/context\/domains\/([^/?#]+)\/detail/);
          return m ? decodeURIComponent(m[1]) : false;
        },
        { timeoutMs: Math.min(12_000, remainingMs()), intervalMs: 200 }
      );
      if (!enteredDetail.ok || !enteredDetail.value) {
        const reason = `点击合成领域卡片「${candidate.name}」后未进入领域详情路由`;
        t.block(STAGE_TITLES.entry, reason);
        t.block(STAGE_TITLES.workbenchLock, reason);
        t.block(STAGE_TITLES.queryAnswer, evaluateSendGate(fixture, { workbenchLockedSameDraft: false }).reason);
        return;
      }
      resolvedDomainId = String(enteredDetail.value);
      resolvedDomainName = candidate.name;
    }

    // ==================== 阶段一：领域详情 -> 版本与记录 -> 独立草稿行「调试」按钮（只读） ====================
    await t.check(STAGE_TITLES.entry, async () => {
      const step = '08-domain-versions-draft-row';
      const detailSubpath = `/context/domains/${encodeURIComponent(resolvedDomainId)}/detail`;
      const currentHref = await page.evalJSON(() => window.location.href);
      if (!currentHref.includes(detailSubpath)) {
        const nav = await page.gotoContext(detailSubpath, {
          stepName: step,
          timeoutMs: Math.min(20_000, remainingMs()),
          readyFn: () => {
            const txt = document.body?.innerText || '';
            if (/业务领域不存在或已删除/.test(txt)) return 'NOT_FOUND';
            const headerEl = document.querySelector(
              '.c-m-detail-header-title, [class*="detail-header-title"], h1'
            );
            const title = headerEl ? (headerEl.textContent || '').trim() : '';
            return title && title !== '—' && /版本与记录|工具配置/.test(txt) ? title : false;
          },
        });
        if (!nav.settledOk) {
          throw new Error(`领域详情 (${resolvedDomainId}) 首屏加载超时 (${nav.firstContentMs}ms)`);
        }
      } else {
        page.setStep(step);
        await page.waitFor(
          () => {
            const txt = document.body?.innerText || '';
            if (/业务领域不存在或已删除/.test(txt)) return 'NOT_FOUND';
            const headerEl = document.querySelector(
              '.c-m-detail-header-title, [class*="detail-header-title"], h1'
            );
            const title = headerEl ? (headerEl.textContent || '').trim() : '';
            return title && title !== '—' && /版本与记录|工具配置/.test(txt) ? title : false;
          },
          { timeoutMs: Math.min(15_000, remainingMs()), intervalMs: 250 }
        );
      }

      const oracle = await page.collectStepOracle(step);
      if (oracle.forbiddenWorkspaceHit) {
        throw new Error(`严重越界：领域详情跳入禁区工作区 ${cfg.forbiddenWorkspaceId}`);
      }
      if (!oracle.urlWorkspaceOk || oracle.urlProjectOk === false) {
        throw new Error(`领域详情丢失 workspaceId 或 project (${redactSensitiveText(oracle.href, 200)})`);
      }
      if (oracle.pageErrors.length > 0) {
        throw new Error(`领域详情抛未捕获异常: ${redactSensitiveText(oracle.pageErrors[0].text, 200)}`);
      }

      const detailHeader = await page.evalJSON(() => {
        const txt = document.body?.innerText || '';
        const notFound = /业务领域不存在或已删除/.test(txt);
        const titleEl = document.querySelector(
          '.c-m-detail-header-title, [class*="detail-header-title"], h1'
        );
        const title = titleEl ? (titleEl.textContent || '').trim() : '';
        const verTab = Array.from(
          document.querySelectorAll('[role="tab"], .arco-tabs-header-title')
        ).find(node => (node.textContent || '').trim() === '版本与记录');
        const rect = verTab ? verTab.getBoundingClientRect() : null;
        return {
          notFound,
          title,
          versionsTabRect: rect
            ? { x: rect.x, y: rect.y, width: rect.width, height: rect.height }
            : null,
        };
      });

      if (detailHeader.notFound) {
        t.block(
          STAGE_TITLES.entry,
          `指定合成测试领域不存在或已删除 (domainId=${resolvedDomainId})`
        );
        stage1Outcome = 'BLOCKED';
        return;
      }

      const actualTitle = detailHeader.title || inspector.state.latestGetDomain?.name || '';
      if (!isSyntheticDomainName(actualTitle)) {
        t.block(
          STAGE_TITLES.entry,
          `目标领域名称「${redactSensitiveText(actualTitle || '未知', 80)}」不以 ${SYNTHETIC_DOMAIN_PREFIX} 开头，拒绝在非合成领域执行草稿调试`
        );
        stage1Outcome = 'BLOCKED';
        return;
      }
      if (resolvedDomainName && actualTitle !== resolvedDomainName) {
        throw new Error(
          `领域详情标题与预期合成领域不一致：期望「${resolvedDomainName}」，实际「${actualTitle}」`
        );
      }
      resolvedDomainName = actualTitle;

      if (!detailHeader.versionsTabRect) {
        throw new Error(`领域「${resolvedDomainName}」详情页未渲染「版本与记录」页签`);
      }

      // 真实鼠标点击「版本与记录」页签
      await cdpClickRect(page, detailHeader.versionsTabRect, '版本与记录页签');

      const versionsReady = await page.waitFor(
        () => {
          const activePane =
            document.querySelector('.arco-tabs-content-item-active') || document.body;
          if (!/领域版本/.test(activePane.innerText || '')) return false;
          const spinning = activePane.querySelector('.arco-spin-loading, .arco-table-spin .arco-spin-icon');
          if (spinning) return false;
          const rows = Array.from(activePane.querySelectorAll('.arco-table tbody tr')).filter(
            tr => tr.getBoundingClientRect().height > 0
          );
          if (rows.length === 0 && !/尚无发布版本|无法加载发布版本/.test(activePane.innerText || '')) {
            return false;
          }
          return true;
        },
        { timeoutMs: Math.min(15_000, remainingMs()), intervalMs: 250 }
      );

      if (!versionsReady.ok) {
        throw new Error(`切换「版本与记录」后领域版本表格加载超时`);
      }

      const tableInspection = await page.evalJSON(() => {
        const activePane =
          document.querySelector('.arco-tabs-content-item-active') || document.body;
        const rows = Array.from(activePane.querySelectorAll('.arco-table tbody tr')).filter(
          tr => tr.getBoundingClientRect().height > 0
        );
        const parsedRows = rows.map((tr, idx) => {
          const cells = Array.from(tr.querySelectorAll('td')).map(td =>
            (td.innerText || td.textContent || '').trim()
          );
          const buttons = Array.from(tr.querySelectorAll('button')).map(btn => {
            const r = btn.getBoundingClientRect();
            return {
              text: (btn.innerText || btn.textContent || '').trim(),
              disabled: Boolean(btn.disabled) || btn.getAttribute('aria-disabled') === 'true',
              rect: { x: r.x, y: r.y, width: r.width, height: r.height },
            };
          });
          return { idx, cells, buttons };
        });

        const draftRow = parsedRows.find(
          r =>
            r.cells[0] === '草稿' &&
            /待发布/.test(r.cells[2] || '') &&
            !/当前发布|历史版本/.test(r.cells[2] || '')
        );
        const releases = parsedRows
          .filter(r => r !== draftRow && r.cells[0] && r.cells[0] !== '草稿')
          .map(r => r.cells[0]);

        return {
          loadError: /无法加载发布版本/.test(activePane.innerText || ''),
          rowCount: parsedRows.length,
          draftRow: draftRow || null,
          releaseVersions: releases,
        };
      });

      releaseVersions = tableInspection.releaseVersions || [];

      if (!tableInspection.draftRow) {
        const diag = inspector.state.latestGetDomain;
        throw new Error(
          `领域「${resolvedDomainName}」(${resolvedDomainId}) 的「版本与记录」不存在独立草稿行（rowCount=${tableInspection.rowCount}, releases=[${releaseVersions.join(', ')}]${
            diag
              ? `, HasDraftChanges=${diag.hasDraftChanges}, DraftRevision=${diag.draftRevision}`
              : ''
          }）`
        );
      }

      const debugBtn = tableInspection.draftRow.buttons.find(b => b.text === '调试');
      if (!debugBtn || debugBtn.disabled || !(debugBtn.rect.width > 0 && debugBtn.rect.height > 0)) {
        const diag = inspector.state.latestGetDomain;
        throw new Error(
          `独立草稿行已展示（状态="${tableInspection.draftRow.cells[2]}"），但未暴露可点击的「调试」按钮（buttons=[${tableInspection.draftRow.buttons
            .map(b => `${b.text}${b.disabled ? '(disabled)' : ''}`)
            .join(', ')}]${
            diag
              ? `, CanPreviewDraft=${diag.canPreviewDraft}, DraftRevision=${diag.draftRevision}`
              : ''
          }）`
        );
      }

      draftDebugButtonRect = debugBtn.rect;
      stage1Outcome = 'PASS';
      await inspector.flush();
      return `domain=${resolvedDomainName}(${resolvedDomainId}), draftRowIndex=${tableInspection.draftRow.idx}, releases=[${releaseVersions.join(', ') || '无'}], apiEvidence=[${formatSanitizedApiEvidence(page.stepRecords(step), [])}]`;
    });

    if (stage1Outcome !== 'PASS') {
      if (stage1Outcome !== 'BLOCKED') stage1Outcome = 'FAIL';
      const skipReason =
        stage1Outcome === 'BLOCKED'
          ? '前置合成领域草稿入口处于 BLOCKED，跳过后续工作台跳转与提问'
          : '阶段一未定位到可用独立草稿行「调试」按钮，无法继续阶段二/三';
      t.block(STAGE_TITLES.workbenchLock, skipReason);
      const gate = evaluateSendGate(fixture, {
        workbenchLockedSameDraft: false,
        workbenchFailureReason: skipReason,
      });
      t.block(STAGE_TITLES.queryAnswer, gate.reason);
      return;
    }

    // ==================== 阶段二：真实点击草稿行「调试」进入工作台并核验同一草稿锁定（只读） ====================
    await t.check(STAGE_TITLES.workbenchLock, async () => {
      if (budgetExhausted()) {
        throw new Error(`进入阶段二前已超出 ${fixture.maxBudgetMs}ms 总预算`);
      }
      const step = '08-workbench-draft-lock';
      page.setStep(step);
      const navStart = Date.now();

      await cdpClickRect(page, draftDebugButtonRect, '独立草稿行「调试」按钮');

      const settled = await page.waitFor(
        () => {
          if (!/\/context\/workbench\/?$/.test(window.location.pathname)) return false;
          const domainEl = document.querySelector('[aria-label="业务领域与版本"]');
          const modelEl = document.querySelector('[aria-label="模型"]');
          const domainRoot = domainEl ? domainEl.closest('.arco-select') || domainEl : null;
          const modelRoot = modelEl ? modelEl.closest('.arco-select') || modelEl : null;
          const domainLoading =
            !domainRoot || /加载领域/.test((domainRoot.textContent || '').trim());
          const modelLoading =
            !modelRoot || /加载模型/.test((modelRoot.textContent || '').trim());
          if (domainLoading || modelLoading) return false;
          const hasChatkit = Boolean(document.querySelector('.context-workbench-chatkit'));
          return hasChatkit ? true : false;
        },
        { timeoutMs: Math.min(25_000, remainingMs()), intervalMs: 250 }
      );

      await page.sleep(250);
      const oracle = await page.collectStepOracle(step);
      await inspector.flush();

      if (oracle.pageErrors.length > 0) {
        throw new Error(`工作台调试台抛未捕获异常: ${redactSensitiveText(oracle.pageErrors[0].text, 200)}`);
      }
      if (!settled.ok) {
        throw new Error(
          `点击草稿「调试」后 ${Date.now() - navStart}ms 内工作台调试台未完成领域/模型就绪 (href=${redactSensitiveText(oracle.href, 200)})`
        );
      }

      const domSnap = await page.evalJSON(queryWorkbenchDomSnapshot);
      const listMatch = inspector.state.latestListDomains.find(
        d => d.domainId === resolvedDomainId
      );

      const checkResult = verifyWorkbenchDraftBinding({
        href: domSnap.href,
        expectedWorkspaceId: cfg.workspaceId,
        forbiddenWorkspaceId: cfg.forbiddenWorkspaceId,
        expectedProject: cfg.projectName,
        expectedDomainId: resolvedDomainId,
        expectedDomainName: resolvedDomainName,
        domainPicker: domSnap.domainPicker,
        modelPicker: domSnap.modelPicker,
        composer: domSnap.composer,
        alerts: domSnap.threadAlerts.map(a => `${a.title} ${a.content}`.trim()),
        toasts: domSnap.toasts,
        releaseVersions,
        apiDomainDiagnostics: {
          detailDomain: inspector.state.latestGetDomain,
          listDomain: listMatch || null,
        },
      });

      if (!checkResult.ok) {
        stage2FailureReason = checkResult.reason;
        throw new Error(
          `${checkResult.reason} | elapsed=${Date.now() - navStart}ms | apiEvidence=[${formatSanitizedApiEvidence(oracle.records, [])}]`
        );
      }

      stage2Outcome = 'PASS';
      return `locked="${checkResult.selectedLabel}", draftDomainId=${resolvedDomainId}, model=${checkResult.modelId}, settleMs=${Date.now() - navStart}ms, apiEvidence=[${formatSanitizedApiEvidence(oracle.records, [])}]`;
    });

    if (stage2Outcome !== 'PASS') {
      stage2Outcome = 'FAIL';
    }

    // ==================== 阶段三：门禁校验后在真实编辑器单次提交「你有哪些数据」并核验草稿回答 ====================
    const sendGate = evaluateSendGate(fixture, {
      workspaceValid: Boolean(cfg.workspaceId && cfg.workspaceId !== cfg.forbiddenWorkspaceId),
      resolvedDomainId,
      resolvedDomainName,
      workbenchLockedSameDraft: stage2Outcome === 'PASS',
      workbenchFailureReason:
        stage2Outcome !== 'PASS'
          ? `工作台未成功锁定同一具体草稿（${stage2FailureReason || '阶段二断言未通过'}），禁止向非预期目标发送消息创建会话`
          : undefined,
    });

    if (!sendGate.allowed) {
      t.block(STAGE_TITLES.queryAnswer, sendGate.reason);
      return;
    }

    await t.check(STAGE_TITLES.queryAnswer, async () => {
      if (submittedOnce) {
        throw new Error('检测到重复发送重入，已拦截以避免重复创建测试会话');
      }
      if (budgetExhausted()) {
        throw new Error(`进入提问发送阶段前已耗尽 ${fixture.maxBudgetMs}ms 预算`);
      }

      const step = '08-draft-query-answer';
      page.setStep(step);

      const preSendSnap = await page.evalJSON(queryWorkbenchDomSnapshot);
      const preSendCheck = verifyWorkbenchDraftBinding({
        href: preSendSnap.href,
        expectedWorkspaceId: cfg.workspaceId,
        forbiddenWorkspaceId: cfg.forbiddenWorkspaceId,
        expectedProject: cfg.projectName,
        expectedDomainId: resolvedDomainId,
        expectedDomainName: resolvedDomainName,
        domainPicker: preSendSnap.domainPicker,
        modelPicker: preSendSnap.modelPicker,
        composer: preSendSnap.composer,
        alerts: preSendSnap.threadAlerts.map(a => `${a.title} ${a.content}`.trim()),
        toasts: preSendSnap.toasts,
        releaseVersions,
      });
      if (!preSendCheck.ok) {
        throw new Error(`提交提问前工作台草稿锁定状态失效：${preSendCheck.reason}`);
      }

      const baseline = {
        userCount: preSendSnap.userMessages.length,
        assistantCount: preSendSnap.assistantMessages.length,
        assistantTexts: preSendSnap.assistantMessages.map(m => m.cleanText),
      };

      // 1. 真实鼠标点击聚焦 ChatKit 实际富文本编辑器
      await cdpClickRect(page, preSendSnap.composer.rect, '工作台对话输入框');
      await page.sleep(80);

      // 2. 通过 CDP Input 输入原问题「你有哪些数据」
      await cdpTypeInFocusedEditor(page, fixture.question);
      await page.sleep(120);

      let typedSnap = await page.evalJSON(queryWorkbenchDomSnapshot);
      if (typedSnap.composer.text !== fixture.question) {
        // 仅当未写入任何字符时用逐字符 keyEvent 补齐一次（仍未发送，不触发会话创建）
        if (!typedSnap.composer.text) {
          for (const ch of fixture.question) {
            await page.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
          }
          await page.sleep(120);
          typedSnap = await page.evalJSON(queryWorkbenchDomSnapshot);
        }
      }

      if (typedSnap.composer.text !== fixture.question) {
        throw new Error(
          `实际编辑器输入校验失败：期望输入「${fixture.question}」，实际编辑器文本="${redactSensitiveText(typedSnap.composer.text, 80)}"`
        );
      }
      if (
        !typedSnap.sendButton.found ||
        typedSnap.sendButton.disabled ||
        typedSnap.sendButton.ariaLabel === 'stop'
      ) {
        throw new Error(
          `输入「${fixture.question}」后发送按钮不可点击（found=${typedSnap.sendButton.found}, disabled=${typedSnap.sendButton.disabled}, aria="${typedSnap.sendButton.ariaLabel}"）`
        );
      }

      // 3. 单次提交锁：严格只点击一次发送按钮，绝不重试或二次回车
      submittedOnce = true;
      const turnStartMs = Date.now();
      await cdpClickRect(page, typedSnap.sendButton.rect, '工作台发送按钮');

      // 4. 在剩余预算（总预算 <= 120s）内轮询等待稳定助手回答或明确终态错误
      let stablePassCandidate = null;
      let lastPendingDetail = '刚提交提问';
      const pollIntervalMs = 350;

      while (!budgetExhausted()) {
        await page.sleep(Math.min(pollIntervalMs, remainingMs(50)));
        await inspector.flush();
        const liveSnap = await page.evalJSON(queryWorkbenchDomSnapshot);
        const verdict = classifyDraftTurnState({
          dom: liveSnap,
          baseline,
          question: fixture.question,
          expectedAssets: fixture.expectedAssets,
          turnDiagnostics: inspector.state.turnDiagnostics,
          inflightTurnActions: inspector.inflightTurnCount(),
        });

        if (verdict.state === 'failed') {
          const turnElapsedMs = Date.now() - turnStartMs;
          const totalElapsedMs = Date.now() - journeyStartMs;
          const oracle = await page.collectStepOracle(step);
          const apiEv = formatSanitizedApiEvidence(oracle.records, inspector.state.turnDiagnostics);
          throw new Error(
            `同一草稿「${resolvedDomainName}」(${resolvedDomainId}) 具备「调试」入口且工作台已锁定草稿，但提交「${fixture.question}」后无法产出合格回答：${verdict.reason} | turnElapsed=${turnElapsedMs}ms, journeyElapsed=${totalElapsedMs}ms | apiEvidence=[${apiEv}]`
          );
        }

        if (verdict.state === 'passed') {
          // 要求连续两次采样文本一致，确保打字机动画与参考来源块完全落定
          if (stablePassCandidate && stablePassCandidate.answerText === verdict.answerText) {
            const turnElapsedMs = Date.now() - turnStartMs;
            const totalElapsedMs = Date.now() - journeyStartMs;
            const oracle = await page.collectStepOracle(step);
            if (oracle.forbiddenWorkspaceHit || !oracle.urlWorkspaceOk) {
              throw new Error(`草稿问答期间工作区参数异常 (${redactSensitiveText(oracle.href, 180)})`);
            }
            if (oracle.pageErrors.length > 0) {
              throw new Error(
                `草稿问答期间页面未捕获异常: ${redactSensitiveText(oracle.pageErrors[0].text, 200)}`
              );
            }
            const submissions = inspector.state.draftSubmissions;
            if (!submissions.length || submissions.some(item =>
              item.sentDomainId !== resolvedDomainId ||
              item.sentTargetKind !== 'DRAFT' ||
              item.sentReleaseId
            )) {
              throw new Error('未能确认本轮发送请求确实指向同一领域的草稿');
            }
            const apiEv = formatSanitizedApiEvidence(
              oracle.records,
              inspector.state.turnDiagnostics
            );
            return `草稿「${resolvedDomainName}」(${resolvedDomainId}) 真实回答通过，命中合成资产=[${verdict.matchedAssets.join(', ')}]，turnElapsed=${turnElapsedMs}ms，journeyElapsed=${totalElapsedMs}ms，apiEvidence=[${apiEv}]`;
          }
          stablePassCandidate = verdict;
          continue;
        }

        stablePassCandidate = null;
        lastPendingDetail = verdict.pendingDetail || '等待中';
      }

      // 预算耗尽仍未到达终态
      await inspector.flush();
      const timeoutOracle = await page.collectStepOracle(step);
      const timeoutApiEv = formatSanitizedApiEvidence(
        timeoutOracle.records,
        inspector.state.turnDiagnostics
      );
      throw new Error(
        `草稿「${resolvedDomainName}」(${resolvedDomainId}) 提交「${fixture.question}」在最大预算 ${fixture.maxBudgetMs}ms 内未完成有效回答（lastState=${lastPendingDetail}，未把生成中状态或用户原问题误判为通过） | turnElapsed=${Date.now() - turnStartMs}ms, journeyElapsed=${Date.now() - journeyStartMs}ms | apiEvidence=[${timeoutApiEv}]`
      );
    });
  } finally {
    inspector.detach();
  }
}
