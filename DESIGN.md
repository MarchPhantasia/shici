# 拾词 · 追问工作台（语言研究台）设计

状态：定稿，待实现
日期：2026-08-18（在 2026-08-17 提案基础上按现有代码与「简单优先」原则修订）
关联：[`TODO.md`](./TODO.md)「P0 · 追问工作台与复习联动」
实现约定：本文档是实现的权威规格。与旧提案冲突之处，以本文档为准。**本特性是纯前端改动**：不改 `server.mjs`、不改 `src-tauri/src/lib.rs`、不改 entry schema、不新增 API——所需的后端能力（follow-up 创建/回退、并行提交、请求取消）已全部存在并有冒烟测试覆盖。

## 1. 产品命题

拾词不只是把「不会的内容」存进词库，也应该把用户后来想明白的过程留下来。一个词条是一个学习锚点，词条下的每轮追问是对这个锚点逐步加深的理解。复习时，用户先回忆，再在恰当的时机看到这些理解，而不是重新翻一段长聊天记录。

因此追问成为独立 tab，但它不是泛用聊天页，而是一个**语言研究台**：所有问题必须挂在已有词条上，内容以词条、结论和可复用的理解片段组织，聊天只是输入方式。

## 2. 范围裁定

### 目标

- 用户能找到「我曾经追问过什么」，并按词条继续研究。
- `thread[].summary` 成为复习中的高价值提示，而不是只躺在详情页底部。
- 通过锚点选择器快速定位词条，杜绝无锚点的孤立提问。
- **零后端改动、零数据迁移**：完全复用现有 `entry.thread`、follow-up API 与请求取消机制。

### 保留原提案的核心决策（这些是产品的骨架，实现时不得偏离）

- 追问是独立 tab，但**不是泛用聊天页**——所有问题必须锚定在已有词条上，内容以词条、结论、可复用理解片段组织。
- 第一版**单锚点**：一个问题只绑定一个词条，避免上下文和复习归属不清。
- **完全复用现有 follow-up API 与数据结构**，不新增 AI 请求类型、不做数据迁移。
- `thread[].summary` 进入复习流：答题后展示摘要而非整段聊天记录；复习过程零 AI 调用。
- 三层结构：锚定输入区（顶部固定）→ 追问索引（窄而可扫描）→ 理解笔记区（连续笔记流，不用左右对话气泡）。
- 「收藏」退出一级导航，让位给「追问」；收藏经筛选下拉与详情操作到达。
- 发送后保留锚点、并行处理多个词条、每个词条独立 pending/停止、失败保留输入不污染 `thread`。

### 明确不做（含对原提案的修订裁剪，均为降低实现复杂度的主动决定，原样保留划线部分供对照）

- 不做没有词条锚点的通用聊天；一个问题只绑定一个词条。
- 复习过程中不调用 AI；复习卡只展示摘要，完整内容按需展开。
- ~~索引的多种排序（最近更新/轮数/待复习/收藏）~~ → V1 固定按最近追问时间排序，搜索复用全局搜索框。排序留给 V1.1。
- ~~复习摘要「按与当前词义相关的顺序」排列~~ → 相关性无从计算（不调 AI），直接取**最近 2 条**。
- ~~「展开全部」用底部 sheet / 侧面 sheet~~ → 复习卡内用原生 `<details>` 就地展开，不新建浮层组件。
- ~~在输入正文里解析 `@词条` 文本~~ → 锚点是独立于正文的 UI 状态（pill + 选择浮层），发送的正文永远不含 `@` 标记，省掉全部光标解析。
- ~~切换 tab 保留滚动位置~~ → 与现有 tab 行为一致（切换即重置）；只保留 `selectedThreadEntryId` 这一项廉价状态。
- 不为追问 tab 单独放模型选择器；模型切换沿用词库页/设置里的入口。

## 3. 现状盘点（实现直接依赖的既有设施）

实现前先读懂这张表，**全部复用，不要重写**：

| 既有设施 | 位置 | 在本特性中的角色 |
| --- | --- | --- |
| `POST /api/entries/:id/followups` | `server.mjs` / `lib.rs`（双端已实现） | 唯一的提问接口；并行提交安全性已由 `test/smoke.mjs` 的 `parallel-a`/`parallel-b` 用例验证 |
| `PATCH /api/entries/:id/followups` + `rewindThread()` | `app.js` | 回退到某轮/清空，含确认弹窗与撤销 toast，原样复用 |
| `state.activeRequests`（Map）+ `requestId` + `stopRequest()` | `app.js` | 并行请求登记与取消的骨架；本特性为它补上 `entryId` 维度 |
| 详情面板壳（`#detail-panel` / `#detail-backdrop` / `.workspace.detail-visible`） | `index.html` / `app.js` `renderDetailPanel()` | 追问笔记区**直接复用这套双栏/移动端 slide-over 布局**，不新建两栏 grid |
| `#capture-page` 的「按 view 显示静态区块」模式 | `index.html` / `renderNavigation()` | 追问 tab 的输入区照此模式做成静态节点 |
| `toast(message, action)` 带操作按钮 | `app.js` | 「已加入 1 条理解 · 查看」通知，零新组件 |
| 全局搜索框 + `searchCache`（WeakMap） | `app.js` `filteredEntries()` | 追问索引的搜索；需把 thread 文本并入 haystack |
| 复习提示（`state.reviewHint` 弱/强提示） | `app.js` `renderReviewHint()`（本轮已实现） | 答题前提示已存在；本特性只加「答题后」的追问摘要区 |
| `renderThread()` / `renderWords()` / `formatTime()` | `app.js` | 笔记区与复习展开的内容渲染基础 |

关键架构事实：**整个应用是 innerHTML 全量重渲染模型**（`render()` → `renderTimeline()` 重写 `#timeline`）。因此：

1. 追问 tab 的索引列表放进 `#timeline` 重渲染，完全没问题（与词库列表同款）。
2. **输入框和锚点选择浮层绝不能放进 `#timeline`**——任何一次 `render()` 都会摧毁输入中的文字与焦点。它们必须是 `index.html` 里的静态节点，按 view 显示/隐藏（现成先例：`#capture-page`、`#composer`）。

## 4. 信息架构

顶部与移动端导航改为：`记录`、`词库`、`追问`、`复习`。「收藏」退出一级导航——筛选下拉里已有「收藏 (N)」项，详情页的收藏操作不变。

追问 tab 桌面布局 = 现有词库页的同构复用：`#timeline` 里放索引列表，选中后用详情面板壳打开笔记区（桌面双栏、移动端 slide-over + backdrop 全部自动继承）。

```text
┌ 追问 ────────────────────────────────────────────────────────────┐
│ [@ Despite ×] 还想弄明白什么？                        [发送/停止] │  ← 静态节点 #thread-composer
├──────────────────────────┬───────────────────────────────────────┤
│ 追问索引（#timeline 内）   │ 笔记区（#detail-panel 壳内）            │
│ 搜索：复用全局搜索框       │ Despite  /dɪˈspaɪt/ · 介词 · 尽管       │
│                          │ ────────────────────────────────      │
│ • Despite          2 轮  │ 问  后面不加从句是什么意思？             │
│   despite 后接名词…      │ 答  ……                                 │
│   2 分钟前               │ ◆ 记忆结论  despite 后接名词或动名词      │
│ • Suffocating      1 轮  │ 问 / 答 / ◆ 记忆结论 …                  │
│ • Wake-up call     2 轮  │ ▸ 查看完整词条（折叠：例句/拆解/AI 理解） │
│                          │ [复习] [再问一句]                       │
└──────────────────────────┴───────────────────────────────────────┘
```

## 5. 状态与数据

**entry schema 不变，`localStorage` 不新增键，一切均为运行时状态或客户端派生。**

`state` 新增三个字段：

```js
view: "threads",              // 加入现有 "all" | "starred" | "review" | "capture" 集合
selectedThreadEntryId: null,  // 笔记区当前词条；切换 tab 不清空，词条被删除时清空
threadAnchorId: null,         // 输入区当前锚点；与 selectedThreadEntryId 独立（可以边看 A 边问 B）
```

`activeRequests` 的登记对象从 `{ id, controller }` 扩展为 `{ id, controller, entryId }`：新建片段时 `entryId: null`，追问时为目标词条 id。这是索引行 pending 态、按词条停止、发送按钮状态三者的共同数据源。

派生数据（每次渲染时现算，词条量在千级以下无需缓存）：

```js
const threadedEntries = () => state.entries
  .filter((entry) => entry.thread?.length)
  .sort((a, b) => (b.thread.at(-1)?.createdAt || 0) - (a.thread.at(-1)?.createdAt || 0));
```

搜索：`filteredEntries()` 中构建 haystack 的那一行，追加 `...(entry.thread || []).flatMap((turn) => [turn.question, turn.answer, turn.summary])`。`searchCache` 以 entry 对象为键，词条更新后对象被替换、缓存自然失效，无需手动清理。

一致性规则（都写在同一处收敛函数里，`render()` 开头调用）：

- `selectedThreadEntryId` / `threadAnchorId` 指向的词条不存在时（被删除/被同步移除）→ 置 null。
- 词条的 `thread` 被清空（回退到原片段）后，它退出索引，但仍可作为锚点继续提问。

## 6. 静态 HTML 变更（`index.html`）

1. 顶部导航与底部导航：`data-view="starred"` 按钮改为 `data-view="threads"`（图标建议 `messages-square`），文案「追问」。
2. 新增静态区块 `#thread-composer`（结构对齐 `#capture-composer` 的外观语言）：
   - `#thread-anchor`：无锚点时是一个按钮「@ 选择词条」；有锚点时渲染 pill（词条名 + `×` 移除按钮）。
   - `#thread-input`：textarea，placeholder「选择一个词条，继续追问…」。
   - `#thread-send`：发送/停止按钮，行为规格见 §7.2。
3. 新增静态浮层 `#mention-popover`（初始 `hidden`）：内含**自己的搜索输入框** `#mention-search` 和结果列表 `#mention-list`。浮层自带搜索框是本设计的关键简化——不解析 textarea 光标位置，不做富文本。
4. 复习卡不需要动静态 HTML（追问摘要在 `renderReview()` 字符串里生成）。
5. 版本号：`styles.css` / `app.js` / service-worker 的 `?v=` 与 `CACHE` 常量按现有惯例同步 +1。

## 7. 交互规格

### 7.1 锚点选择器

- 打开方式：点击「@ 选择词条」按钮；或焦点在 `#thread-input` 且**正文为空**时键入 `@`（该字符不进入正文）。
- 打开后焦点进入 `#mention-search`；列表默认顺序：有追问的词条在前（按最近追问排序），其余按 `createdAt` 倒序；每行显示 `displayText`、kind 标签、释义首行、轮数（有则显示）。
- 搜索复用 haystack 逻辑；结果上限 20 行，超出提示「继续输入以缩小范围」。
- 键盘：`↑`/`↓` 移动高亮，`Enter` 选中，`Escape` 关闭；行元素带 `role="option"` 与 `aria-selected`，列表容器 `role="listbox"`。
- 选中后：`threadAnchorId = entry.id`，关闭浮层，焦点回到 `#thread-input`。
- 已有锚点时再次触发 `@`：直接打开浮层，选中即**替换**当前锚点（比旧提案的「请先移除」少一步，且无歧义——单锚点语义下替换就是用户意图）。
- 点击浮层外部关闭（挂在现有的全局 click 委托上，参照 `closeCustomSelects` 的处理）。
- 从详情页「追问」、复习卡「再问一句」进入时自动预选锚点（见 §7.4/§8）。

### 7.2 发送、并行与停止

- 无锚点时点发送：不发请求，输入区抖动一次并显示内联提示「先用 @ 选择一个词条」；`#thread-send` 不做 disabled（disabled 无法解释原因，点击反馈更友好）。
- 发送流程 `submitThreadQuestion()`：
  1. `pending = { id: crypto.randomUUID(), controller, entryId: threadAnchorId }` 登记进 `activeRequests`；
  2. `POST /api/entries/{entryId}/followups`，body `{ text }`，带 `signal` 与 `requestId`（Tauri 取消链路需要，参照 `submitFragment`）；
  3. **发送后立即清空正文、保留锚点**，用户可以换词条继续问（并行）；
  4. 成功：用返回的 entry 替换 `state.entries` 对应项；若该词条正是 `selectedThreadEntryId` 则重渲染笔记区；否则 `toast("已加入 1 条理解", { label: "查看", run: () => 选中该词条并渲染 })`；
  5. 失败（网络/模型/404）：`toast(错误信息)` 并**把正文和锚点恢复到输入区**供重试；被取消：toast「已停止，内容未保存」。后端保证失败不写入半截 thread（现状已如此）。
- 停止语义（修正现状 `stopRequest()` 只停「最近一个」的含糊行为）：
  - `#thread-send` 在**当前锚点词条有 pending 请求**时变为停止按钮，点击只取消该词条的请求；
  - 索引行与笔记区头部的 pending 指示器（thinking-dots）各带停止按钮，`data-action="stop-thread-request" data-id="{entryId}"`，按 `entryId` 匹配 `activeRequests` 逐个 abort，并调用 `cancel_request`（Tauri）；
  - 词库/记录页的原发送按钮维持现状（停最近一个），不在本特性范围内扩展。
- 同一词条允许并行提问（后端已验证安全），不做前端限制。

### 7.3 追问索引与理解笔记

- `renderTimeline()` 增加 `view === "threads"` 分支 → `renderThreadIndex()`：
  - 空态（无任何 thread）：「还没有追问。去词库打开一个词条，或用上方 @ 直接开始。」+ 返回词库按钮；
  - 行内容：`displayText`、`N 轮`、最后一轮 `summary`（无则用 `question`，CSS 单行截断）、`formatTime(最后一轮 createdAt)`、pending 指示器；
  - 行点击 `data-action="open-thread"` → 设置 `selectedThreadEntryId`（不自动改锚点），打开笔记区。
- 笔记区复用详情面板壳：`renderDetailPanel()` 在 `view === "threads"` 时改调 `renderThreadStudio(entry)` 填充 `#detail-content`（可见性判断沿用现有 `detailClosed/detailOpened/mobile` 逻辑，删掉其中 `view !== "review"` 之外对 threads 的阻拦）：
  - 头部：`displayText`、音标、kind、`meaning`、来源；操作「设为提问对象」（`threadAnchorId = id` + 聚焦输入框）与「打开词库详情」（切到词库 view 并打开该词条详情，参照 `open-new-entry` 的实现）；
  - 轮次列表：时间正序；「问」小号标签 + 正文，「答」主体正文，`summary` 渲染为记忆结论条（视觉延续现有 `.ai-explanation` 的强调语言，用玫瑰/淡蓝底）；
  - 每轮操作：复制（`navigator.clipboard.writeText`，降级 `execCommand`）、回退到此轮（复用 `rewindThread(entry, turnId)`，含确认与撤销）；最后一轮不显示回退（与现状 `renderThread` 的规则一致）；
  - 「▸ 查看完整词条」：原生 `<details>`，展开渲染现有 `renderWords`/例句/拆解/AI 理解各节（直接复用 `renderDetailPanel` 里那几段模板的提取函数）；
  - 底部操作一行：复习（若 `isDue`）、再问一句。收藏/删除/改来源留在词库详情，不在笔记区重复。

### 7.4 旧路径退役（必做，避免同一功能两个入口）

现有「追问」按钮（`data-action="continue"`）走的是词库页 composer + `activeThreadId` 上下文条（`#context-bar`）。本特性落地后：

- `continue` 动作改为：`view = "threads"`、`selectedThreadEntryId = threadAnchorId = entry.id`、聚焦 `#thread-input`；
- 删除 `#context-bar` 相关 HTML、`state.activeThreadId`、`renderComposer()` 中的 entry 分支、`submitFragment` 中的 followup 分支与 `newFragment()` 的相关清理——词库/记录页的 composer 回归**只创建新片段**的单一职责；
- 全仓 grep `activeThreadId` 确认零残留。

## 8. 复习联动

答题前的弱/强提示已在本轮实现（`renderReviewHint`），不动。新增两点：

1. **答题后追问摘要**：`state.reviewReveal === true` 且词条有 thread 时，`review-answer` 之后渲染「追问记忆」区：
   - 取**最近 2 条**有 `summary` 的轮次（无 summary 的轮次跳过；全都没有则不渲染该区）；
   - 每条：summary 正文 + 淡色的原问题一行（帮助回忆当时的困惑点）；
   - 「展开全部 N 轮」：原生 `<details>` 就地展开只读完整轮次（问/答/结论，无回退/复制按钮——复习流内不做管理操作）；
   - 全程零 AI 调用、零网络请求（数据都在 `state.entries` 里）。
2. **再问一句**：评分按钮行上方加次要按钮「再问一句」→ 退出复习进入追问 tab、预选锚点与笔记区、聚焦输入框。复习会话状态照常重置（与现有退出复习行为一致，不做会话恢复）。

键盘（可选增强，实现成本一行判断）：未显示答案时 `1` = 弱提示、`2` = 强提示（此时评分键尚未启用，无冲突）；`Space` 显示答案后 `1`–`4` 恢复评分语义。若实现，同步更新 README 快捷键表。

调度不变：本特性不改 `scheduleReview`、不记录提示使用情况。若未来需要，再在 review 事件中加 `hintLevelUsed`（V1 不做）。

## 9. 响应式与样式

- 双栏/slide-over/backdrop/窄屏行为全部继承详情面板壳，无新增布局系统。
- `#thread-composer` 移动端 sticky 顶部（参照 `#capture-composer` 的现有处理）；`#mention-popover` 在移动端全宽、最大高度 60vh 内滚动。
- 视觉语言沿用原提案：延续当前天蓝、白、粉的清新主题——细玫瑰色锚点线、浅蓝信息底、粉色记忆结论条、低强度阴影；深色主题只切换背景与文字层级，不给每个组件加粉色描边。
- 新增 CSS 类见下方清单，全部使用现有设计变量，不引入新色值：`.thread-composer`、`.thread-anchor-pill`、`.mention-popover`、`.mention-option`、`.thread-index-row`、`.thread-turn-note`、`.thread-summary-bar`、`.review-thread-recall`。
- 验证项：长词条名的 pill 截断、无横向溢出、`✗`/pending 指示并存时索引行不换行。

## 10. 边界与错误

| 场景 | 行为 |
| --- | --- |
| 锚点词条在浮层打开期间被删除（同步/撤销） | 收敛函数置空 `threadAnchorId`，pill 消失，提示「词条已不存在」 |
| 追问请求进行中词条被删除 | 后端返回 404 → toast 错误 + 恢复输入；`activeRequests` 正常清理 |
| 追问请求进行中用户回退该词条 | 后端写队列串行，两个结果都合法；以最后返回的 entry 状态为准 |
| WebDAV 同步替换 `state.entries` | 收敛函数校验两个 id；索引/笔记区随 `render()` 自然刷新 |
| 回退全部轮次后 | 词条退出索引；若它是 `selectedThreadEntryId`，笔记区显示「这个词条已回到原片段」+ 关闭按钮 |
| 复习卡词条 thread 为空 | 不渲染「追问记忆」区（大多数词条走这条路，是默认路径） |
| 演示模式（未配置 AI） | follow-up 返回演示应答（后端现状），流程不特殊处理 |

## 11. 分阶段范围

**V1（本次实现的全部）**：§4–§10。
**V1.1（本次不做）**：索引排序选项；某条 summary 标记「重点理解」并在复习中优先；轻量统计。
**不做**：多词条交叉追问、跨词条引用/知识图谱、追问参与排程、新存储表或同步协议变更。

## 12. 验收标准

1. 词库详情点「追问」或复习卡点「再问一句」，1 次点击后已处于追问 tab、锚点与笔记区就绪、光标在输入框。
2. 空正文键入 `@` → 全键盘（输入、`↓`、`Enter`）选中词条并发送成功；无锚点点发送不产生任何网络请求且有可见提示。
3. 词条 A 请求进行中，切换锚点向词条 B 发送：两个请求并行、索引行各自显示 pending、可分别停止；停止 A 不影响 B（浏览器版与 Tauri 版都要验证，Tauri 走 `cancel_request`）。
4. 复习「显示答案」前无任何网络请求；显示答案后有追问的词条出现至多 2 条摘要，`<details>` 可展开全部轮次，全程无 AI 调用。
5. 删除词条、回退全部轮次、WebDAV 同步、刷新页面后：索引与词库一致、无悬空选中态、无控制台报错。
6. `grep -n activeThreadId public/app.js public/index.html` 无结果；`#context-bar` 已删除。
7. 桌面窄窗口与移动端：无横向溢出、无永久空白右栏、composer 不遮挡正文。
8. `npm run ci` 全绿（本特性不触后端，Rust 测试不应有任何变化）。

## 13. 建议实现顺序

对应 `TODO.md` 的阶段拆分：先修 P0 数据 bug（与本特性无关但必须先行），然后 阶段 1 导航与索引 → 阶段 2 笔记区 → 阶段 3 锚点输入与并行 → 阶段 4 旧路径退役 → 阶段 5 复习联动 → 阶段 6 收尾验收。每个阶段结束跑 `npm run check`，全部完成跑 `npm run ci` 与手工矩阵。
