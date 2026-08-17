import { createReadStream } from "node:fs";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveDataRoot } from "./scripts/data-root.mjs";

const appRoot = fileURLToPath(new URL(".", import.meta.url));
const publicRoot = join(appRoot, "public");
const dataRoot = process.env.SHICI_DATA_DIR || resolveDataRoot();
const legacyDataRoot = join(appRoot, ".local");
const settingsPath = process.env.AI_SETTINGS_PATH || join(dataRoot, "settings.json");
const libraryPath = process.env.SHICI_DATA_PATH || join(dataRoot, "library.json");
const webdavPath = join(dirname(libraryPath), "webdav.json");
const port = Number(process.env.PORT || 4173);
const envBaseUrl = process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1";
const envConfig = {
  apiStyle: process.env.AI_API_STYLE || (envBaseUrl.includes("api.openai.com") ? "responses" : "compatible"),
  baseUrl: envBaseUrl,
  apiKey: process.env.AI_API_KEY || process.env.OPENAI_API_KEY || "",
  model: process.env.AI_MODEL || process.env.OPENAI_MODEL || "",
  reasoningEffort: process.env.AI_REASONING_EFFORT || "auto",
  allowNoKey: process.env.AI_ALLOW_NO_KEY === "1",
};

const reasoningEfforts = new Set(["auto", "none", "low", "medium", "high"]);
const MAX_OUTPUT_TOKENS = 4_000;
const CAPABILITY_TTL = 30 * 60_000;

class ApiError extends Error {
  constructor(message, status = 502) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

function normalizeReasoningEffort(value) {
  const effort = String(value || "").trim().toLowerCase();
  return reasoningEfforts.has(effort) ? effort : "auto";
}

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
      meaning: { type: "string" }, context: { type: "string" }, difficulty: { type: "number", minimum: 1, maximum: 5 },
      words: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, original: { type: "string" }, correction: { type: "string" }, pronunciation: { type: "string" }, meaning: { type: "string" }, context: { type: "string" }, usage: { type: "array", items: { type: "string" } }, partOfSpeech: { type: "array", items: { type: "string" } }, forms: { type: "array", items: { type: "object", additionalProperties: false, properties: { form: { type: "string" }, label: { type: "string" } }, required: ["form", "label"] } }, difficulty: { type: "number", minimum: 1, maximum: 5 } }, required: ["text", "original", "correction", "pronunciation", "meaning", "context", "usage", "partOfSpeech", "forms", "difficulty"] } },
      usage: { type: "array", items: { type: "string" } },
      chunks: { type: "array", items: { type: "object", additionalProperties: false, properties: { text: { type: "string" }, meaning: { type: "string" } }, required: ["text", "meaning"] } },
      memoryCue: { type: "string" },
    },
    required: ["type", "kind", "displayText", "correction", "pronunciation", "meaning", "context", "difficulty", "words", "usage", "chunks", "memoryCue"],
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
let webdavConfig = normalizeWebdavConfig(await loadWebdavConfig());
const providerCapabilities = new Map();

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
      reasoningEffort: normalizeReasoningEffort(provider?.reasoningEffort),
      enableThinkingToggle: Boolean(provider?.enableThinkingToggle),
      allowNoKey: Boolean(provider?.allowNoKey),
    }));
    const activeProviderId = providers.some((provider) => provider.id === value.activeProviderId)
      ? value.activeProviderId
      : providers[0]?.id || "";
    return { version: 2, activeProviderId, providers };
  }
  if (value.baseUrl || value.model || value.apiKey) {
    const id = "default";
    return { version: 2, activeProviderId: id, providers: [{ ...value, id, name: "默认 Provider", reasoningEffort: normalizeReasoningEffort(value.reasoningEffort), enableThinkingToggle: Boolean(value.enableThinkingToggle) }] };
  }
  return { version: 2, activeProviderId: "", providers: [] };
}

function cleanText(value, limit = 5_000) {
  return String(value || "").trim().slice(0, limit);
}

function wordParts(raw) {
  return String(raw || "").split(/[\n,，;；]+/).map((part) => part.trim()).filter(Boolean);
}

function normalizeToken(value) {
  return String(value || "").toLocaleLowerCase().replace(/^[^\p{L}\p{N}'’]+|[^\p{L}\p{N}'’]+$/gu, "");
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= right.length; j += 1) {
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1));
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function claimOriginal(originalParts, used, text, preferred = "") {
  const findExact = (target) => originalParts.findIndex((part, index) => !used.has(index) && normalizeToken(part) === normalizeToken(target));
  let index = preferred ? findExact(preferred) : -1;
  if (index < 0) index = findExact(text);
  if (index < 0) {
    const target = normalizeToken(text);
    let best = -1;
    let bestDistance = 3;
    originalParts.forEach((part, partIndex) => {
      if (used.has(partIndex)) return;
      const distance = editDistance(normalizeToken(part), target);
      if (distance < bestDistance) { bestDistance = distance; best = partIndex; }
    });
    index = best;
  }
  if (index < 0) return "";
  used.add(index);
  return originalParts[index];
}

function normalizeWordCorrection(raw, text, correction) {
  const supplied = cleanText(correction, 200);
  if (supplied) {
    const parts = supplied.split(/\s*(?:→|->)\s*/);
    if (parts.length === 2 && normalizeToken(parts[0]) && normalizeToken(parts[1])) return `${normalizeToken(parts[0])} → ${normalizeToken(parts[1])}`;
  }
  const before = normalizeToken(raw);
  const after = normalizeToken(text);
  const inflection = before.endsWith("ed") && before.slice(0, -2) === after
    || before.endsWith("ing") && before.slice(0, -3) === after
    || before.endsWith("s") && before.slice(0, -1) === after;
  return before && after && before !== after && !inflection && editDistance(before, after) <= 2 ? `${before} → ${after}` : "";
}

function isWordToken(value) {
  return /^[\p{L}\p{M}][\p{L}\p{M}'’-]*$/u.test(value);
}

function capitalizeWord(value) {
  const text = String(value || "");
  if (text !== text.toLocaleLowerCase()) return text;
  const letters = Array.from(text);
  if (letters.length) letters[0] = letters[0].toLocaleUpperCase();
  return letters.join("");
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

function normalizeDifficulty(value) {
  const difficulty = Number(value);
  return Number.isFinite(difficulty) && difficulty >= 1 && difficulty <= 5
    ? Math.round(difficulty * 10) / 10
    : null;
}

function estimateDifficulty(value = {}) {
  const displayText = cleanText(value.displayText || value.raw);
  const kind = value.kind || inferKind(displayText);
  const letters = Array.from(displayText).filter((character) => /\p{L}/u.test(character)).length;
  const wordCount = displayText.split(/\s+/).filter(Boolean).length;
  let difficulty = kind === "sentence" ? 3.4 : kind === "phrase" ? 2.8 : kind === "word_list" ? 3 : 2.1;
  if (kind === "word") {
    difficulty += Math.min(1.3, Math.max(0, letters - 5) * 0.12);
    if (/[bcdfghjklmnpqrstvwxyz]{3}/iu.test(displayText)) difficulty += 0.25;
  } else {
    difficulty += Math.min(0.9, Math.max(0, wordCount - 3) * 0.12);
  }
  if (cleanText(value.pronunciation, 500).length > 18) difficulty += 0.2;
  const review = value.review || {};
  difficulty += Math.min(0.8, Math.max(0, Number(review.lapses) || 0) * 0.2);
  difficulty -= Math.min(0.5, Math.max(0, Number(review.repetitions) || 0) * 0.05);
  if (review.lastGrade === "again") difficulty += 0.4;
  if (review.lastGrade === "hard") difficulty += 0.2;
  if (review.lastGrade === "easy") difficulty -= 0.25;
  return Math.round(Math.min(5, Math.max(1, difficulty)) * 10) / 10;
}

function adjustDifficulty(value, grade) {
  const delta = { again: 0.4, hard: 0.2, good: -0.1, easy: -0.25 }[grade] || 0;
  return Math.round(Math.min(5, Math.max(1, (normalizeDifficulty(value) ?? 3) + delta)) * 10) / 10;
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
  if (kind === "word") displayText = capitalizeWord(displayText);
  const meaning = cleanText(value.meaning);
  let words = Array.isArray(value.words) ? value.words.slice(0, 50).map((word) => ({
    text: capitalizeWord(cleanText(word?.text, 200)),
    pronunciation: cleanText(word?.pronunciation, 500),
    meaning: cleanText(word?.meaning, 1_000),
    partOfSpeech: Array.isArray(word?.partOfSpeech) ? word.partOfSpeech.slice(0, 6).map((item) => cleanText(item, 40)).filter(Boolean) : [],
    forms: Array.isArray(word?.forms) ? word.forms.slice(0, 8).map((form) => ({ form: cleanText(form?.form, 200), label: cleanText(form?.label, 80) })).filter((form) => form.form && form.label) : [],
  })).filter((word) => word.text) : [];
  if (kind === "word" && !words.length) words = [{ text: displayText, pronunciation, meaning, partOfSpeech: [], forms: [] }];
  if (kind === "word_list" && !words.length) words = wordParts(displayText).map((text) => ({ text, pronunciation: "", meaning: "", partOfSpeech: [], forms: [] }));
  const baseConclusion = cleanText(value.baseConclusion || value.meaning || value.conclusion, 2_000);
  const context = cleanText(value.context);
  const usage = Array.isArray(value.usage) ? value.usage.slice(0, 3).map((item) => cleanText(item, 1_000)).filter(Boolean) : [];
  const review = cleanReview(value.review, createdAt, status);
  const difficulty = normalizeDifficulty(value.difficulty) ?? estimateDifficulty({ raw, displayText, kind, pronunciation, meaning, context, usage, review });
  return {
    id: /^[\w-]{1,80}$/.test(String(value.id || "")) ? String(value.id) : randomUUID(),
    raw,
    kind,
    words,
    displayText,
    correction,
    pronunciation: pronunciation || (kind === "word" ? words[0]?.pronunciation || "" : ""),
    meaning,
    context,
    usage,
    difficulty,
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
    review,
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
    if (JSON.stringify(value) !== JSON.stringify(normalized)) await writePrivateJson(libraryPath, normalized);
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
    const previousIds = new Set(library.entries.map((entry) => entry.id));
    const nextIds = new Set(next.entries.map((entry) => entry.id));
    const deletedIds = [...previousIds].filter((id) => !nextIds.has(id));
    let webdavChanged = false;
    for (const entry of next.entries) {
      const deletedAt = Number(webdavConfig.tombstones[entry.id]) || 0;
      if (!deletedAt) continue;
      entry.updatedAt = Math.max(Number(entry.updatedAt) || 0, deletedAt + 1);
      delete webdavConfig.tombstones[entry.id];
      webdavChanged = true;
    }
    const serialized = JSON.stringify(next);
    if (serialized !== librarySerialized) {
      await writePrivateJson(libraryPath, next);
      librarySerialized = serialized;
    }
    if (deletedIds.length) {
      const deletedAt = Date.now();
      for (const id of deletedIds) webdavConfig.tombstones[id] = deletedAt;
      webdavChanged = true;
    }
    if (webdavChanged) {
      await writePrivateJson(webdavPath, webdavConfig);
    }
    library = next;
    return structuredClone(result);
  });
  libraryWrite = operation.catch(() => {});
  return operation;
}

const MAX_WEBDAV_BYTES = 25 * 1024 * 1024;

async function loadWebdavConfig() {
  try { return JSON.parse(await readFile(webdavPath, "utf8")); }
  catch (error) {
    if (error.code === "ENOENT") return {};
    console.warn(`无法读取 WebDAV 配置：${error.message}`);
    return {};
  }
}

function normalizeWebdavBaseUrl(value) {
  try {
    const url = new URL(String(value || "").trim());
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "";
    url.search = "";
    url.hash = "";
    url.pathname = `${url.pathname.replace(/\/+$/, "")}/`;
    return url.toString();
  } catch { return ""; }
}

function normalizeWebdavPath(value) {
  const parts = cleanText(value, 500).replaceAll("\\", "/").split("/").map((part) => part.trim()).filter(Boolean);
  const safe = parts.filter((part) => part !== "." && part !== ".." && ![...part].some((char) => char.charCodeAt(0) < 32));
  return safe.length ? safe.join("/") : "shici/library.json";
}

function normalizeWebdavConfig(value = {}) {
  const tombstones = {};
  const source = value.tombstones && typeof value.tombstones === "object" ? value.tombstones : {};
  for (const [id, at] of Object.entries(source).slice(0, 20_000)) {
    if (/^[\w-]{1,80}$/.test(id) && Number(at) > 0) tombstones[id] = Number(at);
  }
  return {
    version: 1,
    enabled: Boolean(value.enabled),
    baseUrl: normalizeWebdavBaseUrl(value.baseUrl),
    username: cleanText(value.username, 500),
    password: cleanText(value.password, 2_000),
    remotePath: normalizeWebdavPath(value.remotePath),
    etag: cleanText(value.etag, 500),
    lastHash: cleanText(value.lastHash, 128),
    lastSyncAt: Number(value.lastSyncAt) || 0,
    lastStatus: cleanText(value.lastStatus, 40),
    lastError: cleanText(value.lastError, 1_000),
    tombstones,
  };
}

function publicWebdavConfig() {
  return {
    enabled: webdavConfig.enabled,
    baseUrl: webdavConfig.baseUrl,
    username: webdavConfig.username,
    remotePath: webdavConfig.remotePath,
    hasPassword: Boolean(webdavConfig.password),
    lastSyncAt: webdavConfig.lastSyncAt,
    lastStatus: webdavConfig.lastStatus,
    lastError: webdavConfig.lastError,
  };
}

function draftWebdavConfig(body = {}) {
  const baseUrl = normalizeWebdavBaseUrl(body.baseUrl ?? webdavConfig.baseUrl);
  if (!baseUrl) throw new ApiError("WebDAV 根地址格式不正确", 400);
  const remotePath = normalizeWebdavPath(body.remotePath ?? webdavConfig.remotePath);
  if (!remotePath.endsWith(".json")) throw new ApiError("远端文件路径需要以 .json 结尾", 400);
  return normalizeWebdavConfig({
    ...webdavConfig,
    enabled: Boolean(body.enabled),
    baseUrl,
    username: cleanText(body.username ?? webdavConfig.username, 500),
    password: String(body.password || "").trim() || webdavConfig.password,
    remotePath,
  });
}

function webdavFileUrl(config) {
  const url = new URL(config.baseUrl);
  url.pathname += config.remotePath.split("/").map((part) => encodeURIComponent(part)).join("/");
  return url.toString();
}

function webdavFolderUrls(config) {
  const parts = config.remotePath.split("/").slice(0, -1);
  const url = new URL(config.baseUrl);
  return parts.map((part) => {
    url.pathname += `${encodeURIComponent(part)}/`;
    return url.toString();
  });
}

function webdavHeaders(config, extra = {}) {
  const headers = { ...extra };
  if (config.username || config.password) headers.Authorization = `Basic ${Buffer.from(`${config.username}:${config.password}`).toString("base64")}`;
  return headers;
}

async function webdavRequest(config, url, options = {}) {
  let response;
  try {
    response = await fetch(url, {
      ...options,
      redirect: "manual",
      signal: options.signal || AbortSignal.timeout(15_000),
      headers: webdavHeaders(config, options.headers),
    });
  } catch (error) {
    throw new ApiError(`无法连接 WebDAV 服务：${error.message}`, 502);
  }
  if ([301, 302, 303, 307, 308].includes(response.status)) throw new ApiError("WebDAV 地址发生重定向，请填写最终地址", 502);
  return response;
}

function webdavError(response, fallback = "WebDAV 请求失败") {
  if (response.status === 401) return new ApiError("WebDAV 认证失败，请检查账号或密码", 502);
  if (response.status === 403) return new ApiError("WebDAV 服务拒绝访问，请检查权限", 502);
  if (response.status === 404) return new ApiError("WebDAV 路径不存在", 502);
  return new ApiError(`${fallback}（${response.status}）`, 502);
}

async function readWebdavJson(response) {
  const length = Number(response.headers.get("content-length"));
  if (Number.isFinite(length) && length > MAX_WEBDAV_BYTES) throw new ApiError("远端同步文件超过 25 MB，已停止读取", 413);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_WEBDAV_BYTES) throw new ApiError("远端同步文件超过 25 MB，已停止读取", 413);
  try { return JSON.parse(new TextDecoder().decode(bytes)); }
  catch { throw new ApiError("远端同步文件不是有效 JSON", 502); }
}

function webdavPayload(value) {
  const entries = [...(value.entries || [])].sort((left, right) => String(left.id).localeCompare(String(right.id)));
  const tombstones = Object.entries(value.tombstones || {})
    .map(([id, updatedAt]) => ({ id, updatedAt: Number(updatedAt) || 0 }))
    .filter((item) => item.id && item.updatedAt > 0)
    .sort((left, right) => left.id.localeCompare(right.id));
  return { format: "shici-sync", version: 1, entries, tombstones };
}

function webdavHash(value) {
  return createHash("sha256").update(JSON.stringify(webdavPayload(value))).digest("hex");
}

function normalizeWebdavEnvelope(value = {}) {
  const entries = Array.isArray(value.entries) ? value.entries.map(cleanEntry).filter((entry) => entry.raw) : [];
  const tombstones = {};
  const source = Array.isArray(value.tombstones) ? value.tombstones : Object.entries(value.tombstones || {}).map(([id, updatedAt]) => ({ id, updatedAt }));
  for (const item of source.slice(0, 20_000)) {
    const id = cleanText(item?.id, 80);
    const updatedAt = Number(item?.updatedAt) || 0;
    if (/^[\w-]{1,80}$/.test(id) && updatedAt > 0) tombstones[id] = Math.max(tombstones[id] || 0, updatedAt);
  }
  for (const entry of entries) if (tombstones[entry.id] <= Number(entry.updatedAt)) delete tombstones[entry.id];
  return { entries, tombstones };
}

function mergeWebdavEnvelopes(local, remote) {
  const byId = new Map(local.entries.map((entry) => [entry.id, entry]));
  for (const entry of remote.entries) {
    const current = byId.get(entry.id);
    if (!current || Number(entry.updatedAt) > Number(current.updatedAt)) byId.set(entry.id, entry);
  }
  const tombstones = { ...local.tombstones };
  for (const [id, updatedAt] of Object.entries(remote.tombstones)) tombstones[id] = Math.max(tombstones[id] || 0, updatedAt);
  const entries = [...byId.values()].filter((entry) => Number(entry.updatedAt) > (tombstones[entry.id] || 0));
  for (const id of Object.keys(tombstones)) if (entries.some((entry) => entry.id === id && Number(entry.updatedAt) > tombstones[id])) delete tombstones[id];
  return { entries, tombstones };
}

async function testWebdav(body = {}) {
  const config = draftWebdavConfig({ ...body, enabled: false });
  const response = await webdavRequest(config, config.baseUrl, {
    method: "PROPFIND",
    headers: { Depth: "0", "Content-Type": "application/xml" },
    body: "<?xml version=\"1.0\" encoding=\"utf-8\"?><propfind xmlns=\"DAV:\"><propname/></propfind>",
  });
  if (![200, 207].includes(response.status)) throw webdavError(response, "WebDAV 连接测试失败");
  return { ok: true, status: response.status, server: response.headers.get("server") || "" };
}

async function saveWebdavConfig(body = {}) {
  webdavConfig = draftWebdavConfig(body);
  await writePrivateJson(webdavPath, webdavConfig);
  return publicWebdavConfig();
}

async function putWebdav(config, payload, etag, missing) {
  for (const folderUrl of webdavFolderUrls(config)) {
    const folderResponse = await webdavRequest(config, folderUrl, { method: "MKCOL" });
    if (![200, 201, 204, 405].includes(folderResponse.status)) throw webdavError(folderResponse, "无法创建 WebDAV 文件夹");
  }
  const headers = { "Content-Type": "application/json; charset=utf-8" };
  if (missing) headers["If-None-Match"] = "*";
  else if (etag) headers["If-Match"] = etag;
  const response = await webdavRequest(config, webdavFileUrl(config), { method: "PUT", headers, body: `${JSON.stringify(payload, null, 2)}\n` });
  if (![200, 201, 204].includes(response.status)) throw webdavError(response, "无法写入 WebDAV 同步文件");
  return response.headers.get("etag") || etag || "";
}

async function syncWebdav(options = {}) {
  if (!webdavConfig.enabled) return { ...publicWebdavConfig(), status: "disabled", entries: library.entries };
  await libraryWrite;
  const config = normalizeWebdavConfig(webdavConfig);
  const local = normalizeWebdavEnvelope({ entries: library.entries, tombstones: config.tombstones });
  const localHash = webdavHash(local);
  let remote = null;
  let remoteEtag = config.etag;
  let remoteMissing = false;
  try {
    const response = await webdavRequest(config, webdavFileUrl(config), { method: "GET", headers: config.etag ? { "If-None-Match": config.etag } : {} });
    if (response.status === 304) {
      if (config.lastHash !== localHash) remote = null;
    } else if (response.status === 404) {
      remoteMissing = true;
    } else if (response.status === 200) {
      remote = normalizeWebdavEnvelope(await readWebdavJson(response));
      remoteEtag = response.headers.get("etag") || "";
    } else throw webdavError(response, "无法读取 WebDAV 同步文件");
    if (!remoteMissing && !remote && config.lastHash === localHash) {
      webdavConfig = { ...config, lastSyncAt: Date.now(), lastStatus: "unchanged", lastError: "" };
      await writePrivateJson(webdavPath, webdavConfig);
      return { ...publicWebdavConfig(), status: "unchanged", entries: library.entries };
    }
    let merged = remote ? mergeWebdavEnvelopes(local, remote) : local;
    const mergedPayload = webdavPayload(merged);
    const remotePayload = remote ? webdavPayload(remote) : null;
    const mergedHash = webdavHash(merged);
    if (JSON.stringify(mergedPayload) !== JSON.stringify(webdavPayload(local))) {
      const next = { version: 2, entries: merged.entries };
      const serialized = JSON.stringify(next);
      if (serialized !== librarySerialized) {
        await writePrivateJson(libraryPath, next);
        library = next;
        librarySerialized = serialized;
      }
      webdavConfig.tombstones = merged.tombstones;
    }
    const needsUpload = remoteMissing || !remote || JSON.stringify(remotePayload) !== JSON.stringify(mergedPayload);
    if (needsUpload) remoteEtag = await putWebdav(config, mergedPayload, remoteEtag, remoteMissing);
    webdavConfig = { ...config, etag: remoteEtag, lastHash: mergedHash, lastSyncAt: Date.now(), lastStatus: needsUpload ? "synced" : "merged", lastError: "", tombstones: merged.tombstones };
    await writePrivateJson(webdavPath, webdavConfig);
    return { ...publicWebdavConfig(), status: webdavConfig.lastStatus, entries: library.entries };
  } catch (error) {
    webdavConfig = { ...config, lastSyncAt: Date.now(), lastStatus: "error", lastError: error.message || "同步失败" };
    await writePrivateJson(webdavPath, webdavConfig).catch(() => {});
    throw error;
  }
}

function normalizeApiBase(value) {
  let url;
  try { url = new URL(String(value || "").trim()); }
  catch { throw new ApiError("Base URL 格式不正确", 400); }
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
  const reasoningEffort = normalizeReasoningEffort(overrides.reasoningEffort ?? provider?.reasoningEffort ?? envConfig.reasoningEffort);
  const enableThinkingToggle = Boolean(overrides.enableThinkingToggle ?? provider?.enableThinkingToggle ?? false);
  const allowNoKey = Boolean(overrides.allowNoKey ?? provider?.allowNoKey ?? envConfig.allowNoKey);
  let apiKey;
  if (Object.hasOwn(overrides, "apiKey") && String(overrides.apiKey).trim()) apiKey = String(overrides.apiKey).trim();
  else if (Object.hasOwn(overrides, "apiKey") && allowNoKey) apiKey = "";
  else if (provider && baseMatchesProvider && Object.hasOwn(provider, "apiKey")) apiKey = provider.apiKey;
  else apiKey = envConfig.apiKey;

  if (!["responses", "compatible"].includes(apiStyle)) throw new ApiError("API 方式只能是 Responses 或 Compatible", 400);
  return {
    apiStyle,
    providerId: provider?.id || "",
    providerName: provider?.name || (envConfig.apiKey || envConfig.model ? "环境配置" : "新 Provider"),
    baseUrl,
    apiKey,
    model,
    reasoningEffort,
    enableThinkingToggle,
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
        model: item.model, reasoningEffort: item.reasoningEffort, allowNoKey: item.allowNoKey, hasApiKey: Boolean(item.apiKey), configured: item.configured,
        enableThinkingToggle: item.enableThinkingToggle,
      };
    }),
    apiStyle: config.apiStyle,
    baseUrl: config.baseUrl,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
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
  const reasoningEffort = normalizeReasoningEffort(body.reasoningEffort);
  const enableThinkingToggle = Boolean(body.enableThinkingToggle);
  const name = cleanText(body.name, 80) || new URL(baseUrl).host;
  const allowNoKey = Boolean(body.allowNoKey);
  const apiKeyInput = String(body.apiKey || "").trim();
  const apiKey = apiKeyInput || (allowNoKey ? "" : existing?.apiKey || "");
  if (!model) throw new Error("请填写或选择模型 ID");
  if (!apiKey && !allowNoKey) throw new Error("请填写 API Key，或允许无密钥服务");

  const next = { id: providerId, name, apiStyle, baseUrl, model, reasoningEffort, enableThinkingToggle, allowNoKey, apiKey };
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
  try {
    return JSON.parse(Buffer.concat(parts).toString("utf8") || "{}");
  } catch {
    throw new ApiError("请求 JSON 格式不正确", 400);
  }
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
        throw new ApiError(data.error?.message || data.message || `上游请求失败 (${response.status})`, response.status);
      }
      if (data?.status === "incomplete" && data.incomplete_details?.reason === "max_output_tokens") {
        throw new ApiError("模型输出被推理过程耗尽，请提高输出上限或降低推理程度", 502);
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
  let clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  clean = clean.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  const start = clean.search(/[{[]/);
  if (start > 0) clean = clean.slice(start);
  let depth = 0;
  let quoted = false;
  let escaped = false;
  let end = -1;
  for (let index = 0; index < clean.length; index += 1) {
    const char = clean[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') { quoted = true; continue; }
    if (char === "{" || char === "[") depth += 1;
    if (char === "}" || char === "]") {
      depth -= 1;
      if (depth === 0) { end = index + 1; break; }
    }
  }
  if (end > 0) clean = clean.slice(0, end);
  try {
    return JSON.parse(clean);
  } catch {
    throw new ApiError("模型返回了无法解析的 JSON，请降低推理程度或检查模型格式兼容性", 502);
  }
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
  const capabilityKey = [config.providerId, config.apiStyle, config.baseUrl, config.model, config.enableThinkingToggle].join("|");
  const cachedValue = providerCapabilities.get(capabilityKey);
  const cached = cachedValue && Date.now() - cachedValue.at < CAPABILITY_TTL ? cachedValue : {};
  const hasReasoning = config.reasoningEffort !== "auto";
  const supportsChatTemplateKwargs = config.enableThinkingToggle;
  const request = (structured, includeReasoning = true) => config.apiStyle === "responses"
    ? fetchJson(`${config.baseUrl}/responses`, {
      method: "POST", headers: requestHeaders(config),
      body: JSON.stringify({ model: config.model, instructions: systemPrompt, input: JSON.stringify(payload), max_output_tokens: MAX_OUTPUT_TOKENS, ...(includeReasoning && hasReasoning ? { reasoning: { effort: config.reasoningEffort } } : {}), ...(structured ? { text: { format: { type: "json_schema", name: payload.mode === "followup" ? "shici_followup" : "shici_entry", strict: true, schema } } } : {}) }),
    }, signal).then((data) => parseModelJson(responseOutputText(data)))
    : fetchJson(`${config.baseUrl}/chat/completions`, {
      method: "POST", headers: requestHeaders(config),
      body: JSON.stringify({ model: config.model, temperature: 0.2, max_tokens: MAX_OUTPUT_TOKENS, messages: [{ role: "system", content: systemPrompt }, { role: "user", content: JSON.stringify(payload) }], ...(includeReasoning && hasReasoning ? { reasoning_effort: config.reasoningEffort, ...(supportsChatTemplateKwargs ? { chat_template_kwargs: { enable_thinking: config.reasoningEffort !== "none" } } : {}) } : {}), ...(structured ? { response_format: { type: "json_schema", json_schema: { name: payload.mode === "followup" ? "shici_followup" : "shici_entry", strict: true, schema } } } : {}) }),
    }, signal).then((data) => parseModelJson(data.choices?.[0]?.message?.content));
  const attempts = [];
  const addAttempt = (structured, includeReasoning) => {
    if (!attempts.some((attempt) => attempt[0] === structured && attempt[1] === includeReasoning)) attempts.push([structured, includeReasoning]);
  };
  if (cached.structured !== false) {
    if (hasReasoning && cached.reasoning !== false) addAttempt(true, true);
    addAttempt(true, false);
  }
  if (hasReasoning && cached.reasoning !== false) addAttempt(false, true);
  addAttempt(false, false);
  let lastError;
  let structuredCapabilityError = false;
  let reasoningCapabilityError = false;
  for (const [structured, includeReasoning] of attempts) {
    try {
      const result = await request(structured, includeReasoning);
      providerCapabilities.set(capabilityKey, {
        structured: structured ? true : structuredCapabilityError ? false : cached.structured,
        ...(hasReasoning && includeReasoning ? { reasoning: true } : hasReasoning && reasoningCapabilityError ? { reasoning: false } : cached.reasoning === undefined ? {} : { reasoning: cached.reasoning }),
        at: Date.now(),
      });
      return result;
    } catch (error) {
      if (error.status !== 400) throw error;
      const message = String(error.message || "").toLowerCase();
      const genericCapabilityError = /unsupported|unrecognized|unknown parameter|invalid.*parameter/.test(message);
      structuredCapabilityError ||= genericCapabilityError || /response_format|json_schema/.test(message);
      reasoningCapabilityError ||= genericCapabilityError || /reasoning|chat_template|thinking/.test(message);
      lastError = error;
    }
  }
  throw lastError || new ApiError("上游不支持当前请求格式", 400);
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
  const forceNew = body.forceNew === true;
  const normalized = payload.text.trim().toLocaleLowerCase();
  const duplicate = library.entries.find((entry) => [entry.raw, entry.displayText].some((value) => value.trim().toLocaleLowerCase() === normalized));
  if (duplicate && !forceNew) return { entry: duplicate, entries: [duplicate], duplicate: true, demo: false };
  if (payload.kindHint === "word_list" && !forceNew) {
    const parts = wordParts(payload.text);
    const hits = parts.map((part) => library.entries.find((entry) => [entry.raw, entry.displayText].some((value) => value.trim().toLocaleLowerCase() === part.toLocaleLowerCase())));
    if (parts.length > 1 && hits.every(Boolean)) return { entry: hits[0], entries: hits, split: true, duplicate: true, createdCount: 0, reusedCount: hits.length, demo: false };
  }
  const config = resolveConfig();
  const result = config.configured ? await explainWithAI(payload, config, signal) : explainInDemo(payload);
  signal?.throwIfAborted();
  const splitWords = result.kind === "word_list"
    ? (Array.isArray(result.words) && result.words.length > 1 ? result.words : wordParts(payload.text).map((text) => ({ text })))
      .filter((word) => cleanText(word?.text, 200))
    : [];
  if (splitWords.length > 1) {
    const createdAt = Date.now();
    const originalParts = wordParts(payload.text);
    const used = new Set();
    const entries = splitWords.map((word) => {
      const text = capitalizeWord(cleanText(word?.text, 200));
      const raw = cleanText(claimOriginal(originalParts, used, text, word?.original) || text, 200);
      const meaning = cleanText(word?.meaning, 1_000) || cleanText(result.meaning, 2_000) || "暂时没有解释";
      const context = cleanText(word?.context, 2_000) || cleanText(result.context, 2_000);
      const usage = Array.isArray(word?.usage) && word.usage.length ? word.usage : result.usage;
      return cleanEntry({
        id: randomUUID(), raw, displayText: text, kind: "word",
        words: [{
          text,
          pronunciation: cleanText(word?.pronunciation, 500),
          meaning,
          partOfSpeech: Array.isArray(word?.partOfSpeech) ? word.partOfSpeech : [],
          forms: Array.isArray(word?.forms) ? word.forms : [],
        }],
        correction: normalizeWordCorrection(raw, text, word?.correction),
        pronunciation: cleanText(word?.pronunciation, 500), meaning,
        context, usage, chunks: [], source: payload.source,
        difficulty: normalizeDifficulty(word?.difficulty) ?? normalizeDifficulty(result.difficulty),
        status: "review", starred: false, createdAt, updatedAt: createdAt,
        baseConclusion: meaning, conclusion: meaning, review: { dueAt: createdAt + 10 * 60_000 }, thread: [],
      });
    }).filter(Boolean);
    const returned = [];
    const createdEntries = [];
    const seen = new Map();
    let reusedCount = 0;
    await saveLibrary((libraryEntries) => {
      for (const entry of entries) {
        const rawKey = entry.raw.toLocaleLowerCase();
        const displayKey = entry.displayText.toLocaleLowerCase();
        const duplicate = forceNew ? null : seen.get(displayKey) || libraryEntries.find((item) => [item.raw, item.displayText].some((value) => [rawKey, displayKey].includes(value.trim().toLocaleLowerCase())));
        if (duplicate) {
          returned.push(duplicate);
          reusedCount += 1;
        } else {
          returned.push(entry);
          createdEntries.push(entry);
          seen.set(displayKey, entry);
        }
      }
      libraryEntries.unshift(...createdEntries);
    });
    return { entry: returned[0], entries: returned, split: true, duplicate: reusedCount > 0, createdCount: createdEntries.length, reusedCount, demo: Boolean(result.demo) };
  }
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
    difficulty: result.difficulty,
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
  const saved = await saveLibrary((entries) => {
    const duplicate = forceNew ? null : entries.find((item) => [item.raw, item.displayText].some((value) => value.trim().toLocaleLowerCase() === payload.text.trim().toLocaleLowerCase()));
    if (duplicate) return { entry: duplicate, entries: [duplicate], duplicate: true, demo: false };
    entries.unshift(entry);
    return { entry, entries: [entry], demo: Boolean(result.demo) };
  });
  return saved;
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

function stableJitter(id) {
  let hash = 2_166_136_261;
  for (const byte of Buffer.from(String(id || ""))) {
    hash ^= byte;
    hash = Math.imul(hash, 16_777_619);
  }
  return 0.9 + ((hash >>> 0) % 21) / 100;
}

function scheduleReview(review, grade, id, now = Date.now()) {
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

  if (repetitions > 1 && grade !== "again") intervalDays *= stableJitter(id);
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
    entry.review = scheduleReview(entry.review, grade, id);
    entry.difficulty = adjustDifficulty(entry.difficulty, grade);
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

function entryKeys(entry) {
  return [entry.raw, entry.displayText]
    .map((value) => String(value || "").trim().toLocaleLowerCase())
    .filter(Boolean);
}

async function appendEntries(body) {
  if (!Array.isArray(body.entries)) throw new Error("片段数据格式不正确");
  const source = body.entries.slice(0, 10_000);
  const existingKeys = new Set(library.entries.flatMap(entryKeys));
  const usedIds = new Set(library.entries.map((entry) => entry.id));
  const additions = [];
  let skippedCount = 0;
  let invalidCount = 0;
  for (const value of source) {
    const entry = cleanEntry(value);
    if (!entry?.raw) {
      invalidCount += 1;
      continue;
    }
    const keys = entryKeys(entry);
    if (keys.some((key) => existingKeys.has(key))) {
      skippedCount += 1;
      continue;
    }
    if (usedIds.has(entry.id)) entry.id = randomUUID();
    usedIds.add(entry.id);
    keys.forEach((key) => existingKeys.add(key));
    additions.push(entry);
  }
  await saveLibrary((entries) => {
    entries.unshift(...additions);
  });
  return {
    version: 2,
    entries: structuredClone(library.entries),
    importedCount: additions.length,
    skippedCount,
    invalidCount,
    truncatedCount: body.entries.length - source.length,
  };
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
  if (Number.isInteger(error?.status)) return error.status;
  if (/请输入|格式不正确|Base URL|WebDAV 根地址|远端文件路径|请.*填写|没有找到/.test(message)) {
    return /没有找到/.test(message) ? 404 : 400;
  }
  return 502;
}

async function handleApi(request, response, pathname) {
  if (!pathname.startsWith("/api/")) return false;
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
    if (pathname === "/api/webdav" && request.method === "GET") {
      sendJson(response, 200, publicWebdavConfig());
      return true;
    }
    if (pathname === "/api/webdav" && request.method === "PUT") {
      sendJson(response, 200, await saveWebdavConfig(await readJson(request)));
      return true;
    }
    if (pathname === "/api/webdav/test" && request.method === "POST") {
      sendJson(response, 200, await testWebdav(await readJson(request)));
      return true;
    }
    if (pathname === "/api/webdav/sync" && request.method === "POST") {
      sendJson(response, 200, await syncWebdav({ manual: true }));
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
    if (pathname === "/api/entries/import" && request.method === "POST") {
      sendJson(response, 200, await appendEntries(await readJson(request)));
      return true;
    }
    if (pathname === "/api/entries" && request.method === "POST") {
      sendJson(response, 200, await createEntry(await readJson(request), cancellation.signal));
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
  sendJson(response, 404, { error: "Not found" });
  return true;
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
