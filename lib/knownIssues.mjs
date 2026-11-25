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
  'CTX-006': {
    severity: 'P0',
    module: '01-navigation-scope',
    summary: '旧连接详情路由 /context/connections/:Id/detail 无法自动跳转，且错误页点击返回丢失 workspaceId',
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
  'CTX-016': {
    severity: 'P0',
    module: '02-catalog-explorer',
    summary: '存量 TOS 连接打开同步目录 ExploreContextSource 耗时超 4000ms 红线',
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
