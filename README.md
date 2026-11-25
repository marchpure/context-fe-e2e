# AgentKit Context 固定回归

按 [用户旅程验收矩阵](SPEC_MATRIX.md) 维护用例。默认读取合成测试工作区，使用独立浏览器标签页。真实交互以主操作区的业务终态为准，同时采集工作区、项目、请求 ID、业务错误码与耗时。

## 验证原则

- **E2E 优先**。从真实用户入口执行，按验收矩阵确认主操作区的业务终态，并保留请求 ID、业务码和耗时。
- **Property Tests**。用可复现的随机输入验证范围隔离、幂等、往返与等价性。离线测试检查执行器、判定逻辑和业务回执约束。实际数据变更与并发结果由 E2E 验证。

## 运行

```bash
# Node 22+，本机隔离 Chrome CDP 默认监听 127.0.0.1:9223
./run-e2e.sh
./run-e2e.sh 02-catalog
node --test test/*.test.mjs
```

离线性质测试默认使用固定种子。失败输出会给出种子、输入缩减结果和复现命令。可用 `PROP_SEED=0x1234 node --test test/*.test.mjs` 换种子验证。

隔离浏览器需事先登录已授权的测试租户。若端口、账号或合成夹具不可用，报告记为 `BLOCKED`。可设置 `CONTEXT_E2E_REPORT_DIR` 将本次报告写入独立目录。默认写入 `reports/latest-report.md`。报告记录尝试但未完成的请求，HTTP 200 的业务错误单独列示。

| 退出码 | 含义 |
|---|---|
| 0 | 已运行用例无新增失败或阻断，仍需查看已知缺陷和修复候选 |
| 1 | 有回归失败 |
| 2 | 有验证阻断或套件无法运行 |

## 环境

默认目标为 STG 测试工作区 `800e2e0a-bb05-4591-8cd2-f8df54be0ebe`、项目 `default`、前端小流量 `feat_M_7387129035_agentkit_context` 和后端泳道 `7399178560`。默认 STG 配置在执行业务用例前核对目录入口实际加载的静态资源版本 `1.0.0.2257`。对照其他产物时可用 `CONTEXT_E2E_EXPECTED_FE_VERSION` 指定版本。隔离环境参数为 `CONTEXT_CONSOLE_BASE`、`CONTEXT_WORKSPACE_ID`、`CONTEXT_PROJECT_NAME`、`FE_GRAY_HEADER`、`LANE_ENV`、`CDP_HTTP_BASE`。浏览器端口限本机。

需要提交问答、创建对象、扫描、审核、发布或删除的用例使用受控合成对象。执行前确认样本与清理边界。每条用例保留实际通过、失败、待执行或缺前置条件的状态。

## 草稿调试的实际问答

`08-draft-debug` 可按默认只读配置检查草稿入口和跳转。以下参数齐备时，脚本才会在指定合成领域中提交一次「你有哪些数据」。准备一个带未发布草稿、已绑定可读合成资产的领域，使用该草稿资产在界面里的准确名称。

```bash
CONTEXT_E2E_RUN_DRAFT_QUERY=1 \
CONTEXT_E2E_DRAFT_DOMAIN_ID='<合成领域 ID>' \
CONTEXT_E2E_DRAFT_DOMAIN_NAME='<codex-e2e- 开头的领域名>' \
CONTEXT_E2E_DRAFT_EXPECTED_ASSET='<草稿绑定的合成资产名>' \
./run-e2e.sh 08-draft-debug
```

等待新助手回答的总预算上限为 120 秒。仅进入调试页、收到用户消息回显或看到模型仍在生成均无法通过问答断言。按默认只读配置运行时，问答步骤显示为 `BLOCKED`，其余模块继续执行。

## 维护

新增入口与状态都应有用户动作和结果断言。对修复项先捕获可识别的失败信号，再用同一入口复验。已知缺陷的具体症状才允许记为 `KNOWN_BUG`；缺夹具、账号错误、错工作区或其他报错需要按实际状态登记。修复复验完成后，将对应断言转为常规回归，并同步更新矩阵及 `lib/knownIssues.mjs`。
