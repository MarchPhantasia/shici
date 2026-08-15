const STORAGE_KEY = "shici:v1";
const APPEARANCE_KEY = "shici:appearance";
const now = Date.now();
const sourceOptions = ["日常", "阅读", "影视", "工作", "游戏", "网页", "聊天", "其他"];
const kindLabels = { word: "单词", word_list: "词表", phrase: "短语", sentence: "句子", other: "片段" };

function readAppearance() {
  try {
    const value = JSON.parse(localStorage.getItem(APPEARANCE_KEY) || "{}");
    return {
      theme: ["system", "light", "dark"].includes(value.theme) ? value.theme : "system",
      fontScale: Math.min(120, Math.max(90, Number(value.fontScale) || 100)),
    };
  } catch { return { theme: "system", fontScale: 100 }; }
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
  activeThreadId: null,
  expanded: new Set(),
  visibleLimit: 80,
  reviewReveal: false,
  reviewSessionTotal: 0,
  reviewFocusId: null,
  ai: { mode: "checking", model: "", apiStyle: "responses" },
  busy: true,
  storageReady: false,
};

const elements = {
  timeline: document.querySelector("#timeline"),
  workspace: document.querySelector(".workspace"),
  bottomNav: document.querySelector(".bottom-nav"),
  composerShell: document.querySelector(".composer-shell"),
  libraryHead: document.querySelector("#library-head"),
  composer: document.querySelector("#composer"),
  input: document.querySelector("#fragment-input"),
  source: document.querySelector("#source-select"),
  sourceFilters: document.querySelector("#source-filters"),
  send: document.querySelector("#send-button"),
  contextBar: document.querySelector("#context-bar"),
  contextTitle: document.querySelector("#context-title"),
  search: document.querySelector("#search-input"),
  searchBox: document.querySelector(".search-box"),
  aiState: document.querySelector("#ai-state"),
  detailDialog: document.querySelector("#detail-dialog"),
  detailContent: document.querySelector("#detail-content"),
  dialog: document.querySelector("#settings-dialog"),
  toast: document.querySelector("#toast"),
  configForm: document.querySelector("#config-form"),
  apiBaseUrl: document.querySelector("#api-base-url"),
  providerSelect: document.querySelector("#provider-select"),
  providerName: document.querySelector("#provider-name"),
  deleteProvider: document.querySelector("#delete-provider"),
  apiKey: document.querySelector("#api-key"),
  apiModel: document.querySelector("#api-model"),
  allowNoKey: document.querySelector("#allow-no-key"),
  modelOptions: document.querySelector("#model-options"),
  modelListState: document.querySelector("#model-list-state"),
  configMessage: document.querySelector("#config-message"),
  refreshModels: document.querySelector("#refresh-models"),
  fontScale: document.querySelector("#font-scale"),
  fontScaleValue: document.querySelector("#font-scale-value"),
};

async function apiFetch(url, options = {}) {
  const invoke = window.__TAURI__?.core?.invoke;
  if (!invoke) return fetch(url, options);

  let body = {};
  if (typeof options.body === "string" && options.body) body = JSON.parse(options.body);
  const result = await invoke("api_request", {
    request: { url, method: options.method || "GET", body },
  });
  return new Response(JSON.stringify(result.body), {
    status: result.status,
    headers: { "Content-Type": "application/json" },
  });
}

async function requestJson(url, options = {}) {
  const response = await apiFetch(url, options);
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || `请求失败 (${response.status})`);
  return result;
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

function refreshIcons() {
  window.lucide?.createIcons({ attrs: { "stroke-width": 1.8 } });
}

function renderWords(entry, className = "word-grid") {
  if (!entry.words?.length) return "";
  return `<div class="${className}">${entry.words.map((word) => `<div><strong>${escapeHtml(word.text)}</strong>${word.pronunciation ? `<span>${escapeHtml(word.pronunciation)}</span>` : ""}<p>${escapeHtml(word.meaning)}</p></div>`).join("")}</div>`;
}

function formatTime(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric" });
}

function dayKey(timestamp) {
  const date = new Date(timestamp);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "今天";
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return "昨天";
  return "更早";
}

function reviewState(entry) {
  return entry.review || { dueAt: entry.createdAt, intervalDays: 0, ease: 2.5, repetitions: 0, lapses: 0 };
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

function previewInterval(entry, grade) {
  const review = reviewState(entry);
  if (grade === "again") return 10 / 1_440;
  if (grade === "hard") return review.repetitions === 0 ? 1 : Math.max(1, review.intervalDays * 1.2);
  if (grade === "easy") return review.repetitions === 0 ? 4 : review.repetitions === 1 ? 8 : Math.max(8, review.intervalDays * (review.ease + 0.15) * 1.3);
  return review.repetitions === 0 ? 1 : review.repetitions === 1 ? 3 : Math.max(3, review.intervalDays * review.ease);
}

function dueLabel(entry) {
  const difference = reviewState(entry).dueAt - Date.now();
  if (difference <= 0) return "现在复习";
  const days = difference / 86_400_000;
  return `约 ${formatInterval(days)}后`;
}

function filteredEntries() {
  const query = state.query.trim().toLowerCase();
  return state.entries.filter((entry) => {
    if (state.view === "starred" && !entry.starred) return false;
    if (state.sourceFilter && entry.source !== state.sourceFilter) return false;
    if (!query) return true;
    const haystack = [entry.raw, entry.displayText, entry.meaning, entry.context, entry.source, ...(entry.usage || []), ...(entry.words || []).flatMap((word) => [word.text, word.pronunciation, word.meaning])].join(" ").toLowerCase();
    return haystack.includes(query);
  });
}

function renderThread(entry) {
  if (!entry.thread?.length) return "";
  return `<div class="thread-panel">
    ${entry.thread.map((turn) => `<div class="thread-turn">
      <span class="turn-mark">你</span><div class="turn-copy"><strong>追问</strong>${escapeHtml(turn.question)}</div>
      <span class="turn-mark ai">AI</span><div class="turn-copy"><strong>回答</strong>${escapeHtml(turn.answer)}</div>
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

function openEntryDetail(entry) {
  const usage = entry.usage?.length
    ? `<section class="detail-section"><span>用法与例句</span><ul>${entry.usage.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></section>`
    : "";
  const chunks = entry.chunks?.length
    ? `<section class="detail-section"><span>表达拆解</span><div class="detail-chunks">${entry.chunks.map((chunk) => `<div><strong>${escapeHtml(chunk.text)}</strong><p>${escapeHtml(chunk.meaning)}</p></div>`).join("")}</div></section>`
    : "";
  const words = entry.words?.length
    ? `<section class="detail-section"><span>${entry.kind === "word_list" ? "逐词理解" : "读音"}</span>${renderWords(entry, "detail-words")}</section>`
    : "";
  const thread = entry.thread?.length
    ? `<section class="detail-section"><span>围绕这个片段的追问</span><div class="detail-thread">${entry.thread.map((turn) => `<div><strong>你</strong><p>${escapeHtml(turn.question)}</p><strong>AI</strong><p>${escapeHtml(turn.answer)}</p></div>`).join("")}</div></section>`
    : "";
  const displayText = entry.displayText || entry.raw;
  const original = entry.raw !== displayText
    ? `<section class="detail-section"><span>原始输入</span><p class="detail-original">${escapeHtml(entry.raw)}</p></section>`
    : "";
  const review = reviewState(entry);
  elements.detailContent.innerHTML = `
    <article class="detail-sheet">
      <div class="detail-toolbar">
        <span>${icon("languages")}${kindLabels[entry.kind] || "完整片段"}</span>
        <button class="icon-button" type="button" data-action="close-detail" aria-label="关闭完整卡片">${icon("x")}</button>
      </div>
      <header class="detail-hero">
        <div class="detail-badges">
          ${entry.source ? `<span>${icon("tag")}${escapeHtml(entry.source)}</span>` : ""}
          <span class="${isDue(entry) ? "is-due" : ""}">${icon("history")}${dueLabel(entry)}</span>
        </div>
        <h2 id="detail-title">${escapeHtml(displayText)}</h2>
        ${entry.pronunciation ? `<p class="detail-pronunciation">${escapeHtml(entry.pronunciation)}</p>` : ""}
        ${entry.correction ? `<p class="detail-correction">已按 ${escapeHtml(entry.correction)} 理解</p>` : ""}
      </header>
      <div class="detail-layout">
        <main>
          <section class="detail-section detail-meaning">
            <span>在这里的理解</span>
            <h3>${escapeHtml(entry.meaning)}</h3>
            ${entry.context ? `<p>${escapeHtml(entry.context)}</p>` : ""}
          </section>
          ${original}${words}${usage}${chunks}${thread}
        </main>
        <aside class="detail-meta">
          <span>学习记录</span>
          <dl>
            <div><dt>收录时间</dt><dd>${formatTime(entry.createdAt)}</dd></div>
            <div><dt>复习次数</dt><dd>${review.repetitions || 0}</dd></div>
            <div><dt>当前间隔</dt><dd>${review.repetitions ? formatInterval(review.intervalDays) : "尚未开始"}</dd></div>
            <div><dt>记忆难度</dt><dd>${Number(review.ease || 2.5).toFixed(1)}</dd></div>
          </dl>
        </aside>
      </div>
      <footer class="detail-actions">
        ${isDue(entry) ? `<button class="secondary-button" type="button" data-action="start-review" data-id="${entry.id}">${icon("brain")}现在复习</button>` : ""}
        <button class="primary-button" type="button" data-action="continue" data-id="${entry.id}">${icon("message-circle-more")}针对片段追问</button>
      </footer>
    </article>`;
  if (!elements.detailDialog.open) elements.detailDialog.showModal();
  refreshIcons();
}

function renderEntry(entry) {
  const isExpanded = state.expanded.has(entry.id) || state.activeThreadId === entry.id;
  const usage = entry.usage?.length ? `<ul class="usage-list">${entry.usage.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>` : "";
  const chunks = entry.chunks?.length ? `<div class="chunk-row">${entry.chunks.map((chunk) => `<span class="chunk"><strong>${escapeHtml(chunk.text)}</strong>${escapeHtml(chunk.meaning)}</span>`).join("")}</div>` : "";
  const words = entry.kind === "word_list" ? renderWords(entry, "word-list-preview") : "";
  const threadToggle = entry.thread?.length ? `<button type="button" data-action="toggle-thread" data-id="${entry.id}">${icon("messages-square")}${entry.thread.length}</button>` : "";
  return `<article class="entry-card ${isExpanded ? "expanded" : ""} ${isDue(entry) ? "due" : ""}" data-entry-id="${entry.id}">
    <div class="entry-main">
      <div class="entry-head">
        <button class="expand-button" type="button" data-action="toggle-details" data-id="${entry.id}" aria-label="${isExpanded ? "收起详情" : "展开详情"}">${icon(isExpanded ? "chevron-down" : "chevron-right")}</button>
        <div class="entry-title-wrap">
          <button class="entry-title-button" type="button" data-action="open-detail" data-id="${entry.id}" title="查看完整卡片">
            <h2 class="entry-title">${escapeHtml(entry.displayText || entry.raw)}${entry.pronunciation ? `<span class="pronunciation">${escapeHtml(entry.pronunciation)}</span>` : ""}</h2>
          </button>
          ${entry.correction ? `<div class="correction">已按 ${escapeHtml(entry.correction)} 理解</div>` : ""}
        </div>
        <p class="entry-meaning">${escapeHtml(entry.meaning)}</p>
        <div class="row-source">${renderSourcePicker(entry)}</div>
        <span class="review-due ${isDue(entry) ? "is-due" : ""}">${dueLabel(entry)}</span>
        <div class="entry-tools">
          <button class="icon-button open-detail-button" type="button" data-action="open-detail" data-id="${entry.id}" aria-label="查看完整卡片">${icon("maximize-2")}</button>
          <button class="icon-button ${entry.starred ? "starred" : ""}" type="button" data-action="star" data-id="${entry.id}" aria-label="${entry.starred ? "取消收藏" : "收藏"}">${icon("star")}</button>
          <button class="icon-button" type="button" data-action="delete" data-id="${entry.id}" aria-label="删除片段">${icon("trash-2")}</button>
        </div>
      </div>
      <div class="entry-details">
        <div class="entry-details-inner">
          <p class="entry-context">${escapeHtml(entry.context)}</p>
          ${words}${usage}${chunks}
          <div class="entry-footer">
            <div class="entry-meta"><span>${formatTime(entry.createdAt)}</span><span>${reviewState(entry).repetitions ? `当前间隔 ${formatInterval(reviewState(entry).intervalDays)}` : "尚未完成首次复习"}</span></div>
            <div class="entry-actions">
              ${threadToggle}
              ${isDue(entry) ? `<button type="button" data-action="start-review" data-id="${entry.id}">${icon("brain")}现在复习</button>` : ""}
              <button class="continue-button" type="button" data-action="continue" data-id="${entry.id}">${icon("message-circle-more")}针对片段追问</button>
            </div>
          </div>
        </div>
      </div>
    </div>
    ${isExpanded ? renderThread(entry) : ""}
  </article>`;
}

function renderReview() {
  const entries = dueEntries();
  const entry = entries[0];
  if (!entry) {
    return `<div class="review-shell review-complete">${icon("circle-check-big")}<h2>今天已经复习完成</h2><p>新的片段会在适合的时间重新出现。</p><button type="button" class="secondary-button" data-view="all">返回词库</button></div>`;
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
        : `<button class="reveal-button" type="button" data-action="reveal-review">${icon("eye")}显示答案</button>`}
    </article>
  </div>`;
}

function renderTimeline() {
  if (state.view === "review") {
    elements.timeline.innerHTML = renderReview();
    refreshIcons();
    return;
  }
  const entries = filteredEntries();
  const visible = entries.slice(0, state.visibleLimit);
  let html = "";
  if (state.busy) html += `<div class="loading-line"></div>`;
  if (!entries.length) {
    html += `<div class="timeline-inner"><div class="empty-state"><div>${icon("search-x")}<h2>没有找到片段</h2><p>换一个筛选条件，或捕捉新的语言片段。</p></div></div></div>`;
  } else {
    html += `<div class="timeline-inner"><div class="list-columns"><span>片段与解释</span><span>来源</span><span>复习时间</span><span></span></div><div class="entry-list">${visible.map(renderEntry).join("")}</div>${entries.length > visible.length ? `<button class="load-more" type="button" data-action="load-more">再显示 ${Math.min(80, entries.length - visible.length)} 条</button>` : ""}</div>`;
  }
  elements.timeline.innerHTML = html;
  refreshIcons();
}

function renderNavigation() {
  document.querySelectorAll("[data-view]").forEach((button) => button.classList.toggle("active", button.dataset.view === state.view));
  document.querySelectorAll("[data-source-filter]").forEach((button) => button.classList.toggle("active", button.dataset.sourceFilter === state.sourceFilter));
  const reviewCount = dueEntries().length;
  const starCount = state.entries.filter((entry) => entry.starred).length;
  document.querySelector("#all-count").textContent = state.entries.length;
  document.querySelector("#review-count").textContent = reviewCount;
  document.querySelector("#star-count").textContent = starCount;
  const copy = {
    all: ["片段词库", state.sourceFilter ? `${state.sourceFilter} · ${filteredEntries().length} 条` : `${state.entries.length} 个散落在不同场景里的语言片段`],
    review: ["专注复习", "根据你的回忆质量安排下一次出现"],
    starred: ["收藏片段", `${starCount} 个主动保留的重点`],
  }[state.view];
  document.querySelector("#view-title").textContent = copy[0];
  document.querySelector("#view-subtitle").textContent = copy[1];
  document.querySelector("#settings-count").textContent = state.entries.length;
  const sources = [...new Set(state.entries.map((entry) => entry.source).filter(Boolean))];
  elements.sourceFilters.innerHTML = sources.length
    ? sources.map((source) => `<button type="button" data-source-filter="${escapeHtml(source)}" class="${state.sourceFilter === source ? "active" : ""}"><span class="source-dot"></span>${escapeHtml(source)}</button>`).join("")
    : `<span class="source-empty">还没有已标记来源</span>`;
  elements.composerShell.hidden = state.view === "review";
  elements.libraryHead.hidden = state.view === "review";
  elements.searchBox.hidden = state.view === "review";
  elements.bottomNav.hidden = state.view === "review";
  document.body.classList.toggle("review-mode", state.view === "review");
}

function renderComposer() {
  const entry = state.entries.find((item) => item.id === state.activeThreadId);
  if (!entry) state.activeThreadId = null;
  elements.contextBar.hidden = !entry;
  elements.contextTitle.textContent = entry ? `· ${entry.displayText || entry.raw}` : "";
  elements.input.placeholder = entry ? "继续追问这个片段…" : "贴入一个不懂的词、短语或句子…";
  elements.source.disabled = Boolean(entry);
  elements.send.disabled = state.busy || !state.storageReady;
}

function render() {
  renderNavigation();
  renderTimeline();
  renderComposer();
  refreshIcons();
}

function toast(message) {
  elements.toast.textContent = message;
  elements.toast.classList.add("visible");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => elements.toast.classList.remove("visible"), 2600);
}

function setBusy(value) {
  state.busy = value;
  render();
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
    baseUrl: elements.apiBaseUrl.value.trim(),
    model: elements.apiModel.value.trim(),
    allowNoKey: elements.allowNoKey.checked,
    ...(apiKey ? { apiKey } : {}),
  };
}

function showConfigMessage(message, isError = false) {
  elements.configMessage.textContent = message;
  elements.configMessage.classList.toggle("error", isError);
}

function applyAiStatus(config, fillForm = false) {
  state.ai = config;
  const live = config.mode === "live";
  const styleName = config.apiStyle === "compatible" ? "Compatible" : "Responses";
  elements.aiState.className = `ai-state ${live ? "live" : "demo"}`;
  elements.aiState.innerHTML = `<span></span>${live ? escapeHtml(config.model) : "演示模式"}`;
  elements.aiState.title = live ? `${config.providerName} · ${styleName} · ${config.model}` : "打开设置完成 AI 配置";
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
  elements.providerName.value = config.providerName === "新 Provider" ? "" : config.providerName || "";
  elements.deleteProvider.disabled = !config.providerId;
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
  await getAiStatus(true);
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
  elements.providerName.value = "";
  document.querySelector('input[name="api-style"][value="responses"]').checked = true;
  elements.apiBaseUrl.value = "https://api.openai.com/v1";
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

async function activateProvider() {
  const id = elements.providerSelect.value;
  if (!id) return newProvider();
  const result = await requestJson(`/api/config/${id}/activate`, { method: "POST" });
  applyAiStatus(result, true);
  toast(`已切换到 ${result.providerName}`);
}

async function deleteProvider() {
  const id = elements.providerSelect.value;
  const name = elements.providerSelect.selectedOptions[0]?.textContent || "这个 Provider";
  if (!id || !confirm(`删除“${name}”？本机保存的密钥也会一并删除。`)) return;
  const result = await requestJson(`/api/config/${id}`, { method: "DELETE" });
  applyAiStatus(result, true);
  toast("Provider 已删除");
}

function syncAppearanceControls() {
  const radio = document.querySelector(`input[name="theme"][value="${appearance.theme}"]`);
  if (radio) radio.checked = true;
  elements.fontScale.value = appearance.fontScale;
  elements.fontScaleValue.value = `${appearance.fontScale}%`;
}

async function submitFragment(event) {
  event.preventDefault();
  const text = elements.input.value.trim();
  if (!text || state.busy || !state.storageReady) return;
  const active = state.entries.find((entry) => entry.id === state.activeThreadId);

  setBusy(true);
  try {
    const result = await requestJson(active ? `/api/entries/${active.id}/followups` : "/api/entries", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(active ? { text } : { text, source: elements.source.value }),
    });
    if (active) {
      state.entries[state.entries.findIndex((entry) => entry.id === active.id)] = result.entry;
      state.expanded.add(active.id);
    } else {
      state.entries.unshift(result.entry);
      state.view = "all";
      state.sourceFilter = "";
    }
    elements.input.value = "";
    elements.input.style.height = "auto";
    toast(result.demo ? "已保存；当前为演示解释" : "已保存为独立片段");
  } catch (error) {
    toast(error.message || "解释失败");
  } finally {
    setBusy(false);
    elements.input.focus();
  }
}

function newFragment() {
  state.activeThreadId = null;
  state.view = "all";
  elements.input.value = "";
  render();
  elements.input.focus();
}

async function handleAction(action, id, grade) {
  const entry = state.entries.find((item) => item.id === id);
  if (action === "new-fragment") return newFragment();
  if (action === "settings") return openSettings();
  if (action === "close-settings") return elements.dialog.close();
  if (action === "open-detail" && entry) return openEntryDetail(entry);
  if (action === "close-detail") return elements.detailDialog.close();
  if (action === "new-provider") return newProvider();
  if (action === "delete-provider") return deleteProvider();
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
  if (action === "load-more") { state.visibleLimit += 80; return renderTimeline(); }
  if (action === "reveal-review") { state.reviewReveal = true; return renderTimeline(); }
  if (action === "start-review" && entry) {
    if (elements.detailDialog.open) elements.detailDialog.close();
    state.view = "review";
    state.reviewFocusId = entry.id;
    state.reviewSessionTotal = dueEntries().length;
    state.reviewReveal = false;
    return render();
  }
  if (action === "grade-review" && entry) {
    const result = await requestJson(`/api/entries/${entry.id}/review`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ grade }),
    });
    state.entries[state.entries.indexOf(entry)] = result.entry;
    state.reviewReveal = false;
    state.reviewFocusId = null;
    toast(`已安排在 ${formatInterval(reviewState(result.entry).intervalDays)}后复习`);
    return render();
  }
  if (action === "continue" && entry) {
    if (elements.detailDialog.open) elements.detailDialog.close();
    state.activeThreadId = entry.id;
    state.expanded.add(entry.id);
    render(); elements.input.focus(); return;
  }
  if ((action === "toggle-thread" || action === "toggle-details") && entry) {
    state.expanded.has(entry.id) ? state.expanded.delete(entry.id) : state.expanded.add(entry.id);
    return renderTimeline();
  }
  if (action === "star" && entry) {
    const result = await requestJson(`/api/entries/${entry.id}`, {
      method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ starred: !entry.starred }),
    });
    state.entries[state.entries.indexOf(entry)] = result.entry;
  }
  if (action === "delete" && entry && confirm(`删除“${entry.displayText || entry.raw}”？`)) {
    await requestJson(`/api/entries/${entry.id}`, { method: "DELETE" });
    state.entries = state.entries.filter((item) => item.id !== entry.id);
    if (state.activeThreadId === entry.id) state.activeThreadId = null;
  }
  if (action === "export") {
    const blob = new Blob([JSON.stringify({ exportedAt: new Date().toISOString(), entries: state.entries }, null, 2)], { type: "application/json" });
    const link = Object.assign(document.createElement("a"), { href: URL.createObjectURL(blob), download: `拾词-${new Date().toISOString().slice(0, 10)}.json` });
    link.click(); URL.revokeObjectURL(link.href); toast("已导出 JSON"); return;
  }
  if (action === "reset" && confirm("恢复演示数据会替换本机片段库里的所有内容，继续吗？")) {
    const result = await requestJson("/api/entries", {
      method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ entries: seedEntries }),
    });
    state.entries = result.entries; state.activeThreadId = null; state.expanded.clear(); state.view = "all"; state.sourceFilter = ""; elements.dialog.close();
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

document.addEventListener("click", (event) => {
  const actionTarget = event.target.closest("[data-action]");
  if (actionTarget) {
    handleAction(actionTarget.dataset.action, actionTarget.dataset.id, actionTarget.dataset.grade).catch((error) => toast(error.message || "操作失败"));
    return;
  }
  const viewTarget = event.target.closest("[data-view]");
  if (viewTarget) {
    state.view = viewTarget.dataset.view;
    state.sourceFilter = "";
    state.visibleLimit = 80;
    state.reviewReveal = false;
    state.reviewFocusId = null;
    state.reviewSessionTotal = state.view === "review" ? dueEntries().length : 0;
    render(); return;
  }
  const sourceTarget = event.target.closest("[data-source-filter]");
  if (sourceTarget) { state.view = "all"; state.visibleLimit = 80; state.sourceFilter = state.sourceFilter === sourceTarget.dataset.sourceFilter ? "" : sourceTarget.dataset.sourceFilter; render(); }
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

elements.composer.addEventListener("submit", submitFragment);
elements.configForm.addEventListener("submit", saveAiConfig);
elements.refreshModels.addEventListener("click", refreshModelList);
elements.providerSelect.addEventListener("change", () => activateProvider().catch((error) => toast(error.message || "切换失败")));
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
elements.allowNoKey.addEventListener("change", () => {
  elements.apiKey.disabled = elements.allowNoKey.checked;
  if (elements.allowNoKey.checked) elements.apiKey.value = "";
});
elements.input.addEventListener("keydown", (event) => {
  if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); elements.composer.requestSubmit(); }
});
elements.input.addEventListener("input", () => {
  elements.input.style.height = "auto";
  elements.input.style.height = `${Math.min(elements.input.scrollHeight, 150)}px`;
});
elements.search.addEventListener("input", () => {
  state.query = elements.search.value;
  state.visibleLimit = 80;
  elements.searchBox.classList.toggle("has-value", Boolean(state.query));
  renderTimeline();
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
elements.detailDialog.addEventListener("click", (event) => {
  if (event.target === elements.detailDialog) elements.detailDialog.close();
});

render();
getAiStatus();
load().catch((error) => toast(error.message || "无法读取本地数据")).finally(() => {
  state.busy = false;
  render();
});
if (!window.__TAURI__ && "serviceWorker" in navigator) navigator.serviceWorker.register("/service-worker.js?v=8").catch(() => {});
