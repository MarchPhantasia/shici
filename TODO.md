# 拾词 · 待办清单

第六轮审阅：2026-08-17（发布准备）
版本：`0.3.2` · 目标：正式公开发布到 GitHub

**当前验证状态**

| 命令 | 结果 |
| --- | --- |
| `npm run ci`（check + test + fmt + cargo test + release build + clippy） | ✅ 全绿 |

> 标注：**[已验证]** = 实际运行或代码逐行确认；**[判断]** = 设计取舍，由你决定。
> 前五轮的问题已全部解决，完成情况见文末「已结项」。本文只列**尚未完成**的事。

---

## P0 · 代码缺陷

### 1. `capitalizeWord` 会破坏有意小写开头的专有名词

**[已修复]** 修复前实现无条件把首字母转大写：

```
"apple"  → "Apple"    ✅ 符合预期
"iPhone" → "IPhone"   ❌
"eBay"   → "EBay"     ❌
"iOS"    → "IOS"      ❌
"macOS"  → "MacOS"    ❌
```

这些恰好是语言学习者会查的词。且 `cleanEntry` / `clean_entry` 在**每次读取和写入时都会执行**，所以被改坏的形式会落盘，并出现在词库列表、详情卡与复习卡上。详情页还会因为 `raw !== displayText` 而显示「原始输入 iPhone」，读起来像是用户打错了字。

> 注：`normalizeWordCorrection` 用 `normalizeToken` 做比较，所以**不会**因此产生假的「已纠正」记录。这一点是对的，不用改。

#### 解决方案：只在整词全小写时才大写首字母

**JS —— `server.mjs` 的 `capitalizeWord`**

```js
function capitalizeWord(value) {
  const text = String(value || "");
  if (text !== text.toLocaleLowerCase()) return text;   // 已含大写（iPhone / eBay / URL）→ 原样保留
  const letters = Array.from(text);
  if (letters.length) letters[0] = letters[0].toLocaleUpperCase();
  return letters.join("");
}
```

**Rust —— `src-tauri/src/lib.rs:239` 的 `capitalize_word`**

```rust
fn capitalize_word(value: &str) -> String {
    if value != value.to_lowercase() {
        return value.to_string();
    }
    let mut chars = value.chars();
    chars
        .next()
        .map(|first| first.to_uppercase().chain(chars).collect())
        .unwrap_or_default()
}
```

判据是「整词是否已含任一大写字母」：
- `"apple"` 全小写 → 大写首字母 → `"Apple"`
- `"iPhone"` / `"eBay"` / `"URL"` / `"Apple"` 已含大写 → 原样返回
- CJK（`"日本語"`）`to_lowercase()` 等于自身 → 进入分支但大写无效果 → 原样返回

- [x] 改 `server.mjs` 的 `capitalizeWord`
- [x] 改 `src-tauri/src/lib.rs:239` 的 `capitalize_word`

#### 回归测试

**现有的 Rust 测试 `words_are_capitalized_during_cleanup`（`lib.rs:2096`）用的是全小写 `"sloppy"`，加守卫后仍然通过，不要删。** 在它后面补大小写保留的断言：

```rust
#[test]
fn capitalization_preserves_intentional_casing() {
    assert_eq!(capitalize_word("apple"), "Apple");
    assert_eq!(capitalize_word("iPhone"), "iPhone");
    assert_eq!(capitalize_word("eBay"), "eBay");
    assert_eq!(capitalize_word("macOS"), "macOS");
    assert_eq!(capitalize_word("URL"), "URL");
    assert_eq!(capitalize_word(""), "");
    assert_eq!(capitalize_word("日本語"), "日本語");
}
```

Node 侧在 `test/smoke.mjs` 里补一条端到端断言：mock 返回 `kind: "word"` 且 `text: "iPhone"`，断言入库后 `displayText === "iPhone"`、`correction === ""`。

- [x] Rust 补 `capitalization_preserves_intentional_casing`
- [x] `test/smoke.mjs` 补 `iPhone` 端到端断言
- [x] 跑 `npm run ci` 确认全绿

---

## P1 · 发布准备

### 2. 补真实截图（README 目前是占位表格）

GUI 应用的 README 没有截图是硬伤。`design/` 里只有 Stitch 生成的设计稿，不是应用实拍，**不要拿它冒充截图**。

**做法**

1. 新建 `docs/screenshots/`
2. 用 `npm start` 或桌面版跑起来，先「设置 → 恢复演示数据」填充内容，避免截到真实私人词库
3. 截三张（macOS 上 `⌘⇧4` 后按空格可截取带阴影的窗口）：

| 文件名 | 内容 | 要点 |
| --- | --- | --- |
| `library-light.png` | 词库主界面（浅色） | 展示高密度列表 + 顶部捕获区 + 今日复习卡 |
| `detail.png` | 片段详情卡 | 选一条有音标、例句、表达拆解、追问记录的 |
| `review.png` | 专注复习模式 | 截「已显示答案」的状态，四个评分档位可见 |

4. 宽度统一到 1600px 以内，PNG 压一下（`pngquant` / ImageOptim），单张控制在 300 KB 内
5. 替换 `README.md` 的「界面」一节：

```markdown
## 界面

| 词库 | 详情 | 复习 |
| :--: | :--: | :--: |
| <img src="docs/screenshots/library-light.png" width="260"> | <img src="docs/screenshots/detail.png" width="260"> | <img src="docs/screenshots/review.png" width="260"> |
```

- [x] 建 `docs/screenshots/` 并截三张图
- [x] 替换 README 的「界面」一节，删掉占位说明

### 3. 决定 `TODO.md` 是否随仓库公开

**[判断]** 这是一份内部工程审计文档，「已结项」一节记录了历史 CSRF 漏洞的成因与 PoC 验证输出。

漏洞已修（`trustedApiRequest` 四层防护 + PoC 复验 403），**当前版本不受影响，不算泄密**。但它读起来是内部工程记录，未必是访客第一眼该看到的东西。三个选项：

- **留在根目录** —— 最透明，也能体现项目的工程严谨度
- **移到 `docs/AUDIT.md`** —— 保留内容但不占据仓库首屏（推荐）
- **移出仓库** —— 加进 `.gitignore`，只留本地

- [x] 选一个并执行：保留在根目录，便于透明审计

### 4. 提交与发布

当前未提交：`README.md` `package.json` `public/app.js` `public/index.html` `public/service-worker.js` `server.mjs` `src-tauri/src/lib.rs` `system-prompt.txt` `test/smoke.mjs`，以及未跟踪的 `LICENSE`。

**顺序**（先做完 P0-1 和 P1-2 再开始）

```bash
npm run ci                      # 必须先绿
git add -A
git commit -m "Add AGPL-3.0 license, rewrite README, refine word capitalization"
git push origin main
git tag -a v0.3.2 -m "Shici 0.3.2"
git push origin v0.3.2
```

然后在 GitHub 上：

- [ ] 仓库设置里改为 **Public**
- [ ] 填 Description（可用 `package.json` 的 `description`）与 Topics（`language-learning` `spaced-repetition` `vocabulary` `local-first` `tauri` `openai-compatible`）
- [ ] 基于 `v0.3.2` 创建 Release，附上 `npm run app:build` 产出的 macOS `.dmg`
- [ ] 确认首页 CI 徽章变绿（转 public 后 Actions 才会对外可见）
- [ ] **[判断]** 删除已合并的 `codex/message-safety` 分支

> 转 Public 前确认 `origin/main` 已经是 0.3.2 —— 早期的 0.3.0 含未修复的 CSRF 漏洞，不要让它成为默认分支。

---

## P2 · 编码卫生

### 5. U+FFFD 替换字符（已修，建议加护栏）

**[已验证]** 本轮在 `README.md`（2 处）与 `TODO.md`（1 处）发现了 U+FFFD 替换字符，均为文档写入过程中的编码损坏，已修复。源码文件（`server.mjs` / `public/app.js` / `public/index.html` / `system-prompt.txt`）扫描干净。

**[判断]** 这类损坏肉眼很难发现，建议加一条护栏。最省事的是在 `npm run check` 里串一个扫描：

```json
"check": "node --check server.mjs && node --check public/app.js && node --check test/smoke.mjs && npm run lint && npm run lint:encoding",
"lint:encoding": "node --input-type=module -e \"import{readFileSync}from'node:fs';const files=['README.md','TODO.md','system-prompt.txt','server.mjs','public/app.js','public/index.html'];const bad=files.filter(p=>readFileSync(p,'utf8').includes('\\uFFFD'));if(bad.length){console.error('发现替换字符 U+FFFD:',bad.join(', '));process.exit(1)}\""
```

- [x] **[判断]** 加 `lint:encoding` 到 `npm run check`

---

## P3 · 发版前必须实机验证

### 6. CSP 在 Windows / Android 上是否够用

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
- [ ] **[判断]** 前端 0 测试（`public/app.js` 已 1300+ 行）
- [ ] **[判断]** `"targets": "all"` 与实际能力不符（当前只在 macOS 验证过构建）
- [ ] **[判断]** `stableJitter` 是 `entry.id` 的纯函数，同一张卡每次复习抖动系数恒定。跨卡打散有效（主要目的已达成）；若想更均匀可 hash(`id` + `repetitions`)
- [ ] **[判断]** 界面仅有中文，未做 i18n

---

## 建议执行顺序

1. **修 `capitalizeWord` + 补两处测试**（P0-1）—— 双端各三行，跑 `npm run ci`
2. **补三张截图 + 替换 README 界面一节**（P1-2）—— 唯一影响第一印象的事
3. **决定 `TODO.md` 去留**（P1-3）
4. **提交、打 tag、转 Public、发 Release**（P1-4）
5. **[判断]** 加 `lint:encoding` 护栏（P2-5）
6. 出 Windows / Android 版时再做 P3-6

---

## 已结项

**[已验证]** 前五轮问题已全部修复并逐条核对，不再重复审阅。

### 发布准备（本轮已完成）
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

以下已逐点检查，六轮均未发现缺陷：

- **XSS 防护**：`escapeHtml` 覆盖所有 `innerHTML` 拼接点；属性插值的 id 均经 `^[\w-]{1,80}$` 校验
- **路径穿越**：`serveFile` 的 `decodeURIComponent` + `normalize` + 前缀校验组合有效
- **密钥不回传前端**：`publicConfig` 只暴露 `hasApiKey` 布尔值，`smoke.mjs` 有断言
- **文件权限**：目录 `0700`、文件 `0600`，双端一致
- **`.gitignore`**：`.local/`、`src-tauri/target/`、`src-tauri/gen/`、`node_modules/`、`.env*` 均正确忽略
- **全历史无密钥泄漏**：`sk-` / `ghp_` / `AKIA` / `AIza` / `xox*` 全历史扫描，唯一命中是审计文档里的假占位符；`.local/` 从未进入过版本历史
- **无构建产物入库**：`.DS_Store` / `target/` / `node_modules/` / `gen/` 均未跟踪
- **版本号一致**：`package.json` / `tauri.conf.json` / `Cargo.toml` / `Cargo.lock` 四处均为 `0.3.2`
- **请求取消**：前端 AbortController + 后端 signal 透传链路完整，`smoke.mjs` 有覆盖
- **CORS 预检**：对不带 `X-Shici` 的 OPTIONS 返回 403 且无 CORS 头 → 浏览器阻断，实际请求不会发出
- **`reasoningEffort` 默认值**：双端默认 `"auto"`，此时不发送任何 reasoning 相关参数
- **`normalizeWordCorrection`**：用 `normalizeToken` 归一化比较，大小写差异不会产生假的「已纠正」记录
- **`cleanEntry` 幂等性**：重复执行结果稳定，`loadLibrary` 的深比较不会导致每次启动重写
