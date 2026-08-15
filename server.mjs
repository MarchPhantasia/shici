import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(appRoot, "public");
const dataRoot = process.env.SHICI_DATA_DIR || join(homedir(), "Library", "Application Support", "com.pha.shici");
const legacyDataRoot = join(appRoot, ".local");
const settingsPath = process.env.AI_SETTINGS_PATH || join(dataRoot, "settings.json");
const libraryPath = process.env.SHICI_DATA_PATH || join(dataRoot, "library.json");
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

const systemPrompt = await readFile(join(appRoot, "system-prompt.txt"), "utf8");
const responseSchemas = {
  new: {
    type: "object", additionalProperties: false,
    properties: {
      type: { type: "string" }, kind: { type: "string", enum: ["word", "word_list", "phrase", "sentence", "other"] },
      displayText: { type: "string" }, correction: { type: "string" }, pronunciation: { type: "string" },
      meaning: { type: "string" }, context: { type: "string" },
      words: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, pronunciation: { type: "string" }, meaning: { type: "string" } }, required: ["text", "pronunciation", "meaning"] } },
      usage: { type: "array", items: { type: "string" } },
      chunks: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, meaning: { type: "string" } }, required: ["text", "meaning"] } },
      memoryCue: { type: "string" },
    },
    required: ["type", "kind", "displayText", "correction", "pronunciation", "meaning", "context", "words", "usage", "chunks", "memoryCue"],
  },
  followup: {
    type: "object", additionalProperties: false,
    properties: { type: { type: "string" }, answer: { type: "string" }, summary: { type: "string" } },
    required: ["type", "answer", "summary"],
  },
};

const entryKinds = ["word", "word_list", "phrase", "sentence", "other"];
let savedConfig = normalizeSavedConfig(await loadSavedConfig());
let library = await loadLibrary();
let libraryWrite = Promise.resolve();
let librarySerialized = JSON.stringify(library);

async function loadSavedConfig() {
  try {
    return JSON.parse(await readFile(settingsPath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT" && !process.env.AI_SETTINGS_PATH) {
      try { return JSON.parse(await readFile(join(legacyDataRoot, "settings.json"), "utf8")); }
      catch (legacyError) { if (legacyError.code === "ENOENT") return {}; }
    }
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
  const lapses = Math.max(0, Math.floor(Number(value.lapses) || 0));
  return {
    dueAt: Number(value.dueAt) || defaultDueAt,
    intervalDays: Math.max(0, Number(value.intervalDays) || 0),
    ease: Math.min(3.2, Math.max(1.3, Number(value.ease) || 2.5)),
    repetitions: Math.max(0, Math.floor(Number(value.repetitions) || 0)),
    lapses,
    leech: Boolean(value.leech) || lapses >= 8,
    lastReviewedAt: Math.max(0, Number(value.lastReviewedAt) || 0),
    lastGrade: ["again", "hard", "good", "easy"].includes(value.lastGrade) ? value.lastGrade : "",
  };
}

function migrateLegacyCorrection(raw, displayText, correction) {
  if (!correction || displayText.toLocaleLowerCase() !== raw.toLocaleLowerCase() || /→|->/.test(correction)) return null;
  const original = raw.split(/\s+/);
  const corrected = correction.split(/\s+/);
  if (original.length < 2 || original.length !== corrected.length) return null;
  const core = (token) => token.toLocaleLowerCase().replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+$/gu, "");
  const differences = original.map((token, index) => core(token) === core(corrected[index]) ? -1 : index).filter((index) => index >= 0);
  if (differences.length !== 1) return null;
  const index = differences[0];
  const before = core(original[index]);
  const after = core(corrected[index]);
  return before && after ? { displayText: correction, correction: `${before} → ${after}` } : null;
}

function cleanEntry(value = {}) {
  const createdAt = Number(value.createdAt) || Date.now();
  const status = value.status === "learned" ? "learned" : "review";
  const raw = cleanText(value.raw);
  let displayText = cleanText(value.displayText || raw);
  let correction = cleanText(value.correction, 500);
  let pronunciation = cleanText(value.pronunciation, 500);
  const legacyCorrection = migrateLegacyCorrection(raw, displayText, correction);
  if (legacyCorrection) {
    ({ displayText, correction } = legacyCorrection);
    pronunciation = "";
  }
  const kind = inferKind(displayText, value.kind);
  const meaning = cleanText(value.meaning);
  let words = Array.isArray(value.words) ? value.words.slice(0, 50).map((word) => ({
    text: cleanText(word?.text, 200),
    pronunciation: cleanText(word?.pronunciation, 500),
    meaning: cleanText(word?.meaning, 1_000),
  })).filter((word) => word.text) : [];
  if (kind === "word" && !words.length) words = [{ text: displayText, pronunciation, meaning }];
  if (kind === "word_list" && !words.length) words = wordParts(displayText).map((text) => ({ text, pronunciation: "", meaning: "" }));
  const baseConclusion = cleanText(value.baseConclusion || value.meaning || value.conclusion, 2_000);
  return {
    id: /^[\w-]{1,80}$/.test(String(value.id || "")) ? String(value.id) : randomUUID(),
    raw,
    kind,
    words,
    displayText,
    correction,
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
    baseConclusion,
    conclusion: cleanText(value.conclusion, 2_000),
    review: cleanReview(value.review, createdAt, status),
    thread: Array.isArray(value.thread) ? value.thread.map((turn) => ({
      id: /^[\w-]{1,80}$/.test(String(turn?.id || "")) ? String(turn.id) : randomUUID(),
      question: cleanText(turn?.question, 1_000),
      answer: cleanText(turn?.answer, 2_000),
      summary: cleanText(turn?.summary, 2_000),
      createdAt: Number(turn?.createdAt) || createdAt,
    })).filter((turn) => turn.question || turn.answer) : [],
  };
}

async function loadLibrary() {
  try {
    const value = JSON.parse(await readFile(libraryPath, "utf8"));
    const normalized = {
      version: 2,
      entries: Array.isArray(value.entries) ? value.entries.map(cleanEntry).filter((entry) => entry.raw) : [],
    };
    if (value.version !== 2) await writePrivateJson(libraryPath, normalized);
    return normalized;
  } catch (error) {
    if (error.code === "ENOENT") {
      if (!process.env.SHICI_DATA_PATH) {
        try {
          const value = JSON.parse(await readFile(join(legacyDataRoot, "library.json"), "utf8"));
          const normalized = { version: 2, entries: Array.isArray(value.entries) ? value.entries.map(cleanEntry).filter((entry) => entry.raw) : [] };
          await writePrivateJson(libraryPath, normalized);
          return normalized;
        } catch (legacyError) { if (legacyError.code !== "ENOENT") throw legacyError; }
      }
      return { version: 2, entries: [] };
    }
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
    const serialized = JSON.stringify(next);
    if (serialized !== librarySerialized) {
      await writePrivateJson(libraryPath, next);
      librarySerialized = serialized;
    }
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
  const providerBaseUrl = provider?.baseUrl ? normalizeApiBase(provider.baseUrl) : "";
  const baseMatchesProvider = !provider || !Object.hasOwn(overrides, "baseUrl") || baseUrl === providerBaseUrl;
  const model = String(overrides.model ?? provider?.model ?? envConfig.model).trim();
  const allowNoKey = Boolean(overrides.allowNoKey ?? provider?.allowNoKey ?? envConfig.allowNoKey);
  let apiKey;
  if (Object.hasOwn(overrides, "apiKey") && String(overrides.apiKey).trim()) apiKey = String(overrides.apiKey).trim();
  else if (Object.hasOwn(overrides, "apiKey") && allowNoKey) apiKey = "";
  else if (provider && baseMatchesProvider && Object.hasOwn(provider, "apiKey")) apiKey = provider.apiKey;
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
  if (response.destroyed || response.writableEnded) return;
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

async function fetchJson(url, options, signal) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const signals = [AbortSignal.timeout(120_000), ...(signal ? [signal] : [])];
      const response = await fetch(url, { ...options, signal: AbortSignal.any(signals) });
      const raw = await response.text();
      const contentType = response.headers.get("content-type") || "";
      let data;
      try { data = contentType.includes("text/event-stream") ? parseSse(raw) : (raw ? JSON.parse(raw) : {}); }
      catch { data = { raw }; }
      if (!response.ok) {
        const error = new Error(data.error?.message || data.message || `上游请求失败 (${response.status})`);
        error.status = response.status;
        throw error;
      }
      return data;
    } catch (error) {
      if (signal?.aborted || ![429, 500, 502, 503, 504].includes(error.status) || attempt === 2) throw error;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(resolve, 250 * 2 ** attempt);
        signal?.addEventListener("abort", () => { clearTimeout(timer); reject(new DOMException("请求已暂停", "AbortError")); }, { once: true });
      });
    }
  }
  throw new Error("上游请求失败");
}

function parseSse(raw) {
  let responseText = "";
  let chatText = "";
  for (const line of raw.split(/\r?\n/)) {
    if (!line.startsWith("data:")) continue;
    const chunk = line.slice(5).trim();
    if (!chunk || chunk === "[DONE]") continue;
    let event;
    try { event = JSON.parse(chunk); } catch { continue; }
    responseText += event.type === "response.output_text.delta" ? String(event.delta || "") : "";
    chatText += String(event.choices?.[0]?.delta?.content || "");
    if (event.type === "response.completed" && event.response) return event.response;
  }
  return responseText ? { output_text: responseText } : { choices: [{ message: { content: chatText } }] };
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

async function explainWithAI(payload, config, signal) {
  const schema = responseSchemas[payload.mode === "followup" ? "followup" : "new"];
  const request = (structured) => config.apiStyle === "responses"
    ? fetchJson(`${config.baseUrl}/responses`, {
      method: "POST", headers: requestHeaders(config),
      body: JSON.stringify({ model: config.model, instructions: systemPrompt, input: JSON.stringify(payload), max_output_tokens: 1_200, ...(structured ? { stream: true, text: { format: { type: "json_schema", name: payload.mode === "followup" ? "shici_followup" : "shici_entry", strict: true, schema } } } : {}) }),
    }, signal).then((data) => parseModelJson(responseOutputText(data)))
    : fetchJson(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: requestHeaders(config),
      body: JSON.stringify({ model: config.model, temperature: 0.2, max_tokens: 1_200, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(payload) }], ...(structured ? { stream: true, response_format: { type: "json_schema", json_schema: { name: payload.mode === "followup" ? "shici_followup" : "shici_entry", strict: true, schema } } } : {}) }),
    }, signal).then((data) => parseModelJson(data.choices?.[0]?.message?.content));
  try {
    return await request(true);
  } catch (error) {
    if (error.status !== 400) throw error;
    return request(false);
  }
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

async function createEntry(body, signal) {
  const payload = compactPayload({ mode: "new", text: body.text, source: body.source });
  if (!payload.text.trim()) throw new Error("请输入一个语言片段");
  const normalized = payload.text.trim().toLocaleLowerCase();
  const duplicate = library.entries.find((entry) => [entry.raw, entry.displayText].some((value) => value.trim().toLocaleLowerCase() === normalized));
  if (duplicate) return { entry: duplicate, duplicate: true, demo: false };
  const config = resolveConfig();
  const result = config.configured ? await explainWithAI(payload, config, signal) : explainInDemo(payload);
  signal?.throwIfAborted();
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
    baseConclusion: result.memoryCue || result.meaning,
    conclusion: result.memoryCue || result.meaning,
    review: { dueAt: createdAt + 10 * 60_000 },
    thread: [],
  });
  await saveLibrary((entries) => entries.unshift(entry));
  return { entry, demo: Boolean(result.demo) };
}

async function addFollowup(id, body, signal) {
  const entry = library.entries.find((item) => item.id === id);
  if (!entry) throw new Error("没有找到这个片段");
  const payload = compactPayload({
    mode: "followup",
    text: body.text,
    root: entry.displayText || entry.raw,
    conclusion: entry.conclusion,
    recentTurns: entry.thread,
  });
  if (!payload.text.trim()) throw new Error("请输入追问内容");
  const config = resolveConfig();
  const result = config.configured ? await explainWithAI(payload, config, signal) : explainInDemo(payload);
  signal?.throwIfAborted();
  const updated = await saveLibrary((entries) => {
    const current = entries.find((item) => item.id === id);
    if (!current) throw new Error("没有找到这个片段");
    current.thread.push({ id: randomUUID(), question: payload.text, answer: cleanText(result.answer, 2_000), summary: cleanText(result.summary, 2_000), createdAt: Date.now() });
    current.conclusion = cleanText(result.summary || current.conclusion, 2_000);
    current.updatedAt = Date.now();
    return current;
  });
  return { entry: updated, demo: Boolean(result.demo) };
}

async function rewindFollowups(id, body) {
  return saveLibrary((entries) => {
    const entry = entries.find((item) => item.id === id);
    if (!entry) throw new Error("没有找到这个片段");
    const turnId = cleanText(body.turnId, 80);
    const index = turnId ? entry.thread.findIndex((turn) => turn.id === turnId) : -1;
    if (turnId && index < 0) throw new Error("没有找到这一轮追问");
    entry.thread.splice(turnId ? index + 1 : 0);
    const last = entry.thread.at(-1);
    entry.conclusion = cleanText(last?.summary || entry.baseConclusion || entry.meaning, 2_000);
    entry.updatedAt = Date.now();
    return entry;
  });
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

  if (repetitions > 1 && grade !== "again") intervalDays *= 0.9 + (Math.floor(now / 60_000) % 21) / 100;
  intervalDays = Math.round(intervalDays * 100) / 100;
  return {
    dueAt: now + intervalDays * 86_400_000,
    intervalDays,
    ease: Math.round(ease * 100) / 100,
    repetitions,
    lapses,
    leech: lapses >= 8,
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
    entry.status = grade === "again" ? "review" : "learned";
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
  return { version: 2, entries: structuredClone(library.entries) };
}

function trustedApiRequest(request) {
  const allowedHosts = new Set([`127.0.0.1:${port}`, `localhost:${port}`]);
  if (!allowedHosts.has(String(request.headers.host || "").toLowerCase())) return false;
  if (request.headers["x-shici"] !== "1") return false;
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite && !["same-origin", "same-site", "none"].includes(fetchSite)) return false;
  const origin = request.headers.origin;
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return url.protocol === "http:" && allowedHosts.has(url.host.toLowerCase());
  } catch {
    return false;
  }
}

function errorStatus(error) {
  const message = error?.message || "";
  if (error instanceof SyntaxError || /请输入|格式不正确|Base URL|不支持|请.*填写|没有找到/.test(message)) {
    return /没有找到/.test(message) ? 404 : 400;
  }
  return 502;
}

async function handleApi(request, response, pathname) {
  if (!trustedApiRequest(request)) {
    sendJson(response, 403, { error: "Forbidden" });
    return true;
  }
  const cancellation = new AbortController();
  request.once("aborted", () => cancellation.abort());
  response.once("close", () => { if (!response.writableEnded) cancellation.abort(); });
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
      sendJson(response, 201, await createEntry(await readJson(request), cancellation.signal));
      return true;
    }
    const followupMatch = pathname.match(/^\/api\/entries\/([\w-]+)\/followups$/);
    if (followupMatch && request.method === "POST") {
      sendJson(response, 201, await addFollowup(followupMatch[1], await readJson(request), cancellation.signal));
      return true;
    }
    if (followupMatch && request.method === "PATCH") {
      sendJson(response, 200, { entry: await rewindFollowups(followupMatch[1], await readJson(request)) });
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
  } catch (error) {
    if (cancellation.signal.aborted) return true;
    sendJson(response, errorStatus(error), { error: error.message || "请求失败" });
    return true;
  }
  if (pathname.startsWith("/api/")) {
    sendJson(response, 404, { error: "Not found" });
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
