# AgentKit Context 前端固化验证与增量维护规约（试运行固定基地）

本目录（`/Users/bytedance/claude-work/context-fe-e2e/`）是 AgentKit Context 前后端全链路验证的**跨 Worktree 唯一固定承载库**。在正式并入 `cloud-fe/agentkit-monorepo/apps/agentkit-platform/e2e/` Codebase MR CI 之前，所有 Context 新需求开发与 Bug 修复均在此处维护增量用例并跑全量回归。

---

## 一、核心运行机制（为什么快且稳）

1. **单标签页隔离直连 `9223`（零弹窗、零挂起、不碰已有标签页）**：
   - 执行器通过 `PUT http://127.0.0.1:9223/json/new` 单独拉起 1 个测试标签页，Node v22 原生 `WebSocket` 直连该标签页，绕开多标签页 `connectOverCDP` 卡死问题；跑完在 `finally` 自动关闭该临时标签页。
2. **协议层自动注入灰度头与泳道头**：
   - 自动注入 `x-forward-fe: deploy_context_stg_7399178560` 与 `x-lane-env: 7399178560`（可通过环境变量 `FE_GRAY_HEADER` / `LANE_ENV` 覆盖，比如切本地 `CONTEXT_CONSOLE_BASE=http://localhost:8080/agentkit-stg/region:agentkit-stg+cn-beijing/v2` 验证未部署本地前端改动！）。
3. **全局自动探针（`lib/cdpSession.mjs` Oracle）**：
   - **100% 自动采集每条 `/context/control/*` 与 `/context/data/*` 请求的耗时 `ms`、`ResponseMetadata.RequestId` 与错误码**（脱敏不落盘正文）；
   - 自动拦截五大退化：`Uncaught Error` 崩溃、`workspaceId` 丢失或串到禁区空间、`1970-01-01` 零值时间、重复请求风暴、单接口超耗时红线。
4. **已知开放缺陷分流（`lib/knownIssues.mjs`）**：
   - 已登记未修复的 Bug（如 `CTX-001`）跑出预期症状时标为 `KNOWN_BUG`，不中断后续模块；
   - 一旦某次修复部署后该断言通过，自动高亮 `FIXED_CANDIDATE`，此时将其从 `knownIssues.mjs` 删除并把 `t.checkKnownBug` 改为 `t.check`，即永久锁死为硬回归门禁！
   - 任何未登记的新失败直接标为 `REGRESSION_FAIL`（退出码 `1`）。

---

## 二、日常命令速查

```bash
# 1. 跑全量 7 大模块固化用例（约 25~45 秒跑完，生成 reports/latest-report.md）
/Users/bytedance/claude-work/context-fe-e2e/run-e2e.sh

# 2. 只跑单个指定模块（例如只测 MCP 服务页或资产目录）
/Users/bytedance/claude-work/context-fe-e2e/run-e2e.sh 06-mcp
/Users/bytedance/claude-work/context-fe-e2e/run-e2e.sh 02-catalog

# 3. 指向本地正在启动的 edenx dev 服务验证未提交前端代码
CONTEXT_CONSOLE_BASE="https://localhost:8080/agentkit-stg/region:agentkit-stg+cn-beijing/v2" \
  /Users/bytedance/claude-work/context-fe-e2e/run-e2e.sh
```

---

## 三、每次跑新需求 / 修 Bug 的强制维护流程（四步法）

1. **开发前看基线**：查阅 `SPEC_MATRIX.md` 了解所属模块已有断言与性能红线。
2. **开发中补增量用例**：
   - 新增前端功能 → 在对应 `specs/0X-*.spec.mjs` 补充一条 `await t.check('新功能断言名称', ...)`；
   - 修复已有 `CTX-*` 缺陷 → 将对应 `t.checkKnownBug('CTX-xxx', ...)` 升级为硬门禁 `t.check(...)`，并从 `lib/knownIssues.mjs` 删除该编号；
   - 修复新发现的野生 Bug → 先补一条必现该 Bug 的 `t.check(...)` 断言确认能抓红，再修业务代码跑绿。
3. **提 MR / 部署验收后跑全量回归**：
   - 执行 `/Users/bytedance/claude-work/context-fe-e2e/run-e2e.sh`（不带过滤参数，跑全量 7 模块）；
   - 硬门禁标准：**`REGRESSION_FAIL == 0`**，且新增/修复项为 **`PASS`**，接口耗时无新增超红线项。
4. **提交用例变更**：在本目录执行 `git add -A && git commit -m "test(e2e): ..."` 留存用例演进历史，并同步更新 `SPEC_MATRIX.md`。
