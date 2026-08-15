import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(appRoot, "public");
const settingsPath = process.env.AI_SETTINGS_PATH || join(appRoot, ".local", "settings.json");
const libraryPath = process.env.SHICI_DATA_PATH || join(appRoot, ".local", "library.json");
const port = Number(process.env.PORT || 4173);
const envBaseUrl = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const envConfig = {
  apiStyle: process.env.AI_API_STYLE || (envBaseUrl.includes("api.openai.com") ? "responses" : "compatible"),
  baseUrl: envBaseUrl,
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "",
  model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "",
  allowNoKey: process.env.AI_ALLOW_NO_KEY === "1",
};

const mime = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webmanifest": "application/manifest+json",
};

const systemPrompt = `You explain short language fragments for a Chinese-speaking learner.
The input can be a word, phrase, full sentence, dialogue line, sign, message, or excerpt in any language.
Prioritize the meaning in the supplied fragment itself. Do not dump unrelated dictionary senses.
Be concise, natural, and honest about ambiguity. Correct obvious typos only when confident.

For mode "new", first classify the input as word, word_list, phrase, sentence, or other. Return only valid JSON with these keys:
{"type":"entry","kind":"word","displayText":"","correction":"","pronunciation":"/IPA/","meaning":"","context":"","words":[{"text":"","pronunciation":"/IPA/","meaning":""}],"usage":[""],"chunks":[{"text":"","meaning":""}],"memoryCue":""}
- kind "word": exactly one standalone lexical word. pronunciation is required IPA; words contains exactly that word with IPA and its concise Chinese meaning.
- kind "word_list": multiple standalone words rather than a phrase or sentence. words contains every word separately and pronunciation is required IPA for every item. Top-level pronunciation may be empty.
- kind "phrase" or "sentence": words must be []; pronunciation may be empty.
- Distinguish a meaningful multi-word phrase from a list of unrelated vocabulary. Commas/newlines often signal a word_list, but use linguistic meaning as the final test.
- meaning: one natural Chinese understanding, not a long essay.
- context: why this reading fits, or what context is missing.
- usage: at most 3 concise nuances or examples.
- chunks: at most 4 useful phrase chunks; use [] when not useful.
- correction and pronunciation may be empty strings.

For mode "followup", answer only within the supplied root fragment and local thread. Return only:
{"type":"followup","answer":"","summary":""}
- answer: direct Chinese answer to the latest question.
- summary: a compact updated conclusion for later review.
Never refer to fragments outside the payload.`;

const entryKinds = ["word", "word_list", "phrase", "sentence", "other"];
let savedConfig = normalizeSavedConfig(await loadSavedConfig());
let library = await loadLibrary();
let libraryWrite = Promise.resolve();

async function loadSavedConfig() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return {};
    console.warn(`无法读取 AI 配置：${error.message}`);
    return {};
  }
}

function normalizeSavedConfig(value = {}) {
  if (Array.isArray(value.providers)) {
    const providers = value.providers.slice(0, 20).map((provider) => ({
      id: /^[\w-]{1,80}$/.test(String(provider?.id || "")) ? String(provider.id) : randomUUID(),
      name: cleanText(provider?.name, 80) || "未命名 Provider",
      apiStyle: provider?.apiStyle === "compatible" ? "compatible" : "responses",
      baseUrl: cleanText(provider?.baseUrl, 2_000),
      apiKey: cleanText(provider?.apiKey, 10_000),
      model: cleanText(provider?.model, 500),
      allowNoKey: Boolean(provider?.allowNoKey),
    }));
    const activeProviderId = providers.some((provider) => provider.id === value.activeProviderId)
      ? value.activeProviderId
      : providers[0]?.id || "";
    return { version: 2, activeProviderId, providers };
  }
  if (value.baseUrl || value.model || value.apiKey) {
    const id = "default";
    return { version: 2, activeProviderId: id, providers: [{ id, name: "默认 Provider", ...value }] };
  }
  return { version: 2, activeProviderId: "", providers: [] };
}

function cleanText(value, limit = 5_000) {
  return String(value || "").trim().slice(0, limit);
}

function wordParts(raw) {
  return String(raw || "").split(/[\n,，;；]+/).map((part) => part.trim()).filter(Boolean);
}

function isWordToken(value) {
  return /^[\p{L}\p{M}][\p{L}\p{M}'’\-]*$/u.test(value);
}

function inferKind(raw, supplied) {
  if (entryKinds.includes(supplied)) return supplied;
  const value = cleanText(raw);
  const parts = wordParts(value);
  if (parts.length > 1 && parts.every(isWordToken)) return "word_list";
  if (isWordToken(value)) return "word";
  if (/[.!?。！？]/u.test(value) || value.split(/\s+/).length > 7) return "sentence";
  return value.split(/\s+/).length > 1 ? "phrase" : "other";
}

function cleanReview(value = {}, createdAt, status) {
  const defaultDueAt = status === "learned" ? createdAt + 3 * 86_400_000 : createdAt;
  return {
    dueAt: Number(value.dueAt) || defaultDueAt,
    intervalDays: Math.max(0, Number(value.intervalDays) || 0),
    ease: Math.min(3.2, Math.max(1.3, Number(value.ease) || 2.5)),
    repetitions: Math.max(0, Math.floor(Number(value.repetitions) || 0)),
    lapses: Math.max(0, Math.floor(Number(value.lapses) || 0)),
    lastReviewedAt: Math.max(0, Number(value.lastReviewedAt) || 0),
    lastGrade: ["again", "hard", "good", "easy"].includes(value.lastGrade) ? value.lastGrade : "",
  };
}

function cleanEntry(value = {}) {
  const createdAt = Number(value.createdAt) || Date.now();
  const status = value.status === "learned" ? "learned" : "review";
  const raw = cleanText(value.raw);
  const displayText = cleanText(value.displayText || raw);
  const kind = inferKind(raw, value.kind);
  const pronunciation = cleanText(value.pronunciation, 500);
  const meaning = cleanText(value.meaning);
  let words = Array.isArray(value.words) ? value.words.slice(0, 50).map((word) => ({
    text: cleanText(word?.text, 200),
    pronunciation: cleanText(word?.pronunciation, 500),
    meaning: cleanText(word?.meaning, 1_000),
  })).filter((word) => word.text) : [];
  if (kind === "word" && !words.length) words = [{ text: displayText, pronunciation, meaning }];
  if (kind === "word_list" && !words.length) words = wordParts(raw).map((text) => ({ text, pronunciation: "", meaning: "" }));
  return {
    id: /^[\w-]{1,80}$/.test(String(value.id || "")) ? String(value.id) : randomUUID(),
    raw,
    kind,
    words,
    displayText,
    correction: cleanText(value.correction, 500),
    pronunciation: pronunciation || (kind === "word" ? words[0]?.pronunciation || "" : ""),
    meaning,
    context: cleanText(value.context),
    usage: Array.isArray(value.usage) ? value.usage.slice(0, 3).map((item) => cleanText(item, 1_000)).filter(Boolean) : [],
    chunks: Array.isArray(value.chunks) ? value.chunks.slice(0, 4).map((chunk) => ({
      text: cleanText(chunk?.text, 500),
      meaning: cleanText(chunk?.meaning, 1_000),
    })).filter((chunk) => chunk.text || chunk.meaning) : [],
    source: cleanText(value.source, 24),
    status,
    starred: Boolean(value.starred),
    createdAt,
    updatedAt: Number(value.updatedAt) || createdAt,
    conclusion: cleanText(value.conclusion, 2_000),
    review: cleanReview(value.review, createdAt, status),
    thread: Array.isArray(value.thread) ? value.thread.map((turn) => ({
      id: /^[\w-]{1,80}$/.test(String(turn?.id || "")) ? String(turn.id) : randomUUID(),
      question: cleanText(turn?.question, 1_000),
      answer: cleanText(turn?.answer, 2_000),
      createdAt: Number(turn?.createdAt) || createdAt,
    })).filter((turn) => turn.question || turn.answer) : [],
  };
}

async function loadLibrary() {
  try {
    const value = JSON.parse(await readFile(libraryPath, "utf8"));
    return {
      version: 1,
      entries: Array.isArray(value.entries) ? value.entries.map(cleanEntry).filter((entry) => entry.raw) : [],
    };
  } catch (error) {
    if (error.code === "ENOENT") return { version: 1, entries: [] };
    throw new Error(`无法读取本地数据：${error.message}`);
  }
}

async function writePrivateJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporaryPath = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, path);
  await chmod(path, 0o600);
}

function saveLibrary(change) {
  const operation = libraryWrite.then(async () => {
    const next = structuredClone(library);
    const result = change(next.entries);
    await writePrivateJson(libraryPath, next);
    library = next;
    return structuredClone(result);
  });
  libraryWrite = operation.catch(() => {});
  return operation;
}

function normalizeApiBase(value) {
  const url = new URL(String(value || "").trim());
  if (!["http:", "https:"].includes(url.protocol)) throw new Error("Base URL 仅支持 http 或 https");
  if (url.username || url.password) throw new Error("请勿在 Base URL 中包含账号或密钥");
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!url.pathname.endsWith("/v1")) url.pathname = `${url.pathname}/v1`.replace(/\/+/g, "/");
  return url.toString().replace(/\/$/, "");
}

function resolveConfig(overrides = {}) {
  const providerId = overrides.providerId ?? savedConfig.activeProviderId;
  const provider = savedConfig.providers.find((item) => item.id === providerId);
  const apiStyle = overrides.apiStyle ?? provider?.apiStyle ?? envConfig.apiStyle;
  const baseUrl = normalizeApiBase(overrides.baseUrl ?? provider?.baseUrl ?? envConfig.baseUrl);
  const model = String(overrides.model ?? provider?.model ?? envConfig.model).trim();
  const allowNoKey = Boolean(overrides.allowNoKey ?? provider?.allowNoKey ?? envConfig.allowNoKey);
  let apiKey;
  if (Object.hasOwn(overrides, "apiKey") && String(overrides.apiKey).trim()) apiKey = String(overrides.apiKey).trim();
  else if (Object.hasOwn(overrides, "apiKey") && allowNoKey) apiKey = "";
  else if (provider && Object.hasOwn(provider, "apiKey")) apiKey = provider.apiKey;
  else apiKey = envConfig.apiKey;

  if (!["responses", "compatible"].includes(apiStyle)) throw new Error("不支持的 API 方式");
  return {
    apiStyle,
    providerId: provider?.id || "",
    providerName: provider?.name || (envConfig.apiKey || envConfig.model ? "环境配置" : "新 Provider"),
    baseUrl,
    apiKey,
    model,
    allowNoKey,
    configured: Boolean(baseUrl && model && (apiKey || allowNoKey)),
    credentialsReady: Boolean(baseUrl && (apiKey || allowNoKey)),
  };
}

function publicConfig(config = resolveConfig()) {
  return {
    providerId: config.providerId,
    providerName: config.providerName,
    activeProviderId: savedConfig.activeProviderId,
    providers: savedConfig.providers.map((provider) => {
      const item = resolveConfig({ providerId: provider.id });
      return {
        id: provider.id, name: provider.name, apiStyle: item.apiStyle, baseUrl: item.baseUrl,
        model: item.model, allowNoKey: item.allowNoKey, hasApiKey: Boolean(item.apiKey), configured: item.configured,
      };
    }),
    apiStyle: config.apiStyle,
    baseUrl: config.baseUrl,
    model: config.model,
    allowNoKey: config.allowNoKey,
    hasApiKey: Boolean(config.apiKey),
    configured: config.configured,
    mode: config.configured ? "live" : "demo",
    source: savedConfig.providers.length ? "saved" : (envConfig.apiKey || envConfig.model ? "environment" : "default"),
  };
}

async function saveConfig(body) {
  const providerId = /^[\w-]{1,80}$/.test(String(body.providerId || "")) ? String(body.providerId) : randomUUID();
  const existing = savedConfig.providers.find((provider) => provider.id === providerId);
  const apiStyle = body.apiStyle === "compatible" ? "compatible" : "responses";
  const baseUrl = normalizeApiBase(body.baseUrl);
  const model = String(body.model || "").trim();
  const name = cleanText(body.name, 80) || new URL(baseUrl).host;
  const allowNoKey = Boolean(body.allowNoKey);
  const apiKeyInput = String(body.apiKey || "").trim();
  const apiKey = apiKeyInput || (allowNoKey ? "" : existing?.apiKey || "");
  if (!model) throw new Error("请填写或选择模型 ID");
  if (!apiKey && !allowNoKey) throw new Error("请填写 API Key，或允许无密钥服务");

  const next = { id: providerId, name, apiStyle, baseUrl, model, allowNoKey, apiKey };
  const providers = savedConfig.providers.filter((provider) => provider.id !== providerId);
  providers.push(next);
  savedConfig = { version: 2, activeProviderId: providerId, providers };
  await writePrivateJson(settingsPath, savedConfig);
  return publicConfig(resolveConfig());
}

async function activateProvider(id) {
  if (!savedConfig.providers.some((provider) => provider.id === id)) throw new Error("没有找到这个 Provider");
  savedConfig.activeProviderId = id;
  await writePrivateJson(settingsPath, savedConfig);
  return publicConfig(resolveConfig());
}

async function deleteProvider(id) {
  const providers = savedConfig.providers.filter((provider) => provider.id !== id);
  if (providers.length === savedConfig.providers.length) throw new Error("没有找到这个 Provider");
  savedConfig = { version: 2, activeProviderId: providers[0]?.id || "", providers };
  await writePrivateJson(settingsPath, savedConfig);
  return publicConfig(resolveConfig());
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json; charset=utf-8" });
  response.end(JSON.stringify(data));
}

async function readJson(request) {
  const parts = [];
  let size = 0;
  for await (const part of request) {
    size += part.length;
    if (size > 5_000_000) throw new Error("请求内容过长");
    parts.push(part);
  }
  return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
}

function compactPayload(body) {
  const mode = body.mode === "followup" ? "followup" : "new";
  return {
    mode,
    text: String(body.text || "").slice(0, 5_000),
    kindHint: mode === "new" ? inferKind(body.text) : "",
    source: String(body.source || "").slice(0, 24),
    root: mode === "followup" ? String(body.root || "").slice(0, 5_000) : "",
    conclusion: mode === "followup" ? String(body.conclusion || "").slice(0, 2_000) : "",
    recentTurns: mode === "followup" && Array.isArray(body.recentTurns)
      ? body.recentTurns.slice(-4).map((turn) => ({
          question: String(turn.question || "").slice(0, 1_000),
          answer: String(turn.answer || "").slice(0, 2_000),
        }))
      : [],
  };
}

function requestHeaders(config) {
  return {
    "Content-Type": "application/json",
    ...(config.apiKey ? { "Authorization": `Bearer ${config.apiKey}` } : {}),
  };
}

async function fetchJson(url, options) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
  const raw = await response.text();
  let data;
  try { data = raw ? JSON.parse(raw) : {}; }
  catch { data = { raw }; }
  if (!response.ok) throw new Error(data.error?.message || data.message || `上游请求失败 (${response.status})`);
  return data;
}

function parseModelJson(value) {
  const text = Array.isArray(value)
    ? value.map((part) => part.text || part.content || "").join("")
    : String(value || "");
  const clean = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  return JSON.parse(clean);
}

function responseOutputText(data) {
  if (typeof data.output_text === "string") return data.output_text;
  return (data.output || [])
    .flatMap((item) => item.content || [])
    .filter((item) => item.type === "output_text" || typeof item.text === "string")
    .map((item) => item.text || "")
    .join("");
}

async function explainWithAI(payload, config) {
  if (config.apiStyle === "responses") {
    const data = await fetchJson(`${config.baseUrl}/responses`, {
      method: "POST",
      headers: requestHeaders(config),
      body: JSON.stringify({ model: config.model, instructions: systemPrompt, input: JSON.stringify(payload) }),
    });
    return parseModelJson(responseOutputText(data));
  }

  const data = await fetchJson(`${config.baseUrl}/chat/completions`, {
    method: "POST",
    headers: requestHeaders(config),
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: JSON.stringify(payload) },
      ],
    }),
  });
  return parseModelJson(data.choices?.[0]?.message?.content);
}

async function listModels(body) {
  const overrides = {
    providerId: body.providerId,
    apiStyle: body.apiStyle,
    baseUrl: body.baseUrl,
    allowNoKey: Boolean(body.allowNoKey),
    ...(String(body.apiKey || "").trim() ? { apiKey: String(body.apiKey).trim() } : {}),
  };
  const config = resolveConfig(overrides);
  if (!config.credentialsReady) throw new Error("请先填写 API Key，或允许无密钥服务");
  const data = await fetchJson(`${config.baseUrl}/models`, { method: "GET", headers: requestHeaders(config) });
  const items = Array.isArray(data.data) ? data.data : (Array.isArray(data.models) ? data.models : []);
  const models = [...new Set(items.map((item) => typeof item === "string" ? item : (item.id || item.name)).filter(Boolean))].sort();
  if (!models.length) throw new Error("接口没有返回可用的模型 ID");
  return { models };
}

function explainInDemo(payload) {
  if (payload.mode === "followup") {
    return {
      type: "followup",
      answer: "演示模式已把这条问题记在当前片段内。完成 AI 配置后，这里会结合原片段和最近几轮追问作答。",
      summary: payload.conclusion || "待连接 AI 后生成归纳结论。",
      demo: true,
    };
  }

  const known = {
    "figure it out": {
      meaning: "把它弄明白；想办法解决。",
      context: "口语里常指通过思考或尝试找到答案、办法。",
      usage: ["I’ll figure it out. = 我会想办法的。"],
      chunks: [{ text: "figure out", meaning: "弄清楚；解决" }],
    },
    "suffocating": {
      pronunciation: "/ˈsʌfəkeɪtɪŋ/",
      meaning: "令人窒息的；压得人喘不过气的。",
      context: "既可描述真的呼吸困难，也常比喻气氛、压力或关系令人压抑。",
      usage: ["a suffocating atmosphere = 令人窒息的氛围"],
      chunks: [{ text: "feel suffocating", meaning: "感到压抑、喘不过气" }],
    },
  };
  const hit = known[payload.text.trim().toLowerCase()];
  return {
    type: "entry",
    kind: inferKind(payload.text),
    displayText: payload.text,
    correction: "",
    pronunciation: hit?.pronunciation || "",
    words: inferKind(payload.text) === "word" ? [{ text: payload.text, pronunciation: hit?.pronunciation || "", meaning: hit?.meaning || "" }] : [],
    meaning: hit?.meaning || "演示模式不会猜测这个片段的具体含义。",
    context: hit?.context || "它已作为独立片段保存，不会携带其他条目的上下文。配置 AI 后会生成语境化解释。",
    usage: hit?.usage || [],
    chunks: hit?.chunks || [],
    memoryCue: "",
    demo: true,
  };
}

async function createEntry(body) {
  const payload = compactPayload({ mode: "new", text: body.text, source: body.source });
  if (!payload.text.trim()) throw new Error("请输入一个语言片段");
  const config = resolveConfig();
  const result = config.configured ? await explainWithAI(payload, config) : explainInDemo(payload);
  const createdAt = Date.now();
  const entry = cleanEntry({
    id: randomUUID(),
    raw: payload.text,
    displayText: result.displayText || payload.text,
    kind: result.kind,
    words: result.words,
    correction: result.correction,
    pronunciation: result.pronunciation,
    meaning: result.meaning || "暂时没有解释",
    context: result.context,
    usage: result.usage,
    chunks: result.chunks,
    source: payload.source,
    status: "review",
    starred: false,
    createdAt,
    updatedAt: createdAt,
    conclusion: result.memoryCue || result.meaning,
    review: { dueAt: createdAt + 10 * 60_000 },
    thread: [],
  });
  await saveLibrary((entries) => entries.unshift(entry));
  return { entry, demo: Boolean(result.demo) };
}

async function addFollowup(id, body) {
  const entry = library.entries.find((item) => item.id === id);
  if (!entry) throw new Error("没有找到这个片段");
  const payload = compactPayload({
    mode: "followup",
    text: body.text,
    root: entry.raw,
    conclusion: entry.conclusion,
    recentTurns: entry.thread,
  });
  if (!payload.text.trim()) throw new Error("请输入追问内容");
  const config = resolveConfig();
  const result = config.configured ? await explainWithAI(payload, config) : explainInDemo(payload);
  const updated = await saveLibrary((entries) => {
    const current = entries.find((item) => item.id === id);
    if (!current) throw new Error("没有找到这个片段");
    current.thread.push({ id: randomUUID(), question: payload.text, answer: cleanText(result.answer, 2_000), createdAt: Date.now() });
    current.conclusion = cleanText(result.summary || current.conclusion, 2_000);
    current.updatedAt = Date.now();
    return current;
  });
  return { entry: updated, demo: Boolean(result.demo) };
}

async function updateEntry(id, body) {
  return saveLibrary((entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error("没有找到这个片段");
    if (Object.hasOwn(body, "source")) entry.source = cleanText(body.source, 24);
    if (Object.hasOwn(body, "status")) {
      entry.status = body.status === "learned" ? "learned" : "review";
      if (entry.status === "review") entry.review.dueAt = Date.now();
    }
    if (Object.hasOwn(body, "starred")) entry.starred = Boolean(body.starred);
    entry.updatedAt = Date.now();
    return entry;
  });
}

function scheduleReview(review, grade, now = Date.now()) {
  let ease = review.ease;
  let repetitions = review.repetitions;
  let lapses = review.lapses;
  let intervalDays;

  if (grade === "again") {
    intervalDays = 10 / 1_440;
    ease = Math.max(1.3, ease - 0.2);
    repetitions = 0;
    lapses += 1;
  } else if (grade === "hard") {
    intervalDays = repetitions === 0 ? 1 : Math.max(1, review.intervalDays * 1.2);
    ease = Math.max(1.3, ease - 0.15);
    repetitions = Math.max(1, repetitions);
  } else if (grade === "easy") {
    intervalDays = repetitions === 0 ? 4 : repetitions === 1 ? 8 : Math.max(8, review.intervalDays * (ease + 0.15) * 1.3);
    ease = Math.min(3.2, ease + 0.15);
    repetitions += 1;
  } else {
    intervalDays = repetitions === 0 ? 1 : repetitions === 1 ? 3 : Math.max(3, review.intervalDays * ease);
    repetitions += 1;
  }

  intervalDays = Math.round(intervalDays * 100) / 100;
  return {
    dueAt: now + intervalDays * 86_400_000,
    intervalDays,
    ease: Math.round(ease * 100) / 100,
    repetitions,
    lapses,
    lastReviewedAt: now,
    lastGrade: grade,
  };
}

async function gradeEntry(id, body) {
  const grade = ["again", "hard", "good", "easy"].includes(body.grade) ? body.grade : "good";
  return saveLibrary((entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error("没有找到这个片段");
    entry.review = scheduleReview(entry.review, grade);
    entry.status = "learned";
    entry.updatedAt = Date.now();
    return entry;
  });
}

async function deleteEntry(id) {
  return saveLibrary((entries) => {
    const index = entries.findIndex((item) => item.id === id);
    if (index < 0) throw new Error("没有找到这个片段");
    entries.splice(index, 1);
    return { deleted: true };
  });
}

async function replaceEntries(body) {
  if (!Array.isArray(body.entries)) throw new Error("片段数据格式不正确");
  const entries = body.entries.slice(0, 10_000).map(cleanEntry).filter((entry) => entry.raw);
  await saveLibrary((current) => {
    current.splice(0, current.length, ...entries);
    return current;
  });
  return { version: 1, entries: structuredClone(library.entries) };
}

async function handleApi(request, response, pathname) {
  try {
    if ((pathname === "/api/config" || pathname === "/api/status") && request.method === "GET") {
      sendJson(response, 200, publicConfig(resolveConfig()));
      return true;
    }
    if (pathname === "/api/config" && request.method === "PUT") {
      sendJson(response, 200, await saveConfig(await readJson(request)));
      return true;
    }
    const providerMatch = pathname.match(/^\/api\/config\/([\w-]+)$/);
    const activateMatch = pathname.match(/^\/api\/config\/([\w-]+)\/activate$/);
    if (activateMatch && request.method === "POST") {
      sendJson(response, 200, await activateProvider(activateMatch[1]));
      return true;
    }
    if (providerMatch && request.method === "DELETE") {
      sendJson(response, 200, await deleteProvider(providerMatch[1]));
      return true;
    }
    if (pathname === "/api/models" && request.method === "POST") {
      sendJson(response, 200, await listModels(await readJson(request)));
      return true;
    }
    if (pathname === "/api/entries" && request.method === "GET") {
      sendJson(response, 200, { version: library.version, entries: library.entries });
      return true;
    }
    if (pathname === "/api/entries" && request.method === "PUT") {
      sendJson(response, 200, await replaceEntries(await readJson(request)));
      return true;
    }
    if (pathname === "/api/entries" && request.method === "POST") {
      sendJson(response, 201, await createEntry(await readJson(request)));
      return true;
    }
    const followupMatch = pathname.match(/^\/api\/entries\/([\w-]+)\/followups$/);
    if (followupMatch && request.method === "POST") {
      sendJson(response, 201, await addFollowup(followupMatch[1], await readJson(request)));
      return true;
    }
    const reviewMatch = pathname.match(/^\/api\/entries\/([\w-]+)\/review$/);
    if (reviewMatch && request.method === "POST") {
      sendJson(response, 200, { entry: await gradeEntry(reviewMatch[1], await readJson(request)) });
      return true;
    }
    const entryMatch = pathname.match(/^\/api\/entries\/([\w-]+)$/);
    if (entryMatch && request.method === "PATCH") {
      sendJson(response, 200, { entry: await updateEntry(entryMatch[1], await readJson(request)) });
      return true;
    }
    if (entryMatch && request.method === "DELETE") {
      sendJson(response, 200, await deleteEntry(entryMatch[1]));
      return true;
    }
    if (pathname === "/api/explain" && request.method === "POST") {
      const payload = compactPayload(await readJson(request));
      if (!payload.text.trim()) return sendJson(response, 400, { error: "请输入一个语言片段" }) ?? true;
      const config = resolveConfig();
      const result = config.configured ? await explainWithAI(payload, config) : explainInDemo(payload);
      sendJson(response, 200, result);
      return true;
    }
  } catch (error) {
    sendJson(response, 502, { error: error.message || "请求失败" });
    return true;
  }
  return false;
}

async function serveFile(response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const relative = normalize(decodeURIComponent(requested)).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicRoot, relative);
  if (!filePath.startsWith(publicRoot)) return sendJson(response, 403, { error: "Forbidden" });

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("Not a file");
    response.writeHead(200, { "Content-Type": mime[extname(filePath)] || "application/octet-stream", "Cache-Control": "no-cache" });
    createReadStream(filePath).pipe(response);
  } catch {
    const fallback = await readFile(join(publicRoot, "index.html"));
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-cache" });
    response.end(fallback);
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host || "localhost"}`);
  const handled = await handleApi(request, response, url.pathname);
  if (!handled) await serveFile(response, url.pathname);
});

server.listen(port, "127.0.0.1", () => {
  const config = publicConfig(resolveConfig());
  console.log(`拾词已启动：http://127.0.0.1:${port}`);
  console.log(config.configured ? `AI 已配置：${config.model} (${config.apiStyle})` : "AI 未完成配置：当前使用演示模式");
});
