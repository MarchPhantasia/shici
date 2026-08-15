# 拾词 · 待修复清单

代码审阅日期：2026-08-16
审阅版本：`0.3.1`（工作区，含未提交改动）
审阅范围：`server.mjs` / `public/app.js` / `public/styles.css` / `public/index.html` / `public/service-worker.js` / `src-tauri/src/lib.rs` / `test/smoke.mjs` / `scripts/migrate-app-data.mjs` / `src-tauri/tauri.conf.json`
基线状态：`npm test` 通过

> 标注说明：**[已验证]** = 已通过实际运行或代码逐行确认；**[判断]** = 设计层面的建议，取舍由你决定。

---

## P0 · 安全（建议今天就修）

### 开发服务器会泄露 API Key

- [ ] **给 `handleApi` 加同源校验** —— `server.mjs:637`
  校验 `Origin` / `Sec-Fetch-Site`，非同源请求直接返回 403。

- [ ] **校验 `Host` 头** —— `server.mjs:734`
  必须是 `127.0.0.1:<port>` 或 `localhost:<port>`，用于阻断 DNS rebinding。

- [ ] **要求自定义请求头**（如 `X-Shici: 1`）
  强制触发 CORS 预检，从根本上挡掉"简单请求"绕过。

- [ ] **收紧 `/api/models` 的密钥复用规则** —— `server.mjs:423`、`server.mjs:253`
  当请求方传入的 `baseUrl` 与已保存 provider 的不一致时，拒绝复用已保存的 `apiKey`。

- [ ] **删除 `/api/explain` 端点** —— `server.mjs:699`
  前端、Rust 侧、测试均无引用（已 grep 确认）。它当前是一个无鉴权、代付费的 AI 代理。

**[已验证] 问题描述**

`server.mjs` 不校验 `Origin`，也不校验 `Content-Type`（`readJson` 无条件 `JSON.parse`，`server.mjs:335`）。用 `text/plain` 发出的跨域 POST 属于 CORS "简单请求"，浏览器不发预检直接送达；响应虽被 CORS 拦截，但副作用已经发生。

叠加 `/api/models` 允许调用方任意指定 `baseUrl`、密钥却仍从已保存 provider 取用（`resolveConfig`，`server.mjs:243-254`），构成完整窃取链路。

PoC 实测结果：

```
server accepted the cross-origin request: 200 {"models":["pwned"]}
attacker received: { "path": "/v1/models", "authorization": "Bearer sk-REAL-USER-SECRET-KEY" }
```

**影响**：只要 `npm start` 在运行，当时浏览器里开着的任意网页都能取走已保存的 API Key。绑定 `127.0.0.1` 无法防御，因为请求正是从本机浏览器发出的。

**不受影响**：Tauri 桌面/移动版走 `invoke`，不监听 HTTP 端口。

- [ ] 修复后补一条回归测试到 `test/smoke.mjs`（跨域请求应被拒、异常 `baseUrl` 不得携带已存密钥）

---

## P1 · 架构：后端逻辑存在两份独立实现

`server.mjs`(743 行 JS) 与 `src-tauri/src/lib.rs`(1286 行 Rust) 是同一套业务逻辑的两份实现：system prompt、`cleanEntry`、`inferKind`、`scheduleReview`、provider 管理全部重复。

**[已验证] 已经发生的漂移：**


| 项目                            | `server.mjs`                                  | `src-tauri/src/lib.rs` |
| ----------------------------- | --------------------------------------------- | ---------------------- |
| `library.json` 的 `version` 字段 | 写 `1`（`:204`、`:634`）                          | 写 `2`（`:496`、`:957`）   |
| 演示模式内容                        | 内置 `figure it out` / `suffocating` 词条（`:450`） | 无，全部返回占位文本（`:1144`）    |
| 环境变量配置                        | 支持（`:14-20`）                                  | 完全没有                   |


同一份数据文件被两个后端写成不同 `version`，是后续最容易出事的地方。

- [ ] **【必做，无论走哪条路】统一 `library.json` 的 `version` 字段**
  两边都写 `2`，并确认双向读取兼容。

- [ ] **【必做】把 system prompt 抽成单一来源**（如 `prompt.txt`），两边运行时读取
  当前 25 行 prompt 在 `server.mjs:31-55` 与 `lib.rs:17-41` 逐字重复。

- [ ] **【选一条路】消除双份实现**
  - 方案 A（推荐）：把 `server.mjs` 降级为纯静态文件服务 + 反代到同一个 Rust 二进制（增加 HTTP 模式），业务逻辑只留一份
  - 方案 B：短期兜底 —— 建立共享 JSON fixture，让 `smoke.mjs` 与 Rust 单测跑同一批输入、断言同一批输出，漂移立刻被测出来

---

## P2 · 已确认的 Bug

- [ ] **Service Worker 离线回退是坏的** —— `public/service-worker.js:2`
  **[已验证]** 预缓存 `?v=11`，而 `index.html` 请求 `?v=13`（`index.html:10,240,241`）。URL 不匹配 → `caches.match()` 永不命中 → 离线时除 `/` 外全部拿不到。
  修复：构建时注入统一常量，或 `caches.match(request, { ignoreSearch: true })`。

- [ ] `**?v=` 缓存版本号散落 4 处手工维护，现已不同步**
  `index.html:10`、`index.html:240`、`index.html:241`、`app.js:1098`、`service-worker.js:2`。改为单一来源。

- [ ] **桌面端在 AI 生成期间整个 App 冻结** —— `src-tauri/src/lib.rs:1189`
  **[已验证]**
  ```rust
  let mut backend = state.backend.lock().await;
  backend.handle(request, cancellation).await   // 锁横跨最长 120 秒的 LLM 请求
  ```
  期间任何其他 `api_request`（评分复习、收藏、改来源、切 provider、读词库）全部排队等待。仅 `cancel_request` 因走独立 `StdMutex` 仍可用。
  修复：把锁粒度收窄到"读配置"和"写库"两小段，网络请求在锁外执行。

- [ ] **Windows 上的"原子写"反而不原子** —— `src-tauri/src/lib.rs:403-406`
  ```rust
  #[cfg(windows)]
  if path.exists() { fs::remove_file(path)?; }
  ```
  `std::fs::rename` 在 Windows 上使用 `MoveFileExW` + `MOVEFILE_REPLACE_EXISTING`，本就会覆盖目标。这段 `remove_file` 既多余，又制造了"目标文件不存在"的窗口 —— 恰在此时崩溃即丢失整个词库。
  修复：删除这 4 行。

- [ ] **HTTP 状态码一律返回 502** —— `server.mjs:709`
  "请输入一个语言片段"应为 400，"没有找到这个片段"应为 404。当前前端无法区分"用户输错"与"AI 服务故障"。

- [ ] `**beforeBuildCommand` 有副作用** —— `src-tauri/tauri.conf.json:7` → `scripts/migrate-app-data.mjs`
  `npm run app:build` 会往**构建者本机的**应用数据目录写文件。构建不应改动用户数据。
  修复：挪到应用首次启动时执行，或改为显式的 `npm run migrate`。

---

## P3 · AI 调用健壮性与体感

- [ ] **启用 JSON mode / structured outputs** —— `server.mjs:399`、`src-tauri/src/lib.rs:732`
  当前完全依赖 prompt 里的 "Return only valid JSON" + 手工剥离 ``` 围栏（`server.mjs:386`、`lib.rs:1131`）。模型只要前置一句"好的，这是结果："，整条请求即失败。
  - Responses API：使用 `text.format`
  - chat/completions：使用 `response_format: { type: "json_schema" }`
  配合已有的 schema，这一类失败可直接归零。

- [ ] **实现流式输出（SSE）** —— **[判断] 单点体感收益最大的一项**
  App 的核心动作就是"发送 → 等解释"，当前用户最长盯着转圈 120 秒（`server.mjs:372` 的 `AbortSignal.timeout(120_000)`；`lib.rs:506` 的 120s client timeout）。

- [ ] **为 429 / 5xx 增加重试退避** —— `server.mjs:371`、`src-tauri/src/lib.rs:661`

- [ ] **补齐 `max_tokens` / `temperature` 等请求参数**

---

## P4 · 性能与规模（当前无感，几千条后明显）

- [ ] **每次改动全量重写整个 `library.json**` —— `server.mjs:220-230`、`src-tauri/src/lib.rs:657`
  JS 侧还额外 `structuredClone` 整个库。评一张复习卡 = 序列化全部词条。
  修复方向：迁移到 SQLite（`tauri-plugin-sql`），或至少写前做脏检查 / 增量。

- [ ] **搜索每次按键都为每个 entry 重建 haystack** —— `public/app.js:300`
  `join(" ").toLowerCase()` 是 O(n × 文本长度) 的字符串分配，键入即卡。
  修复：预计算并缓存 `entry._search`；输入加 ~150ms 防抖（`app.js:1075`）。

- [ ] `**render()` 全量重建 innerHTML，无虚拟滚动** —— `public/app.js:473-498`
  当前靠 `visibleLimit = 80` 兜底。若要支撑大词库需引入虚拟列表。

---

## P5 · 产品与交互

- [ ] **补一个"导入 JSON"入口** —— **[判断] 性价比最高的一项**
  本地优先的 App 现在只能导出（`app.js:930`）却无法从备份恢复。`PUT /api/entries` 已存在（"恢复演示数据"就在用，`app.js:935`），加一个文件选择按钮即可。

- [ ] **重复提交同一个词会产生两条记录**
  没有去重，也没有"词库里已有"的提示。

- [ ] `**entry.status` 基本是废字段**
  UI 显示"待复习/已学习"用的是 `isDue()`（`app.js:430`），而评分时无论"忘记"还是"轻松"都统一设成 `learned`（`server.mjs:613`、`lib.rs:930`）。
  决策：要么删除该字段，要么让它真正参与逻辑。

- [ ] `**review.lapses` 一直累加但从未被读取** —— 没有 leech（顽固词）处理
  既然已经在存，补上阈值触发（如 lapses ≥ 8 时标记/降频）很自然。

- [ ] **复习间隔没有 fuzz（随机抖动）** —— `server.mjs:570`、`lib.rs:1046`
  同一天录入的词会永远在同一天到期，长期形成复习尖峰。

- [ ] **破坏性操作全部依赖 `confirm()**` —— `app.js:765`（删 provider）、`app.js:841`（回退追问）、`app.js:925`（删片段）、`app.js:935`（恢复演示数据）
  改为"已删除 + 撤销"的 toast 体验更好，也顺带避开 webview 内原生 confirm 的样式问题。

- [ ] **删除 `state.expanded` 死代码** —— `public/app.js:105`
  只在 `app.js:939` 被 `.clear()` 过，从未 `add`。

- [ ] **捕捉页缺少 provider 快切下拉**
  `#quick-model-select` 只存在于主 composer（`index.html:73`），捕捉页（`index.html:106-134`）没有对应控件。

- [ ] `**#timeline` 的 `aria-live="polite"` 应移除** —— `public/index.html:103`
  每次重渲染都会朗读整个列表。该属性只应保留在 `#toast`（`:239`）与 `#ai-state`（`:72`、`:128`）上。

---

## P6 · 工程化

- [ ] `**npm run check` 仅做语法检查** —— `package.json:11`
  当前是 `node --check`。建议引入 ESLint；配 JSDoc + `checkJs` 可在不改写为 TS 的前提下白拿类型检查。

- [ ] **前端 0 测试**
  `public/app.js` 1098 行无任何测试覆盖。

- [ ] **接入 CI** —— **[判断] 最省力的一步**
  `test/smoke.mjs` 质量很高，直接挂到 GitHub Actions 即可。

- [ ] `**"csp": null` 显式关闭了 CSP** —— `src-tauri/tauri.conf.json:25`
  现有转义已逐点扫查、未发现遗漏，但 CSP 是近乎零成本的第二道防线。

- [ ] `**"targets": "all"` 与实际能力不符** —— `src-tauri/tauri.conf.json:30`
  当前环境只能产出 macOS 产物。README 已说明，配置本身也可收敛以免误解。

---

## 建议执行顺序

若只做三件事：

1. **修 P0 安全问题** —— 当前每次 `npm start` 都处于暴露状态
2. **上流式输出（P3）** —— 体感提升最明显
3. **消除双份后端（P1）** —— 否则每个新功能都要写两遍，且会继续漂移

---

## 审阅中确认无问题的部分

以下项已逐点检查，未发现缺陷，记录在此以免重复审阅：

- **XSS 防护**：`escapeHtml`（`app.js:222`）覆盖了所有 `innerHTML` 拼接点；`data-entry-id` / `data-turn-id` 等属性插值的 id 均经 `^[\w-]{1,80}$` 校验（`server.mjs:167`、`lib.rs:130`）
- **路径穿越**：`serveFile`（`server.mjs:715`）的 `decodeURIComponent` + `normalize` + 前缀校验组合有效，`%2e%2e%2f` 等编码绕过均被拦下
- **密钥不回传前端**：`publicConfig`（`server.mjs:270`）只暴露 `hasApiKey` 布尔值，`smoke.mjs:94` 有对应断言
- **文件权限**：`.local/` 目录 `0700`、文件 `0600`，两个后端一致
- `**.gitignore**`：`.local/`、`src-tauri/target/`、`src-tauri/gen/` 均已正确忽略，无密钥入库
- **版本号**：`package.json` / `tauri.conf.json` / `Cargo.toml` 三处均为 `0.3.1`，一致
- **请求取消**：前端 AbortController + 后端 signal 透传链路完整，`smoke.mjs:161-169` 有覆盖

&nbsp;