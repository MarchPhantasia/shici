const STORAGE_KEY = "shici:v1";
const APPEARANCE_KEY = "shici:appearance";
const now = Date.now();
const sourceOptions = ["日常", "阅读", "影视", "工作", "游戏", "网页", "聊天", "其他"];
const kindLabels = { word: "单词", word_list: "词表", phrase: "短语", sentence: "句子", other: "片段" };
const shortcutLabels = { "mod-enter": "⌘/Ctrl + Enter", "shift-enter": "Shift + Enter", enter: "Enter" };

function readAppearance() {
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "{}");
    return {
      theme: ["system", "light", "dark"].includes(value.theme) ? value.theme : "system",
      fontScale: Math.min(120, Math.max(90, Number(value.fontScale) || 100)),
      sendShortcut: Object.hasOwn(shortcutLabels, value.sendShortcut) ? value.sendShortcut : "mod-enter",
    };
  } catch { return { theme: "system", fontScale: 100, sendShortcut: "mod-enter" }; }
}

const appearance = readAppearance();
const colorScheme = matchMedia("(prefers-color-scheme: dark)");

function applyAppearance() {
  const theme = appearance.theme === "system" ? (colorScheme.matches ? "dark" : "light") : appearance.theme;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.setProperty("--font-scale", appearance.fontScale / 100);
  localStorage.setItem(APPEARANCE_KEY, JSON.stringify(appearance));
}

applyAppearance();
colorScheme.addEventListener("change", () => { if (appearance.theme === "system") applyAppearance(); });

const seedEntries = [
  {
    id: "seed-figure",
    raw: "figure it out",
    displayText: "figure it out",
    correction: "",
    pronunciation: "/ˈfɪɡjər ɪt aʊt/",
    meaning: "把它弄明白；想办法解决。",
    context: "口语里常指通过思考或尝试找到答案、办法。",
    usage: ["I’ll figure it out. = 我会想办法的。"],
    chunks: [{ text: "figure out", meaning: "弄清楚；解决" }],
    source: "日常",
    status: "review",
    starred: false,
    createdAt: now - 1000 * 60 * 9,
    conclusion: "figure out 表示通过思考或尝试弄清、解决某事。",
    thread: [],
  },
  {
    id: "seed-chill",
    raw: "The familiar yet unsettling chill ran down my spine.",
    displayText: "The familiar yet unsettling chill ran down my spine.",
    correction: "",
    pronunciation: "",
    meaning: "那股熟悉却令人不安的寒意掠过我的脊背。",
    context: "run down one’s spine 常写恐惧或强烈不安带来的生理感受；yet 突出“熟悉”和“不安”的反差。",
    usage: ["a chill ran down my spine = 我脊背一阵发凉"],
    chunks: [
      { text: "familiar yet unsettling", meaning: "熟悉却令人不安" },
      { text: "run down my spine", meaning: "让我脊背发凉" },
    ],
    source: "影视",
    status: "learned",
    starred: true,
    createdAt: now - 1000 * 60 * 60 * 5,
    conclusion: "这是带有恐惧感的环境描写，核心表达是 run down my spine。",
    thread: [],
  },
  {
    id: "seed-suffocating",
    raw: "suffocating",
    displayText: "suffocating",
    correction: "",
    pronunciation: "/ˈsʌfəkeɪtɪŋ/",
    meaning: "令人窒息的；压得人喘不过气的。",
    context: "既能描述真的呼吸困难，也常比喻气氛、压力或关系令人压抑。",
    usage: ["a suffocating atmosphere = 令人窒息的氛围"],
    chunks: [{ text: "feel suffocating", meaning: "感到压抑、喘不过气" }],
    source: "游戏",
    status: "review",
    starred: false,
    createdAt: now - 1000 * 60 * 60 * 28,
    conclusion: "suffocating 可描述真实窒息，也可比喻环境或压力令人喘不过气。",
    thread: [
      {
        id: "turn-1",
        question: "可以用来形容压力很大吗？",
        answer: "可以。形容压力、工作环境或关系时，强调的是被压得喘不过气、缺少空间的感觉。",
        createdAt: now - 1000 * 60 * 60 * 27,
      },
    ],
  },
];

const state = {
  entries: [],
  view: "all",
  query: "",
  sourceFilter: "",
  sort: "recent",
  newEntryIds: [],
  activeThreadId: null,
  selectedThreadEntryId: null,
  threadAnchorId: null,
  selectedEntryId: null,
  detailClosed: true,
  detailOpened: false,
  visibleLimit: 80,
  reviewReveal: false,
  reviewHint: "",
  reviewSessionTotal: 0,
  reviewFocusId: null,
  ai: { mode: "checking", model: "", apiStyle: "responses" },
  webdav: { enabled: false, baseUrl: "", username: "", remotePath: "shici/library.json", hasPassword: false, lastStatus: "", lastError: "" },
  webdavSyncBusy: false,
  activeRequest: null,
  activeRequests: new Map(),
  storageReady: false,
};
const searchCache = new WeakMap();
let searchTimer;

const elements = {
  timeline: document.querySelector("#timeline"),
  workspace: document.querySelector(".workspace"),
  bottomNav: document.querySelector(".bottom-nav"),
  composerShell: document.querySelector(".composer-shell"),
  captureGrid: document.querySelector(".capture-grid"),
  capturePage: document.querySelector("#capture-page"),
  captureComposer: document.querySelector("#capture-composer"),
  captureInput: document.querySelector("#capture-input"),
  captureSource: document.querySelector("#capture-source-select"),
  captureSend: document.querySelector("#capture-send"),
  libraryHead: document.querySelector("#library-head"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#fragment-input"),
  source: document.querySelector("#source-select"),
  filterSelect: document.querySelector("#library-filter-select"),
  sortSelect: document.querySelector("#library-sort-select"),
  newEntryNotice: document.querySelector("#new-entry-notice"),
  focusCount: document.querySelector("#focus-count"),
  focusLabel: document.querySelector("#focus-label"),
  focusProgress: document.querySelector("#focus-progress"),
  send: document.querySelector("#send-button"),
  contextBar: document.querySelector("#context-bar"),
  contextTitle: document.querySelector("#context-title"),
  search: document.querySelector("#search-input"),
  searchBox: document.querySelector(".search-box"),
  aiState: document.querySelector("#ai-state"),
  quickModelSelect: document.querySelector("#quick-model-select"),
  captureQuickModelSelect: document.querySelector("#capture-quick-model-select"),
  captureAiState: document.querySelector("#capture-ai-state"),
  threadComposer: document.querySelector("#thread-composer"),
  threadForm: document.querySelector("#thread-form"),
  threadAnchor: document.querySelector("#thread-anchor"),
  threadInput: document.querySelector("#thread-input"),
  threadSend: document.querySelector("#thread-send"),
  threadAiState: document.querySelector("#thread-ai-state"),
  threadMessage: document.querySelector("#thread-composer-message"),
  mentionPopover: document.querySelector("#mention-popover"),
  mentionSearch: document.querySelector("#mention-search"),
  mentionList: document.querySelector("#mention-list"),
  detailPanel: document.querySelector("#detail-panel"),
  detailBackdrop: document.querySelector(".detail-backdrop"),
  detailContent: document.querySelector("#detail-content"),
  dialog: document.querySelector("#settings-dialog"),
  confirmDialog: document.querySelector("#confirm-dialog"),
  confirmTitle: document.querySelector("#confirm-title"),
  confirmMessage: document.querySelector("#confirm-message"),
  confirmAccept: document.querySelector("#confirm-accept"),
  toast: document.querySelector("#toast"),
  configForm: document.querySelector("#config-form"),
  apiBaseUrl: document.querySelector("#api-base-url"),
  providerSelect: document.querySelector("#provider-select"),
  providerName: document.querySelector("#provider-name"),
  deleteProvider: document.querySelector("#delete-provider"),
  reasoningEffort: document.querySelector("#reasoning-effort"),
  enableThinkingToggle: document.querySelector("#enable-thinking-toggle"),
  apiKey: document.querySelector("#api-key"),
  apiModel: document.querySelector("#api-model"),
  allowNoKey: document.querySelector("#allow-no-key"),
  modelOptions: document.querySelector("#model-options"),
  modelListState: document.querySelector("#model-list-state"),
  configMessage: document.querySelector("#config-message"),
  refreshModels: document.querySelector("#refresh-models"),
  fontScale: document.querySelector("#font-scale"),
  fontScaleValue: document.querySelector("#font-scale-value"),
  sendShortcut: document.querySelector("#send-shortcut"),
  importJson: document.querySelector("#import-json"),
  webdavForm: document.querySelector("#webdav-form"),
  webdavBaseUrl: document.querySelector("#webdav-base-url"),
  webdavUsername: document.querySelector("#webdav-username"),
  webdavPassword: document.querySelector("#webdav-password"),
  webdavRemotePath: document.querySelector("#webdav-remote-path"),
  webdavEnabled: document.querySelector("#webdav-enabled"),
  webdavStatusPill: document.querySelector("#webdav-status-pill"),
  webdavMessage: document.querySelector("#webdav-message"),
  webdavTest: document.querySelector("#webdav-test"),
  webdavSave: document.querySelector("#webdav-save"),
  webdavSync: document.querySelector("#webdav-sync"),
};

async function apiFetch(url, options = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  const { requestId = "", ...requestOptions } = options;
  if (!invoke) {
    const headers = new Headers(requestOptions.headers);
    headers.set("X-Shici", "1");
    return fetch(url, { ...requestOptions, headers });
  }

  let body = {};
  if (typeof requestOptions.body === "string" && requestOptions.body) body = JSON.parse(requestOptions.body);
  const invocation = invoke("api_request", {
    request: { url, method: requestOptions.method || "GET", body, requestId },
  });
  let result;
  if (requestOptions.signal) {
    if (requestOptions.signal.aborted) throw new DOMException("请求已暂停", "AbortError");
    let onAbort;
    const aborted = new Promise((_, reject) => {
      onAbort = () => reject(new DOMException("请求已暂停", "AbortError"));
      requestOptions.signal.addEventListener("abort", onAbort, { once: true });
    });
    try { result = await Promise.race([invocation, aborted]); }
    finally { requestOptions.signal.removeEventListener("abort", onAbort); }
  } else {
    result = await invocation;
  }
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  if (options.method && options.method !== "GET" && /^\/api\/entries(?:\/|$)/.test(url)) scheduleWebdavSync();
  return result;
}

function setWebdavMessage(message = "", error = false) {
  elements.webdavMessage.textContent = message;
  elements.webdavMessage.classList.toggle("error", error);
}

function renderWebdavStatus() {
  const configured = Boolean(state.webdav.baseUrl);
  const pill = elements.webdavStatusPill;
  const status = state.webdav.lastError ? "同步失败" : state.webdav.lastStatus;
  pill.textContent = state.webdavSyncBusy ? "同步中" : state.webdav.lastError ? "需检查" : state.webdav.enabled ? (status === "unchanged" ? "已同步" : "自动同步") : configured ? "已配置" : "未配置";
  pill.classList.toggle("live", state.webdav.enabled && !state.webdav.lastError);
  pill.classList.toggle("demo", !state.webdav.enabled || Boolean(state.webdav.lastError));
  elements.webdavBaseUrl.value = state.webdav.baseUrl || "";
  elements.webdavUsername.value = state.webdav.username || "";
  elements.webdavRemotePath.value = state.webdav.remotePath || "shici/library.json";
  elements.webdavEnabled.checked = Boolean(state.webdav.enabled);
  elements.webdavPassword.placeholder = state.webdav.hasPassword ? "已保存，留空不修改" : "输入密码（可选）";
}

function webdavDraft() {
  return {
    enabled: elements.webdavEnabled.checked,
    baseUrl: elements.webdavBaseUrl.value.trim(),
    username: elements.webdavUsername.value.trim(),
    password: elements.webdavPassword.value,
    remotePath: elements.webdavRemotePath.value.trim(),
  };
}

async function loadWebdavConfig() {
  try {
    state.webdav = await requestJson("/api/webdav");
    renderWebdavStatus();
  } catch (error) {
    state.webdav = { ...state.webdav, lastError: error.message || "无法读取同步配置" };
    renderWebdavStatus();
  }
}

function scheduleWebdavSync() {
  clearTimeout(scheduleWebdavSync.timer);
  if (!state.webdav.enabled || state.webdavSyncBusy) return;
  scheduleWebdavSync.timer = setTimeout(() => runWebdavSync({ silent: true }).catch(() => {}), 1600);
}

async function runWebdavSync({ silent = false } = {}) {
  if (state.webdavSyncBusy) return;
  state.webdavSyncBusy = true;
  renderWebdavStatus();
  if (!silent) setWebdavMessage("正在同步…");
  [elements.webdavTest, elements.webdavSave, elements.webdavSync].forEach((button) => { if (button) button.disabled = true; });
  try {
    const result = await requestJson("/api/webdav/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    if (Array.isArray(result.entries)) {
      state.entries = result.entries;
      render();
    }
    state.webdav = { ...state.webdav, ...result, lastStatus: result.status || state.webdav.lastStatus, lastError: "" };
    renderWebdavStatus();
    if (!silent) setWebdavMessage(result.status === "unchanged" ? "本地与远端没有变化。" : "同步完成。", false);
  } catch (error) {
    state.webdav.lastError = error.message || "同步失败";
    renderWebdavStatus();
    if (!silent) setWebdavMessage(state.webdav.lastError, true);
  } finally {
    state.webdavSyncBusy = false;
    renderWebdavStatus();
    [elements.webdavTest, elements.webdavSave, elements.webdavSync].forEach((button) => { if (button) button.disabled = false; });
  }
}

async function saveWebdavConfig(event) {
  event.preventDefault();
  elements.webdavSave.disabled = true;
  setWebdavMessage("正在保存…");
  try {
    const result = await requestJson("/api/webdav", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webdavDraft()) });
    state.webdav = { ...state.webdav, ...result, lastError: "" };
    elements.webdavPassword.value = "";
    renderWebdavStatus();
    setWebdavMessage("同步配置已保存。", false);
    toast("WebDAV 配置已保存");
    if (state.webdav.enabled) await runWebdavSync({ silent: false });
  } catch (error) {
    setWebdavMessage(error.message || "保存失败", true);
  } finally {
    elements.webdavSave.disabled = false;
  }
}

async function testWebdav() {
  elements.webdavTest.disabled = true;
  setWebdavMessage("正在测试连接…");
  try {
    const result = await requestJson("/api/webdav/test", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(webdavDraft()) });
    setWebdavMessage(`连接成功（HTTP ${result.status}）。`, false);
  } catch (error) {
    setWebdavMessage(error.message || "连接失败", true);
  } finally {
    elements.webdavTest.disabled = false;
  }
}

async function load() {
  let result = await requestJson("/api/entries");
  if (!result.entries.length) {
    const raw = localStorage.getItem(STORAGE_KEY);
    let legacy;
    try { legacy = raw ? JSON.parse(raw) : null; }
    catch { console.warn("旧浏览器数据格式无效，已忽略"); }
    if (Array.isArray(legacy?.entries) && legacy.entries.length) {
      result = await requestJson("/api/entries", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ entries: legacy.entries }),
      });
    }
  }
  state.entries = Array.isArray(result.entries) ? result.entries : [];
  state.storageReady = true;
  localStorage.removeItem(STORAGE_KEY);
}

function escapeHtml(value = "") {
  return String(value).replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
}

function icon(name) {
  return `<i data-lucide="${name}" aria-hidden="true"></i>`;
}

function customSelectKind(select) {
  if (select.classList.contains("quick-model-select")) return "custom-select-model";
  if (select.closest(".source-picker")) return "custom-select-source";
  if (select.closest(".entry-source-picker")) return "custom-select-entry";
  if (select.closest(".library-filter")) return "custom-select-filter";
  if (select.closest(".provider-switcher")) return "custom-select-provider";
  return "custom-select-field";
}

function closeCustomSelects(except) {
  document.querySelectorAll(".custom-select-open").forEach((wrapper) => {
    if (wrapper !== except) {
      wrapper.classList.remove("custom-select-open");
      wrapper.querySelector(".custom-select-trigger")?.setAttribute("aria-expanded", "false");
    }
  });
}

function syncCustomSelect(select) {
  const ui = select._customSelect;
  if (!ui) return;
  const selected = select.selectedOptions[0] || select.options[0];
  ui.label.textContent = selected?.textContent || "";
  ui.wrapper.hidden = select.hidden;
  ui.button.disabled = select.disabled;
  ui.button.setAttribute("aria-expanded", String(ui.wrapper.classList.contains("custom-select-open")));
  ui.menu.replaceChildren(...[...select.options].map((option, index) => {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "custom-select-option";
    item.dataset.index = String(index);
    item.textContent = option.textContent;
    item.disabled = option.disabled;
    item.setAttribute("role", "option");
    item.setAttribute("aria-selected", String(option.selected));
    return item;
  }));
}

function enhanceCustomSelect(select) {
  if (select.dataset.customSelect === "true") {
    syncCustomSelect(select);
    return;
  }
  const wrapper = document.createElement("span");
  wrapper.className = `custom-select ${customSelectKind(select)}`;
  const host = select.parentElement;
  host?.classList.add("has-custom-select");
  const button = document.createElement("button");
  button.type = "button";
  button.className = "custom-select-trigger";
  button.setAttribute("aria-haspopup", "listbox");
  button.setAttribute("aria-label", select.getAttribute("aria-label") || "选择");
  const label = document.createElement("span");
  const menu = document.createElement("div");
  menu.className = "custom-select-menu";
  menu.setAttribute("role", "listbox");
  button.append(label);
  select.parentNode.insertBefore(wrapper, select);
  wrapper.append(select, button, menu);
  select.dataset.customSelect = "true";
  select.classList.add("custom-select-native");
  select.tabIndex = -1;
  select._customSelect = { wrapper, button, label, menu };
  button.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    if (select.disabled || select.hidden) return;
    const open = !wrapper.classList.contains("custom-select-open");
    closeCustomSelects(wrapper);
    wrapper.classList.toggle("custom-select-open", open);
    syncCustomSelect(select);
  });
  button.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      wrapper.classList.remove("custom-select-open");
    } else if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      button.click();
    }
  });
  menu.addEventListener("click", (event) => {
    const item = event.target.closest("[data-index]");
    if (!item) return;
    select.selectedIndex = Number(item.dataset.index);
    select.dispatchEvent(new Event("change", { bubbles: true }));
    wrapper.classList.remove("custom-select-open");
    syncCustomSelect(select);
    button.focus();
  });
  select.addEventListener("change", () => syncCustomSelect(select));
  syncCustomSelect(select);
}

function enhanceCustomSelects() {
  document.querySelectorAll("select").forEach(enhanceCustomSelect);
}

document.addEventListener("click", (event) => {
  if (!event.target.closest(".custom-select")) closeCustomSelects();
});

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
  enhanceCustomSelects();
}

function renderWords(entry, className = "word-grid") {
  if (!entry.words?.length) return "";
  return `<div class="${className}">${entry.words.map((word) => {
    const parts = Array.isArray(word.partOfSpeech) ? word.partOfSpeech.filter(Boolean).join(" / ") : "";
    const forms = Array.isArray(word.forms) ? word.forms.filter((item) => item?.form && item?.label) : [];
    return `<div><strong>${escapeHtml(word.text)}</strong>${word.pronunciation ? `<span>${escapeHtml(word.pronunciation)}</span>` : ""}${parts ? `<small class="word-pos">${escapeHtml(parts)}</small>` : ""}<p>${escapeHtml(word.meaning)}</p>${forms.length ? `<div class="word-forms">${forms.map((item) => `<span><b>${escapeHtml(item.label)}</b> ${escapeHtml(item.form)}</span>`).join("")}</div>` : ""}</div>`;
  }).join("")}</div>`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function reviewState(entry) {
  return entry.review || { dueAt: entry.createdAt, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0, leech: false };
}

function isDue(entry, at = Date.now()) {
  return reviewState(entry).dueAt <= at;
}

function dueEntries() {
  const entries = state.entries.filter((entry) => isDue(entry));
  entries.sort((a, b) => reviewState(a).dueAt - reviewState(b).dueAt);
  if (state.reviewFocusId) entries.sort((a, b) => a.id === state.reviewFocusId ? -1 : b.id === state.reviewFocusId ? 1 : 0);
  return entries;
}

function formatInterval(days) {
  if (days < 0.02) return "10分钟";
  if (days < 1) return `${Math.max(1, Math.round(days * 24))}小时`;
  if (days < 30) return `${Math.round(days)}天`;
  return `${Math.round(days / 30)}个月`;
}

function stableJitter(id) {
  let hash = 2_166_136_261;
  for (const character of String(id || "")) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return 0.9 + ((hash >>> 0) % 21) / 100;
}

function previewInterval(entry, grade) {
  const review = reviewState(entry);
  let interval = grade === "again"
    ? 10 / 1_440
    : grade === "hard"
      ? review.repetitions === 0 ? 1 : Math.max(1, review.intervalDays * 1.2)
      : grade === "easy"
        ? review.repetitions === 0 ? 4 : review.repetitions === 1 ? 8 : Math.max(8, review.intervalDays * (review.ease + 0.15) * 1.3)
        : review.repetitions === 0 ? 1 : review.repetitions === 1 ? 3 : Math.max(3, review.intervalDays * review.ease);
  if (review.repetitions + (grade === "hard" ? 0 : 1) > 1 && grade !== "again") interval *= stableJitter(entry.id);
  return Math.round(interval * 100) / 100;
}

function dueLabel(entry) {
  const difference = reviewState(entry).dueAt - Date.now();
  if (difference <= 0) return "现在复习";
  const days = difference / 86_400_000;
  return `约 ${formatInterval(days)}后`;
}

function entrySearchHaystack(entry) {
  let haystack = searchCache.get(entry);
  if (haystack !== undefined) return haystack;
  haystack = [entry.raw, entry.displayText, entry.meaning, entry.context, entry.source, ...(entry.usage || []), ...(entry.thread || []).flatMap((turn) => [turn.question, turn.answer, turn.summary]), ...(entry.words || []).flatMap((word) => [word.text, word.pronunciation, word.meaning, ...(word.partOfSpeech || []), ...(word.forms || []).flatMap((form) => [form.form, form.label])])].join(" ").toLowerCase();
  searchCache.set(entry, haystack);
  return haystack;
}

function filteredEntries() {
  const query = state.query.trim().toLowerCase();
  const entries = state.entries.filter((entry) => {
    if (state.view === "starred" && !entry.starred) return false;
    if (state.sourceFilter && entry.source !== state.sourceFilter) return false;
    if (!query) return true;
    return entrySearchHaystack(entry).includes(query);
  });
  const text = (entry) => entry.displayText || entry.raw || "";
  const recent = (left, right) => Number(right.createdAt) - Number(left.createdAt);
  const comparators = {
    recent,
    oldest: (left, right) => Number(left.createdAt) - Number(right.createdAt),
    due: (left, right) => Number(reviewState(left).dueAt) - Number(reviewState(right).dueAt) || recent(left, right),
    "difficulty-desc": (left, right) => Number(right.difficulty) - Number(left.difficulty) || recent(left, right),
    "difficulty-asc": (left, right) => Number(left.difficulty) - Number(right.difficulty) || recent(left, right),
    alpha: (left, right) => text(left).localeCompare(text(right), "en", { sensitivity: "base", numeric: true }),
    source: (left, right) => (left.source || "未标记").localeCompare(right.source || "未标记", "zh-CN") || recent(left, right),
  };
  return entries.sort(comparators[state.sort] || recent);
}

function threadedEntries() {
  return filteredEntries()
    .filter((entry) => entry.thread?.length)
    .sort((left, right) => Number(right.thread.at(-1)?.createdAt || 0) - Number(left.thread.at(-1)?.createdAt || 0));
}

function reconcileThreadState() {
  const ids = new Set(state.entries.map((entry) => entry.id));
  if (state.selectedThreadEntryId && !ids.has(state.selectedThreadEntryId)) state.selectedThreadEntryId = null;
  if (state.threadAnchorId && !ids.has(state.threadAnchorId)) state.threadAnchorId = null;
}

function pendingForEntry(entryId) {
  return [...state.activeRequests.values()].filter((pending) => pending.entryId === entryId);
}

function renderMentionOptions() {
  const query = elements.mentionSearch.value.trim().toLowerCase();
  const entries = state.entries
    .filter((entry) => !query || entrySearchHaystack(entry).includes(query))
    .sort((left, right) => {
      const leftThread = Number(left.thread?.at(-1)?.createdAt || 0);
      const rightThread = Number(right.thread?.at(-1)?.createdAt || 0);
      return rightThread - leftThread || Number(right.createdAt) - Number(left.createdAt);
    });
  const visible = entries.slice(0, 20);
  elements.mentionList.innerHTML = visible.length
    ? visible.map((entry, index) => `<button class="mention-option" type="button" role="option" aria-selected="${index === 0}" data-action="select-thread-anchor" data-id="${escapeHtml(entry.id)}"><span><strong>${escapeHtml(entry.displayText || entry.raw)}</strong><small>${escapeHtml(entry.meaning || kindLabels[entry.kind] || "语言片段")}</small></span>${entry.thread?.length ? `<b>${entry.thread.length} 轮</b>` : ""}</button>`).join("")
    : `<div class="mention-empty">没有匹配的词条</div>`;
  if (entries.length > visible.length) elements.mentionList.insertAdjacentHTML("beforeend", `<div class="mention-limit">继续输入以缩小范围</div>`);
}

function openMentionPopover() {
  elements.mentionPopover.hidden = false;
  elements.mentionSearch.value = "";
  renderMentionOptions();
  elements.mentionSearch.focus();
}

function closeMentionPopover() {
  elements.mentionPopover.hidden = true;
  elements.mentionSearch.value = "";
}

function renderThreadComposer() {
  const visible = state.view === "threads";
  elements.threadComposer.hidden = !visible;
  if (!visible) {
    closeMentionPopover();
    return;
  }
  const entry = state.entries.find((item) => item.id === state.threadAnchorId);
  const pending = entry ? pendingForEntry(entry.id) : [];
  elements.threadAnchor.innerHTML = entry
    ? `<button class="thread-anchor-pill" type="button" data-action="open-mentions" aria-label="更换提问词条"><span>${icon("at-sign")}</span><strong>${escapeHtml(entry.displayText || entry.raw)}</strong>${icon("chevron-down")}</button><button class="thread-anchor-remove" type="button" data-action="clear-thread-anchor" aria-label="移除提问词条">${icon("x")}</button>`
    : `<button class="thread-anchor-empty" type="button" data-action="open-mentions">${icon("at-sign")}选择词条</button>`;
  elements.threadSend.classList.toggle("stop", pending.length > 0);
  elements.threadSend.disabled = !state.storageReady;
  elements.threadSend.innerHTML = pending.length ? icon("square") : icon("arrow-up");
  elements.threadSend.setAttribute("aria-label", pending.length ? "停止当前词条追问" : "发送追问");
  elements.threadSend.title = pending.length ? "停止当前词条追问" : `发送：${shortcutLabels[appearance.sendShortcut]}`;
  elements.threadAiState.className = `ai-state${pending.length ? " processing" : ""}`;
  elements.threadAiState.innerHTML = pending.length
    ? `<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>${pending.length > 1 ? `${pending.length} 个请求` : "正在追问"}`
    : `<span class="status-dot"></span>${entry ? "已选择词条" : "先选择词条"}`;
}

function renderThreadIndex() {
  const entries = threadedEntries();
  if (!entries.length) {
    const message = state.entries.some((entry) => entry.thread?.length)
      ? "没有匹配的追问。换一个搜索词，或从词库打开一个词条。"
      : "还没有追问。去词库打开一个词条，或用上方 @ 直接开始。";
    return `<div class="timeline-inner"><div class="empty-state thread-empty">${icon("messages-square")}<h2>${escapeHtml(message)}</h2><button class="secondary-button" type="button" data-view="all">返回词库</button></div></div>`;
  }
  return `<div class="timeline-inner thread-index"><div class="thread-index-head"><span>追问索引</span><small>${entries.length} 个词条</small></div><div class="thread-index-list">${entries.map((entry) => {
    const last = entry.thread.at(-1) || {};
    const title = entry.displayText || entry.raw;
    const summary = last.summary || last.question || "等待归纳";
    const selected = state.selectedThreadEntryId === entry.id;
    const pending = pendingForEntry(entry.id);
    return `<div class="thread-index-row ${selected ? "selected" : ""}" role="button" tabindex="0" data-action="open-thread" data-id="${escapeHtml(entry.id)}" aria-pressed="${selected}"><span class="thread-index-main"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(summary)}</span></span><span class="thread-index-meta"><b>${entry.thread.length} 轮</b>${pending.length ? `<span class="thread-pending"><span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span><button type="button" data-action="stop-thread-request" data-id="${escapeHtml(entry.id)}" aria-label="停止 ${escapeHtml(title)} 的追问">停止</button></span>` : `<time>${formatTime(last.createdAt)}</time>`}</span></div>`;
  }).join("")}</div></div>`;
}

function renderEntrySupportingSections(entry, includeThread = true) {
  const displayText = entry.displayText || entry.raw;
  const original = entry.raw !== displayText
    ? `<section class="detail-section"><span>原始输入</span><p class="detail-original">${escapeHtml(entry.raw)}</p></section>`
    : "";
  const words = entry.words?.length
    ? `<section class="detail-section"><span>${entry.kind === "word_list" ? "逐词理解" : "读音"}</span>${renderWords(entry, "detail-words")}</section>`
    : "";
  const usage = entry.usage?.length
    ? `<section class="detail-section"><span>语境 / 例句</span><div class="detail-quote">${entry.usage.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div></section>`
    : "";
  const chunks = entry.chunks?.length
    ? `<section class="detail-section"><span>表达拆解</span><div class="detail-chunks">${entry.chunks.map((chunk) => `<div><strong>${escapeHtml(chunk.text)}</strong><p>${escapeHtml(chunk.meaning)}</p></div>`).join("")}</div></section>`
    : "";
  const ai = entry.context
    ? `<section class="ai-explanation"><span>${icon("sparkles")}AI 理解</span><p>${escapeHtml(entry.context)}</p>${entry.conclusion && entry.conclusion !== entry.context ? `<p>${escapeHtml(entry.conclusion)}</p>` : ""}</section>`
    : "";
  const thread = includeThread && entry.thread?.length
    ? `<section class="detail-section"><span>追问记录</span>${renderThread(entry)}</section>`
    : "";
  return `${original}${words}${usage}${chunks}${ai}${thread}`;
}

function renderThreadStudio(entry) {
  const displayText = entry.displayText || entry.raw;
  const review = reviewState(entry);
  const turns = entry.thread || [];
  const pending = pendingForEntry(entry.id);
  const notes = turns.map((turn, index) => `<article class="thread-turn-note">
    <div class="thread-note-head"><span>第 ${index + 1} 轮 · ${formatTime(turn.createdAt)}</span><span class="thread-note-actions"><button class="icon-button" type="button" data-action="copy-thread-turn" data-id="${escapeHtml(entry.id)}" data-turn-id="${escapeHtml(turn.id)}" aria-label="复制第 ${index + 1} 轮追问" title="复制">${icon("copy")}</button>${index < turns.length - 1 ? `<button class="icon-button" type="button" data-action="rewind-thread" data-id="${escapeHtml(entry.id)}" data-turn-id="${escapeHtml(turn.id)}" aria-label="回退到第 ${index + 1} 轮" title="回退到这一轮">${icon("undo-2")}</button>` : ""}</span></div>
    <div class="thread-note-question"><span>问</span><p>${escapeHtml(turn.question)}</p></div>
    <div class="thread-note-answer"><span>答</span><p>${escapeHtml(turn.answer)}</p></div>
    ${turn.summary ? `<div class="thread-summary-bar"><strong>记忆结论</strong><p>${escapeHtml(turn.summary)}</p></div>` : ""}
  </article>`).join("");
  return `<article class="detail-sheet thread-studio">
    <div class="detail-toolbar"><span>理解笔记</span><div class="thread-studio-pending">${pending.length ? `<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>${pending.length > 1 ? `${pending.length} 个请求` : "追问中"}<button class="text-button" type="button" data-action="stop-thread-request" data-id="${escapeHtml(entry.id)}">停止</button>` : ""}<button class="icon-button" type="button" data-action="close-detail" aria-label="关闭详情">${icon("x")}</button></div></div>
    <div class="detail-scroll">
      <header class="detail-hero thread-studio-hero"><h2>${escapeHtml(displayText)}</h2><div class="detail-badges"><span>${kindLabels[entry.kind] || "片段"}</span>${entry.pronunciation ? `<span>${escapeHtml(entry.pronunciation)}</span>` : ""}${entry.source ? `<span>${escapeHtml(entry.source)}</span>` : ""}</div>${entry.correction ? `<p class="detail-correction">已纠正：${escapeHtml(entry.correction)}</p>` : ""}<p class="thread-studio-meaning">${escapeHtml(entry.meaning)}</p><div class="thread-studio-links"><button class="text-button" type="button" data-action="set-thread-anchor" data-id="${escapeHtml(entry.id)}">设为提问对象</button><button class="text-button" type="button" data-action="open-library-entry" data-id="${escapeHtml(entry.id)}">打开词库详情</button></div></header>
      <main class="detail-body">${turns.length ? `<section class="thread-notes">${notes}</section>` : `<div class="thread-studio-empty">${icon("message-circle-more")}<p>这个词条已回到原片段，还没有追问记录。</p><button class="secondary-button" type="button" data-action="close-detail">关闭笔记</button></div>`}<details class="thread-entry-details"><summary>查看完整词条</summary><div>${renderEntrySupportingSections(entry, false)}</div></details></main>
    </div>
    <footer class="detail-actions"><span class="thread-studio-status">${review.leech ? "顽固词" : isDue(entry) ? "今天待复习" : `下次 ${dueLabel(entry)}`}</span>${isDue(entry) ? `<button class="secondary-button" type="button" data-action="start-review" data-id="${escapeHtml(entry.id)}">${icon("brain")}复习</button>` : ""}<button class="primary-button" type="button" data-action="continue" data-id="${escapeHtml(entry.id)}">${icon("message-circle-more")}再问一句</button></footer>
  </article>`;
}

function renderThread(entry) {
  if (!entry.thread?.length) return "";
  return `<div class="thread-panel">
    <div class="thread-head"><span>${entry.thread.length} 轮追问</span><button class="thread-rewind" type="button" data-action="rewind-thread" data-id="${entry.id}" data-turn-id="" aria-label="回到原片段" title="清空追问，回到原片段">${icon("undo-2")}</button></div>
    ${entry.thread.map((turn, index) => `<div class="thread-turn">
      <span class="turn-mark">你</span><div class="turn-copy"><strong>追问</strong>${escapeHtml(turn.question)}</div>
      <span class="turn-mark ai">AI</span><div class="turn-copy"><strong>回答</strong>${escapeHtml(turn.answer)}</div>
      ${index < entry.thread.length - 1 ? `<button class="thread-rewind" type="button" data-action="rewind-thread" data-id="${entry.id}" data-turn-id="${turn.id}" aria-label="回退到第 ${index + 1} 轮" title="保留这一轮，移除之后的追问">${icon("undo-2")}</button>` : ""}
    </div>`).join("")}
  </div>`;
}

function renderSourcePicker(entry) {
  const options = entry.source && !sourceOptions.includes(entry.source) ? [...sourceOptions, entry.source] : sourceOptions;
  return `<label class="entry-source-picker" title="修改来源">
    ${icon("tag")}
    <select data-source-entry="${entry.id}" aria-label="修改片段来源">
      <option value="">未标记</option>
      ${options.map((source) => `<option value="${escapeHtml(source)}" ${entry.source === source ? "selected" : ""}>${escapeHtml(source)}</option>`).join("")}
    </select>
  </label>`;
}

function renderDetailPanel() {
  const threadView = state.view === "threads";
  const entry = state.entries.find((item) => item.id === (threadView ? state.selectedThreadEntryId : state.selectedEntryId));
  const mobile = matchMedia("(max-width: 760px)").matches;
  const visible = Boolean(entry) && !state.detailClosed && state.view !== "review" && (!mobile || state.detailOpened);
  elements.detailPanel.hidden = !visible;
  elements.detailBackdrop.hidden = !visible;
  elements.workspace.classList.toggle("detail-visible", visible);
  if (!visible) {
    elements.detailContent.innerHTML = "";
    return;
  }
  if (threadView) {
    elements.detailContent.innerHTML = renderThreadStudio(entry);
    refreshIcons();
    return;
  }

  const displayText = entry.displayText || entry.raw;
  const review = reviewState(entry);

  elements.detailContent.innerHTML = `
    <article class="detail-sheet">
      <div class="detail-toolbar">
        <span>详细信息</span>
        <button class="icon-button" type="button" data-action="close-detail" aria-label="关闭详情">${icon("x")}</button>
      </div>
      <div class="detail-scroll">
        <header class="detail-hero">
          <h2 id="detail-title">${escapeHtml(displayText)}</h2>
          <div class="detail-badges">
            <span>${kindLabels[entry.kind] || "片段"}</span>
            ${entry.pronunciation ? `<span>${escapeHtml(entry.pronunciation)}</span>` : ""}
            ${entry.source ? `<span>${escapeHtml(entry.source)}</span>` : ""}
          </div>
          ${entry.correction ? `<p class="detail-correction">已纠正：${escapeHtml(entry.correction)}</p>` : ""}
        </header>
        <main class="detail-body">
          <section class="detail-section detail-meaning">
            <span>释义</span>
            <h3>${escapeHtml(entry.meaning)}</h3>
          </section>
          ${renderEntrySupportingSections(entry)}
          <section class="detail-meta">
            <span>学习记录</span>
            <dl>
              <div><dt>收录</dt><dd>${formatTime(entry.createdAt)}</dd></div>
              <div><dt>复习</dt><dd>${review.repetitions || 0} 次</dd></div>
              <div><dt>下次</dt><dd>${dueLabel(entry)}</dd></div>
              <div><dt>状态</dt><dd>${review.leech ? "顽固词" : entry.status === "review" ? "待复习" : "已学习"}</dd></div>
              <div><dt>难度</dt><dd>${Number(entry.difficulty || 3).toFixed(1)} / 5</dd></div>
            </dl>
          </section>
        </main>
      </div>
      <footer class="detail-actions">
        ${renderSourcePicker(entry)}
        <span class="detail-action-icons">
          <button class="icon-button ${entry.starred ? "starred" : ""}" type="button" data-action="star" data-id="${entry.id}" aria-label="${entry.starred ? "取消收藏" : "收藏"}">${icon("star")}</button>
          <button class="icon-button" type="button" data-action="delete" data-id="${entry.id}" aria-label="删除片段">${icon("trash-2")}</button>
        </span>
        ${isDue(entry) ? `<button class="secondary-button" type="button" data-action="start-review" data-id="${entry.id}">${icon("brain")}复习</button>` : ""}
        <button class="primary-button" type="button" data-action="continue" data-id="${entry.id}">${icon("message-circle-more")}追问</button>
      </footer>
    </article>`;
  refreshIcons();
}

function openEntryDetail(entry) {
  if (state.activeThreadId && state.activeThreadId !== entry.id) state.activeThreadId = null;
  if (state.newEntryIds.includes(entry.id)) {
    state.newEntryIds = state.newEntryIds.filter((entryId) => entryId !== entry.id);
    renderNewEntryNotice();
  }
  const previousId = state.selectedEntryId;
  state.selectedEntryId = entry.id;
  state.detailClosed = false;
  state.detailOpened = true;
  if (previousId !== entry.id) {
    for (const id of [previousId, entry.id]) {
      if (!id) continue;
      const card = elements.timeline.querySelector(`[data-entry-id="${CSS.escape(id)}"]`);
      const current = state.entries.find((item) => item.id === id);
      if (card && current) card.outerHTML = renderEntry(current);
    }
    refreshIcons();
  }
  renderDetailPanel();
}

function renderEntry(entry) {
  const selected = state.selectedEntryId === entry.id;
  const meta = entry.meaning || kindLabels[entry.kind] || "语言片段";
  const wordParts = entry.kind === "word" && entry.words?.[0]?.partOfSpeech?.length
    ? entry.words[0].partOfSpeech.filter(Boolean).join(" / ")
    : "";
  return `<article class="entry-card ${selected ? "selected" : ""} ${isDue(entry) ? "due" : ""}" data-entry-id="${entry.id}">
    <button class="entry-row" type="button" data-action="open-detail" data-id="${entry.id}" aria-pressed="${selected}">
      <span class="entry-check" aria-hidden="true"></span>
      <span class="entry-row-copy">
        <strong>${escapeHtml(entry.displayText || entry.raw)}</strong>
        <span><em>${escapeHtml(meta)}</em><i>${entry.source ? escapeHtml(entry.source) : kindLabels[entry.kind] || "片段"} · ${entry.status === "review" ? (isDue(entry) ? "待复习" : "待安排") : (isDue(entry) ? "已到期" : "已学习")}${reviewState(entry).leech ? " · 顽固词" : ""}</i></span>
        ${wordParts ? `<small class="entry-word-meta">${escapeHtml(wordParts)}</small>` : ""}
        ${entry.correction ? `<small>已纠正 ${escapeHtml(entry.correction)}</small>` : ""}
      </span>
      ${icon(selected ? "chevron-down" : "chevron-right")}
    </button>
  </article>`;
}

function renderReviewHint(entry) {
  if (!state.reviewHint) return "";
  if (state.reviewHint === "weak") {
    const usage = (entry.usage || []).filter(Boolean).slice(0, 2);
    const chunks = (entry.chunks || []).filter((chunk) => chunk?.text || chunk?.meaning).slice(0, 3);
    const content = usage.length
      ? `<div class="review-hint-copy">${usage.map((item) => `<p>${escapeHtml(item)}</p>`).join("")}</div>`
      : chunks.length
        ? `<div class="review-hint-chunks">${chunks.map((chunk) => `<span><strong>${escapeHtml(chunk.text)}</strong>${escapeHtml(chunk.meaning)}</span>`).join("")}</div>`
        : `<p>这个片段暂时没有可用的例句提示。</p>`;
    return `<aside class="review-hint-panel weak"><span>${icon("lightbulb")}弱提示</span>${content}</aside>`;
  }
  const details = [...new Set([entry.context, entry.conclusion].filter(Boolean))];
  return `<aside class="review-hint-panel strong"><span>${icon("sparkles")}AI 理解</span>${details.length ? details.map((item) => `<p>${escapeHtml(item)}</p>`).join("") : `<p>${escapeHtml(entry.meaning || "暂无更多理解提示。")}</p>`}</aside>`;
}

function renderReview() {
  const entries = dueEntries();
  const entry = entries[0];
  if (!entry) {
    return `<div class="review-shell review-complete">${icon("circle-check-big")}<h2>今天已经复习完成</h2><p>新的片段会在适合的时间重新出现。</p><button type="button" class="secondary-button" data-view="all">返回词库</button></div>`;
  }
  if (state.reviewFocusId !== entry.id) {
    state.reviewFocusId = entry.id;
    state.reviewHint = "";
  }
  if (!state.reviewSessionTotal) state.reviewSessionTotal = entries.length;
  const completed = Math.max(0, state.reviewSessionTotal - entries.length);
  const progress = Math.round((completed / state.reviewSessionTotal) * 100);
  const chunks = entry.chunks?.length ? `<div class="review-chunks">${entry.chunks.map((chunk) => `<span><strong>${escapeHtml(chunk.text)}</strong>${escapeHtml(chunk.meaning)}</span>`).join("")}</div>` : "";
  const words = entry.words?.length ? renderWords(entry, "review-words") : "";
  const grades = [
    ["again", "忘记", "rotate-ccw"],
    ["hard", "困难", "chevrons-right"],
    ["good", "记得", "check"],
    ["easy", "轻松", "sparkles"],
  ];
  return `<div class="review-shell">
    <div class="review-session-head">
      <button class="icon-button" type="button" data-view="all" aria-label="退出复习">${icon("x")}</button>
      <div class="review-progress"><span><strong>${completed + 1}</strong> / ${state.reviewSessionTotal}</span><div><i style="width:${progress}%"></i></div></div>
      <span class="due-today">今日剩余 ${entries.length}</span>
    </div>
    <article class="review-card ${state.reviewReveal ? "revealed" : ""}">
      <div class="review-prompt"><span>${entry.source ? escapeHtml(entry.source) : "语言片段"}</span><h2>${escapeHtml(entry.displayText || entry.raw)}</h2>${entry.pronunciation ? `<p>${escapeHtml(entry.pronunciation)}</p>` : ""}</div>
      <div class="review-answer" aria-hidden="${state.reviewReveal ? "false" : "true"}">
        <span>你的理解</span><h3>${escapeHtml(entry.meaning)}</h3><p>${escapeHtml(entry.context)}</p>${words}${chunks}
      </div>
      ${state.reviewReveal
        ? `<div class="review-grades">${grades.map(([grade, label, gradeIcon]) => `<button type="button" data-action="grade-review" data-id="${entry.id}" data-grade="${grade}">${icon(gradeIcon)}<strong>${label}</strong><small>${formatInterval(previewInterval(entry, grade))}</small></button>`).join("")}</div>`
        : `<div class="review-hint-controls"><button class="${state.reviewHint === "weak" ? "active" : ""}" type="button" data-action="review-hint" data-hint="weak">${icon("lightbulb")}弱提示</button><button class="${state.reviewHint === "strong" ? "active" : ""}" type="button" data-action="review-hint" data-hint="strong">${icon("sparkles")}强提示</button></div>${renderReviewHint(entry)}<button class="reveal-button" type="button" data-action="reveal-review">${icon("eye")}显示答案</button>`}
    </article>
  </div>`;
}

function renderTimeline() {
  if (state.view === "capture") {
    elements.timeline.innerHTML = "";
    elements.detailPanel.hidden = true;
    elements.detailBackdrop.hidden = true;
    return;
  }
  if (state.view === "review") {
    elements.timeline.innerHTML = renderReview();
    renderDetailPanel();
    refreshIcons();
    return;
  }
  if (state.view === "threads") {
    state.selectedEntryId = null;
    elements.timeline.innerHTML = renderThreadIndex();
    renderDetailPanel();
    refreshIcons();
    return;
  }
  const entries = filteredEntries();
  const visible = entries.slice(0, state.visibleLimit);
  if (!state.detailClosed && !entries.some((entry) => entry.id === state.selectedEntryId)) state.selectedEntryId = visible[0]?.id || null;
  let html = "";
  if (!entries.length) {
    html += `<div class="timeline-inner"><div class="empty-state"><div>${icon("search-x")}<h2>没有找到片段</h2><p>换一个筛选条件，或捕捉新的语言片段。</p></div></div></div>`;
  } else {
    html += `<div class="timeline-inner"><div class="list-columns"><span>片段与解释</span><span>状态</span></div><div class="entry-list">${visible.map(renderEntry).join("")}</div>${entries.length > visible.length ? `<button class="load-more" type="button" data-action="load-more">再显示 ${Math.min(80, entries.length - visible.length)} 条</button>` : ""}</div>`;
  }
  elements.timeline.innerHTML = html;
  renderDetailPanel();
  refreshIcons();
}

function renderNewEntryNotice() {
  const entries = state.newEntryIds.map((id) => state.entries.find((entry) => entry.id === id)).filter(Boolean);
  state.newEntryIds = entries.map((entry) => entry.id);
  const visible = state.view === "all" && entries.length > 0;
  elements.newEntryNotice.hidden = !visible;
  if (!visible) {
    elements.newEntryNotice.innerHTML = "";
    return;
  }
  const names = entries.slice(0, 3).map((entry) => entry.displayText || entry.raw).join("、");
  const links = entries.slice(0, 3).map((entry) => `<button class="new-entry-link" type="button" data-action="open-new-entry" data-id="${entry.id}">${escapeHtml(entry.displayText || entry.raw)}</button>`).join("");
  elements.newEntryNotice.innerHTML = `<div>${icon("circle-check")}<span><strong>${entries.length === 1 ? "新词已加入" : `${entries.length} 个新词已加入`}</strong><small>${escapeHtml(names)}${entries.length > 3 ? ` 等 ${entries.length} 个` : ""}</small></span></div><span class="new-entry-notice-actions">${links}<button class="icon-button" type="button" data-action="dismiss-new-entries" aria-label="关闭新词提醒">${icon("x")}</button></span>`;
}

function renderNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  const reviewCount = dueEntries().length;
  const starCount = state.entries.filter((entry) => entry.starred).length;
  document.querySelector("#all-count").textContent = state.entries.length;
  document.querySelector("#review-count").textContent = reviewCount;
  document.querySelector("#star-count").textContent = starCount;
  elements.focusCount.textContent = reviewCount;
  elements.focusLabel.textContent = reviewCount ? "今日待复习" : "今日已清空";
  elements.focusProgress.style.width = `${state.entries.length ? Math.max(8, Math.min(100, (reviewCount / state.entries.length) * 100)) : 100}%`;
  const copy = {
    all: ["词库", state.sourceFilter ? `${state.sourceFilter} · ${filteredEntries().length} 条` : `${state.entries.length} 个散落在不同场景里的语言片段`],
    review: ["专注复习", "根据你的回忆质量安排下一次出现"],
    threads: ["追问工作台", `${threadedEntries().length} 个有后续理解的语言片段`],
    starred: ["收藏片段", `${starCount} 个主动保留的重点`],
    capture: ["记录", ""],
  }[state.view];
  document.querySelector("#view-title").textContent = copy[0];
  document.querySelector("#view-subtitle").textContent = copy[1];
  document.querySelector("#settings-count").textContent = state.entries.length;
  const sources = [...new Set(state.entries.map((entry) => entry.source).filter(Boolean))];
  elements.filterSelect.innerHTML = `<option value="all">全部</option><option value="starred">收藏 (${starCount})</option>${sources.map((source) => `<option value="source:${escapeHtml(source)}">${escapeHtml(source)}</option>`).join("")}`;
  elements.filterSelect.value = state.view === "starred" ? "starred" : state.sourceFilter ? `source:${state.sourceFilter}` : "all";
  syncCustomSelect(elements.filterSelect);
  elements.sortSelect.value = state.sort;
  syncCustomSelect(elements.sortSelect);
  elements.captureGrid.hidden = state.view === "review" || state.view === "threads";
  elements.libraryHead.hidden = state.view === "review";
  elements.capturePage.hidden = state.view !== "capture";
  elements.searchBox.hidden = state.view === "review" || state.view === "capture";
  elements.bottomNav.hidden = state.view === "review" || state.view === "capture";
  document.body.classList.toggle("review-mode", state.view === "review");
  document.body.classList.toggle("capture-mode", state.view === "capture");
  const recordButton = document.querySelector('[data-action="focus-composer"]');
  recordButton?.classList.toggle("active", state.view === "capture");
}

function renderComposer() {
  const entry = state.entries.find((item) => item.id === state.activeThreadId);
  const stopping = state.activeRequests.size > 0;
  if (!entry) state.activeThreadId = null;
  elements.contextBar.hidden = !entry;
  elements.contextTitle.textContent = entry ? `· ${entry.displayText || entry.raw}` : "";
  elements.input.placeholder = entry ? "继续追问这个片段…" : "记录一个不懂的词、短语或句子…";
  elements.source.disabled = Boolean(entry);
  elements.composer.classList.toggle("processing", stopping);
  elements.send.disabled = !state.storageReady;
  elements.send.classList.toggle("stop", stopping);
  elements.send.setAttribute("aria-label", stopping ? "停止生成" : `发送（${shortcutLabels[appearance.sendShortcut]}）`);
  elements.send.title = stopping ? "停止生成" : `发送：${shortcutLabels[appearance.sendShortcut]}`;
  elements.send.innerHTML = stopping ? icon("square") : "保存";
  renderAiState();
}

function renderCapturePage() {
  const stopping = state.activeRequests.size > 0;
  elements.captureComposer.classList.toggle("processing", stopping);
  elements.captureSend.disabled = !state.storageReady;
  elements.captureSend.classList.toggle("stop", stopping);
  elements.captureSend.setAttribute("aria-label", stopping ? "停止生成" : `发送（${shortcutLabels[appearance.sendShortcut]}）`);
  elements.captureSend.title = stopping ? "停止生成" : `发送：${shortcutLabels[appearance.sendShortcut]}`;
  elements.captureSend.innerHTML = stopping ? icon("square") : "保存到词库";
}

function render() {
  reconcileThreadState();
  renderNavigation();
  renderTimeline();
  renderNewEntryNotice();
  renderComposer();
  renderCapturePage();
  renderThreadComposer();
  refreshIcons();
}

function toast(message, action) {
  elements.toast.replaceChildren(document.createTextNode(message));
  elements.toast.classList.toggle("has-action", Boolean(action));
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "toast-action";
    button.textContent = action.label;
    button.addEventListener("click", () => {
      elements.toast.classList.remove("visible", "has-action");
      action.run().catch((error) => toast(error.message || "撤销失败"));
    }, { once: true });
    elements.toast.append(button);
  }
  elements.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("visible"), action ? 8000 : 2600);
}

function confirmAction(message, { title = "确认操作", confirmLabel = "确认" } = {}) {
  elements.confirmTitle.textContent = title;
  elements.confirmMessage.textContent = message;
  elements.confirmAccept.textContent = confirmLabel;
  elements.confirmDialog.returnValue = "";
  return new Promise((resolve) => {
    const finish = () => resolve(elements.confirmDialog.returnValue === "confirm");
    elements.confirmDialog.addEventListener("close", finish, { once: true });
    elements.confirmDialog.showModal();
  });
}

function apiStyleInput() {
  return document.querySelector('input[name="api-style"]:checked');
}

function updateApiStyleHelp() {
  const responses = apiStyleInput()?.value !== "compatible";
  document.querySelector("#api-style-help").textContent = responses
    ? "使用 /v1/responses。"
    : "使用 /v1/chat/completions。";
}

function configDraft() {
  const apiKey = elements.apiKey.value.trim();
  return {
    providerId: elements.providerSelect.value,
    name: elements.providerName.value.trim(),
    apiStyle: apiStyleInput()?.value || "responses",
    reasoningEffort: elements.reasoningEffort.value,
    baseUrl: elements.apiBaseUrl.value.trim(),
    model: elements.apiModel.value.trim(),
    enableThinkingToggle: elements.enableThinkingToggle.checked,
    allowNoKey: elements.allowNoKey.checked,
    ...(apiKey ? { apiKey } : {}),
  };
}

function showConfigMessage(message, isError = false) {
  elements.configMessage.textContent = message;
  elements.configMessage.classList.toggle("error", isError);
}

function renderAiState() {
  const targets = [elements.aiState, elements.captureAiState].filter(Boolean);
  const setTargets = (className, html, title) => targets.forEach((target) => {
    target.className = `ai-state${className ? ` ${className}` : ""}`;
    target.innerHTML = html;
    target.title = title;
  });
  if (state.activeRequests.size) {
    const hasFollowup = [...state.activeRequests.values()].some((pending) => pending.entryId);
    setTargets("processing", `<span class="thinking-dots" aria-hidden="true"><i></i><i></i><i></i></span>正在处理 ${state.activeRequests.size > 1 ? `${state.activeRequests.size} 个请求` : hasFollowup || state.activeThreadId ? "追问" : "片段"}`, "正在等待模型返回，可点击停止按钮取消");
    elements.aiState.hidden = false;
    elements.captureAiState.hidden = false;
    elements.quickModelSelect.hidden = true;
    elements.captureQuickModelSelect.hidden = true;
    return;
  }
  const config = state.ai;
  if (config.mode === "checking") {
    setTargets("", `<span class="status-dot"></span>检测中`, "正在检查 AI 配置");
    elements.aiState.hidden = false;
    elements.captureAiState.hidden = false;
    elements.quickModelSelect.hidden = true;
    elements.captureQuickModelSelect.hidden = true;
    return;
  }
  const live = config.mode === "live";
  const styleName = config.apiStyle === "compatible" ? "Compatible" : "Responses";
  const label = live ? escapeHtml(config.model || "未填写模型") : "演示模式";
  const title = live ? `${config.providerName} · ${styleName} · ${config.model}` : "打开设置完成 AI 配置";
  setTargets(live ? "live" : "demo", `<span class="status-dot"></span>${label}`, title);
  const providers = Array.isArray(config.providers) ? config.providers : [];
  const options = providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.model || "未填写模型")} · ${escapeHtml(provider.name)}</option>`).join("");
  for (const select of [elements.quickModelSelect, elements.captureQuickModelSelect]) {
    select.innerHTML = options;
    select.value = config.providerId || "";
    select.title = title;
    select.hidden = providers.length === 0;
    syncCustomSelect(select);
  }
  elements.aiState.hidden = providers.length > 0;
  elements.captureAiState.hidden = providers.length > 0;
}

function applyAiStatus(config, fillForm = false) {
  state.ai = config;
  renderAiState();
  const live = config.mode === "live";
  const styleName = config.apiStyle === "compatible" ? "Compatible" : "Responses";
  const pill = document.querySelector("#settings-ai-pill");
  pill.className = `status-pill ${live ? "live" : "demo"}`;
  pill.textContent = live ? "已配置" : "演示模式";
  document.querySelector("#settings-ai-copy").textContent = live
    ? `${config.providerName} · ${styleName} · ${config.model}`
    : "填写接口、密钥与模型后启用真实解释";

  if (!fillForm) return;
  const providers = config.providers || [];
  elements.providerSelect.innerHTML = `${providers.map((provider) => `<option value="${escapeHtml(provider.id)}">${escapeHtml(provider.name)}</option>`).join("")}<option value="">新增 Provider…</option>`;
  elements.providerSelect.value = config.providerId || "";
  syncCustomSelect(elements.providerSelect);
  elements.providerName.value = config.providerName === "新 Provider" ? "" : config.providerName || "";
  elements.deleteProvider.disabled = !config.providerId;
  elements.reasoningEffort.value = ["auto", "none", "low", "medium", "high"].includes(config.reasoningEffort) ? config.reasoningEffort : "auto";
  elements.enableThinkingToggle.checked = Boolean(config.enableThinkingToggle);
  const radio = document.querySelector(`input[name="api-style"][value="${config.apiStyle}"]`);
  if (radio) radio.checked = true;
  elements.apiBaseUrl.value = config.baseUrl || "https://api.openai.com/v1";
  elements.apiModel.value = config.model || "";
  elements.apiKey.value = "";
  elements.apiKey.placeholder = config.hasApiKey ? "已保存，留空不修改" : "输入新的 API Key";
  elements.allowNoKey.checked = Boolean(config.allowNoKey);
  elements.apiKey.disabled = elements.allowNoKey.checked;
  document.querySelector("#api-key-help").textContent = config.hasApiKey
    ? "已保存在本机服务端；留空不会修改。"
    : "密钥只保存在本机服务端。";
  updateApiStyleHelp();
}

async function getAiStatus(fillForm = false) {
  try {
    const response = await apiFetch("/api/config");
    if (!response.ok) throw new Error("无法读取 AI 配置");
    applyAiStatus(await response.json(), fillForm);
  } catch {
    applyAiStatus({ mode: "demo", model: "", apiStyle: "responses", baseUrl: "https://api.openai.com/v1", hasApiKey: false }, fillForm);
  }
}

async function openSettings() {
  renderNavigation();
  elements.dialog.showModal();
  showConfigMessage("");
  await Promise.all([getAiStatus(true), loadWebdavConfig()]);
  syncAppearanceControls();
  refreshIcons();
}

async function refreshModelList() {
  elements.refreshModels.disabled = true;
  elements.refreshModels.classList.add("spinning");
  elements.modelListState.textContent = "正在获取模型…";
  try {
    const response = await apiFetch("/api/models", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configDraft()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "获取模型失败");
    elements.modelOptions.innerHTML = result.models.map((model) => `<option value="${escapeHtml(model)}"></option>`).join("");
    elements.modelListState.textContent = `已获取 ${result.models.length} 个模型，也可以直接输入。`;
    showConfigMessage("");
  } catch (error) {
    elements.modelListState.textContent = "仍可直接填写模型 ID。";
    showConfigMessage(error.message || "获取模型失败", true);
  } finally {
    elements.refreshModels.disabled = false;
    elements.refreshModels.classList.remove("spinning");
  }
}

async function saveAiConfig(event) {
  event.preventDefault();
  const submit = elements.configForm.querySelector('button[type="submit"]');
  submit.disabled = true;
  showConfigMessage("正在保存…");
  try {
    const response = await apiFetch("/api/config", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(configDraft()),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || "保存失败");
    applyAiStatus(result, true);
    showConfigMessage("Provider 已保存并设为当前使用。", false);
    toast("Provider 已保存");
  } catch (error) {
    showConfigMessage(error.message || "保存失败", true);
  } finally {
    submit.disabled = false;
  }
}

function newProvider() {
  elements.providerSelect.value = "";
  syncCustomSelect(elements.providerSelect);
  elements.providerName.value = "";
  document.querySelector('input[name="api-style"][value="responses"]').checked = true;
  elements.apiBaseUrl.value = "https://api.openai.com/v1";
  elements.reasoningEffort.value = "auto";
  elements.enableThinkingToggle.checked = false;
  elements.apiKey.value = "";
  elements.apiKey.placeholder = "输入 API Key";
  elements.apiModel.value = "";
  elements.allowNoKey.checked = false;
  elements.apiKey.disabled = false;
  elements.deleteProvider.disabled = true;
  showConfigMessage("");
  updateApiStyleHelp();
  elements.providerName.focus();
}

async function activateProvider(providerId = elements.providerSelect.value, fillForm = true) {
  const id = providerId;
  if (!id) return newProvider();
  const result = await requestJson(`/api/config/${id}/activate`, { method: "POST" });
  applyAiStatus(result, fillForm);
  toast(`已切换到 ${result.providerName}`);
}

async function deleteProvider() {
  const id = elements.providerSelect.value;
  const name = elements.providerSelect.selectedOptions[0]?.textContent || "这个 Provider";
  if (!id || !await confirmAction(`删除“${name}”？本机保存的密钥也会一并删除。`, { title: "删除 Provider", confirmLabel: "删除" })) return;
  const result = await requestJson(`/api/config/${id}`, { method: "DELETE" });
  applyAiStatus(result, true);
  toast("Provider 已删除");
}

function syncAppearanceControls() {
  const radio = document.querySelector(`input[name="theme"][value="${appearance.theme}"]`);
  if (radio) radio.checked = true;
  elements.fontScale.value = appearance.fontScale;
  elements.fontScaleValue.value = `${appearance.fontScale}%`;
  elements.sendShortcut.value = appearance.sendShortcut;
}

async function submitFragment(event, forceNew = false, overrideText = "") {
  event.preventDefault();
  const form = event.currentTarget;
  const input = form.querySelector("textarea");
  const source = form.querySelector("select");
  const text = (overrideText || input.value).trim();
  if (!text || !state.storageReady) return;
  const active = state.entries.find((entry) => entry.id === state.activeThreadId);
  const wasCapture = state.view === "capture";
  const pending = { id: crypto.randomUUID(), controller: new AbortController(), entryId: null };

  state.activeRequests.set(pending.id, pending);
  state.activeRequest = pending;
  render();
  try {
    const result = await requestJson(active ? `/api/entries/${active.id}/followups` : "/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(active ? { text } : { text, source: source.value, ...(forceNew ? { forceNew: true } : {}) }),
      signal: pending.controller.signal,
      requestId: pending.id,
    });
    if (pending.controller.signal.aborted) return;
    if (active) {
      state.entries[state.entries.findIndex((entry) => entry.id === active.id)] = result.entry;
    } else {
      const returnedEntries = Array.isArray(result.entries) && result.entries.length ? result.entries : [result.entry];
      const additions = returnedEntries.filter((item) => !state.entries.some((entry) => entry.id === item.id));
      state.entries.unshift(...additions);
      if (additions.length) state.newEntryIds = [...new Set([...additions.map((entry) => entry.id), ...state.newEntryIds])];
      if (wasCapture) {
        state.view = "all";
        state.sourceFilter = "";
      }
    }
    input.value = "";
    input.style.height = "auto";
    const duplicateAction = result.duplicate ? { label: "仍然新建", run: () => submitFragment({ preventDefault() {}, currentTarget: form }, true, text) } : undefined;
    const splitMessage = result.split
      ? `已拆分：新建 ${result.createdCount || 0} 个${result.reusedCount ? `，复用 ${result.reusedCount} 个` : ""}`
      : result.duplicate ? "词库中已有这个片段" : result.demo ? "已保存；当前为演示解释" : "已保存为独立片段";
    toast(splitMessage, duplicateAction);
  } catch (error) {
    const stopped = pending.controller.signal.aborted || error.name === "AbortError" || error.message === "请求已暂停";
    toast(stopped ? "已停止，内容未保存" : (error.message || "解释失败"));
  } finally {
    state.activeRequests.delete(pending.id);
    if (state.activeRequest?.id === pending.id) state.activeRequest = [...state.activeRequests.values()].at(-1) || null;
    render();
  }
}

function restoreThreadDraft(pending, message) {
  const restore = () => {
    state.threadAnchorId = pending.entryId;
    elements.threadInput.value = pending.text;
    elements.threadInput.focus();
    renderThreadComposer();
  };
  if (!elements.threadInput.value.trim()) {
    restore();
    toast(message);
    return;
  }
  toast(message, { label: "恢复草稿", run: async () => restore() });
}

async function submitThreadQuestion(event) {
  event.preventDefault();
  const entry = state.entries.find((item) => item.id === state.threadAnchorId);
  const text = elements.threadInput.value.trim();
  if (!entry) {
    elements.threadMessage.textContent = "先用 @ 选择一个词条";
    elements.threadComposer.classList.remove("shake");
    requestAnimationFrame(() => elements.threadComposer.classList.add("shake"));
    return;
  }
  if (!text || !state.storageReady) {
    elements.threadMessage.textContent = text ? "本地存储尚未就绪" : "先写下你想弄明白的问题";
    return;
  }
  elements.threadMessage.textContent = "";
  const pending = { id: crypto.randomUUID(), controller: new AbortController(), entryId: entry.id, text };
  state.activeRequests.set(pending.id, pending);
  state.activeRequest = pending;
  elements.threadInput.value = "";
  render();
  try {
    const result = await requestJson(`/api/entries/${entry.id}/followups`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
      signal: pending.controller.signal,
      requestId: pending.id,
    });
    if (pending.controller.signal.aborted) return;
    const index = state.entries.findIndex((item) => item.id === entry.id);
    if (index >= 0) state.entries[index] = result.entry;
    if (state.selectedThreadEntryId === entry.id) {
      state.detailClosed = false;
      state.detailOpened = true;
    } else {
      toast("已加入 1 条理解", { label: "查看", run: async () => {
        state.view = "threads";
        state.selectedThreadEntryId = entry.id;
        state.detailClosed = false;
        state.detailOpened = true;
        render();
      } });
    }
  } catch (error) {
    const stopped = pending.controller.signal.aborted || error.name === "AbortError" || error.message === "请求已暂停";
    restoreThreadDraft(pending, stopped ? "已停止，内容未保存" : (error.message || "追问失败"));
  } finally {
    state.activeRequests.delete(pending.id);
    if (state.activeRequest?.id === pending.id) state.activeRequest = [...state.activeRequests.values()].at(-1) || null;
    render();
  }
}

function stopThreadRequest(entryId) {
  for (const pending of pendingForEntry(entryId)) {
    pending.controller.abort();
    window.__TAURI__?.core?.invoke("cancel_request", { requestId: pending.id }).catch(() => {});
  }
}

function stopRequest() {
  const pending = state.activeRequest;
  if (!pending) return;
  pending.controller.abort();
  window.__TAURI__?.core?.invoke("cancel_request", { requestId: pending.id }).catch(() => {});
}

function newFragment() {
  stopRequest();
  state.activeThreadId = null;
  state.view = "all";
  elements.input.value = "";
  render();
  elements.input.focus();
}

async function rewindThread(entry, turnId) {
  const turn = entry.thread.find((item) => item.id === turnId);
  const target = turn ? `第 ${entry.thread.indexOf(turn) + 1} 轮` : "原片段";
  if (!await confirmAction(`回退到${target}？之后的追问会从本机记录中移除。`, { title: "回退追问", confirmLabel: "回退" })) return;
  const snapshot = structuredClone(state.entries);
  const result = await requestJson(`/api/entries/${entry.id}/followups`, {
    method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ turnId: turnId || "" }),
  });
  state.entries[state.entries.indexOf(entry)] = result.entry;
  state.selectedEntryId = entry.id;
  toast(`已回退到${target}`, { label: "撤销", run: () => restoreEntries(snapshot) });
  render();
}

async function restoreEntries(entries) {
  const result = await requestJson("/api/entries", {
    method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries }),
  });
  state.entries = result.entries || [];
  state.selectedEntryId = state.entries.find((entry) => entry.id === state.selectedEntryId)?.id || state.entries[0]?.id || null;
  state.view = "all";
  state.sourceFilter = "";
  render();
  toast("已撤销");
}

async function handleAction(action, id, grade, turnId, hint) {
  const entry = state.entries.find((item) => item.id === id);
  if (action === "new-fragment") return newFragment();
  if (action === "dismiss-new-entries") {
    state.newEntryIds = [];
    return renderNewEntryNotice();
  }
  if (action === "open-new-entry" && entry) {
    state.newEntryIds = state.newEntryIds.filter((entryId) => entryId !== entry.id);
    state.view = "all";
    state.query = "";
    elements.search.value = "";
    elements.searchBox.classList.remove("has-value");
    state.sourceFilter = "";
    state.detailClosed = false;
    state.detailOpened = true;
    const index = filteredEntries().findIndex((item) => item.id === entry.id);
    state.visibleLimit = Math.max(80, index + 1);
    state.selectedEntryId = entry.id;
    render();
    elements.timeline.querySelector(`[data-entry-id="${CSS.escape(entry.id)}"]`)?.scrollIntoView({ block: "center", behavior: "smooth" });
    return;
  }
  if (action === "focus-composer") {
    state.view = "capture";
    state.activeThreadId = null;
    render();
    elements.captureInput.focus();
    return;
  }
  if (action === "open-mentions") {
    openMentionPopover();
    return;
  }
  if (action === "clear-thread-anchor") {
    state.threadAnchorId = null;
    closeMentionPopover();
    renderThreadComposer();
    elements.threadInput.focus();
    return;
  }
  if (action === "select-thread-anchor" && entry) {
    state.threadAnchorId = entry.id;
    closeMentionPopover();
    renderThreadComposer();
    elements.threadInput.focus();
    return;
  }
  if (action === "stop-thread-request" && entry) {
    stopThreadRequest(entry.id);
    return;
  }
  if (action === "focus-search") {
    elements.searchBox.classList.add("is-open");
    elements.search.focus();
    return;
  }
  if (action === "settings") return openSettings();
  if (action === "close-settings") return elements.dialog.close();
  if (action === "open-detail" && entry) return openEntryDetail(entry);
  if (action === "open-thread" && entry) {
    state.selectedThreadEntryId = entry.id;
    state.detailClosed = false;
    state.detailOpened = true;
    renderTimeline();
    return;
  }
  if (action === "set-thread-anchor" && entry) {
    state.threadAnchorId = entry.id;
    toast(`已选择“${entry.displayText || entry.raw}”作为提问对象`);
    return;
  }
  if (action === "open-library-entry" && entry) {
    state.view = "all";
    state.sourceFilter = "";
    state.selectedEntryId = entry.id;
    state.detailClosed = false;
    state.detailOpened = true;
    return render();
  }
  if (action === "copy-thread-turn" && entry) {
    const turn = entry.thread?.find((item) => item.id === turnId);
    if (!turn) return;
    const text = `问：${turn.question}\n答：${turn.answer}${turn.summary ? `\n记忆结论：${turn.summary}` : ""}`;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      const textarea = Object.assign(document.createElement("textarea"), { value: text });
      document.body.append(textarea); textarea.select(); document.execCommand("copy"); textarea.remove();
    }
    toast("已复制这轮追问");
    return;
  }
  if (action === "close-detail") {
    state.selectedEntryId = null;
    state.detailClosed = true;
    state.detailOpened = false;
    renderTimeline();
    return;
  }
  if (action === "new-provider") return newProvider();
  if (action === "delete-provider") return deleteProvider();
  if (action === "rewind-thread" && entry) return rewindThread(entry, turnId);
  if (action === "toggle-key") {
    const showing = elements.apiKey.type === "text";
    elements.apiKey.type = showing ? "password" : "text";
    const button = document.querySelector('[data-action="toggle-key"]');
    button.setAttribute("aria-label", showing ? "显示 API Key" : "隐藏 API Key");
    button.innerHTML = icon(showing ? "eye" : "eye-off");
    refreshIcons();
    return;
  }
  if (action === "clear-search") { state.query = ""; elements.search.value = ""; elements.searchBox.classList.remove("has-value"); return renderTimeline(); }
  if (action === "import") { elements.importJson.click(); return; }
  if (action === "load-more") { state.visibleLimit += 80; return renderTimeline(); }
  if (action === "review-hint") {
    state.reviewHint = hint === "strong" ? "strong" : "weak";
    return renderTimeline();
  }
  if (action === "reveal-review") { state.reviewReveal = true; return renderTimeline(); }
  if (action === "start-review" && entry) {
    state.view = "review";
    elements.timeline.scrollTop = 0;
    state.reviewFocusId = entry.id;
    state.reviewSessionTotal = dueEntries().length;
    state.reviewReveal = false;
    state.reviewHint = "";
    return render();
  }
  if (action === "grade-review" && entry) {
    const result = await requestJson(`/api/entries/${entry.id}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grade }),
    });
    state.entries[state.entries.indexOf(entry)] = result.entry;
    state.reviewReveal = false;
    state.reviewHint = "";
    state.reviewFocusId = null;
    toast(`已安排在 ${formatInterval(reviewState(result.entry).intervalDays)}后复习`);
    return render();
  }
  if (action === "continue" && entry) {
    state.activeThreadId = entry.id;
    state.selectedEntryId = entry.id;
    state.detailClosed = false;
    state.detailOpened = true;
    render(); elements.input.focus(); return;
  }
  if ((action === "toggle-thread" || action === "toggle-details") && entry) {
    return openEntryDetail(entry);
  }
  if (action === "star" && entry) {
    const result = await requestJson(`/api/entries/${entry.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: !entry.starred }),
    });
    state.entries[state.entries.indexOf(entry)] = result.entry;
  }
  if (action === "delete" && entry) {
    if (!await confirmAction(`删除“${entry.displayText || entry.raw}”？`, { title: "删除片段", confirmLabel: "删除" })) return;
    const snapshot = structuredClone(state.entries);
    await requestJson(`/api/entries/${entry.id}`, { method: "DELETE" });
    state.entries = state.entries.filter((item) => item.id !== entry.id);
    if (state.activeThreadId === entry.id) state.activeThreadId = null;
    toast("片段已删除", { label: "撤销", run: () => restoreEntries(snapshot) });
  }
  if (action === "export") {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: state.entries }, null, 2)], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `拾词-${new Date().toISOString().slice(0, 10)}.json` });
    link.click(); URL.revokeObjectURL(link.href); toast("已导出 JSON"); return;
  }
  if (action === "reset" && await confirmAction("恢复演示数据会替换本机片段库里的所有内容，继续吗？", { title: "恢复演示数据", confirmLabel: "替换" })) {
    const snapshot = structuredClone(state.entries);
    const result = await requestJson("/api/entries", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: seedEntries }),
    });
    state.entries = result.entries; state.activeThreadId = null; state.selectedEntryId = state.entries[0]?.id || null; state.view = "all"; state.sourceFilter = ""; elements.dialog.close();
    toast("已恢复演示数据", { label: "撤销", run: () => restoreEntries(snapshot) });
  }
  render();
}

async function changeEntrySource(select) {
  const entry = state.entries.find((item) => item.id === select.dataset.sourceEntry);
  if (!entry || select.value === entry.source) return;
  select.disabled = true;
  try {
    const result = await requestJson(`/api/entries/${entry.id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ source: select.value }),
    });
    state.entries[state.entries.indexOf(entry)] = result.entry;
    toast(select.value ? `来源已改为“${select.value}”` : "已移除来源标记");
    render();
  } catch (error) {
    select.value = entry.source;
    select.disabled = false;
    toast(error.message || "来源保存失败");
  }
}

async function importLibraryFile(event) {
  const file = event.target.files?.[0];
  event.target.value = "";
  if (!file) return;
  try {
    const parsed = JSON.parse(await file.text());
    const entries = Array.isArray(parsed) ? parsed : parsed?.entries;
    if (!Array.isArray(entries)) throw new Error("JSON 中没有 entries 数组");
    const result = await requestJson("/api/entries/import", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ entries }),
    });
    state.entries = result.entries || [];
    state.selectedEntryId = state.entries.find((entry) => entry.id === state.selectedEntryId)?.id || state.entries[0]?.id || null;
    state.view = "all";
    state.sourceFilter = "";
    elements.dialog.close();
    render();
    const parts = [`已追加 ${result.importedCount || 0} 条`];
    if (result.skippedCount) parts.push(`跳过 ${result.skippedCount} 条重复`);
    if (result.invalidCount) parts.push(`忽略 ${result.invalidCount} 条无效记录`);
    if (result.truncatedCount) parts.push(`超出上限 ${result.truncatedCount} 条`);
    toast(parts.join("，"));
  } catch (error) {
    toast(error.message || "导入失败");
  }
}

document.addEventListener("click", (event) => {
  if (!event.target.closest("#mention-popover, #thread-anchor")) closeMentionPopover();
  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget) {
    handleAction(actionTarget.dataset.action, actionTarget.dataset.id, actionTarget.dataset.grade, actionTarget.dataset.turnId, actionTarget.dataset.hint).catch((error) => toast(error.message || "操作失败"));
    return;
  }
  const viewTarget = event.target.closest("[data-view]");
  if (viewTarget) {
    state.view = viewTarget.dataset.view;
    state.detailClosed = false;
    state.detailOpened = false;
    state.sourceFilter = "";
    state.visibleLimit = 80;
    state.reviewReveal = false;
    state.reviewHint = "";
    state.reviewFocusId = null;
    state.reviewSessionTotal = state.view === "review" ? dueEntries().length : 0;
    elements.timeline.scrollTop = 0;
    render(); return;
  }
});

document.addEventListener("dblclick", (event) => {
  const card = event.target.closest(".entry-card");
  if (!card || event.target.closest("button, select, label, input, a")) return;
  const entry = state.entries.find((item) => item.id === card.dataset.entryId);
  if (entry) openEntryDetail(entry);
});

document.addEventListener("change", (event) => {
  const sourceSelect = event.target.closest("[data-source-entry]");
  if (sourceSelect) changeEntrySource(sourceSelect);
});

elements.filterSelect.addEventListener("change", () => {
  const value = elements.filterSelect.value;
  state.detailClosed = false;
  state.detailOpened = false;
  state.visibleLimit = 80;
  if (value === "starred") {
    state.view = "starred";
    state.sourceFilter = "";
  } else {
    state.view = "all";
    state.sourceFilter = value.startsWith("source:") ? value.slice(7) : "";
  }
  render();
});
elements.sortSelect.addEventListener("change", () => {
  state.sort = elements.sortSelect.value;
  state.visibleLimit = 80;
  elements.timeline.scrollTop = 0;
  renderTimeline();
  renderNewEntryNotice();
  refreshIcons();
});

elements.composer.addEventListener("submit", submitFragment);
elements.send.addEventListener("click", (event) => {
  if (!state.activeRequest) return;
  event.preventDefault();
  stopRequest();
});
elements.captureComposer.addEventListener("submit", submitFragment);
elements.captureSend.addEventListener("click", (event) => {
  if (!state.activeRequest) return;
  event.preventDefault();
  stopRequest();
});
elements.threadForm.addEventListener("submit", submitThreadQuestion);
elements.threadSend.addEventListener("click", (event) => {
  const entry = state.entries.find((item) => item.id === state.threadAnchorId);
  if (!entry || !pendingForEntry(entry.id).length) return;
  event.preventDefault();
  stopThreadRequest(entry.id);
});
elements.threadInput.addEventListener("keydown", (event) => {
  if (event.key === "@" && !elements.threadInput.value.trim()) {
    event.preventDefault();
    openMentionPopover();
    return;
  }
  if (event.key !== "Enter" || event.isComposing) return;
  const sends = appearance.sendShortcut === "mod-enter"
    ? (event.metaKey || event.ctrlKey) && !event.shiftKey
    : appearance.sendShortcut === "shift-enter"
      ? event.shiftKey && !event.metaKey && !event.ctrlKey
      : !event.shiftKey && !event.metaKey && !event.ctrlKey;
  if (sends) { event.preventDefault(); elements.threadForm.requestSubmit(); }
});
elements.threadInput.addEventListener("input", () => {
  elements.threadInput.style.height = "auto";
  elements.threadInput.style.height = `${Math.min(elements.threadInput.scrollHeight, 150)}px`;
  elements.threadMessage.textContent = "";
});
elements.mentionSearch.addEventListener("input", renderMentionOptions);
elements.mentionSearch.addEventListener("keydown", (event) => {
  const options = [...elements.mentionList.querySelectorAll(".mention-option")];
  if (event.key === "Escape") { event.preventDefault(); closeMentionPopover(); elements.threadInput.focus(); return; }
  if (!options.length || !["ArrowDown", "ArrowUp", "Enter"].includes(event.key)) return;
  event.preventDefault();
  let index = options.findIndex((option) => option.getAttribute("aria-selected") === "true");
  if (event.key === "ArrowDown") index = (index + 1) % options.length;
  if (event.key === "ArrowUp") index = (index - 1 + options.length) % options.length;
  if (event.key === "Enter") return options[Math.max(0, index)]?.click();
  options.forEach((option, optionIndex) => option.setAttribute("aria-selected", String(optionIndex === index)));
});
elements.configForm.addEventListener("submit", saveAiConfig);
elements.webdavForm.addEventListener("submit", saveWebdavConfig);
elements.webdavTest.addEventListener("click", testWebdav);
elements.webdavSync.addEventListener("click", () => runWebdavSync({ silent: false }));
elements.importJson.addEventListener("change", importLibraryFile);
elements.refreshModels.addEventListener("click", refreshModelList);
elements.providerSelect.addEventListener("change", () => activateProvider().catch((error) => toast(error.message || "切换失败")));
elements.quickModelSelect.addEventListener("change", () => activateProvider(elements.quickModelSelect.value, false).catch((error) => toast(error.message || "切换失败")));
elements.captureQuickModelSelect.addEventListener("change", () => activateProvider(elements.captureQuickModelSelect.value, false).catch((error) => toast(error.message || "切换失败")));
document.querySelectorAll('input[name="api-style"]').forEach((input) => input.addEventListener("change", updateApiStyleHelp));
document.querySelectorAll('input[name="theme"]').forEach((input) => input.addEventListener("change", () => {
  appearance.theme = input.value;
  applyAppearance();
}));
elements.fontScale.addEventListener("input", () => {
  appearance.fontScale = Number(elements.fontScale.value);
  elements.fontScaleValue.value = `${appearance.fontScale}%`;
  applyAppearance();
});
elements.sendShortcut.addEventListener("change", () => {
  appearance.sendShortcut = elements.sendShortcut.value;
  applyAppearance();
  renderComposer();
  renderCapturePage();
  refreshIcons();
});
elements.allowNoKey.addEventListener("change", () => {
  elements.apiKey.disabled = elements.allowNoKey.checked;
  if (elements.allowNoKey.checked) elements.apiKey.value = "";
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const sends = appearance.sendShortcut === "mod-enter"
    ? (event.metaKey || event.ctrlKey) && !event.shiftKey
    : appearance.sendShortcut === "shift-enter"
      ? event.shiftKey && !event.metaKey && !event.ctrlKey
      : !event.shiftKey && !event.metaKey && !event.ctrlKey;
  if (sends) { event.preventDefault(); elements.composer.requestSubmit(); }
});
elements.captureInput.addEventListener("keydown", (event) => {
  if (event.key !== "Enter" || event.isComposing) return;
  const sends = appearance.sendShortcut === "mod-enter"
    ? (event.metaKey || event.ctrlKey) && !event.shiftKey
    : appearance.sendShortcut === "shift-enter"
      ? event.shiftKey && !event.metaKey && !event.ctrlKey
      : !event.shiftKey && !event.metaKey && !event.ctrlKey;
  if (sends) { event.preventDefault(); elements.captureComposer.requestSubmit(); }
});
elements.input.addEventListener("input", () => {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
});
elements.captureInput.addEventListener("input", () => {
  elements.captureInput.style.height = "auto";
  elements.captureInput.style.height = `${Math.min(elements.captureInput.scrollHeight, 180)}px`;
});
elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  state.visibleLimit = 80;
  elements.searchBox.classList.toggle("has-value", Boolean(state.query));
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => renderTimeline(), 150);
});
document.addEventListener("keydown", (event) => {
  if (state.view !== "review" || elements.dialog.open || ["INPUT", "TEXTAREA", "SELECT"].includes(event.target.tagName)) return;
  if (event.code === "Space" && !state.reviewReveal) { event.preventDefault(); handleAction("reveal-review"); return; }
  if (!state.reviewReveal) return;
  const grade = { Digit1: "again", Digit2: "hard", Digit3: "good", Digit4: "easy" }[event.code];
  const entry = dueEntries()[0];
  if (grade && entry) handleAction("grade-review", entry.id, grade).catch((error) => toast(error.message || "复习保存失败"));
});
elements.dialog.addEventListener("click", (event) => {
  if (event.target === elements.dialog) elements.dialog.close();
});
render();
getAiStatus();
load().catch((error) => toast(error.message || "无法读取本地数据")).finally(() => {
  render();
  loadWebdavConfig().then(() => { if (state.webdav.enabled) runWebdavSync({ silent: true }).catch(() => {}); });
});
if (!window.__TAURI__ && "serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js?v=30").catch(() => {});
