use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tokio::sync::Mutex;
use url::Url;
use uuid::Uuid;

const DAY_MS: f64 = 86_400_000.0;
const SYSTEM_PROMPT: &str = r#"You explain short language fragments for a Chinese-speaking learner.
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
Never refer to fragments outside the payload."#;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    body: Value,
}

fn default_method() -> String {
    "GET".into()
}

#[derive(Serialize)]
struct ApiResponse {
    status: u16,
    body: Value,
}

#[derive(Clone)]
struct AiConfig {
    provider_id: String,
    provider_name: String,
    api_style: String,
    base_url: String,
    api_key: String,
    model: String,
    allow_no_key: bool,
}

impl AiConfig {
    fn configured(&self) -> bool {
        !self.base_url.is_empty()
            && !self.model.is_empty()
            && (!self.api_key.is_empty() || self.allow_no_key)
    }
}

struct Backend {
    settings_path: PathBuf,
    library_path: PathBuf,
    saved_config: Value,
    library: Value,
    client: reqwest::Client,
}

struct AppState(Mutex<Backend>);

fn now_ms() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1_000.0
}

fn text(value: Option<&Value>, limit: usize) -> String {
    value
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .chars()
        .take(limit)
        .collect()
}

fn number(value: Option<&Value>, fallback: f64) -> f64 {
    value
        .and_then(Value::as_f64)
        .filter(|value| value.is_finite())
        .unwrap_or(fallback)
}

fn integer(value: Option<&Value>, fallback: u64) -> u64 {
    value.and_then(Value::as_u64).unwrap_or(fallback)
}

fn boolean(value: Option<&Value>, fallback: bool) -> bool {
    value.and_then(Value::as_bool).unwrap_or(fallback)
}

fn valid_id(value: Option<&Value>) -> String {
    let value = text(value, 80);
    if !value.is_empty()
        && value
            .chars()
            .all(|char| char.is_ascii_alphanumeric() || matches!(char, '-' | '_'))
    {
        value
    } else {
        Uuid::new_v4().to_string()
    }
}

fn word_parts(raw: &str) -> Vec<String> {
    raw.split(['\n', ',', '，', ';', '；'])
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect()
}

fn is_word_token(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(char::is_alphabetic)
        && chars.all(|char| char.is_alphabetic() || matches!(char, '\'' | '’' | '-'))
}

fn infer_kind(raw: &str, supplied: &str) -> String {
    if ["word", "word_list", "phrase", "sentence", "other"].contains(&supplied) {
        return supplied.into();
    }
    let parts = word_parts(raw);
    if parts.len() > 1 && parts.iter().all(|part| is_word_token(part)) {
        return "word_list".into();
    }
    if is_word_token(raw.trim()) {
        return "word".into();
    }
    if raw
        .chars()
        .any(|char| matches!(char, '.' | '!' | '?' | '。' | '！' | '？'))
        || raw.split_whitespace().count() > 7
    {
        return "sentence".into();
    }
    if raw.split_whitespace().count() > 1 {
        "phrase".into()
    } else {
        "other".into()
    }
}

fn clean_review(value: Option<&Value>, created_at: f64, status: &str) -> Value {
    let review = value.and_then(Value::as_object);
    let default_due = if status == "learned" {
        created_at + 3.0 * DAY_MS
    } else {
        created_at
    };
    let grade = text(review.and_then(|v| v.get("lastGrade")), 12);
    json!({
        "dueAt": number(review.and_then(|v| v.get("dueAt")), default_due),
        "intervalDays": number(review.and_then(|v| v.get("intervalDays")), 0.0).max(0.0),
        "ease": number(review.and_then(|v| v.get("ease")), 2.5).clamp(1.3, 3.2),
        "repetitions": integer(review.and_then(|v| v.get("repetitions")), 0),
        "lapses": integer(review.and_then(|v| v.get("lapses")), 0),
        "lastReviewedAt": number(review.and_then(|v| v.get("lastReviewedAt")), 0.0).max(0.0),
        "lastGrade": if ["again", "hard", "good", "easy"].contains(&grade.as_str()) { grade } else { String::new() }
    })
}

fn clean_entry(value: &Value) -> Option<Value> {
    let object = value.as_object()?;
    let raw = text(object.get("raw"), 5_000);
    if raw.is_empty() {
        return None;
    }
    let created_at = number(object.get("createdAt"), now_ms());
    let status = if text(object.get("status"), 16) == "learned" {
        "learned"
    } else {
        "review"
    };
    let usage = object
        .get("usage")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(3)
        .map(|item| text(Some(item), 1_000))
        .filter(|item| !item.is_empty())
        .collect::<Vec<_>>();
    let chunks = object
        .get("chunks")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(4)
        .filter_map(|item| {
            let item = item.as_object()?;
            let chunk_text = text(item.get("text"), 500);
            let meaning = text(item.get("meaning"), 1_000);
            if chunk_text.is_empty() && meaning.is_empty() {
                None
            } else {
                Some(json!({"text": chunk_text, "meaning": meaning}))
            }
        })
        .collect::<Vec<_>>();
    let thread = object
        .get("thread")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(|turn| {
            let turn = turn.as_object()?;
            let question = text(turn.get("question"), 1_000);
            let answer = text(turn.get("answer"), 2_000);
            if question.is_empty() && answer.is_empty() {
                return None;
            }
            Some(json!({
                "id": valid_id(turn.get("id")),
                "question": question,
                "answer": answer,
                "createdAt": number(turn.get("createdAt"), created_at)
            }))
        })
        .collect::<Vec<_>>();
    let display_text = text(object.get("displayText"), 5_000);
    let display_text = if display_text.is_empty() {
        raw.clone()
    } else {
        display_text
    };
    let kind = infer_kind(&raw, &text(object.get("kind"), 24));
    let pronunciation = text(object.get("pronunciation"), 500);
    let meaning = text(object.get("meaning"), 5_000);
    let mut words = object
        .get("words")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(50)
        .filter_map(|word| {
            let word = word.as_object()?;
            let word_text = text(word.get("text"), 200);
            if word_text.is_empty() {
                None
            } else {
                Some(json!({
                    "text": word_text,
                    "pronunciation": text(word.get("pronunciation"), 500),
                    "meaning": text(word.get("meaning"), 1_000)
                }))
            }
        })
        .collect::<Vec<_>>();
    if kind == "word" && words.is_empty() {
        words.push(json!({"text":display_text.clone(),"pronunciation":pronunciation.clone(),"meaning":meaning.clone()}));
    } else if kind == "word_list" && words.is_empty() {
        words = word_parts(&raw)
            .into_iter()
            .map(|word| json!({"text":word,"pronunciation":"","meaning":""}))
            .collect();
    }
    let pronunciation = if pronunciation.is_empty() && kind == "word" {
        text(
            words.first().and_then(|word| word.get("pronunciation")),
            500,
        )
    } else {
        pronunciation
    };

    Some(json!({
        "id": valid_id(object.get("id")),
        "raw": raw,
        "kind": kind,
        "words": words,
        "displayText": display_text,
        "correction": text(object.get("correction"), 500),
        "pronunciation": pronunciation,
        "meaning": meaning,
        "context": text(object.get("context"), 5_000),
        "usage": usage,
        "chunks": chunks,
        "source": text(object.get("source"), 24),
        "status": status,
        "starred": boolean(object.get("starred"), false),
        "createdAt": created_at,
        "updatedAt": number(object.get("updatedAt"), created_at),
        "conclusion": text(object.get("conclusion"), 2_000),
        "review": clean_review(object.get("review"), created_at, status),
        "thread": thread
    }))
}

fn read_json(path: &Path, fallback: Value) -> Result<Value, String> {
    match fs::read(path) {
        Ok(data) => {
            serde_json::from_slice(&data).map_err(|error| format!("无法读取本地数据：{error}"))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(format!("无法读取本地数据：{error}")),
    }
}

fn write_private_json(path: &Path, value: &Value) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| format!("无法创建数据目录：{error}"))?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(parent, fs::Permissions::from_mode(0o700))
                .map_err(|error| error.to_string())?;
        }
    }
    let temporary = path.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let data = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    fs::write(&temporary, data).map_err(|error| format!("无法写入本地数据：{error}"))?;
    #[cfg(windows)]
    if path.exists() {
        fs::remove_file(path).map_err(|error| error.to_string())?;
    }
    fs::rename(&temporary, path).map_err(|error| format!("无法保存本地数据：{error}"))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o600))
            .map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn normalize_base(value: &str) -> Result<String, String> {
    let mut url = Url::parse(value.trim()).map_err(|_| "Base URL 格式不正确".to_string())?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err("Base URL 仅支持 http 或 https".into());
    }
    if !url.username().is_empty() || url.password().is_some() {
        return Err("请勿在 Base URL 中包含账号或密钥".into());
    }
    url.set_query(None);
    url.set_fragment(None);
    let path = url.path().trim_end_matches('/');
    let path = if path.ends_with("/v1") || path == "/v1" {
        path.to_string()
    } else if path.is_empty() {
        "/v1".into()
    } else {
        format!("{path}/v1")
    };
    url.set_path(&path);
    Ok(url.to_string().trim_end_matches('/').to_string())
}

fn normalize_saved_config(value: Value) -> Value {
    if let Some(items) = value.get("providers").and_then(Value::as_array) {
        let providers = items
            .iter()
            .take(20)
            .filter_map(|provider| {
                let provider = provider.as_object()?;
                Some(json!({
                    "id": valid_id(provider.get("id")),
                    "name": text(provider.get("name"), 80).if_empty("未命名 Provider"),
                    "apiStyle": if text(provider.get("apiStyle"), 32) == "compatible" { "compatible" } else { "responses" },
                    "baseUrl": text(provider.get("baseUrl"), 2_000),
                    "apiKey": text(provider.get("apiKey"), 10_000),
                    "model": text(provider.get("model"), 500),
                    "allowNoKey": boolean(provider.get("allowNoKey"), false)
                }))
            })
            .collect::<Vec<_>>();
        let requested = text(value.get("activeProviderId"), 80);
        let active = if providers.iter().any(|provider| provider["id"] == requested) {
            requested
        } else {
            text(
                providers.first().and_then(|provider| provider.get("id")),
                80,
            )
        };
        return json!({"version":2,"activeProviderId":active,"providers":providers});
    }
    if value.get("baseUrl").is_some()
        || value.get("model").is_some()
        || value.get("apiKey").is_some()
    {
        return json!({"version":2,"activeProviderId":"default","providers":[{
            "id":"default","name":"默认 Provider",
            "apiStyle":if text(value.get("apiStyle"),32)=="compatible"{"compatible"}else{"responses"},
            "baseUrl":text(value.get("baseUrl"),2_000),"apiKey":text(value.get("apiKey"),10_000),
            "model":text(value.get("model"),500),"allowNoKey":boolean(value.get("allowNoKey"),false)
        }]});
    }
    json!({"version":2,"activeProviderId":"","providers":[]})
}

impl Backend {
    fn new(data_dir: PathBuf) -> Result<Self, String> {
        fs::create_dir_all(&data_dir).map_err(|error| error.to_string())?;
        let settings_path = data_dir.join("settings.json");
        let library_path = data_dir.join("library.json");
        let saved_config = normalize_saved_config(read_json(&settings_path, json!({}))?);
        let source = read_json(&library_path, json!({"version": 2, "entries": []}))?;
        let entries = source
            .get("entries")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(clean_entry)
            .collect::<Vec<_>>();
        let library = json!({"version": 2, "entries": entries});
        if library_path.exists() {
            write_private_json(&library_path, &library)?;
        }
        Ok(Self {
            settings_path,
            library_path,
            saved_config,
            library,
            client: reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(120))
                .build()
                .map_err(|error| error.to_string())?,
        })
    }

    fn resolve_config(&self, overrides: Option<&Value>) -> Result<AiConfig, String> {
        let override_map = overrides.and_then(Value::as_object);
        let provider_id = {
            let supplied = text(override_map.and_then(|map| map.get("providerId")), 80);
            if supplied.is_empty() {
                text(self.saved_config.get("activeProviderId"), 80)
            } else {
                supplied
            }
        };
        let provider = self
            .saved_config
            .get("providers")
            .and_then(Value::as_array)
            .and_then(|providers| {
                providers.iter().find(|provider| {
                    provider.get("id").and_then(Value::as_str) == Some(provider_id.as_str())
                })
            });
        let pick = |key: &str| {
            override_map
                .and_then(|map| map.get(key))
                .or_else(|| provider.and_then(|item| item.get(key)))
        };
        let base_url =
            normalize_base(&text(pick("baseUrl"), 2_000).if_empty("https://api.openai.com/v1"))?;
        let allow_no_key = boolean(pick("allowNoKey"), false);
        let supplied_key = text(override_map.and_then(|map| map.get("apiKey")), 10_000);
        let api_key = if !supplied_key.is_empty() {
            supplied_key
        } else if override_map.is_some() && allow_no_key {
            String::new()
        } else {
            text(provider.and_then(|item| item.get("apiKey")), 10_000)
        };
        let api_style = if text(pick("apiStyle"), 32) == "compatible" {
            "compatible".into()
        } else {
            "responses".into()
        };
        Ok(AiConfig {
            provider_id: text(provider.and_then(|item| item.get("id")), 80),
            provider_name: text(provider.and_then(|item| item.get("name")), 80)
                .if_empty("新 Provider"),
            api_style,
            base_url,
            api_key,
            model: text(pick("model"), 500),
            allow_no_key,
        })
    }

    fn public_config(&self) -> Result<Value, String> {
        let config = self.resolve_config(None)?;
        let providers = self.saved_config.get("providers").and_then(Value::as_array).into_iter().flatten().filter_map(|provider| {
            let id = text(provider.get("id"), 80);
            let item = self.resolve_config(Some(&json!({"providerId":id}))).ok()?;
            Some(json!({"id":id,"name":item.provider_name,"apiStyle":item.api_style,"baseUrl":item.base_url,"model":item.model,"allowNoKey":item.allow_no_key,"hasApiKey":!item.api_key.is_empty(),"configured":item.configured()}))
        }).collect::<Vec<_>>();
        Ok(json!({
            "providerId": config.provider_id,
            "providerName": config.provider_name,
            "activeProviderId": text(self.saved_config.get("activeProviderId"), 80),
            "providers": providers,
            "apiStyle": config.api_style,
            "baseUrl": config.base_url,
            "model": config.model,
            "allowNoKey": config.allow_no_key,
            "hasApiKey": !config.api_key.is_empty(),
            "configured": config.configured(),
            "mode": if config.configured() { "live" } else { "demo" },
            "source": if self.saved_config.get("providers").and_then(Value::as_array).map(|items| !items.is_empty()).unwrap_or(false) { "saved" } else { "default" }
        }))
    }

    fn save_config(&mut self, body: &Value) -> Result<Value, String> {
        let supplied_id = text(body.get("providerId"), 80);
        let provider_id = if supplied_id.is_empty() {
            Uuid::new_v4().to_string()
        } else {
            valid_id(body.get("providerId"))
        };
        let mut draft = body.clone();
        draft["providerId"] = json!(provider_id);
        let current = self.resolve_config(Some(&draft))?;
        if current.model.is_empty() {
            return Err("请填写或选择模型 ID".into());
        }
        if current.api_key.is_empty() && !current.allow_no_key {
            return Err("请填写 API Key，或允许无密钥服务".into());
        }
        let provider = json!({"id":provider_id.clone(),"name":text(body.get("name"),80).if_empty("未命名 Provider"),"apiStyle":current.api_style,"baseUrl":current.base_url,"model":current.model,"allowNoKey":current.allow_no_key,"apiKey":current.api_key});
        let mut providers = self.saved_config["providers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        providers.retain(|item| item.get("id") != provider.get("id"));
        providers.push(provider);
        self.saved_config =
            json!({"version":2,"activeProviderId":provider_id,"providers":providers});
        write_private_json(&self.settings_path, &self.saved_config)?;
        self.public_config()
    }

    fn activate_provider(&mut self, id: &str) -> Result<Value, String> {
        if !self.saved_config["providers"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|provider| provider.get("id").and_then(Value::as_str) == Some(id))
        {
            return Err("没有找到这个 Provider".into());
        }
        self.saved_config["activeProviderId"] = json!(id);
        write_private_json(&self.settings_path, &self.saved_config)?;
        self.public_config()
    }

    fn delete_provider(&mut self, id: &str) -> Result<Value, String> {
        let mut providers = self.saved_config["providers"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let before = providers.len();
        providers.retain(|provider| provider.get("id").and_then(Value::as_str) != Some(id));
        if providers.len() == before {
            return Err("没有找到这个 Provider".into());
        }
        let active = text(
            providers.first().and_then(|provider| provider.get("id")),
            80,
        );
        self.saved_config = json!({"version":2,"activeProviderId":active,"providers":providers});
        write_private_json(&self.settings_path, &self.saved_config)?;
        self.public_config()
    }

    fn entries(&self) -> &Vec<Value> {
        self.library["entries"].as_array().expect("entries array")
    }
    fn entries_mut(&mut self) -> &mut Vec<Value> {
        self.library["entries"]
            .as_array_mut()
            .expect("entries array")
    }
    fn save_library(&self) -> Result<(), String> {
        write_private_json(&self.library_path, &self.library)
    }

    async fn fetch_json(
        &self,
        method: Method,
        url: String,
        config: &AiConfig,
        body: Option<Value>,
    ) -> Result<Value, String> {
        let mut request = self
            .client
            .request(method, url)
            .header("Content-Type", "application/json");
        if !config.api_key.is_empty() {
            request = request.bearer_auth(&config.api_key);
        }
        if let Some(body) = body {
            request = request.json(&body);
        }
        let response = request
            .send()
            .await
            .map_err(|error| format!("无法连接 AI 服务：{error}"))?;
        let status = response.status();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        let value: Value = serde_json::from_slice(&bytes)
            .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}));
        if !status.is_success() {
            return Err(value
                .pointer("/error/message")
                .and_then(Value::as_str)
                .or_else(|| value.get("message").and_then(Value::as_str))
                .unwrap_or("上游请求失败")
                .to_string());
        }
        Ok(value)
    }

    async fn list_models(&self, body: &Value) -> Result<Value, String> {
        let config = self.resolve_config(Some(body))?;
        if config.api_key.is_empty() && !config.allow_no_key {
            return Err("请先填写 API Key，或允许无密钥服务".into());
        }
        let value = self
            .fetch_json(
                Method::GET,
                format!("{}/models", config.base_url),
                &config,
                None,
            )
            .await?;
        let items = value
            .get("data")
            .or_else(|| value.get("models"))
            .and_then(Value::as_array)
            .ok_or("接口没有返回可用的模型 ID")?;
        let mut models = items
            .iter()
            .filter_map(|item| {
                item.as_str()
                    .or_else(|| item.get("id").and_then(Value::as_str))
                    .or_else(|| item.get("name").and_then(Value::as_str))
            })
            .map(str::to_string)
            .collect::<Vec<_>>();
        models.sort();
        models.dedup();
        if models.is_empty() {
            return Err("接口没有返回可用的模型 ID".into());
        }
        Ok(json!({"models": models}))
    }

    async fn explain(&self, payload: &Value, config: &AiConfig) -> Result<Value, String> {
        if !config.configured() {
            return Ok(demo_explain(payload));
        }
        let input = serde_json::to_string(payload).map_err(|error| error.to_string())?;
        let value = if config.api_style == "responses" {
            self.fetch_json(
                Method::POST,
                format!("{}/responses", config.base_url),
                config,
                Some(json!({"model": config.model, "instructions": SYSTEM_PROMPT, "input": input})),
            )
            .await?
        } else {
            self.fetch_json(Method::POST, format!("{}/chat/completions", config.base_url), config, Some(json!({"model": config.model, "messages": [{"role":"system","content":SYSTEM_PROMPT},{"role":"user","content":input}]}))).await?
        };
        let output = if config.api_style == "responses" {
            response_text(&value)
        } else {
            content_text(value.pointer("/choices/0/message/content"))
        };
        parse_model_json(&output)
    }

    async fn create_entry(&mut self, body: &Value) -> Result<Value, String> {
        let fragment = text(body.get("text"), 5_000);
        if fragment.is_empty() {
            return Err("请输入一个语言片段".into());
        }
        let source = text(body.get("source"), 24);
        let payload = json!({"mode":"new","text":fragment,"source":source,"kindHint":infer_kind(&fragment, "")});
        let config = self.resolve_config(None)?;
        let result = self.explain(&payload, &config).await?;
        let created = now_ms();
        let entry = clean_entry(&json!({
            "id": Uuid::new_v4().to_string(), "raw": fragment,
            "kind": text(result.get("kind"), 24), "words": result.get("words").cloned().unwrap_or(json!([])),
            "displayText": text(result.get("displayText"), 5_000),
            "correction": text(result.get("correction"), 500), "pronunciation": text(result.get("pronunciation"), 500),
            "meaning": text(result.get("meaning"), 5_000), "context": text(result.get("context"), 5_000),
            "usage": result.get("usage").cloned().unwrap_or(json!([])), "chunks": result.get("chunks").cloned().unwrap_or(json!([])),
            "source": source, "status":"review", "starred":false, "createdAt":created, "updatedAt":created,
            "conclusion": text(result.get("memoryCue").or_else(|| result.get("meaning")), 2_000),
            "review":{"dueAt":created + 600_000.0}, "thread":[]
        })).ok_or("无法创建片段")?;
        self.entries_mut().insert(0, entry.clone());
        self.save_library()?;
        Ok(json!({"entry": entry, "demo": !config.configured()}))
    }

    async fn add_followup(&mut self, id: &str, body: &Value) -> Result<Value, String> {
        let index = self
            .entries()
            .iter()
            .position(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        let entry = self.entries()[index].clone();
        let question = text(body.get("text"), 1_000);
        if question.is_empty() {
            return Err("请输入追问内容".into());
        }
        let payload = json!({"mode":"followup","text":question,"root":entry["raw"],"conclusion":entry["conclusion"],"recentTurns":entry["thread"]});
        let config = self.resolve_config(None)?;
        let result = self.explain(&payload, &config).await?;
        let current = &mut self.entries_mut()[index];
        current["thread"].as_array_mut().expect("thread array").push(json!({"id":Uuid::new_v4().to_string(),"question":question,"answer":text(result.get("answer"),2_000),"createdAt":now_ms()}));
        if let Some(summary) = result
            .get("summary")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
        {
            current["conclusion"] = json!(summary);
        }
        current["updatedAt"] = json!(now_ms());
        let updated = current.clone();
        self.save_library()?;
        Ok(json!({"entry":updated,"demo":!config.configured()}))
    }

    fn update_entry(&mut self, id: &str, body: &Value) -> Result<Value, String> {
        let entry = self
            .entries_mut()
            .iter_mut()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        if body.get("source").is_some() {
            entry["source"] = json!(text(body.get("source"), 24));
        }
        if let Some(starred) = body.get("starred").and_then(Value::as_bool) {
            entry["starred"] = json!(starred);
        }
        if let Some(status) = body.get("status").and_then(Value::as_str) {
            entry["status"] = json!(if status == "learned" {
                "learned"
            } else {
                "review"
            });
            if status != "learned" {
                entry["review"]["dueAt"] = json!(now_ms());
            }
        }
        entry["updatedAt"] = json!(now_ms());
        let updated = entry.clone();
        self.save_library()?;
        Ok(json!({"entry":updated}))
    }

    fn grade_entry(&mut self, id: &str, body: &Value) -> Result<Value, String> {
        let grade = text(body.get("grade"), 12);
        let grade = if ["again", "hard", "good", "easy"].contains(&grade.as_str()) {
            grade
        } else {
            "good".into()
        };
        let entry = self
            .entries_mut()
            .iter_mut()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        entry["review"] = schedule_review(&entry["review"], &grade);
        entry["status"] = json!("learned");
        entry["updatedAt"] = json!(now_ms());
        let updated = entry.clone();
        self.save_library()?;
        Ok(json!({"entry":updated}))
    }

    fn delete_entry(&mut self, id: &str) -> Result<Value, String> {
        let index = self
            .entries()
            .iter()
            .position(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        self.entries_mut().remove(index);
        self.save_library()?;
        Ok(json!({"deleted":true}))
    }

    fn replace_entries(&mut self, body: &Value) -> Result<Value, String> {
        let entries = body
            .get("entries")
            .and_then(Value::as_array)
            .ok_or("片段数据格式不正确")?
            .iter()
            .take(10_000)
            .filter_map(clean_entry)
            .collect::<Vec<_>>();
        self.library = json!({"version":2,"entries":entries});
        self.save_library()?;
        Ok(self.library.clone())
    }

    async fn handle(&mut self, request: ApiRequest) -> Result<(u16, Value), String> {
        let method = request.method.to_uppercase();
        let path = request.url.split('?').next().unwrap_or("");
        if matches!(path, "/api/config" | "/api/status") && method == "GET" {
            return Ok((200, self.public_config()?));
        }
        if path == "/api/config" && method == "PUT" {
            return Ok((200, self.save_config(&request.body)?));
        }
        if path == "/api/models" && method == "POST" {
            return Ok((200, self.list_models(&request.body).await?));
        }
        if path == "/api/entries" && method == "GET" {
            return Ok((200, self.library.clone()));
        }
        if path == "/api/entries" && method == "PUT" {
            return Ok((200, self.replace_entries(&request.body)?));
        }
        if path == "/api/entries" && method == "POST" {
            return Ok((201, self.create_entry(&request.body).await?));
        }
        let parts = path.trim_matches('/').split('/').collect::<Vec<_>>();
        if parts.len() == 4
            && parts[..2] == ["api", "config"]
            && parts[3] == "activate"
            && method == "POST"
        {
            return Ok((200, self.activate_provider(parts[2])?));
        }
        if parts.len() == 3 && parts[..2] == ["api", "config"] && method == "DELETE" {
            return Ok((200, self.delete_provider(parts[2])?));
        }
        if parts.len() == 4
            && parts[..2] == ["api", "entries"]
            && parts[3] == "followups"
            && method == "POST"
        {
            return Ok((201, self.add_followup(parts[2], &request.body).await?));
        }
        if parts.len() == 4
            && parts[..2] == ["api", "entries"]
            && parts[3] == "review"
            && method == "POST"
        {
            return Ok((200, self.grade_entry(parts[2], &request.body)?));
        }
        if parts.len() == 3 && parts[..2] == ["api", "entries"] && method == "PATCH" {
            return Ok((200, self.update_entry(parts[2], &request.body)?));
        }
        if parts.len() == 3 && parts[..2] == ["api", "entries"] && method == "DELETE" {
            return Ok((200, self.delete_entry(parts[2])?));
        }
        Err("不支持的本地 API".into())
    }
}

trait EmptyFallback {
    fn if_empty(self, fallback: &str) -> String;
}
impl EmptyFallback for String {
    fn if_empty(self, fallback: &str) -> String {
        if self.is_empty() {
            fallback.into()
        } else {
            self
        }
    }
}

fn schedule_review(review: &Value, grade: &str) -> Value {
    let now = now_ms();
    let mut ease = number(review.get("ease"), 2.5).clamp(1.3, 3.2);
    let mut repetitions = integer(review.get("repetitions"), 0);
    let mut lapses = integer(review.get("lapses"), 0);
    let previous = number(review.get("intervalDays"), 0.0);
    let interval = match grade {
        "again" => {
            ease = (ease - 0.2).max(1.3);
            repetitions = 0;
            lapses += 1;
            10.0 / 1_440.0
        }
        "hard" => {
            ease = (ease - 0.15).max(1.3);
            let result = if repetitions == 0 {
                1.0
            } else {
                (previous * 1.2).max(1.0)
            };
            repetitions = repetitions.max(1);
            result
        }
        "easy" => {
            let result = if repetitions == 0 {
                4.0
            } else if repetitions == 1 {
                8.0
            } else {
                (previous * (ease + 0.15) * 1.3).max(8.0)
            };
            ease = (ease + 0.15).min(3.2);
            repetitions += 1;
            result
        }
        _ => {
            let result = if repetitions == 0 {
                1.0
            } else if repetitions == 1 {
                3.0
            } else {
                (previous * ease).max(3.0)
            };
            repetitions += 1;
            result
        }
    };
    let interval = (interval * 100.0).round() / 100.0;
    json!({"dueAt":now + interval * DAY_MS,"intervalDays":interval,"ease":(ease*100.0).round()/100.0,"repetitions":repetitions,"lapses":lapses,"lastReviewedAt":now,"lastGrade":grade})
}

fn content_text(value: Option<&Value>) -> String {
    match value {
        Some(Value::String(text)) => text.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter_map(|part| {
                part.get("text")
                    .or_else(|| part.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<String>(),
        _ => String::new(),
    }
}

fn response_text(value: &Value) -> String {
    if let Some(text) = value.get("output_text").and_then(Value::as_str) {
        return text.into();
    }
    value
        .get("output")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .flat_map(|item| {
            item.get("content")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
        })
        .filter_map(|part| part.get("text").and_then(Value::as_str))
        .collect()
}

fn parse_model_json(value: &str) -> Result<Value, String> {
    let mut clean = value.trim();
    if let Some(value) = clean.strip_prefix("```json") {
        clean = value.trim();
    } else if let Some(value) = clean.strip_prefix("```") {
        clean = value.trim();
    }
    if let Some(value) = clean.strip_suffix("```") {
        clean = value.trim();
    }
    serde_json::from_str(clean).map_err(|error| format!("AI 返回格式不正确：{error}"))
}

fn demo_explain(payload: &Value) -> Value {
    if payload.get("mode").and_then(Value::as_str) == Some("followup") {
        return json!({"type":"followup","answer":"演示模式已把这条问题记在当前片段内。完成 AI 配置后，这里会结合原片段和最近几轮追问作答。","summary":payload.get("conclusion").cloned().unwrap_or(json!("待连接 AI 后生成归纳结论。")),"demo":true});
    }
    let fragment = text(payload.get("text"), 5_000);
    let kind = infer_kind(&fragment, "");
    let words = if kind == "word" {
        json!([{"text":fragment,"pronunciation":"","meaning":""}])
    } else if kind == "word_list" {
        Value::Array(
            word_parts(&fragment)
                .into_iter()
                .map(|word| json!({"text":word,"pronunciation":"","meaning":""}))
                .collect(),
        )
    } else {
        json!([])
    };
    json!({"type":"entry","kind":kind,"displayText":fragment,"correction":"","pronunciation":"","words":words,"meaning":"演示模式不会猜测这个片段的具体含义。","context":"它已作为独立片段保存。配置 AI 后会生成语境化解释。","usage":[],"chunks":[],"memoryCue":"","demo":true})
}

#[tauri::command]
async fn api_request(
    request: ApiRequest,
    state: State<'_, AppState>,
) -> Result<ApiResponse, String> {
    let mut backend = state.0.lock().await;
    Ok(match backend.handle(request).await {
        Ok((status, body)) => ApiResponse { status, body },
        Err(message) => ApiResponse {
            status: 502,
            body: json!({"error":message}),
        },
    })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let backend = Backend::new(data_dir).map_err(std::io::Error::other)?;
            app.manage(AppState(Mutex::new(backend)));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_request])
        .run(tauri::generate_context!())
        .expect("error while running 拾词");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn review_intervals_are_adaptive() {
        let review = json!({"ease":2.5,"repetitions":0,"lapses":0,"intervalDays":0});
        assert_eq!(
            schedule_review(&review, "again")["intervalDays"],
            json!(0.01)
        );
        assert_eq!(schedule_review(&review, "good")["intervalDays"], json!(1.0));
        assert_eq!(schedule_review(&review, "easy")["intervalDays"], json!(4.0));
    }

    #[test]
    fn fragment_kinds_keep_words_separate_from_phrases() {
        assert_eq!(infer_kind("suffocating", ""), "word");
        assert_eq!(infer_kind("alpha, beta", ""), "word_list");
        assert_eq!(infer_kind("figure it out", ""), "phrase");
        assert_eq!(infer_kind("This is a complete sentence.", ""), "sentence");
    }
}
