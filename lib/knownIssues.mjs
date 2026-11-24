// 已知未修复缺陷登记表（对标 hermes-agent e2e/core/known.ts）。
// 规则：
// 1. 已确认但尚未合入修复的真实缺陷在此登记；用例保留正确的最终业务断言。
// 2. 运行时若命中已登记缺陷，记为 KNOWN_BUG（输出实时证据与 RequestId，不中断后续模块回归）。
// 3. 一旦代码修复部署后断言自动通过，运行器会高亮提示 FIXED_CANDIDATE，提醒从本表移除、转正为硬阻断门禁！
// 4. 任何未在此表登记的断言失败一律判为 REGRESSION_FAIL（返回非 0 退出码阻断交付）。

export const KNOWN_ISSUES = {
  'CTX-001': {
    severity: 'P0',
    module: '06-mcp-services',
    summary: 'MCP 管理页对缺失 CreatedAt/ServiceId 调用 localeCompare 抛 TypeError 导致列表加载失败',
  },
  'CTX-002': {
    severity: 'P1',
    module: '05-processing-eval',
    summary: '禁用的双轮评测仍渲染 0% 命中率数值',
  },
  'CTX-003': {
    severity: 'P0',
    module: '02-catalog-explorer',
    summary: 'PG 多表发现未续读 NextToken，126 张表截断为 100 张',
  },
  'CTX-006': {
    severity: 'P0',
    module: '01-navigation-scope',
    summary: '旧连接详情路由 /context/connections/:Id/detail 无法自动跳转，且错误页点击返回丢失 workspaceId',
  },
  'CTX-007': {
    severity: 'P2',
    module: '03-asset-detail-lineage',
    summary: '零值或空 UpdatedAt 被格式化展示为 1970-01-01 08:00:00',
  },
  'CTX-011': {
    severity: 'P1',
    module: '05-processing-eval',
    summary: '提案引用来源将 Markdown 误标为「数据表」且缺少原资产跳转链接',
  },
  'CTX-012': {
    severity: 'P2',
    module: '04-domains-versions',
    summary: '发布弹窗第一步仍展示当前接口暂不生效的网关/服务名/认证可编辑项',
  },
  'CTX-013': {
    severity: 'P0',
    module: '07-workbench-first-paint',
    summary: '工作台首屏冷启动/切换等待超 5000ms 红线（实测曾达 13.3s 留白）',
  },
  'CTX-014': {
    severity: 'P1',
    module: '04-domains-versions',
    summary: '已发布版本显示冻结条目数，但前端 Adapter 将 Scope 置空导致版本范围明细为空',
  },
  'CTX-016': {
    severity: 'P0',
    module: '02-catalog-explorer',
    summary: '存量 TOS 连接打开同步目录 ExploreContextSource 耗时超 4000ms 红线',
  },
  'CTX-017': {
    severity: 'P0',
    module: '03-asset-detail-lineage',
    summary: '领域发布后查看资产血缘返回 HTTP 409 BindingRequired（缺少 working_version_id 兜底）',
  },
  'CTX-020': {
    severity: 'P2',
    module: '02-catalog-explorer',
    summary: '新建连接「业务应用」仍暴露数据面已下线在线能力的 Meego / 风神入口',
  },
  'CTX-021': {
    severity: 'P1',
    module: '06-mcp-services',
    summary: '控制面固定返回 Metrics24h: nil / UNAVAILABLE，未接通数据面真实调用统计',
  },
};
