# AgentKit Context 前端固化用例矩阵（`SPEC_MATRIX.md`）

## 一、性能红线契约（Latency SLO）

| 指标项 | 硬红线阈值 | 说明 |
|---|---:|---|
| 常规控制面/数据面读接口（`List*` / `Get*`） | `<= 1500 ms` | 超限记入慢响应告警 |
| 常规写/治理接口（`Create/Update/Review*`） | `<= 2000 ms` | 不含重型异步沙箱执行本身 |
| 同步源端探测（`ExploreContextSource`） | `<= 4000 ms` | 目标 `< 2000 ms`，严禁 `> 8s` 超长卡顿 |
| 异步状态轮询（`GetContextScanJob` 等） | `<= 800 ms` | 切走页面/关抽屉后必须停止 |
| 页面路由导航首屏可交互（First Content Settled） | `<= 5000 ms` | 目标 `< 2000 ms`，防止 `CTX-013` 13s 留白 |

---

## 二、七大模块固化用例清单

| 模块文件 | 覆盖路由 | 固化检查项（含已锁定回归点） |
|---|---|---|
| `01-navigation-scope.spec.mjs` | `/context/workbench`<br>`/context/catalog`<br>`/context/domains`<br>`/context/processing`<br>`/context/domains/mcp`<br>`/context/connections/:Id/detail` | 1. 五大一级页面导航可达、零未捕获异常、全程保持指定 `workspaceId`<br>2. 严禁串入禁区工作区 `ws-7710414566965542920`<br>3. 旧连接路由兼容重定向与错误返回不丢 `workspaceId`（守护 `CTX-006`） |
| `02-catalog-explorer.spec.mjs` | `/context/catalog` | 1. 资产目录列表、连接分组与筛选渲染及接口耗时达标<br>2. 打开「添加资产」向导检查「业务应用」死入口残留（守护 `CTX-020`）<br>3. 存量 TOS 连接「管理同步范围」目录探测耗时红线（守护 `CTX-016`）<br>4. 目标测试工作区中，`codex-e2e-local-kb-1125` 和 `codex-e2e-pg-1125` 分别显示两篇文档和两张表 |
| `03-asset-detail-lineage.spec.mjs` | `/context/catalog/:Id/detail` | 1. 文档资产详情正文预览、索引状态展示与零 `1970-01-01` 时间戳（守护 `CTX-007`）<br>2. 已发布领域绑定资产切换「数据血缘」Tab 加载成功且无 `409 BindingRequired`（守护 `CTX-017`） |
| `04-domains-versions.spec.mjs` | `/context/domains`<br>`/context/domains/:Id/detail` | 1. 业务领域列表与创建弹窗必填内联校验<br>2. 领域详情知识模型/知识页/工具配置加载<br>3. 已发布版本快照抽屉展示真实冻结条目明细而非空数组（守护 `CTX-014`）<br>4. 发布弹窗首步不展示未生效的冗余网关/认证编辑项（守护 `CTX-012`）<br>5. 目标测试工作区中，退款数据资产更新后，发布版本 `1.0.1` 仍冻结来源修订 `1` |
| `05-processing-eval.spec.mjs` | `/context/domains/:Id/processing` | 1. 知识加工运行历史与报告页签加载<br>2. 禁用态评测不误展示 `0%` 命中率（守护 `CTX-002`）<br>3. 建议来源依据准确展示文档类型与资产跳转链接（守护 `CTX-011`） |
| `06-mcp-services.spec.mjs` | `/context/domains/mcp` | 1. MCP 服务管理列表正常渲染，缺省字段排序不触发 `localeCompare` 崩溃（守护 `CTX-001`）<br>2. 服务 24h 调用统计状态非硬编码永久 `UNAVAILABLE`（守护 `CTX-021`） |
| `07-workbench-first-paint.spec.mjs` | `/context/workbench` | 1. 工作台首屏切换至核心交互区（「概览 / 调试台」）耗时 `<= 5000 ms`（守护 `CTX-013`）<br>2. 调试台输入框、模型选择器与历史会话列表正常挂载零报错 |
