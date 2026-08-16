# 拾词

一个面向碎片化语言输入的本地优先 App。单词、短语、句子或生活中遇到的任意语言片段都可以随手发送；每次默认提交都是独立片段，只有点击“继续问”才会把原片段、归纳结论和当前片段的最近几轮追问发送给 AI。

AI 会区分单个单词、多个独立单词、短语和句子。单个单词保存音标；一次发送多个独立单词时，每个词分别保存音标、含义与复习内容，不会误合并成短语。

明显的拼写错误会在解释前纠正：原始输入保留用于核对，纠正后的完整文本用于解释、追问和复习。生成期间发送按钮会变成停止按钮，停止后不会写入片段或追问；多轮追问也可以回到原片段或任一较早轮次，后续上下文会一并移除。

界面不使用传统聊天侧栏：词库是可搜索、可按来源筛选的高密度列表，解释按需展开；单击标题或双击词条可打开完整阅读卡片，长句不会被截断；复习则进入独立专注模式。复习调度受艾宾浩斯遗忘规律启发，并根据“忘记 / 困难 / 记得 / 轻松”动态调整下一次出现时间，而不是套用一张固定日程表。

## 浏览器开发版

```bash
npm start
```

打开 `http://127.0.0.1:4173`。没有配置 AI 时会进入明确标记的演示模式。

## 接入 AI

在应用的“设置”中可以保存并切换多个 Provider；每个 Provider 独立保存接口方式、Base URL、API Key 与模型：

- `Responses API`：调用 `/v1/responses`。
- `Compatible`：调用 `/v1/chat/completions`。
- 模型输入框可从 `/v1/models` 获取候选，也可以直接填写任意模型 ID。

设置中还可以选择跟随系统、浅色或深色主题，并将主要阅读字号调整为 `90%` 到 `120%`。外观偏好只保存在本机。

默认使用 `Command/Ctrl + Enter` 发送，普通回车换行；也可以在设置中改成 `Shift + Enter` 或 `Enter`。

浏览器开发版的 API Key 保存在本机服务端的应用数据目录 `settings.json`，文件权限为 `0600`；页面只能读取是否已配置，不能取回密钥。Base URL 会自动规范到 `/v1`。可用 `SHICI_DATA_DIR` 覆盖默认目录。

环境变量仍可作为初始配置：`AI_API_STYLE`、`AI_API_KEY`、`AI_BASE_URL`、`AI_MODEL`，并兼容 `OPENAI_API_KEY`、`OPENAI_BASE_URL`、`OPENAI_MODEL`。无需密钥的本地服务可设置 `AI_ALLOW_NO_KEY=1`，也可直接在界面勾选。

片段、来源、复习状态和追问统一保存在本机服务端的应用数据目录 `library.json`。写入时先生成临时文件再原子替换，文件权限为 `0600`；旧版浏览器 `localStorage` 数据会在首次启动时自动迁移。设置中仍可导出 JSON。

## 跨平台 App

桌面和移动端使用 Tauri 2，共用当前静态界面与 Rust 本地后端，不捆绑 Chromium 或 Node 运行时。

```bash
npm run app:dev
npm run app:build
```

安装版数据位于系统应用数据目录，不放在应用包内：

- macOS：`~/Library/Application Support/com.pha.shici/`
- Windows：`%APPDATA%/com.pha.shici/`
- Linux：`$XDG_DATA_HOME/com.pha.shici/`（未设置时为 `~/.local/share/com.pha.shici/`）

`settings.json` 和 `library.json` 均以私有权限原子写入。构建前的迁移脚本只会在目标文件不存在时将旧 `.local` 数据复制过去，因此升级或重新安装不会覆盖已有词库与第三方 API 配置。

当前环境可以直接生成 macOS `.app` 和 `.dmg`。同一份 Tauri 源码与图标已经面向 Windows、Linux、iOS 和 Android；各平台产物需在对应系统及其签名/SDK 环境中构建。

## 检查

```bash
npm run check
npm test
```

## 设计

`design/` 保存通过 Stitch MCP 生成的桌面与移动端界面基准。项目 ID：`7005147210859806427`。

本轮自由重构稿使用 Stitch 的 `GEMINI_3_1_PRO` 生成：项目 ID `14867800618947253716`，屏幕 ID `924d6e8ddc04469496c12f31339f4f0e`。实现保留了它的顶部工作区、紧凑捕获、密集词库与按需详情思路，并针对真实数据量、专注复习和移动端操作重新完成了信息架构。

用于生成下一版应用图标的提示词见 [`design/icon-prompt.md`](design/icon-prompt.md)。
