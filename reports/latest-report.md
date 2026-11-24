# AgentKit Context 前端固化验证报告（自动生成）

- **执行时间**：2026-11-24T13:31:14.887Z
- **总墙钟耗时**：30.7s
- **测试工作区**：`800e2e0a-bb05-4591-8cd2-f8df54be0ebe`（前端灰度 `deploy_context_stg_7399178560` / 后端泳道 `7399178560`）
- **统计汇总**：PASS **8** | 新修复转正候选 (FIXED_CANDIDATE) **3** | 已知未修缺陷 (KNOWN_BUG) **4** | 新增回归失败 (REGRESSION_FAIL) **0**

---

## 一、用例断言明细

| 模块文件 | 状态 | 关联缺陷号 | 用例断言 | 耗时 (ms) | 实测证据 / 详情 |
|---|---|---|---|---:|---|
| `01-navigation-scope.spec.mjs` | **PASS** | — | 导航进入 资产目录 (/context/catalog) 保持 workspaceId 且无未捕获异常 | 2383 | firstContent=1631ms, APIs=4 |
| `01-navigation-scope.spec.mjs` | **PASS** | — | 导航进入 业务领域 (/context/domains) 保持 workspaceId 且无未捕获异常 | 1913 | firstContent=1070ms, APIs=4 |
| `01-navigation-scope.spec.mjs` | **PASS** | — | 导航进入 知识加工 (/context/processing) 保持 workspaceId 且无未捕获异常 | 1677 | firstContent=801ms, APIs=5 |
| `01-navigation-scope.spec.mjs` | **KNOWN_BUG** | CTX-006 | 旧连接路由 /context/connections/:Id/detail 自动重定向到资产详情且不丢 workspaceId | 4173 | 未成功重定向至资产详情: href=https://console.volcengine.com/agentkit-stg/region:agentkit-stg+cn-beijing/v2/context/connections/res-01a20d5afab17c8fa64fbbcedf492414/detail?workspaceId=800e2e0a-bb05-4591-8cd2-f8df54be0ebe&project=default, 错误提示=无 ([截图](/Users/bytedance/claude-work/context-fe-e2e/reports/screenshots/known_CTX-006.webp)) |
| `02-catalog-explorer.spec.mjs` | **PASS** | — | 资产目录列表首屏加载成功且常规接口耗时达标 | 2012 | firstContent=1428ms, APIs=7 |
| `02-catalog-explorer.spec.mjs` | **FIXED_CANDIDATE** | CTX-007 | 资产目录列表不出现 1970-01-01 零值时间戳 | 2 | 未发现 1970-01-01 零值时间 |
| `02-catalog-explorer.spec.mjs` | **KNOWN_BUG** | CTX-020 | 添加资产向导不暴露数据面已下线在线能力的 Meego / 风神死入口 | 2232 | 新建连接向导仍暴露 Meego / 风神入口卡片 ([截图](/Users/bytedance/claude-work/context-fe-e2e/reports/screenshots/known_CTX-020.webp)) |
| `03-asset-detail-lineage.spec.mjs` | **PASS** | — | 基准 Markdown 文档资产详情页正常加载且保持 workspaceId | 1904 | firstContent=1291ms, APIs=7 |
| `03-asset-detail-lineage.spec.mjs` | **KNOWN_BUG** | CTX-017 | 已发布领域绑定的资产打开「数据血缘」Tab 正常加载，不报 409 BindingRequired | 2252 | 资产血缘加载失败: HTTP=200, RequestId=20261124213102485E84A9FAC6DD31413F, 错误码=BindingRequired ([截图](/Users/bytedance/claude-work/context-fe-e2e/reports/screenshots/known_CTX-017.webp)) |
| `04-domains-versions.spec.mjs` | **PASS** | — | 业务领域列表首屏加载正常且接口耗时达标 | 1450 | firstContent=786ms, APIs=7 |
| `04-domains-versions.spec.mjs` | **PASS** | — | 基准业务领域详情页正常加载知识模型与页签 | 1422 | firstContent=789ms, APIs=6 |
| `04-domains-versions.spec.mjs` | **KNOWN_BUG** | CTX-014 | 已发布版本抽屉正确展示冻结条目范围明细（非空数组提示） | 2049 | 版本抽屉显示冻结条目数非 0，但范围列表显示「暂未提供此版本的发布范围明细」 ([截图](/Users/bytedance/claude-work/context-fe-e2e/reports/screenshots/known_CTX-014.webp)) |
| `05-processing-eval.spec.mjs` | **PASS** | — | 领域知识加工页与运行历史正常渲染且无崩溃 | 1427 | firstContent=786ms, APIs=4 |
| `06-mcp-services.spec.mjs` | **FIXED_CANDIDATE** | CTX-001 | MCP 服务管理页正常渲染列表，不抛 localeCompare TypeError 或显示「加载失败，点击重试」 | 3419 | MCP 列表加载成功 (1376ms, APIs=7) |
| `07-workbench-first-paint.spec.mjs` | **FIXED_CANDIDATE** | CTX-013 | 工作台 (/context/workbench) 首屏在 5000ms 红线内渲染出「概览 / 调试台」核心交互区 | 1514 | 工作台首屏达标: 794ms (APIs=11) |

---

## 二、全量接口耗时与 RequestId 采集全景表

| 步骤模块 | Action | HTTP | 耗时 (ms) | RequestId | 错误码 | WorkspaceId 携带 | 慢响应判定 |
|---|---|---:|---:|---|---|---|---|
| `01-nav:/context/catalog` | `GetFeatureGateValidateResult` | 200 | 370 | `20261124213046D992ECDD6FAB74004A93` | — | — | 达标 |
| `01-nav:/context/catalog` | `CheckServiceLinkedRole` | 200 | 196 | `20261124213046803C41670BD711ECC738` | — | — | 达标 |
| `01-nav:/context/catalog` | `GetOrganization` | 200 | 280 | `2026112421304672D48A1C86FAA4E1F41E` | — | — | 达标 |
| `01-nav:/context/catalog` | `GetOrganization` | 200 | 158 | `202611242130472AF3F39DB845CE24E821` | — | — | 达标 |
| `01-nav:/context/catalog` | `GetWorkspace` | 200 | 177 | `2026112421304744FA7D1D5D5BCD910616` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-nav:/context/catalog` | `GetOrganizationStudioStatus` | 200 | 187 | `202611242130474B6FC7AA63C5FBF4B75E` | — | — | 达标 |
| `01-nav:/context/catalog` | `ListWorkspaces` | 200 | 303 | `20261124213047ED0539B4829760E13F37` | — | — | 达标 |
| `01-nav:/context/domains` | `GetFeatureGateValidateResult` | 200 | 229 | `202611242130483831C151C0A7C9D18BF5` | — | — | 达标 |
| `01-nav:/context/domains` | `CheckServiceLinkedRole` | 200 | 227 | `202611242130483E6AFA683FD23B2BC85A` | — | — | 达标 |
| `01-nav:/context/domains` | `GetOrganization` | 200 | 188 | `20261124213048295F0EF6FF9964399F96` | — | — | 达标 |
| `01-nav:/context/domains` | `GetOrganization` | 200 | 170 | `2026112421304935E2F0A5B08C6B0BDAC6` | — | — | 达标 |
| `01-nav:/context/domains` | `GetOrganizationStudioStatus` | 200 | 169 | `20261124213049C0C4BEE63FA6BBF62C1D` | — | — | 达标 |
| `01-nav:/context/domains` | `ListWorkspaces` | 200 | 200 | `202611242130497E61FEC95BABDA3A97AA` | — | — | 达标 |
| `01-nav:/context/domains` | `GetWorkspace` | 200 | 215 | `20261124213049D6B2E49D981EF6F2D4F5` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-nav:/context/processing` | `ListContextConnections` | 200 | 382 | `20261124213049295F0EF6FF9964399F9C` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-nav:/context/processing` | `GetFeatureGateValidateResult` | 200 | 126 | `202611242130503831C151C0A7C9D18C02` | — | — | 达标 |
| `01-nav:/context/processing` | `CheckServiceLinkedRole` | 200 | 377 | `202611242130500169828381CDE84CAF26` | — | — | 达标 |
| `01-nav:/context/processing` | `GetOrganization` | 200 | 114 | `2026112421305044FA7D1D5D5BCD9107A6` | — | — | 达标 |
| `01-nav:/context/processing` | `GetOrganization` | 200 | 179 | `20261124213050ED0539B4829760E13F4F` | — | — | 达标 |
| `01-nav:/context/processing` | `GetOrganizationStudioStatus` | 200 | 113 | `20261124213050894E0AD261271AC49684` | — | — | 达标 |
| `01-nav:/context/processing` | `GetWorkspace` | 200 | 168 | `20261124213051188B839E8A47C8EF5EB6` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-nav:/context/processing` | `ListWorkspaces` | 200 | 206 | `202611242130507E61FEC95BABDA3A97B7` | — | — | 达标 |
| `01-legacy-conn-redirect` | `GetFeatureGateValidateResult` | 200 | 94 | `20261124213051C0C4BEE63FA6BBF62CFA` | — | — | 达标 |
| `01-legacy-conn-redirect` | `CheckServiceLinkedRole` | 200 | 132 | `202611242130513831C151C0A7C9D18C0C` | — | — | 达标 |
| `01-legacy-conn-redirect` | `GetOrganization` | 200 | 388 | `20261124213051D8780885C8D96AE0142E` | — | — | 达标 |
| `01-legacy-conn-redirect` | `GetOrganization` | 200 | 187 | `202611242130526D1300802241D470962B` | — | — | 达标 |
| `01-legacy-conn-redirect` | `GetOrganizationStudioStatus` | 200 | 126 | `20261124213052485783BA25C309D509F7` | — | — | 达标 |
| `01-legacy-conn-redirect` | `GetWorkspace` | 200 | 194 | `20261124213052DF439FA5BD7C8330CC06` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-legacy-conn-redirect` | `ListWorkspaces` | 200 | 378 | `202611242130527DD0263FFEE8A036443D` | — | — | 达标 |
| `01-legacy-conn-redirect` | `ListContextTasks` | 200 | 305 | `20261124213052696CB6F8C31D482C9455` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-legacy-conn-redirect` | `ListContextConnections` | 200 | 346 | `2026112421305244FA7D1D5D5BCD9108B2` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `01-restore-safe-ws` | `GetFeatureGateValidateResult` | 200 | 178 | `202611242130537E61FEC95BABDA3A97CC` | — | — | 达标 |
| `01-restore-safe-ws` | `CheckServiceLinkedRole` | 200 | 192 | `202611242130540E894A8104CB3FB76DB0` | — | — | 达标 |
| `01-restore-safe-ws` | `GetOrganization` | 200 | 234 | `20261124213054F5CA2E7F51E40131750B` | — | — | 达标 |
| `01-restore-safe-ws` | `GetOrganization` | 200 | 363 | `20261124213054E17406E4D1CB251CFD9E` | — | — | 达标 |
| `01-restore-safe-ws` | `ListWorkspaces` | 200 | 210 | `202611242130556E20583AA1047059CB55` | — | — | 达标 |
| `01-restore-safe-ws` | `GetOrganizationStudioStatus` | 200 | 252 | `202611242130557E61FEC95BABDA3A97D9` | — | — | 达标 |
| `01-restore-safe-ws` | `GetWorkspace` | 200 | 465 | `20261124213055E3B50691A2F05D2C7F15` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `02-catalog-list` | `GetFeatureGateValidateResult` | 200 | 266 | `20261124213055B404B5E6ADD70031AE3C` | — | — | 达标 |
| `02-catalog-list` | `CheckServiceLinkedRole` | 200 | 233 | `20261124213056F28943BA10BC50A79756` | — | — | 达标 |
| `02-catalog-list` | `GetOrganization` | 200 | 185 | `202611242130567B1538507EBB8AB6EA88` | — | — | 达标 |
| `02-catalog-list` | `GetOrganization` | 200 | 241 | `202611242130561B07593B3A8A073678F9` | — | — | 达标 |
| `02-catalog-list` | `ListWorkspaces` | 200 | 107 | `2026112421305644FA7D1D5D5BCD910AE6` | — | — | 达标 |
| `02-catalog-list` | `GetWorkspace` | 200 | 200 | `2026112421305673AA13065A479F045712` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `02-catalog-list` | `GetOrganizationStudioStatus` | 200 | 232 | `20261124213056B040BDE63A5DD4028699` | — | — | 达标 |
| `02-connect-modal-dead-sources` | `GetRole` | 200 | 359 | `20261124213057AD583B2CD83AEC04EFE5` | — | — | 达标 |
| `02-connect-modal-dead-sources` | `ListAttachedRolePolicies` | 200 | 204 | `20261124213057E974C92593A5F6E3CA51` | — | — | 达标 |
| `02-catalog-list` | `ListContextConnections` | 200 | 1148 | `202611242130564B6FC7AA63C5FBF4BC95` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `02-catalog-list` | `ListContextDomains` | 200 | 2474 | `20261124213056B404B5E6ADD70031AE48` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 超红线 (>1500ms) |
| `03-asset-detail` | `GetFeatureGateValidateResult` | 200 | 240 | `20261124213059F855CDD42A89FC0E8BDC` | — | — | 达标 |
| `03-asset-detail` | `CheckServiceLinkedRole` | 200 | 274 | `202611242131007DD0263FFEE8A03BE4C8` | — | — | 达标 |
| `03-asset-detail` | `GetOrganization` | 200 | 116 | `202611242131000B56863744661B0AA208` | — | — | 达标 |
| `03-asset-detail` | `GetOrganization` | 200 | 165 | `20261124213100485E84A9FAC6DD314131` | — | — | 达标 |
| `03-asset-detail` | `ListWorkspaces` | 200 | 137 | `202611242131003DCD20D41E5E55E997DC` | — | — | 达标 |
| `03-asset-detail` | `GetOrganizationStudioStatus` | 200 | 185 | `20261124213100B404B5E6ADD70031AE63` | — | — | 达标 |
| `03-asset-detail` | `GetWorkspace` | 200 | 337 | `2026112421310057940A17FA844535E0F6` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-detail` | `GetContextEntry` | 200 | 468 | `20261124213101C2AA8669F81248F4C809` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-detail` | `ListContextConnections` | 200 | 550 | `202611242131013CEB79CF2341352B479D` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-lineage-tab` | `ListContextConnections` | 200 | 94 | `2026112421310144FA7D1D5D5BCD910D5C` | AccountFlowLimitExceeded | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-lineage-tab` | `ListContextTasks` | 200 | 190 | `202611242131019571862A2DC093E02DEF` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-lineage-tab` | `GetContextEntry` | 200 | 582 | `20261124213101485E84A9FAC6DD31413B` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-lineage-tab` | `ListContextEntryLinks` | 200 | 140 | `20261124213102485E84A9FAC6DD31413F` | BindingRequired | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `03-asset-lineage-tab` | `ListContextConnections` | 200 | 449 | `20261124213102532F44290BB66281E4B6` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-list` | `GetFeatureGateValidateResult` | 200 | 305 | `20261124213104482004E13E5AA90CD0F2` | — | — | 达标 |
| `04-domain-list` | `CheckServiceLinkedRole` | 200 | 143 | `20261124213104E89AD1D7840B3BECE17D` | — | — | 达标 |
| `04-domain-list` | `GetOrganization` | 200 | 187 | `20261124213104B404B5E6ADD70031AE7C` | — | — | 达标 |
| `04-domain-list` | `GetOrganization` | 200 | 98 | `20261124213104CE4FC42F5D4DBD6B0F8C` | — | — | 达标 |
| `04-domain-list` | `GetOrganizationStudioStatus` | 200 | 96 | `20261124213104C0C4BEE63FA6BBF63371` | — | — | 达标 |
| `04-domain-list` | `GetWorkspace` | 200 | 112 | `2026112421310453A2DD8D1EDF5EF452CE` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-list` | `ListWorkspaces` | 200 | 141 | `20261124213104485E84A9FAC6DD314151` | — | — | 达标 |
| `04-domain-detail` | `GetFeatureGateValidateResult` | 200 | 147 | `20261124213105DAC8C1E4A468ECB7022B` | — | — | 达标 |
| `04-domain-detail` | `CheckServiceLinkedRole` | 200 | 177 | `202611242131055AACD84942257231150E` | — | — | 达标 |
| `04-domain-detail` | `GetOrganization` | 200 | 287 | `202611242131052CAD7551A9566809AEBA` | — | — | 达标 |
| `04-domain-detail` | `GetOrganization` | 200 | 109 | `2026112421310644FA7D1D5D5BCD910FE1` | — | — | 达标 |
| `04-domain-detail` | `GetOrganizationStudioStatus` | 200 | 93 | `20261124213106532F44290BB66281E66D` | — | — | 达标 |
| `04-domain-detail` | `GetWorkspace` | 200 | 123 | `20261124213106F855CDD42A89FC0E8C00` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-version-snapshot` | `ListContextDomainActivities` | 200 | 143 | `20261124213106E974C92593A5F6E3CA89` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-detail` | `GetContextDomain` | 200 | 189 | `20261124213106485783BA25C309D51259` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-version-snapshot` | `ListContextDomainReleases` | 200 | 160 | `20261124213106E89AD1D7840B3BECE2AF` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-detail` | `ListWorkspaces` | 200 | 344 | `202611242131062413D598EA1DB52C1CA6` | — | — | 达标 |
| `04-domain-detail` | `ListContextEntries` | 200 | 318 | `202611242131065AACD849422572311512` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `04-domain-version-snapshot` | `GetContextDomainService` | 200 | 888 | `202611242131065AACD849422572311515` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `05-domain-processing` | `GetFeatureGateValidateResult` | 200 | 205 | `2026112421310993098397778A3930C709` | — | — | 达标 |
| `05-domain-processing` | `CheckServiceLinkedRole` | 200 | 226 | `2026112421310999B4B14AB192A5F8AB72` | — | — | 达标 |
| `05-domain-processing` | `GetOrganization` | 200 | 136 | `202611242131095AACD84942257231152C` | — | — | 达标 |
| `05-domain-processing` | `GetOrganization` | 200 | 293 | `2026112421310953A3E4789597F8F6C47C` | — | — | 达标 |
| `05-domain-processing` | `ListWorkspaces` | 200 | 106 | `20261124213109532F44290BB66281E817` | — | — | 达标 |
| `05-domain-processing` | `GetWorkspace` | 200 | 182 | `20261124213109F855CDD42A89FC0E8C15` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `05-domain-processing` | `GetOrganizationStudioStatus` | 200 | 283 | `202611242131105EAF5F1B90D43BF29E84` | — | — | 达标 |
| `06-mcp-services` | `GetFeatureGateValidateResult` | 200 | 102 | `20261124213111C0C4BEE63FA6BBF636A0` | — | — | 达标 |
| `06-mcp-services` | `CheckServiceLinkedRole` | 200 | 254 | `2026112421311115AE36D586CA2CDBA9D8` | — | — | 达标 |
| `06-mcp-services` | `GetOrganization` | 200 | 298 | `20261124213111C892AA322A6F43F40C78` | — | — | 达标 |
| `06-mcp-services` | `GetOrganization` | 200 | 140 | `20261124213111C6F397032911AB20484D` | — | — | 达标 |
| `06-mcp-services` | `GetOrganizationStudioStatus` | 200 | 113 | `20261124213111ACD780F715D7BB80069E` | — | — | 达标 |
| `06-mcp-services` | `GetWorkspace` | 200 | 244 | `202611242131119161F1B30DC1DD600491` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `06-mcp-services` | `ListWorkspaces` | 200 | 311 | `20261124213111478BEFFB2DF3BB2C21FE` | — | — | 达标 |
| `06-mcp-services` | `ListContextDomains` | 200 | 1495 | `202611242131120FAD351C4ED075F4082D` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 170 | `20261124213113E974C92593A5F6E3CAC0` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 177 | `20261124213113CB9BF51F0A0FABF8663E` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 200 | `20261124213113FF9D6FD6AA884E0E8970` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 200 | `20261124213113AEA6523D33237DEF3B5C` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 198 | `2026112421311398FB4520FDB6A3E05DC0` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetContextDomainService` | 200 | 206 | `20261124213113138A286A0F94EAAE1DEF` | — | 800e2e0a-bb05-4591-8cd2-f8df54be0ebe | 达标 |
| `07-workbench-first-paint` | `GetFeatureGateValidateResult` | 200 | 212 | `202611242131142DA324563980D631126A` | — | — | 达标 |
| `07-workbench-first-paint` | `CheckServiceLinkedRole` | 200 | 238 | `2026112421311457940A17FA844535E147` | — | — | 达标 |
| `07-workbench-first-paint` | `GetOrganization` | 200 | 98 | `2026112421311444FA7D1D5D5BCD911471` | — | — | 达标 |
| `07-workbench-first-paint` | `GetOrganization` | 200 | 164 | `2026112421311424FB8E5174848DD5D509` | — | — | 达标 |
| `07-workbench-first-paint` | `GetOrganizationStudioStatus` | 200 | 97 | `202611242131145B7DAE10F5B8083B1158` | — | — | 达标 |
