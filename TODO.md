# 拾词 · 待办清单

第七轮审阅：2026-08-18（WebDAV 同步 / 词性词形 / 复习提示 / 排序等未提交改动 + 追问工作台定稿）
版本：`0.3.2` → 下一版本 `0.4.0` · 目标：修复本轮发现的同步数据缺陷，随后实现追问工作台

**当前验证状态**

| 命令 | 结果 |
| --- | --- |
| `npm run ci`（check + test + fmt + cargo test + release build + clippy） | ✅ P0-A 修复后全绿 |

> 标注：**[已验证]** = 实际运行或代码逐行确认；**[判断]** = 设计取舍，由你决定。
> 历史轮次的完成情况见文末「已结项」。本文只列**尚未完成**的事。

---

## P0-A · 本轮 review 发现：撤销恢复的词条会被 WebDAV tombstone 再次删除

**[已验证·代码推演]** 数据丢失级缺陷，双端同构，必须在提交 WebDAV 功能前修复。

**复现链路**（浏览器版与 Tauri 版逻辑相同）：

1. 删除词条 → `saveLibrary` / `delete_entry` 记录 `tombstones[id] = Date.now()`；
2. 8 秒撤销 → `restoreEntries` 走 `PUT /api/entries`，快照里的词条带着**旧的 `updatedAt`** 回到词库，但 tombstone 未清除（`replaceEntries` 只为消失的 id 添加 tombstone，不为复活的 id 移除）；
3. 上传的同步文件同时含有该词条和它的 tombstone（`normalizeWebdavEnvelope` 只在 `tombstone <= updatedAt` 时清理，此处 tombstone 更新）；
4. 任何一次真正执行 `mergeWebdavEnvelopes` 的同步（另一台设备、或 etag 变化后的本机）都会以 `updatedAt > tombstone` 过滤词条 → **撤销恢复的词条被静默删除，并把删除继续传播给所有设备**。

单机 + etag 304 快路径不会触发（`remote` 保持 null、不走 merge），所以日常自测发现不了——这正是它危险的原因。

**修复规格（双端一致）**：复活时把词条的 `updatedAt` 抬到 tombstone 之上并删除本地 tombstone。只删 tombstone 不够——远端可能已持有同一时间戳的 tombstone 副本，merge 时按 `max` 合并回来；抬高 `updatedAt` 才能在合并语义下胜出。

- [x] **JS（`server.mjs` `saveLibrary`）**：在 `change(next.entries)` 之后、`JSON.stringify(next)` **之前**，扫描 next 中 id 命中 `webdavConfig.tombstones` 的词条：`entry.updatedAt = Math.max(Number(entry.updatedAt) || 0, tombstones[id] + 1)`，随后 `delete tombstones[id]`；有变更时与现有 deletedIds 逻辑一并写 `webdav.json`。放在 `saveLibrary` 里可同时覆盖 `replaceEntries`（撤销）与 `appendEntries`（导入旧备份复活）两条路径
- [x] **Rust（`src-tauri/src/lib.rs`）**：新增 `fn resurrect_tombstoned_entries(&mut self)`——同样的扫描/抬高/删除逻辑，在 `replace_entries` 与 `append_entries` 写库前调用，tombstones 有变更时写 `webdav.json`
- [x] **回归测试（`test/smoke.mjs`）**：在现有 WebDAV 用例后追加——删除词条 → sync → `PUT` 恢复快照 → sync → 解析 mock 服务器上的 `webdavBody`：断言词条在 `entries` 中、其 id 不在 `tombstones` 中、`updatedAt` 大于删除时刻
- [x] **回归测试（Rust）**：`#[test]` 直接验证 `resurrect_tombstoned_entries` 后 `merge_webdav_envelopes` 不再丢弃该词条
- [x] 跑 `npm run ci` 确认全绿

### 同轮次要发现（不阻塞提交）

- [ ] **[判断]** `stopRequest()` 在多请求并行时只取消「最近登记」的一个，停止按钮语义含糊——追问工作台阶段 3 会引入按 `entryId` 的精确取消，词库页是否同步收敛届时一起定
- [ ] **[判断]** WebDAV 密码一旦保存无法清空（留空 = 保留旧密码）。个人应用可接受；若要支持，加一个「清除凭据」次要按钮即可
- [ ] **[判断]** `submitFragment` 的 finally 不再把焦点交还输入框（并行化时移除）。连续录入场景需要多点一次输入框，确认这是有意取舍
- [ ] **[已验证]** 其余本轮改动无缺陷：词性/词形三处 schema（`server.mjs`/`lib.rs`/`docs/import-format.schema.json`）与 `required` 均已对齐；`strict: true` 陷阱已避开；排序比较器不变异 `state.entries`；`new-entry-notice` 的 XSS 插值点均经 `escapeHtml`；SW `v27/v30` 版本号三处一致；并行追问与 WebDAV 均有冒烟覆盖

---

## P0-B · 追问工作台与复习联动（`0.4.0` 核心特性）

设计依据：[`DESIGN.md`](./DESIGN.md)（2026-08-18 定稿版，**以它为权威规格**，本节是执行清单）。

**总体约束，实现前必读**：

1. **纯前端改动**——只动 `public/app.js`、`public/index.html`、`public/styles.css`。`server.mjs`、`lib.rs`、entry schema、API 一律不动；`cargo` 相关测试结果应与改动前完全一致。
2. 输入框与锚点浮层必须是 `index.html` 静态节点（DESIGN §3 关键架构事实）：`#timeline` 是 innerHTML 全量重渲染区，放进去会在每次 `render()` 时丢失输入与焦点。
3. 逐阶段提交，每阶段结束 `npm run check` 通过；不要一次性大 diff。

### 阶段 1 · 导航、状态与索引

- [ ] `index.html`：顶部与底部导航的 `data-view="starred"` 改为 `data-view="threads"`（文案「追问」，图标 `messages-square`）；收藏入口保留在筛选下拉（已存在，无需改动）
- [ ] `state` 新增 `selectedThreadEntryId: null`、`threadAnchorId: null`；全局 view 切换 handler（`document` click 委托里的 `[data-view]` 分支）**不要**重置这两个字段
- [ ] 写状态收敛函数（`render()` 开头调用）：两个 id 指向的词条不存在时置 null——覆盖删除、WebDAV 同步替换、恢复演示数据三条路径
- [ ] `filteredEntries()` 的 haystack 追加 thread 的 question/answer/summary（一行改动，`searchCache` 靠对象替换自然失效）
- [ ] `renderTimeline()` 增加 `threads` 分支 → `renderThreadIndex()`：数据为 `entries.filter(e => e.thread?.length)` 按最后一轮 `createdAt` 倒序；行显示词条名、`N 轮`、最后摘要（无 summary 用 question，单行截断）、`formatTime`；空态文案与返回按钮见 DESIGN §7.3
- [ ] `renderNavigation()`：`copy` 映射表加 `threads` 标题/副标题；搜索框在 threads view 保持可见（复用现有 hidden 逻辑）；`starred` 相关计数展示保持不变
- [ ] 手工验证：0 条 / 1 条 / 20 条 thread 词条的索引展示，搜索命中追问内容

### 阶段 2 · 理解笔记区（复用详情面板壳）

- [ ] `renderDetailPanel()`：`view === "threads"` 时改填 `renderThreadStudio(entry)`（`selectedThreadEntryId` 对应词条），可见性/backdrop/移动端逻辑全部沿用现有实现
- [ ] `renderThreadStudio`：头部（词条/音标/kind/释义/来源 + 「设为提问对象」+「打开词库详情」）、时间正序轮次（问标签 / 答正文 / `summary` 记忆结论条）、每轮「复制」「回退到此轮」（复用 `rewindThread`，最后一轮不显示回退，与 `renderThread` 现规则一致）
- [ ] 「▸ 查看完整词条」原生 `<details>`：把 `renderDetailPanel` 里 words/usage/chunks/AI 理解四段模板提取为可复用函数后引用，不复制粘贴
- [ ] 底部操作一行：复习（`isDue` 时）、再问一句；收藏/删除/改来源**不**进笔记区
- [ ] 回退全部轮次后的笔记区空态：「这个词条已回到原片段」+ 关闭
- [ ] 索引行点击 `open-thread` → 设 `selectedThreadEntryId` 并打开面板；不自动改 `threadAnchorId`

### 阶段 3 · 锚点输入、并行与停止

- [ ] `index.html` 新增静态 `#thread-composer`（anchor 区 + textarea + 发送/停止按钮）与 `#mention-popover`（内置 `#mention-search` 输入框 + `#mention-list`），threads view 之外隐藏
- [ ] 锚点选择器交互按 DESIGN §7.1 全量实现：`@`（空正文时）或按钮打开；浮层内搜索；`↑↓ Enter Escape`；`role="listbox"/"option"` + `aria-selected`；已有锚点时再次选择直接替换；外部点击关闭挂到现有全局 click 委托
- [ ] `activeRequests` 登记对象加 `entryId` 字段（新建片段为 null，追问为词条 id）；`submitFragment` 同步补上这个字段
- [ ] `submitThreadQuestion()` 按 DESIGN §7.2：无锚点抖动提示（不发请求、不 disabled）；发送后清正文留锚点；成功走「当前选中 → 就地刷新，否则 toast『已加入 1 条理解 · 查看』」；失败恢复正文与锚点；取消提示「已停止，内容未保存」
- [ ] 停止：`#thread-send` 在锚点词条有 pending 时变停止（只停该词条）；索引行/笔记区 pending 指示带 `stop-thread-request`，按 `entryId` 匹配 abort + Tauri `cancel_request`
- [ ] 手工验证（浏览器 + Tauri 各一遍）：A、B 两词条并行请求、分别停止、互不影响；同一词条连发两问都落库
- [ ] `renderAiState()` 的 processing 文案适配多请求（现有实现已按 `activeRequests.size` 显示，确认覆盖追问场景即可）

### 阶段 4 · 旧追问路径退役

- [ ] `data-action="continue"` 改为跳转 threads view + 双 id 预选 + 聚焦输入框
- [ ] 删除 `#context-bar` HTML、`state.activeThreadId`、`renderComposer()` entry 分支、`submitFragment` followup 分支、`newFragment()` 相关清理
- [ ] `grep -n "activeThreadId\|context-bar" public/` 零结果；词库/记录页 composer 只创建新片段

### 阶段 5 · 复习联动

- [ ] `renderReview()`：`reviewReveal` 后若词条有带 `summary` 的轮次，渲染「追问记忆」区——最近 2 条 summary + 淡色原问题；`<details>`「展开全部 N 轮」就地展开只读轮次（无回退/复制按钮）；无 summary 轮次跳过，全无则不渲染
- [ ] 评分行上方加「再问一句」→ 退出复习进入 threads + 预选 + 聚焦（复习会话照常重置）
- [ ] **[判断]** 键盘：未显示答案时 `1`=弱提示、`2`=强提示（与评分键无冲突）；若实现，同步 README 快捷键表
- [ ] 验证：复习全程（含展开摘要）无任何网络请求（DevTools Network 面板确认）

### 阶段 6 · 样式、响应式与收尾

- [ ] 新增 CSS 类见 DESIGN §9 清单，全部使用现有设计变量；深浅两主题各过一遍
- [ ] 移动端：composer sticky、popover 全宽 + 60vh 内滚动、slide-over 继承验证；窄窗口无横向溢出、pill 长词条截断
- [ ] `?v=` 版本号与 SW `CACHE` 同步 +1（`index.html` 两处 + `service-worker.js` 两处）
- [ ] 手工回归矩阵：0/1/2+ 轮追问、回退、删除、导入、WebDAV 同步中切换 tab、刷新、模型错误、网络失败、复习中点「再问一句」
- [ ] DESIGN §12 验收标准逐条勾验；`npm run ci` 全绿；浏览器版与 Tauri 版各完整走一遍
- [ ] README：导航说明、快捷键表（若做了提示快捷键）、特性一节补「追问工作台」

---

## P1 · 发布准备（0.3.2 遗留）

- [ ] 仓库设置里改为 **Public**
- [ ] 填 Description（可用 `package.json` 的 `description`）与 Topics（`language-learning` `spaced-repetition` `vocabulary` `local-first` `tauri` `openai-compatible`）
- [ ] 基于 `v0.3.2` 创建 Release，附上 `npm run app:build` 产出的 macOS `.dmg`
- [ ] 确认首页 CI 徽章变绿（转 public 后 Actions 才会对外可见）
- [ ] **[判断]** 删除已合并的 `codex/message-safety` 分支

> 转 Public 前确认 `origin/main` 已经是 0.3.2 —— 早期的 0.3.0 含未修复的 CSRF 漏洞，不要让它成为默认分支。
> 注意：当前工作区的 WebDAV / 词性词形 / 排序 / 复习提示改动属于 `0.4.0` 线，需在 **P0-A 修复后**才能提交；若想先发 0.3.2 Release，直接基于既有 tag 操作即可，不受工作区影响。

---

## P3 · 发版前必须实机验证

### CSP 在 Windows / Android 上是否够用

`tauri.conf.json` 的 csp 已包含 `connect-src 'self' ipc: http://ipc.localhost`，但**只在 macOS 上构建验证过**。

Tauri v2 在 Windows / Android 上 IPC 走自定义协议。若被 CSP 拦截，表现是**所有 `invoke` 静默失败、应用完全读不到数据**，而 CI 和 macOS 上一切正常 —— 这是清单里唯一一个自动化测不出来、且失败后果严重的项。

- [ ] 发 Windows 版前实机验证一次
- [ ] 发 Android 版前实机验证一次

---

## P4 · 已知未做，可接受

这些是当前体量下不值得增加复杂度的取舍，README 的「已知限制」一节已如实列出面向用户的部分。

- [ ] **[判断]** 前端虚拟滚动 —— 当前靠 `visibleLimit = 80` 兜底，万条以上词库才需要
- [ ] **[判断]** 迁移到 SQLite —— 双端已有写前脏检查，全量重写的压力已缓解
- [ ] **[判断]** 流式输出（SSE）—— 已明确撤掉，`parseSse` 仅保留作上游兼容容错
- [ ] **[判断]** `restoreEntries` 走全量 `PUT /api/entries`，词库大了以后一次撤销 = 序列化 + 落盘全量数据
- [ ] **[判断]** JSDoc + `checkJs`，在不改写为 TS 的前提下拿到类型检查
- [ ] **[判断]** 前端 0 测试（`public/app.js` 已 1500+ 行；追问工作台落地后优先考虑把 `threadedEntries` 排序、状态收敛等纯函数抽出用 `node:test` 覆盖）
- [ ] **[判断]** `"targets": "all"` 与实际能力不符（当前只在 macOS 验证过构建）
- [ ] **[判断]** `stableJitter` 是 `entry.id` 的纯函数，同一张卡每次复习抖动系数恒定。跨卡打散有效（主要目的已达成）；若想更均匀可 hash(`id` + `repetitions`)
- [ ] **[判断]** 界面仅有中文，未做 i18n
- [ ] **[判断]** `renderReview()` 在渲染中写 `state.reviewFocusId/reviewHint`（换卡时重置提示）——可用但属渲染副作用，重构时再收敛

---

## 建议执行顺序

1. **修 P0-A tombstone 复活缺陷 + 双端回归测试**——数据丢失级，先于一切
2. `npm run ci` 全绿后提交当前 `0.4.0` 线改动（WebDAV / 词性词形 / 排序 / 复习提示）
3. 追问工作台按阶段 1 → 6 实现（DESIGN.md 为权威规格），逐阶段提交
4. 0.3.2 的 GitHub 发布流程（P1）可与上述并行，基于既有 tag 操作
5. 出 Windows / Android 版时再做 P3

---

## 已结项

**[已验证]** 前六轮问题已全部修复并逐条核对，不再重复审阅。

### 第六轮 —— 发布准备（0.3.2）
- ✅ `capitalizeWord` / `capitalize_word` 加「整词全小写才大写首字母」守卫，iPhone/eBay/macOS/URL/CJK 原样保留；Rust `capitalization_preserves_intentional_casing` + smoke `iPhone` 端到端断言双覆盖
- ✅ 三张真实截图入 `docs/screenshots/` 并替换 README「界面」一节
- ✅ TODO.md 保留在根目录，便于透明审计
- ✅ `lint:encoding`（U+FFFD 扫描）加入 `npm run check`
- ✅ 浏览器版首页路由 —— API 信任校验只作用于 /api/*，直接访问 / 返回前端页面
- ✅ **`LICENSE`** —— 从 gnu.org 取的官方 AGPL-3.0 全文（661 行），非手写
- ✅ **`package.json` 元数据** —— `description` / `license: AGPL-3.0-only` / `repository` / `homepage` / `bugs` / `keywords`，保留 `private: true` 防误发 npm
- ✅ **README 重写** —— 徽章、动机、特性、安装、AI 配置、数据与隐私、快捷键、开发、已知限制、License。全部事实已对照代码核验（端口、快捷键、四档评分、推理强度五档、字号区间、环境变量全集、数据路径）

### 第五轮 —— 词条呈现与 schema 扩展
- ✅ `words[].context` / `words[].usage` 进 schema 且 `required` 同步，拆分条目不再复制整句语境、也不再丢弃例句
- ✅ `loadLibrary` 改为深比较后再写，比只看 `version` 更准确且幂等
- ✅ 单词首字母大写：全小写词首字母大写，已含大写字母的专有名词原样保留

### 第四轮 —— word_list 拆分数据损坏 + CI
- ✅ **拆分路径改为按内容认领**：`claimOriginal` 三级降级（模型给的 `original` → 精确匹配 → 编辑距离 ≤2 → 不猜）。四个实测场景（AI 少返词 / 词形还原 / 顺序重排 / 真拼写错）全部正确
- ✅ **批内去重收窄到 `displayKey`**，不再因 raw/display 交叉碰撞而丢词
- ✅ **`words[].original` / `words[].correction` 进 prompt 与 schema**，`required` 已同步（`strict: true` 的陷阱已避开）
- ✅ **clippy 修复**（`map_or(true, ..)` → `is_none_or(..)`）并通过 `-D warnings`
- ✅ **`npm run ci` 单一闸门**，CI workflow 收敛为一条命令 —— 从根上杜绝「加了 CI 步骤没本地跑」
- ✅ **CI 加 `Swatinem/rust-cache@v2`**；`cargo test --release` 换成更省时的 `cargo build --release`
- ✅ **能力协商缓存加 30 分钟 TTL**（双端），偶发 400 不再永久降级 provider
- ✅ **`chat_template_kwargs` 改为 provider 显式开关**，删除无效的 URL 猜测
- ✅ **word_list 全命中时跳过 AI 调用**，反复粘贴同一份词表不再浪费额度

### 第三轮 —— fmt / 拆分基础 / 回退顺序
- ✅ `cargo fmt --check` 通过；拆分保留原始输入与词级 correction；`.reverse()` 移除
- ✅ 能力协商缓存引入；回退顺序改为先丢 reasoning 再丢 schema
- ✅ ESLint 接 `js.configs.recommended` + `globals` 包

### 第二轮 —— 流式 / fuzz / 竞态 / 错误分类
- ✅ `stream: true` 双端移除；fuzz 改为基于 `entry.id` 的 `stableJitter`（FNV-1a）
- ✅ Rust `commit_new_entry` 补查重，TOCTOU 已堵
- ✅ `ApiError` 在抛出点携带 status；`SyntaxError → 400` 误映射已修
- ✅ `MAX_OUTPUT_TOKENS` 提高 + 检测 `incomplete_details`
- ✅ `resolveDataRoot()` 三平台映射抽出共用；`forceNew` 出口；撤销 toast 延长到 8 秒

### 第一轮 —— 安全 / 架构 / 产品
- ✅ **P0 安全全部封堵**：`trustedApiRequest`（Host 白名单 + `X-Shici` 强制预检 + `Sec-Fetch-Site` + Origin）、`/api/models` 跨 baseUrl 不复用密钥、`/api/explain` 删除。PoC 复验返回 403，攻击者服务器收到 0 条记录
- ✅ `system-prompt.txt` 单一来源；`library.json` version 双端统一；共享 fixture
- ✅ SW `ignoreSearch: true`；Rust 全局锁拆为 prepare/commit；Windows 非原子写修复；状态码 400/404/502
- ✅ JSON Schema structured outputs；429/5xx 指数退避；双端写前脏检查；搜索 `WeakMap` 缓存 + 150ms 防抖
- ✅ 导入 JSON、重复检测、`leech` 顽固词、`confirm()` 全替换为撤销 toast、`#timeline` 的 `aria-live` 移除

---

## 确认无问题的部分

以下已逐点检查，历轮均未发现缺陷：

- **XSS 防护**：`escapeHtml` 覆盖所有 `innerHTML` 拼接点；属性插值的 id 均经 `^[\w-]{1,80}$` 校验（第七轮复核了 `new-entry-notice`、排序下拉、词性/词形渲染的新增插值点）
- **路径穿越**：`serveFile` 的 `decodeURIComponent` + `normalize` + 前缀校验组合有效
- **密钥不回传前端**：`publicConfig` 只暴露 `hasApiKey` 布尔值；WebDAV 同理只回 `hasPassword`，`smoke.mjs` 有断言
- **文件权限**：目录 `0700`、文件 `0600`，双端一致；`webdav.json` 沿用 `writePrivateJson`
- **`.gitignore`**：`.local/`、`src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`.env*` 均正确忽略
- **全历史无密钥泄漏**：`sk-` / `ghp_` / `AKIA` / `AIza` / `xox*` 全历史扫描，唯一命中是审计文档里的假占位符；`.local/` 从未进入过版本历史
- **无构建产物入库**：`.DS_Store` / `target/` / `node_modules/` / `gen/` 均未跟踪
- **版本号一致**：`package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 四处均为 `0.3.2`
- **请求取消**：前端 AbortController + 后端 signal 透传链路完整，`smoke.mjs` 有覆盖；并行 follow-up 落库有专项断言
- **CORS 预检**：对不带 `X-Shici` 的 OPTIONS 返回 403 且无 CORS 头 → 浏览器阻断，实际请求不会发出
- **`reasoningEffort` 默认值**：双端默认 `"auto"`，此时不发送任何 reasoning 相关参数
- **`normalizeWordCorrection`**：用 `normalizeToken` 归一化比较，大小写差异不会产生假的「已纠正」记录
- **`cleanEntry` 幂等性**：重复执行结果稳定（含新增 `partOfSpeech`/`forms` 字段），`loadLibrary` 的深比较不会导致每次启动重写
- **WebDAV 防护面**：URL 仅 http/https、拒绝内嵌凭据、路径过滤 `..` 与控制字符、拒绝重定向、25 MB 读取上限、etag 条件请求（tombstone 复活缺陷见 P0-A，属合并语义而非防护面）
