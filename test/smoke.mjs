import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDataRoot } from "../scripts/data-root.mjs";

assert.equal(resolveDataRoot({ platform: "darwin", home: "/tmp/home", env: {} }), "/tmp/home/Library/Application Support/com.pha.shici");
assert.equal(resolveDataRoot({ platform: "linux", home: "/tmp/home", env: { XDG_DATA_HOME: "/tmp/data" } }), "/tmp/data/com.pha.shici");

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function json(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { "X-Shici": "1", ...(options.headers || {}) } });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error || `HTTP ${response.status}`);
  return body;
}

const calls = [];
const mock = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {};
  calls.push({ path: request.url, authorization: request.headers.authorization || "", body });
  response.setHeader("Content-Type", "application/json");

  if (request.url === "/v1/models") {
    return response.end(JSON.stringify({ object: "list", data: [{ id: "alpha-model" }, { id: "beta-model" }] }));
  }
  if (request.url === "/v1/responses") {
    const input = JSON.parse(body.input);
    if (input.text === "slow") await new Promise((resolve) => setTimeout(resolve, 300));
    if (input.text === "incomplete") return response.end(JSON.stringify({ status: "incomplete", incomplete_details: { reason: "max_output_tokens" } }));
    if (input.text.startsWith("capability-") && body.reasoning) {
      response.statusCode = 400;
      return response.end(JSON.stringify({ error: { message: "reasoning unsupported" } }));
    }
    const result = input.text.includes("foodsteps")
      ? { type: "entry", kind: "sentence", displayText: "Her footsteps hurried as she all but fled the room.", correction: "foodsteps → footsteps", pronunciation: "", meaning: "她脚步匆匆，几乎是逃出了房间。", context: "纠错句", words: [], usage: [], chunks: [], memoryCue: "纠正 footsteps 后理解。" }
      : input.text === "gamma, deltta"
        ? { type: "entry", kind: "word_list", displayText: input.text, correction: "deltta → delta", pronunciation: "", meaning: "两个独立单词", context: "词表", words: [{ text: "gamma", pronunciation: "/ˈɡæmə/", meaning: "伽马" }, { text: "delta", pronunciation: "/ˈdeltə/", meaning: "德尔塔" }], usage: [], chunks: [], memoryCue: "" }
      : input.text === "omega, omega"
          ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "重复单词", context: "词表", words: [{ text: "omega", pronunciation: "/ˈoʊmɪɡə/", meaning: "欧米伽" }, { text: "omega", pronunciation: "/ˈoʊmɪɡə/", meaning: "欧米伽" }], usage: [], chunks: [], memoryCue: "" }
      : input.text === "alpha, xyzzy, banana"
        ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "缺少一个模型不认识的词", context: "词表", words: [{ text: "alpha", pronunciation: "/ˈælfə/", meaning: "阿尔法" }, { text: "banana", pronunciation: "/bəˈnænə/", meaning: "香蕉" }], usage: [], chunks: [], memoryCue: "" }
        : input.text === "running, jumped"
          ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "词形还原", context: "词表", words: [{ text: "run", original: "running", correction: "", pronunciation: "/rʌn/", meaning: "跑" }, { text: "jump", original: "jumped", correction: "", pronunciation: "/dʒʌmp/", meaning: "跳" }], usage: [], chunks: [], memoryCue: "" }
          : input.text === "cherry, apple, banana"
            ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "乱序词表", context: "词表", words: [{ text: "apple", pronunciation: "/ˈæpəl/", meaning: "苹果" }, { text: "banana", pronunciation: "/bəˈnænə/", meaning: "香蕉" }, { text: "cherry", pronunciation: "/ˈtʃeri/", meaning: "樱桃" }], usage: [], chunks: [], memoryCue: "" }
      : input.text === "epsilon, zetta"
              ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "拼写纠错", context: "词表", words: [{ text: "epsilon", original: "epsilon", correction: "", pronunciation: "/ˈepsɪlɒn/", meaning: "艾普西隆" }, { text: "zeta", original: "zetta", correction: "zetta → zeta", pronunciation: "/ˈziːtə/", meaning: "泽塔" }], usage: [], chunks: [], memoryCue: "" }
      : input.text === "iPhone"
        ? { type: "entry", kind: "word", displayText: "iPhone", correction: "", pronunciation: "/ˈaɪfoʊn/", meaning: "苹果手机", context: "品牌名", words: [{ text: "iPhone", pronunciation: "/ˈaɪfoʊn/", meaning: "苹果手机" }], usage: [], chunks: [], memoryCue: "" }
      : input.kindHint === "word_list" || input.text.includes(",")
        ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "两个独立单词", context: "词表", words: [{ text: "alpha", pronunciation: "/ˈælfə/", meaning: "阿尔法", context: "希腊字母表的第一个字母。", usage: ["Alpha is the first letter. Alpha 是第一个字母。"], difficulty: 1.8 }, { text: "beta", pronunciation: "/ˈbiːtə/", meaning: "贝塔", context: "希腊字母表的第二个字母。", usage: ["The app is still in beta. 这个应用仍处于测试阶段。"], difficulty: 2.2 }], usage: [], chunks: [], memoryCue: "" }
        : input.kindHint === "phrase" || input.kindHint === "sentence"
          ? { type: "entry", kind: input.kindHint, displayText: input.text, correction: "", pronunciation: "", meaning: "保持原片段含义", context: "短语或句子", words: [], usage: [], chunks: [], memoryCue: "" }
        : { type: "entry", kind: "word", displayText: input.text, correction: "", pronunciation: "/test/", meaning: "响应成功", context: "Responses", words: [{ text: input.text, pronunciation: "/test/", meaning: "测试" }], usage: [], chunks: [], memoryCue: "" };
    const fence = String.fromCharCode(96).repeat(3);
    const outputText = input.text === "delete-me"
      ? `<think>先确认这是一个可删除的测试词条</think>\n${fence}json\n${JSON.stringify(result)}\n${fence}`
      : JSON.stringify(result);
    return response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: outputText }] }] }));
  }
  if (request.url === "/v1/chat/completions") {
    const input = JSON.parse(body.messages.at(-1).content);
    return response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "followup", answer: `回答：${input.text}`, summary: `摘要：${input.text}` }) } }] }));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: "not found" } }));
});

const mockPort = await listen(mock);
const probe = createServer();
const appPort = await listen(probe);
await close(probe);
const temp = await mkdtemp(join(tmpdir(), "shici-test-"));
const fragmentCases = JSON.parse(await readFile(new URL("./fixtures/fragment-cases.json", import.meta.url), "utf8"));
const settingsPath = join(temp, "settings.json");
const dataPath = join(temp, "library.json");
await writeFile(settingsPath, JSON.stringify({ apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}`, apiKey: "test-secret", model: "alpha-model", allowNoKey: false }));
const child = spawn(process.execPath, ["server.mjs"], {
  cwd: new URL("..", import.meta.url),
  env: {
    ...process.env,
    PORT: String(appPort),
    AI_SETTINGS_PATH: settingsPath,
    SHICI_DATA_PATH: dataPath,
    AI_API_KEY: "",
    OPENAI_API_KEY: "",
    AI_MODEL: "",
    OPENAI_MODEL: "",
  },
  stdio: "ignore",
});

const app = `http://127.0.0.1:${appPort}`;
const headers = { "Content-Type": "application/json", "X-Shici": "1" };

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await json(`${app}/api/config`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }

  const migratedConfig = await json(`${app}/api/config`);
  assert.equal(migratedConfig.providerId, "default");
  assert.equal(migratedConfig.providers.length, 1);
  const homepage = await fetch(app);
  assert.equal(homepage.status, 200);
  assert.match(await homepage.text(), /拾词/);

  const invalidBase = await fetch(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ providerId: "default", baseUrl: "not-a-url", model: "alpha-model", apiKey: "test-secret" }),
  });
  assert.equal(invalidBase.status, 400);
  assert.match((await invalidBase.json()).error, /Base URL/);

  const missingHeader = await fetch(`${app}/api/config`, { headers: { Origin: app } });
  assert.equal(missingHeader.status, 403);
  const blocked = await fetch(`${app}/api/config`, { headers: { Origin: "http://attacker.test", "X-Shici": "1" } });
  assert.equal(blocked.status, 403);

  const responsesConfig = await json(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ providerId: "default", name: "Responses Test", apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}`, model: "alpha-model", reasoningEffort: "low", allowNoKey: false }),
  });
  assert.equal(responsesConfig.baseUrl, `http://127.0.0.1:${mockPort}/v1`);
  assert.equal(responsesConfig.reasoningEffort, "low");
  assert.equal(responsesConfig.hasApiKey, true);
  assert.equal("apiKey" in responsesConfig, false);
  assert.deepEqual((await json(`${app}/api/entries`)).entries, []);

  const migratedLegacy = await json(`${app}/api/entries`, {
    method: "PUT", headers,
    body: JSON.stringify({ entries: [{
      raw: "her foodsteps hurried as she all but fled the room",
      displayText: "her foodsteps hurried as she all but fled the room",
      correction: "her footsteps hurried as she all but fled the room",
      pronunciation: "old sentence pronunciation",
      kind: "sentence",
      meaning: "旧记录",
    }] }),
  });
  assert.equal(migratedLegacy.entries[0].displayText, "her footsteps hurried as she all but fled the room");
  assert.equal(migratedLegacy.entries[0].correction, "foodsteps → footsteps");
  assert.equal(migratedLegacy.entries[0].pronunciation, "");
  const imported = await json(app + "/api/entries/import", {
    method: "POST", headers,
    body: JSON.stringify({ entries: [
      { raw: "harbor", displayText: "Harbor", kind: "word", pronunciation: "/ˈhɑːrbər/", meaning: "港口", context: "新导入的测试词", words: [{ text: "Harbor", pronunciation: "/ˈhɑːrbər/", meaning: "港口" }] },
      { raw: "her foodsteps hurried as she all but fled the room", displayText: "her footsteps hurried as she all but fled the room", kind: "sentence", meaning: "重复项" },
      { meaning: "缺少原文" },
    ] }),
  });
  assert.equal(imported.importedCount, 1);
  assert.equal(imported.skippedCount, 1);
  assert.equal(imported.invalidCount, 1);
  assert.equal(imported.entries.some((entry) => entry.raw === "harbor"), true);
  assert.equal(imported.entries.some((entry) => entry.raw === "her foodsteps hurried as she all but fled the room"), true);

  const models = await json(`${app}/api/models`, {
    method: "POST", headers,
    body: JSON.stringify({ apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}` }),
  });
  assert.deepEqual(models.models, ["alpha-model", "beta-model"]);

  for (const fragmentCase of fragmentCases) {
    await json(`${app}/api/entries`, {
      method: "POST", headers,
      body: JSON.stringify({ text: fragmentCase.text, source: "" }),
    });
    const payload = JSON.parse(calls.at(-1).body.input);
    assert.equal(payload.kindHint, fragmentCase.kind);
  }

  const leaked = await fetch(`${app}/api/models`, {
    method: "POST", headers,
    body: JSON.stringify({ apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort + 1}` }),
  });
  assert.equal(leaked.status, 400);

  const createdResponse = await fetch(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "test", source: "游戏" }),
  });
  const created = await createdResponse.json();
  assert.equal(createdResponse.status, 200);
  assert.equal(created.entry.meaning, "响应成功");
  assert.equal(created.entry.kind, "word");
  assert.equal(created.entry.displayText, "Test");
  assert.equal(created.entry.words[0].text, "Test");
  assert.equal(created.entry.pronunciation, "/test/");
  assert.equal(created.entry.words[0].pronunciation, "/test/");
  assert.equal(created.entry.source, "游戏");
  assert.equal(created.entry.review.repetitions, 0);
  assert.equal(created.entry.review.dueAt > created.entry.createdAt, true);
  assert.equal(calls.findLast((call) => call.path === "/v1/responses").body.stream, undefined);
  assert.equal(calls.findLast((call) => call.path === "/v1/responses").body.max_output_tokens, 4000);
  assert.equal(calls.findLast((call) => call.path === "/v1/responses").body.reasoning.effort, "low");

  const intentionalCasing = await json(app + "/api/entries", {
    method: "POST", headers,
    body: JSON.stringify({ text: "iPhone", source: "阅读" }),
  });
  assert.equal(intentionalCasing.entry.displayText, "iPhone");
  assert.equal(intentionalCasing.entry.correction, "");
  assert.equal(intentionalCasing.entry.words[0].text, "iPhone");

  const incomplete = await fetch(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "incomplete", source: "" }),
  });
  assert.equal(incomplete.status, 502);
  assert.match((await incomplete.json()).error, /输出被推理过程耗尽/);

  const disposable = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "delete-me", source: "" }),
  });
  const deleted = await json(`${app}/api/entries/${disposable.entry.id}`, { method: "DELETE" });
  assert.equal(deleted.deleted, true);
  assert.equal((await json(`${app}/api/entries`)).entries.some((entry) => entry.id === disposable.entry.id), false);

  const duplicate = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "test", source: "游戏" }),
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(duplicate.entry.id, created.entry.id);
  assert.deepEqual(duplicate.entries.map((entry) => entry.id), [created.entry.id]);

  const forced = await fetch(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "test", source: "游戏", forceNew: true }),
  });
  assert.equal(forced.status, 200);
  const forcedBody = await forced.json();
  assert.equal(forcedBody.duplicate, undefined);
  assert.notEqual(forcedBody.entry.id, created.entry.id);

  const updated = await json(`${app}/api/entries/${created.entry.id}`, {
    method: "PATCH", headers,
    body: JSON.stringify({ source: "阅读", starred: true }),
  });
  assert.equal(updated.entry.source, "阅读");
  assert.equal(updated.entry.starred, true);

  const reviewed = await json(`${app}/api/entries/${created.entry.id}/review`, {
    method: "POST", headers,
    body: JSON.stringify({ grade: "good" }),
  });
  assert.equal(reviewed.entry.review.lastGrade, "good");
  assert.equal(reviewed.entry.review.repetitions, 1);
  assert.equal(reviewed.entry.review.intervalDays, 1);
  assert.equal(reviewed.entry.difficulty < created.entry.difficulty, true);

  const wordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "alpha, beta", source: "阅读" }),
  });
  assert.equal(wordList.split, true);
  assert.equal(wordList.entries.length, 2);
  assert.deepEqual(wordList.entries.map((entry) => entry.kind), ["word", "word"]);
  assert.deepEqual(wordList.entries.map((entry) => entry.raw), ["alpha", "beta"]);
  assert.deepEqual(wordList.entries.map((entry) => entry.displayText), ["Alpha", "Beta"]);
  assert.deepEqual(wordList.entries.map((entry) => entry.words[0].pronunciation), ["/ˈælfə/", "/ˈbiːtə/"]);
  assert.deepEqual(wordList.entries.map((entry) => entry.context), ["希腊字母表的第一个字母。", "希腊字母表的第二个字母。"]);
  assert.deepEqual(wordList.entries.map((entry) => entry.usage.length), [1, 1]);
  assert.deepEqual(wordList.entries.map((entry) => entry.difficulty), [1.8, 2.2]);

  const repeatedWordListBefore = calls.length;
  const repeatedWordListHit = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "alpha, beta", source: "阅读" }),
  });
  assert.equal(calls.length, repeatedWordListBefore);
  assert.equal(repeatedWordListHit.createdCount, 0);
  assert.equal(repeatedWordListHit.reusedCount, 2);

  const missingWord = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "alpha, xyzzy, banana", source: "阅读" }),
  });
  assert.deepEqual(missingWord.entries.map((entry) => [entry.raw, entry.displayText]), [["alpha", "Alpha"], ["banana", "Banana"]]);

  const lemmatizedWordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "running, jumped", source: "阅读" }),
  });
  assert.deepEqual(lemmatizedWordList.entries.map((entry) => [entry.raw, entry.displayText, entry.correction]), [["running", "Run", ""], ["jumped", "Jump", ""]]);

  const reorderedWordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "cherry, apple, banana", source: "阅读" }),
  });
  assert.deepEqual(reorderedWordList.entries.map((entry) => [entry.raw, entry.displayText]), [["apple", "Apple"], ["banana", "Banana"], ["cherry", "Cherry"]]);

  const explicitlyCorrectedWordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "epsilon, zetta", source: "阅读" }),
  });
  assert.deepEqual(explicitlyCorrectedWordList.entries.map((entry) => [entry.raw, entry.displayText, entry.correction]), [["epsilon", "Epsilon", ""], ["zetta", "Zeta", "zetta → zeta"]]);

  const correctedWordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "gamma, deltta", source: "阅读" }),
  });
  assert.deepEqual(correctedWordList.entries.map((entry) => entry.raw), ["gamma", "deltta"]);
  assert.deepEqual(correctedWordList.entries.map((entry) => entry.displayText), ["Gamma", "Delta"]);
  assert.equal(correctedWordList.entries[1].correction, "deltta → delta");
  assert.deepEqual(correctedWordList.entries.map((entry) => entry.context), ["词表", "词表"]);

  const repeatedWordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "omega, omega", source: "阅读" }),
  });
  assert.equal(repeatedWordList.split, true);
  assert.equal(repeatedWordList.createdCount, 1);
  assert.equal(repeatedWordList.reusedCount, 1);
  assert.equal(repeatedWordList.duplicate, true);
  assert.equal((await json(`${app}/api/entries`)).entries.filter((entry) => entry.raw === "omega").length, 1);

  const capabilityFirst = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "capability-first", source: "阅读" }),
  });
  assert.equal(capabilityFirst.entry.kind, "word");
  const capabilityCalls = calls.filter((call) => call.path === "/v1/responses" && JSON.parse(call.body.input).text === "capability-first");
  assert.equal(capabilityCalls.length, 2);
  assert.equal(capabilityCalls[0].body.reasoning.effort, "low");
  assert.equal(capabilityCalls[1].body.reasoning, undefined);

  await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "capability-second", source: "阅读" }),
  });
  const cachedCapabilityCalls = calls.filter((call) => call.path === "/v1/responses" && JSON.parse(call.body.input).text === "capability-second");
  assert.equal(cachedCapabilityCalls.length, 1);
  assert.equal(cachedCapabilityCalls[0].body.reasoning, undefined);

  const phrase = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "keep it close", source: "阅读" }),
  });
  assert.equal(phrase.entries.length, 1);
  assert.equal(phrase.entry.kind, "phrase");

  const corrected = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "her foodsteps hurried as she all but fled the room", source: "阅读" }),
  });
  assert.equal(corrected.duplicate, true);
  assert.equal(corrected.entry.raw, "her foodsteps hurried as she all but fled the room");
  assert.equal(corrected.entry.displayText, "her footsteps hurried as she all but fled the room");
  assert.equal(corrected.entry.correction, "foodsteps → footsteps");
  assert.equal(corrected.entry.kind, "sentence");

  const cancellation = new AbortController();
  const stopped = fetch(`${app}/api/entries`, {
    method: "POST", headers, signal: cancellation.signal,
    body: JSON.stringify({ text: "slow", source: "" }),
  });
  setTimeout(() => cancellation.abort(), 30);
  await assert.rejects(stopped, (error) => error.name === "AbortError");
  await new Promise((resolve) => setTimeout(resolve, 350));
  assert.equal((await json(`${app}/api/entries`)).entries.some((entry) => entry.raw === "slow"), false);

  const compatibleConfig = await json(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Compatible Test", apiStyle: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "second-secret", model: "beta-model", reasoningEffort: "none", enableThinkingToggle: true, allowNoKey: false }),
  });
  assert.equal(compatibleConfig.apiStyle, "compatible");
  assert.equal(compatibleConfig.reasoningEffort, "none");
  assert.equal(compatibleConfig.hasApiKey, true);
  assert.equal(compatibleConfig.providers.length, 2);

  const followup = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "why" }),
  });
  assert.equal(followup.entry.thread[0].answer, "回答：why");
  const compatibleCall = calls.findLast((call) => call.path === "/v1/chat/completions");
  assert.equal(compatibleCall.body.reasoning_effort, "none");
  assert.equal(compatibleCall.body.chat_template_kwargs.enable_thinking, false);
  assert.equal(compatibleCall.body.max_tokens, 4000);
  assert.equal(compatibleCall.body.stream, undefined);
  const secondFollowup = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "again" }),
  });
  assert.equal(secondFollowup.entry.thread.length, 2);
  const rewound = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "PATCH", headers,
    body: JSON.stringify({ turnId: followup.entry.thread[0].id }),
  });
  assert.equal(rewound.entry.thread.length, 1);
  assert.equal(rewound.entry.conclusion, "摘要：why");
  const resetThread = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "PATCH", headers,
    body: JSON.stringify({ turnId: "" }),
  });
  assert.equal(resetThread.entry.thread.length, 0);
  assert.equal(resetThread.entry.conclusion, "响应成功");
  const keptFollowup = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "kept" }),
  });
  assert.equal(keptFollowup.entry.thread.length, 1);

  const activated = await json(`${app}/api/config/default/activate`, { method: "POST" });
  assert.equal(activated.providerId, "default");
  const afterDelete = await json(`${app}/api/config/default`, { method: "DELETE" });
  assert.equal(afterDelete.providers.length, 1);
  assert.equal(afterDelete.providerName, "Compatible Test");

  const noKeyConfig = await json(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Local Test", apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}`, model: "manual-model", allowNoKey: true }),
  });
  assert.equal(noKeyConfig.configured, true);
  assert.equal(noKeyConfig.hasApiKey, false);
  assert.equal(calls.some((call) => call.path === "/v1/responses"), true);
  assert.equal(calls.some((call) => call.path === "/v1/chat/completions"), true);
  assert.equal(calls.find((call) => call.path === "/v1/models").authorization, "Bearer test-secret");
  const stored = JSON.parse(await readFile(dataPath, "utf8"));
  const storedSettings = JSON.parse(await readFile(settingsPath, "utf8"));
  assert.equal(stored.version, 2);
  assert.equal(stored.entries.some((entry) => entry.raw === "alpha" && entry.kind === "word"), true);
  assert.equal(stored.entries.some((entry) => entry.raw === "beta" && entry.kind === "word"), true);
  assert.equal(stored.entries.find((entry) => entry.id === created.entry.id).thread.length, 1);
  assert.equal(stored.entries.find((entry) => entry.raw.includes("foodsteps")).displayText.includes("footsteps"), true);
  assert.equal(stored.entries.find((entry) => entry.id === created.entry.id).review.lastGrade, "good");
  assert.equal(storedSettings.providers.length, 2);
  assert.equal(storedSettings.providers.every((provider) => Object.hasOwn(provider, "apiKey")), true);
  console.log("smoke ok: cancellation, correction, rewind, providers, word IPA, review, atomic local data");
} finally {
  child.kill("SIGTERM");
  await close(mock);
  await rm(temp, { recursive: true, force: true });
}
