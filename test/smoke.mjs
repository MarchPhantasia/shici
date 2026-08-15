import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

function listen(server, port = 0) {
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server.address().port)));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

async function json(url, options = {}) {
  const response = await fetch(url, options);
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
    const result = input.text.includes(",")
      ? { type: "entry", kind: "word_list", displayText: input.text, correction: "", pronunciation: "", meaning: "两个独立单词", context: "词表", words: [{ text: "alpha", pronunciation: "/ˈælfə/", meaning: "阿尔法" }, { text: "beta", pronunciation: "/ˈbiːtə/", meaning: "贝塔" }], usage: [], chunks: [], memoryCue: "" }
      : { type: "entry", kind: "word", displayText: "test", correction: "", pronunciation: "/test/", meaning: "响应成功", context: "Responses", words: [{ text: "test", pronunciation: "/test/", meaning: "测试" }], usage: [], chunks: [], memoryCue: "" };
    return response.end(JSON.stringify({ output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(result) }] }] }));
  }
  if (request.url === "/v1/chat/completions") {
    return response.end(JSON.stringify({ choices: [{ message: { content: JSON.stringify({ type: "followup", answer: "兼容接口成功", summary: "已验证" }) } }] }));
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: { message: "not found" } }));
});

const mockPort = await listen(mock);
const probe = createServer();
const appPort = await listen(probe);
await close(probe);
const temp = await mkdtemp(join(tmpdir(), "shici-test-"));
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
const headers = { "Content-Type": "application/json" };

try {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try { await json(`${app}/api/config`); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }

  const migratedConfig = await json(`${app}/api/config`);
  assert.equal(migratedConfig.providerId, "default");
  assert.equal(migratedConfig.providers.length, 1);

  const responsesConfig = await json(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ providerId: "default", name: "Responses Test", apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}`, model: "alpha-model", allowNoKey: false }),
  });
  assert.equal(responsesConfig.baseUrl, `http://127.0.0.1:${mockPort}/v1`);
  assert.equal(responsesConfig.hasApiKey, true);
  assert.equal("apiKey" in responsesConfig, false);
  assert.deepEqual((await json(`${app}/api/entries`)).entries, []);

  const models = await json(`${app}/api/models`, {
    method: "POST", headers,
    body: JSON.stringify({ apiStyle: "responses", baseUrl: `http://127.0.0.1:${mockPort}` }),
  });
  assert.deepEqual(models.models, ["alpha-model", "beta-model"]);

  const created = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "test", source: "游戏" }),
  });
  assert.equal(created.entry.meaning, "响应成功");
  assert.equal(created.entry.kind, "word");
  assert.equal(created.entry.pronunciation, "/test/");
  assert.equal(created.entry.words[0].pronunciation, "/test/");
  assert.equal(created.entry.source, "游戏");
  assert.equal(created.entry.review.repetitions, 0);
  assert.equal(created.entry.review.dueAt > created.entry.createdAt, true);

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

  const wordList = await json(`${app}/api/entries`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "alpha, beta", source: "阅读" }),
  });
  assert.equal(wordList.entry.kind, "word_list");
  assert.deepEqual(wordList.entry.words.map((word) => word.pronunciation), ["/ˈælfə/", "/ˈbiːtə/"]);

  const compatibleConfig = await json(`${app}/api/config`, {
    method: "PUT", headers,
    body: JSON.stringify({ name: "Compatible Test", apiStyle: "compatible", baseUrl: `http://127.0.0.1:${mockPort}/v1`, apiKey: "second-secret", model: "beta-model", allowNoKey: false }),
  });
  assert.equal(compatibleConfig.apiStyle, "compatible");
  assert.equal(compatibleConfig.hasApiKey, true);
  assert.equal(compatibleConfig.providers.length, 2);

  const followup = await json(`${app}/api/entries/${created.entry.id}/followups`, {
    method: "POST", headers,
    body: JSON.stringify({ text: "why" }),
  });
  assert.equal(followup.entry.thread[0].answer, "兼容接口成功");

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
  assert.equal(stored.version, 1);
  assert.equal(stored.entries.some((entry) => entry.kind === "word_list" && entry.words.length === 2), true);
  assert.equal(stored.entries.find((entry) => entry.raw === "test").thread.length, 1);
  assert.equal(stored.entries.find((entry) => entry.raw === "test").review.lastGrade, "good");
  assert.equal(storedSettings.providers.length, 2);
  assert.equal(storedSettings.providers.every((provider) => Object.hasOwn(provider, "apiKey")), true);
  console.log("smoke ok: providers, models, AI modes, word IPA, source editing, spaced review, atomic local data");
} finally {
  child.kill("SIGTERM");
  await close(mock);
  await rm(temp, { recursive: true, force: true });
}
