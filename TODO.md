# 拾词 · 待修复清单

第一轮审阅：2026-08-16 · 基线 `0.3.1`
第二轮审阅：2026-08-16（codex 首次修复后复审）
第三轮审阅：2026-08-16（codex 二次修复后复审）
第四轮审阅：2026-08-16（codex 三次修复后复审）
第五轮审阅：2026-08-16（本轮逐条核对并修复）

**验证状态**
| 命令 | 结果 |
|---|---|
| `npm run ci`（临时 `CARGO_TARGET_DIR`） | ✅ 通过 |
| `npm run check`（含 lint） | ✅ 通过 |
| `npm test` | ✅ 通过 |
| `cargo fmt -- --check` | ✅ 通过 |
| `cargo test --no-default-features` | ✅ 6/6 |
| `cargo build --no-default-features --release` | ✅ 通过 |
| `cargo clippy --no-default-features -- -D warnings` | ✅ 通过 |

> 标注：**[已验证]** = 实际运行或代码逐行确认；**[判断]** = 设计取舍，由你决定。
> 正文保留每轮复核的证据；本轮已处理项以 `[x]` 标记。前三轮完成情况见文末「已结项」。
> 本轮逐条核对后，P0–P2 的可验证问题均已修复；P3 已补 CSP 配置但仍需 Windows / Android 实机确认，P4 保留为后续取舍。

---

## P0 · 数据损坏（最高优先级）

### 1. word_list 拆分的「按下标对齐」会产生错误的词条和虚构的纠错记录

`server.mjs` 拆分路径与 `src-tauri/src/lib.rs` 同构逻辑：

```js
const originalParts = wordParts(payload.text);
const entries = splitWords.map((word, index) => {
  const text = cleanText(word?.text, 200);
  const raw  = cleanText(originalParts[index] || text, 200);   // ← 假设下标一一对应
  correction: raw.toLocaleLowerCase() === text.toLocaleLowerCase() ? "" : `${raw} → ${text}`,
```

`splitWords` 来自 **AI 返回的 `result.words`**，`originalParts` 来自 **用户输入的切分**。两者的**长度和顺序都没有任何契约保证** —— `system-prompt.txt` 只说 "words contains every word separately"，从未要求保持输入顺序或数量一致。

#### [已验证] 四个场景实测

```
【A. AI 少返回一个词（不认识 xyzzy）】
  输入: "apple, xyzzy, banana"   AI words: [apple, banana]
     raw="apple"     display="apple"     correction=""
     raw="xyzzy"     display="banana"    correction="xyzzy → banana"   ← 虚构的纠错

【B. AI 做了词形还原（不是拼写纠错）】
  输入: "running, jumped"        AI words: [run, jump]
     raw="running"   display="run"       correction="running → run"    ← 误报为拼写错误
     raw="jumped"    display="jump"      correction="jumped → jump"

【C. AI 重排了顺序（按字母序）】
  输入: "cherry, apple, banana"  AI words: [apple, banana, cherry]
  → 入库 1 条 / 复用 2 条
     raw="cherry"    display="apple"     correction="cherry → apple"
     （三条 returned 全指向同一条错误记录，apple 与 banana 直接丢失）

【D. 顺序一致 + 真拼写错（happy path）】
  输入: "alpha, betta"           AI words: [alpha, beta]
     raw="betta"     display="beta"      correction="betta → beta"     ← 正确
```

**只有 D 是对的。** 场景 C 尤其糟：用户录 3 个词，库里只留下 1 条，且内容完全错误。

#### 为什么 C 会退化成 1 条 —— `seen` 双键去重放大了错位

本轮新加的批内去重同时用 `rawKey` 和 `displayKey` 作为 Map 键：

```js
seen.set(rawKey, entry);
seen.set(displayKey, entry);
// ...
const duplicate = seen.get(rawKey) || seen.get(displayKey) || libraryEntries.find(...)
```

错位之后，第 2 条的 `raw`（= "apple"）正好等于第 1 条的 `displayText`（= "apple"）→ 判为重复 → 丢弃。第 3 条同理。**去重逻辑本身没错，是被上游的错位喂了脏数据。**

#### 解决方案

**① 立即止血（约 15 行，双端）—— 放弃下标对齐，改为按内容匹配**

```js
const normalizeToken = (value) =>
  String(value || "").toLocaleLowerCase().replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+$/gu, "");

function editDistance(a, b) {            // 经典 DP，词长很短，成本可忽略
  const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
  for (let j = 0; j <= b.length; j += 1) d[0][j] = j;
  for (let i = 1; i <= a.length; i += 1)
    for (let j = 1; j <= b.length; j += 1)
      d[i][j] = Math.min(d[i-1][j] + 1, d[i][j-1] + 1, d[i-1][j-1] + (a[i-1] === b[j-1] ? 0 : 1));
  return d[a.length][b.length];
}

// 为每个 AI 返回的词，从未被认领的原始 token 里挑最匹配的一个
function claimOriginal(originalParts, used, text) {
  const target = normalizeToken(text);
  let index = originalParts.findIndex((part, i) => !used.has(i) && normalizeToken(part) === target);
  if (index < 0) {                       // 退而求其次：编辑距离 ≤2 视为同一个词的拼写变体
    let best = -1, bestDistance = 3;
    originalParts.forEach((part, i) => {
      if (used.has(i)) return;
      const distance = editDistance(normalizeToken(part), target);
      if (distance < bestDistance) { bestDistance = distance; best = i; }
    });
    index = best;
  }
  if (index < 0) return "";              // 认领不到就不猜
  used.add(index);
  return originalParts[index];
}
```

调用处：

```js
const used = new Set();
const entries = splitWords.map((word) => {
  const text = cleanText(word?.text, 200);
  const claimed = claimOriginal(originalParts, used, text);
  const raw = claimed || text;                                    // 认领不到就用 AI 的形式
  const correction = claimed && normalizeToken(claimed) !== normalizeToken(text)
    ? `${normalizeToken(claimed)} → ${normalizeToken(text)}`      // 与非拆分路径同样做归一化
    : "";
  // ...
});
```

对照四个场景的预期结果：
- A：`xyzzy` 认领不到（与 banana 距离 6）→ banana 的 `raw="banana"`、`correction=""`，不再虚构
- B：`running`→`run` 距离 4 > 2 → 不认领 → `correction=""`，不再误报（`raw` 会退成 `run`，用 ② 可彻底解决）
- C：按内容各自认领到正确的原始 token → 3 条全部正确入库
- D：`betta`→`beta` 距离 1 → 认领 → `correction="betta → beta"` 保持正确

**② 根治（推荐，稍后做）—— 让模型直接给出归属，代码不再猜**

`system-prompt.txt` 的 words 项加两个字段，`responseSchemas.new.properties.words.items` 同步：

```jsonc
"words": [{ "text": "", "original": "", "correction": "", "pronunciation": "", "meaning": "" }]
```
prompt 补一行：
```
- words[].original must echo the exact input token this word came from, verbatim.
  Use "" when the word cannot be attributed to a single input token.
- words[].correction is non-empty ONLY for genuine spelling errors, not for
  lemmatization or case normalization.
```
然后 `raw = cleanText(word.original) || claimOriginal(...) || text`，`correction = cleanText(word.correction)`。
这样场景 B 也能拿到 `raw="running" / display="run" / correction=""` —— 保留原文又不误报。

> 注意：`strict: true` 的 json_schema 要求 `required` 列全所有 properties，加字段时记得同步 `required` 数组，否则结构化输出会直接 400。

**③ 收窄批内去重的键**

```js
// 只用 displayText 做批内去重；与已有库比对时才 raw/display 双向
const duplicate = forceNew ? null
  : seen.get(displayKey)
  || libraryEntries.find((item) => [item.raw, item.displayText]
      .some((value) => [rawKey, displayKey].includes(value.trim().toLocaleLowerCase())));
// ...
seen.set(displayKey, entry);              // 不再 seen.set(rawKey, entry)
```

**④ 补回归测试** —— 把上面 A/B/C/D 四个场景写进 `test/smoke.mjs`，mock 返回乱序/缺词/词形还原的 `words`，断言 `raw` / `correction` / `createdCount`。Rust 侧对 `claim_original` 加单测。

- [x] ① 按内容匹配替代下标对齐（`server.mjs` + `src-tauri/src/lib.rs`）
- [x] ② prompt/schema 加 `words[].original` 与 `words[].correction`（含 `required` 同步）
- [x] ③ 批内去重只用 `displayKey`
- [x] ④ A/B/C/D 四场景回归测试（Node 端到端 + Rust 单测）

---

## P0 · CI / 构建卫生（本轮已修）

### 2. `cargo clippy -- -D warnings` 失败（历史复核项）

**[已验证]** 本轮 CI 新增了 clippy 步骤，但没本地跑过 —— 和上一轮 `cargo fmt` 是同一类问题：

```
error: this `map_or` can be simplified
   --> src/lib.rs:537:37
    |
537 |  let base_matches_provider = provider_base_url.as_deref().map_or(true, |saved| {
    |
    = note: `-D clippy::unnecessary-map-or` implied by `-D warnings`
error: could not compile `shici-app` (lib) due to 1 previous error
```

**解决方案**（一处，`src-tauri/src/lib.rs:537`）：

```rust
let base_matches_provider = provider_base_url.as_deref().is_none_or(|saved| {
    !override_map.is_some_and(|map| map.contains_key("baseUrl")) || saved == base_url
});
```
（`Option::is_none_or` 自 Rust 1.82 稳定，当前工具链 1.9.0-stable rustfmt 对应的 rustc 远高于此，安全。）

- [x] 改 `map_or(true, ..)` → `is_none_or(..)`
- [x] **改完后本地跑一遍完整 CI 序列再推**：
  ```bash
  npm run check && npm test \
    && cargo fmt --manifest-path src-tauri/Cargo.toml -- --check \
    && cargo clippy --manifest-path src-tauri/Cargo.toml --no-default-features -- -D warnings \
    && cargo test --manifest-path src-tauri/Cargo.toml --no-default-features
  ```
  建议把这串收成 `npm run ci`，避免第五次再犯。

### 3. CI 没有 Rust 构建缓存 → 每次 push 重编译整棵依赖树三遍

`.github/workflows/ci.yml` 只给 Node 配了 `cache: npm`，Rust 侧没有任何缓存。而现在有三个 Rust 步骤（fmt / test debug / test release / clippy），其中 test-release 因为 `[profile.release]` 的 `lto = true` + `codegen-units = 1` 特别慢。

**解决方案**：在 `dtolnay/rust-toolchain` 之后插入

```yaml
      - uses: Swatinem/rust-cache@v2
        with:
          workspaces: src-tauri
```

- [x] 加 `Swatinem/rust-cache@v2`
- [x] **[判断] 去掉 `cargo test --release`，改用 `cargo build --release`** —— 单测保留 debug 覆盖，release 只验证发布配置可编译。

---

## P1 · 能力协商机制的两个缺口（本轮已修）

### 4. 一次偶发 400 会永久降级该 provider 的能力档位

`explainWithAI` 的协商缓存只在**成功时**写入，写入的是"当次成功的组合"：

```js
providerCapabilities.set(capabilityKey, { structured, ...(hasReasoning ? { reasoning: includeReasoning } : {}) });
```

问题：400 的成因不一定是参数不支持 —— 可能是单条输入过长、上游临时抽风、限流误报。一旦某次 `(structured=true, reasoning=true)` 偶发 400 而 `(true, false)` 成功，就会**永久**缓存 `reasoning: false`，此后该 provider 再也不发 reasoning 参数，直到进程重启。用户完全无感。

**解决方案**：加 TTL + 周期性重探。

```js
const CAPABILITY_TTL = 30 * 60_000;      // 30 分钟后重新尝试完整能力

const raw = providerCapabilities.get(capabilityKey);
const cached = raw && Date.now() - raw.at < CAPABILITY_TTL ? raw : {};
// ...
providerCapabilities.set(capabilityKey, {
  structured,
  ...(hasReasoning ? { reasoning: includeReasoning } : {}),
  at: Date.now(),
});
```

**[判断] 更严谨的做法**：只在错误消息明确指向参数问题时才记录负面能力，例如匹配 `/response_format|json_schema|reasoning|unsupported|unrecognized|invalid.*parameter/i`；否则视为偶发错误，不写缓存。两者可以叠加。

- [x] 给 `providerCapabilities` 加 TTL（JS `server.mjs` + Rust `AI_CAPABILITIES`）
- [x] **[判断]** 仅在错误消息指向参数问题时写入负面能力

### 5. `chat_template_kwargs` 的 URL 猜测把主要目标用户排除在外

```js
const host = new URL(value).hostname;
return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(host) || /vllm|sglang/.test(value);
```
（Rust `supports_chat_template_kwargs` 同逻辑，**双端一致，已核对**）

`chat_template_kwargs` 唯一的使用场景就是自建 vLLM / SGLang。但自建推理服务**最常见的部署形态恰恰是局域网另一台带显卡的机器** —— `http://192.168.1.50:8000/v1`、`http://10.0.0.8:8000/v1`、`http://host.docker.internal:8000/v1`。这些全都不匹配当前规则，参数不会被发送。

也就是说：需要它的用户拿不到，不需要它的用户（`api.openai.com`）本来也不会触发。**这条规则目前近乎无效。**

**解决方案（推荐）**：改成 provider 的显式开关，只有自建服务的用户知道自己要不要。

- `settings.json` 的 provider 增加 `enableThinkingToggle: boolean`
- 设置面板在「推理强度」下方加一个 checkbox：`此服务需要 chat_template_kwargs（vLLM / SGLang）`
- `explainWithAI` 里 `supportsChatTemplateKwargs` 直接读该字段，删掉 URL 猜测
- 双端 + `publicConfig` / `saveConfig` / `normalizeSavedConfig` 同步

**[判断] 备选**：把它并入能力协商，作为第三个维度参与回退（`structured × reasoning × chatTemplate`）。更自动但攻击面更大，回退链会变长。

- [x] 改为 provider 显式开关，删除 URL 猜测（双端 + 设置 UI）

---

## P2 · 一致性与优化

### 6. 拆分路径的 `correction` 格式与非拆分路径不一致

非拆分路径经 `migrateLegacyCorrection` 的 `core()` 归一化（转小写 + 去首尾标点），产出 `"betta → beta"`���拆分路径直接用原样字符串拼接：

```js
correction: raw.toLocaleLowerCase() === text.toLocaleLowerCase() ? "" : `${raw} → ${text}`
```

后果：输入 `"Alpha, betta"` 时，若 AI 返回 `alpha`，会生成 `"Alpha → alpha"` 这种仅大小写差异的"纠错"噪音（比较用了 lowercase 所以不会触发，但一旦有标点残留如 `"alpha!"` 就会）。

**解决方案**：P0-1 的方案 ① 里已包含 —— 统一用 `normalizeToken()` 做比较和展示。

- [x] 拆分路径复用与非拆分路径同一套归一化

### 7. 整批重复的词表仍会白白调用一次 AI

场景：用户第二次粘贴同一份生词表。整串 `"alpha, betta"` 不在库里（库里是拆分后的 `alpha` / `beta`），所以整串重复检查不命中 → 照常调用 AI → 拿到结果后逐词发现全部重复 → `createdCount: 0, reusedCount: 2`。

行为正确，但**白花一次 API 调用**。而"反复粘贴同一份词表"恰恰是这个功能的高频用法。

**解决方案**：在调用 AI 之前用 `kindHint` 预检。

```js
// createEntry 里，config.configured 判断之前
if (payload.kindHint === "word_list") {
  const parts = wordParts(payload.text);
  if (parts.length > 1) {
    const hits = parts.map((part) => library.entries.find((entry) =>
      [entry.raw, entry.displayText].some((v) => v.trim().toLocaleLowerCase() === part.trim().toLocaleLowerCase())));
    if (!forceNew && hits.every(Boolean)) {
      return { entry: hits[0], entries: hits, split: true, duplicate: true,
               createdCount: 0, reusedCount: hits.length, demo: false };
    }
  }
}
```

- [x] word_list 全命中时跳过 AI 调用（双端）

---

## P3 · 待实机验证

### 8. CSP 在 Windows / Android 上是否够用

- [x] 补充 `ipc:` / `http://ipc.localhost` 到 `connect-src`；**Windows / Android 仍需实机验证**

Tauri 会自动补它自己需要的源，大概率没事，但当前只在 macOS 上构建过。**发版前必须实机验证一次** —— 若 IPC 被 CSP 拦截，表现是整个应用打不开数据、所有 `invoke` 静默失败，而 CI 完全测不出来。

若确实被拦，在 `tauri.conf.json` 的 csp 里补：
```
connect-src 'self' ipc: http://ipc.localhost
```

---

## P4 · 已知未做，可接受

- [ ] **[判断]** `restoreEntries` 走全量 `PUT /api/entries`，词库大了以后一次撤销 = 序列化 + 落盘全量数据
- [ ] **[判断]** JSDoc + `checkJs`，在不改写为 TS 的前提下拿到类型检查
- [ ] **[判断]** 前端仍 0 测试（`public/app.js` 已 1200+ 行）
- [ ] **[判断]** `"targets": "all"` 与实际能力不符
- [ ] **[判断]** 虚拟滚动 —— 当前靠 `visibleLimit = 80` 兜底
- [ ] **[判断]** 迁移到 SQLite —— 双端已加写前脏检查，压力已缓解
- [ ] **[判断]** `stableJitter` 是 `entry.id` 的纯函数，同一张卡每次复习抖动系数恒定。跨卡打散有效（主要目的已达成）；若想更均匀可 hash(`id` + `repetitions`)

---

## 本轮执行记录

P0–P2 的修复已完成并通过 `npm run ci`；P3 已补 CSP 配置，仍需 Windows / Android 实机验证。P4 项目属于后续规模化取舍，暂不为它们增加复杂度。
8. **word_list 全命中跳过 AI**（P2-7）

---

## 已结项

**[已验证]** 以下均已确认完成，不再重复审阅。

### 第三轮问题 —— 12 项全部修复
- ✅ **`cargo fmt --check` 通过**：导入排序已对齐 Rust 2021 style edition
- ✅ **拆分条目保留原始输入**：`raw` 取自 `originalParts`，`correction` 按词级生成（**但对齐方式有缺陷，见 P0-1**）
- ✅ **`.reverse()` 已移除**，拆分顺序不再颠倒
- ✅ **批内去重**：`seen` Map（**但键的选取放大了错位，见 P0-1③**）
- ✅ **拆分条目不再复制整句 `context`**（`context: ""`）
- ✅ **拆分结果上报 `createdCount` / `reusedCount` / `duplicate`**，前端 toast 区分「新建 N 个 / 复用 M 个」并提供 forceNew 出口
- ✅ **能力协商缓存**：`providerCapabilities` / `AI_CAPABILITIES`，键为 `providerId|apiStyle|baseUrl|model`（**缺 TTL，见 P1-4**）
- ✅ **回退顺序已调换**：`(schema+reasoning) → (schema) → (reasoning) → (裸)`，优先保住 structured outputs
- ✅ **`chat_template_kwargs` 已按 baseUrl 收窄**（**规则近乎无效，见 P1-5**）
- ✅ **ESLint 接入 `js.configs.recommended` + `globals` 包**，手工 globals 列表已删除
- ✅ **CI 加了 clippy 与 `--release` 测试**（**clippy 本身失败，见 P0-2**）
- ✅ **双端对等性**：拆分逻辑、`seen` 去重、能力缓存、`supports_chat_template_kwargs`（含 `sglang` 分支）JS / Rust 均已核对一致

### 第二轮问题 —— 9 项全部修复
- ✅ `stream: true` 双端移除，`parseSse` 保留作上游兼容容错
- ✅ fuzz 改为 `stableJitter`（FNV-1a + `Math.imul`，双端同算法，基于 `entry.id`，无需 `rand`）
- ✅ Rust `commit_new_entry` 补 `duplicate_entry()` 复查，TOCTOU 已堵
- ✅ `ApiError` 在抛出点携带 status，`errorStatus` 优先读 `error.status`
- ✅ `SyntaxError → 400` 已修：模型 JSON 解析失败返回可读的 502
- ✅ `MAX_OUTPUT_TOKENS` 提高 + 检测 `incomplete_details.reason == "max_output_tokens"`
- ✅ `scripts/data-root.mjs` 抽出 `resolveDataRoot()`，三平台映射，服务端与迁移脚本共用；README 已同步
- ✅ `forceNew` 出口（后端参数 + 前端「仍然新建」toast action + `overrideText`）
- ✅ duplicate 双端统一为 200 且都返回 `entries`
- ✅ 撤销 toast 延长到 8 秒

### 第一轮问题
- ✅ **P0 安全全部封堵**：`trustedApiRequest`（Host 白名单 + `X-Shici` 强制预检 + `Sec-Fetch-Site` + Origin）、`/api/models` 跨 baseUrl 不复用密钥、`/api/explain` 删除。PoC 复验 `403 {"error":"Forbidden"}`，攻击者服务器收到 0 条
- ✅ **架构**：`system-prompt.txt` 单一来源、`library.json` version 双端统一为 2、共享 fixture
- ✅ **Bug**：SW `ignoreSearch: true`、Rust 全局锁拆为 prepare/commit、Windows `remove_file` 删除、状态码 400/404/502、`beforeBuildCommand` 改为 `npm run migrate`
- ✅ **AI**：JSON Schema structured outputs、429/5xx 指数退避、`temperature` / `max_tokens`
- ✅ **性能**：双端写前脏检查、搜索 `WeakMap` 缓存 + 150ms 防抖
- ✅ **产品**：导入 JSON、重复检测、`status` 参与逻辑、`leech` + 「顽固词」UI、`confirm()` 全替换为撤销 toast、`state.expanded` 删除、`#timeline` 的 `aria-live` 移除

---

## 确认无问题的部分

以下已逐点检查，四轮均未发现缺陷：

- **XSS 防护**：`escapeHtml` 覆盖所有 `innerHTML` 拼接点；属性插值的 id 均经 `^[\w-]{1,80}$` 校验
- **路径穿越**：`serveFile` 的 `decodeURIComponent` + `normalize` + 前缀校验组合有效
- **密钥不回传前端**：`publicConfig` 只暴露 `hasApiKey` 布尔值，`smoke.mjs` 有断言
- **文件权限**：目录 `0700`、文件 `0600`，双端一致
- **`.gitignore`**：`.local/`、`src-tauri/target/`、`src-tauri/gen/` 均正确忽略，无密钥入库
- **版本号**：`package.json` / `tauri.conf.json` / `Cargo.toml` 三处均为 `0.3.1`
- **请求取消**：前端 AbortController + 后端 signal 透传链路完整，`smoke.mjs` 有覆盖
- **CORS 预检**：服务器对不带 `X-Shici` 的 OPTIONS 返回 403 且无 CORS 头 → 浏览器阻断，实际请求不会发出
- **`reasoningEffort` 默认值**：双端默认 `"auto"`，此时不发送任何 reasoning 相关参数
- **eslint 依赖装配**：`eslint@^9.39.5` + `@eslint/js` + `globals` 已在 devDependencies 且写入 package-lock，CI 的 `npm ci` 不会缺包
- **能力协商的回退链构造**：`addAttempt` 去重正确，`hasReasoning === false` 时不会生成冗余组合
- **拆分路径在演示模式下可用**：`explainInDemo` 返回空 `words` 时会回落到 `wordParts(payload.text)` 分支
