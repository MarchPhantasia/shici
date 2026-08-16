use reqwest::Method;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
    sync::{Mutex as StdMutex, OnceLock},
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{Manager, State};
use tokio::sync::{watch, Mutex};
use url::Url;
use uuid::Uuid;

const DAY_MS: f64 = 86_400_000.0;
const MAX_OUTPUT_TOKENS: u64 = 4_000;
const CAPABILITY_TTL_MS: f64 = 30.0 * 60_000.0;
const SYSTEM_PROMPT: &str = include_str!("../../system-prompt.txt");
#[derive(Clone, Copy, Default)]
struct AiCapabilities {
    structured: Option<bool>,
    reasoning: Option<bool>,
    at: f64,
}

static AI_CAPABILITIES: OnceLock<StdMutex<HashMap<String, AiCapabilities>>> = OnceLock::new();

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ApiRequest {
    url: String,
    #[serde(default = "default_method")]
    method: String,
    #[serde(default)]
    body: Value,
    #[serde(default)]
    request_id: String,
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
    reasoning_effort: String,
    enable_thinking_toggle: bool,
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
    library_serialized: String,
    client: reqwest::Client,
}

struct AppState {
    backend: Mutex<Backend>,
    cancellations: StdMutex<HashMap<String, watch::Sender<bool>>>,
}

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

fn normalize_token(value: &str) -> String {
    value
        .to_lowercase()
        .trim_matches(|char: char| !char.is_alphanumeric() && !matches!(char, '\'' | '’'))
        .to_string()
}

fn edit_distance(left: &str, right: &str) -> usize {
    let right = right.chars().collect::<Vec<_>>();
    let mut previous = (0..=right.len()).collect::<Vec<_>>();
    for (i, left_char) in left.chars().enumerate() {
        let mut current = vec![i + 1];
        for (j, right_char) in right.iter().enumerate() {
            current.push(
                (current[j] + 1)
                    .min(previous[j + 1] + 1)
                    .min(previous[j] + usize::from(left_char != *right_char)),
            );
        }
        previous = current;
    }
    previous[right.len()]
}

fn claim_original(
    original_parts: &[String],
    used: &mut std::collections::HashSet<usize>,
    text: &str,
    preferred: &str,
) -> String {
    let find_exact = |target: &str| {
        original_parts
            .iter()
            .enumerate()
            .find(|(index, part)| {
                !used.contains(index) && normalize_token(part) == normalize_token(target)
            })
            .map(|(index, _)| index)
    };
    let mut index = if preferred.is_empty() {
        None
    } else {
        find_exact(preferred)
    };
    if index.is_none() {
        index = find_exact(text);
    }
    if index.is_none() {
        let target = normalize_token(text);
        index = original_parts
            .iter()
            .enumerate()
            .filter(|(part_index, _)| !used.contains(part_index))
            .filter_map(|(part_index, part)| {
                let distance = edit_distance(&normalize_token(part), &target);
                (distance < 3).then_some((distance, part_index))
            })
            .min_by_key(|(distance, _)| *distance)
            .map(|(_, part_index)| part_index);
    }
    let Some(index) = index else {
        return String::new();
    };
    used.insert(index);
    original_parts[index].clone()
}

fn normalize_word_correction(raw: &str, text: &str, correction: &str) -> String {
    let supplied = correction.trim();
    if !supplied.is_empty() {
        let parts = supplied
            .split_once('→')
            .or_else(|| supplied.split_once("->"));
        if let Some((before, after)) = parts {
            let before = normalize_token(before);
            let after = normalize_token(after);
            if !before.is_empty() && !after.is_empty() {
                return format!("{before} → {after}");
            }
        }
    }
    let before = normalize_token(raw);
    let after = normalize_token(text);
    let inflection = (before.ends_with("ed") && before.trim_end_matches("ed") == after)
        || (before.ends_with("ing") && before.trim_end_matches("ing") == after)
        || (before.ends_with('s') && before.trim_end_matches('s') == after);
    if !before.is_empty() && before != after && !inflection && edit_distance(&before, &after) <= 2 {
        format!("{before} → {after}")
    } else {
        String::new()
    }
}

fn is_word_token(value: &str) -> bool {
    let mut chars = value.chars();
    chars.next().is_some_and(char::is_alphabetic)
        && chars.all(|char| char.is_alphabetic() || matches!(char, '\'' | '’' | '-'))
}

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

fn normalize_difficulty(value: Option<&Value>) -> Option<f64> {
    let difficulty = number(value, -1.0);
    (1.0..=5.0)
        .contains(&difficulty)
        .then(|| (difficulty * 10.0).round() / 10.0)
}

fn estimate_difficulty(
    raw: &str,
    display_text: &str,
    kind: &str,
    pronunciation: &str,
    review: &Value,
) -> f64 {
    let fragment = if display_text.is_empty() {
        raw
    } else {
        display_text
    };
    let letters = fragment
        .chars()
        .filter(|character| character.is_alphabetic())
        .count();
    let word_count = fragment
        .split_whitespace()
        .filter(|word| !word.is_empty())
        .count();
    let mut difficulty = match kind {
        "sentence" => 3.4,
        "phrase" => 2.8,
        "word_list" => 3.0,
        _ => 2.1,
    };
    if kind == "word" {
        difficulty += (letters.saturating_sub(5) as f64 * 0.12).min(1.3);
        let mut consonants = 0;
        for character in fragment.chars() {
            if character.is_alphabetic()
                && !matches!(
                    character.to_ascii_lowercase(),
                    'a' | 'e' | 'i' | 'o' | 'u' | 'y'
                )
            {
                consonants += 1;
            } else {
                consonants = 0;
            }
            if consonants >= 3 {
                difficulty += 0.25;
                break;
            }
        }
    } else {
        difficulty += ((word_count.saturating_sub(3) as f64) * 0.12).min(0.9);
    }
    if pronunciation.chars().count() > 18 {
        difficulty += 0.2;
    }
    difficulty += (integer(review.get("lapses"), 0) as f64 * 0.2).min(0.8);
    difficulty -= (integer(review.get("repetitions"), 0) as f64 * 0.05).min(0.5);
    match text(review.get("lastGrade"), 12).as_str() {
        "again" => difficulty += 0.4,
        "hard" => difficulty += 0.2,
        "easy" => difficulty -= 0.25,
        _ => {}
    }
    (difficulty.clamp(1.0, 5.0) * 10.0).round() / 10.0
}

fn adjust_difficulty(value: Option<&Value>, grade: &str) -> f64 {
    let delta = match grade {
        "again" => 0.4,
        "hard" => 0.2,
        "good" => -0.1,
        "easy" => -0.25,
        _ => 0.0,
    };
    ((normalize_difficulty(value).unwrap_or(3.0) + delta).clamp(1.0, 5.0) * 10.0).round() / 10.0
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
    let lapses = integer(review.and_then(|v| v.get("lapses")), 0);
    json!({
        "dueAt": number(review.and_then(|v| v.get("dueAt")), default_due),
        "intervalDays": number(review.and_then(|v| v.get("intervalDays")), 0.0).max(0.0),
        "ease": number(review.and_then(|v| v.get("ease")), 2.5).clamp(1.3, 3.2),
        "repetitions": integer(review.and_then(|v| v.get("repetitions")), 0),
        "lapses": lapses,
        "leech": boolean(review.and_then(|v| v.get("leech")), false) || lapses >= 8,
        "lastReviewedAt": number(review.and_then(|v| v.get("lastReviewedAt")), 0.0).max(0.0),
        "lastGrade": if ["again", "hard", "good", "easy"].contains(&grade.as_str()) { grade } else { String::new() }
    })
}

fn lexical_token(value: &str) -> &str {
    value.trim_matches(|char: char| !char.is_alphanumeric() && !matches!(char, '\'' | '’'))
}

fn migrate_legacy_correction(
    raw: &str,
    display_text: &str,
    correction: &str,
) -> Option<(String, String)> {
    if correction.is_empty()
        || display_text.to_lowercase() != raw.to_lowercase()
        || correction.contains('→')
        || correction.contains("->")
    {
        return None;
    }
    let original = raw.split_whitespace().collect::<Vec<_>>();
    let corrected = correction.split_whitespace().collect::<Vec<_>>();
    if original.len() < 2 || original.len() != corrected.len() {
        return None;
    }
    let differences = original
        .iter()
        .zip(&corrected)
        .enumerate()
        .filter(|(_, (before, after))| {
            lexical_token(before).to_lowercase() != lexical_token(after).to_lowercase()
        })
        .map(|(index, _)| index)
        .collect::<Vec<_>>();
    if differences.len() != 1 {
        return None;
    }
    let index = differences[0];
    let before = lexical_token(original[index]);
    let after = lexical_token(corrected[index]);
    (!before.is_empty() && !after.is_empty()).then(|| {
        (
            correction.to_string(),
            format!("{} → {}", before.to_lowercase(), after.to_lowercase()),
        )
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
                "summary": text(turn.get("summary"), 2_000),
                "createdAt": number(turn.get("createdAt"), created_at)
            }))
        })
        .collect::<Vec<_>>();
    let display_text = text(object.get("displayText"), 5_000);
    let mut display_text = if display_text.is_empty() {
        raw.clone()
    } else {
        display_text
    };
    let mut correction = text(object.get("correction"), 500);
    let mut pronunciation = text(object.get("pronunciation"), 500);
    if let Some((corrected, label)) = migrate_legacy_correction(&raw, &display_text, &correction) {
        display_text = corrected;
        correction = label;
        pronunciation.clear();
    }
    let kind = infer_kind(&display_text, &text(object.get("kind"), 24));
    if kind == "word" {
        display_text = capitalize_word(&display_text);
    }
    let meaning = text(object.get("meaning"), 5_000);
    let mut words = object
        .get("words")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .take(50)
        .filter_map(|word| {
            let word = word.as_object()?;
            let word_text = capitalize_word(&text(word.get("text"), 200));
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
        words = word_parts(&display_text)
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
    let context = text(object.get("context"), 5_000);
    let review = clean_review(object.get("review"), created_at, status);
    let difficulty = normalize_difficulty(object.get("difficulty")).unwrap_or_else(|| {
        estimate_difficulty(&raw, &display_text, &kind, &pronunciation, &review)
    });

    Some(json!({
        "id": valid_id(object.get("id")),
        "raw": raw,
        "kind": kind,
        "words": words,
        "displayText": display_text,
        "correction": correction,
        "pronunciation": pronunciation,
        "meaning": meaning,
        "context": context,
        "usage": usage,
        "difficulty": difficulty,
        "chunks": chunks,
        "source": text(object.get("source"), 24),
        "status": status,
        "starred": boolean(object.get("starred"), false),
        "createdAt": created_at,
        "updatedAt": number(object.get("updatedAt"), created_at),
        "baseConclusion": text(object.get("baseConclusion").or_else(|| object.get("meaning")).or_else(|| object.get("conclusion")), 2_000),
        "conclusion": text(object.get("conclusion"), 2_000),
        "review": review,
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

fn normalize_reasoning_effort(value: Option<&Value>) -> String {
    match text(value, 16).as_str() {
        "none" | "low" | "medium" | "high" => text(value, 16),
        _ => "auto".into(),
    }
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
                    "reasoningEffort": normalize_reasoning_effort(provider.get("reasoningEffort")),
                    "enableThinkingToggle": boolean(provider.get("enableThinkingToggle"), false),
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
            "model":text(value.get("model"),500),"reasoningEffort":normalize_reasoning_effort(value.get("reasoningEffort")),"enableThinkingToggle":boolean(value.get("enableThinkingToggle"),false),"allowNoKey":boolean(value.get("allowNoKey"),false)
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
        let library_serialized =
            serde_json::to_string(&library).map_err(|error| error.to_string())?;
        Ok(Self {
            settings_path,
            library_path,
            saved_config,
            library,
            library_serialized,
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
        let provider_base_url = provider
            .and_then(|item| item.get("baseUrl"))
            .map(|value| normalize_base(&text(Some(value), 2_000)))
            .transpose()?;
        let base_matches_provider = provider_base_url.as_deref().is_none_or(|saved| {
            !override_map.is_some_and(|map| map.contains_key("baseUrl")) || saved == base_url
        });
        let allow_no_key = boolean(pick("allowNoKey"), false);
        let supplied_key = text(override_map.and_then(|map| map.get("apiKey")), 10_000);
        let api_key = if !supplied_key.is_empty() {
            supplied_key
        } else if override_map.is_some() && allow_no_key {
            String::new()
        } else if base_matches_provider {
            text(provider.and_then(|item| item.get("apiKey")), 10_000)
        } else {
            String::new()
        };
        let api_style = if text(pick("apiStyle"), 32) == "compatible" {
            "compatible".into()
        } else {
            "responses".into()
        };
        let reasoning_effort = normalize_reasoning_effort(pick("reasoningEffort"));
        let enable_thinking_toggle = boolean(pick("enableThinkingToggle"), false);
        Ok(AiConfig {
            provider_id: text(provider.and_then(|item| item.get("id")), 80),
            provider_name: text(provider.and_then(|item| item.get("name")), 80)
                .if_empty("新 Provider"),
            api_style,
            base_url,
            api_key,
            model: text(pick("model"), 500),
            reasoning_effort,
            enable_thinking_toggle,
            allow_no_key,
        })
    }

    fn public_config(&self) -> Result<Value, String> {
        let config = self.resolve_config(None)?;
        let providers = self.saved_config.get("providers").and_then(Value::as_array).into_iter().flatten().filter_map(|provider| {
            let id = text(provider.get("id"), 80);
            let item = self.resolve_config(Some(&json!({"providerId":id}))).ok()?;
            Some(json!({"id":id,"name":item.provider_name,"apiStyle":item.api_style,"baseUrl":item.base_url,"model":item.model,"reasoningEffort":item.reasoning_effort,"enableThinkingToggle":item.enable_thinking_toggle,"allowNoKey":item.allow_no_key,"hasApiKey":!item.api_key.is_empty(),"configured":item.configured()}))
        }).collect::<Vec<_>>();
        Ok(json!({
            "providerId": config.provider_id,
            "providerName": config.provider_name,
            "activeProviderId": text(self.saved_config.get("activeProviderId"), 80),
            "providers": providers,
            "apiStyle": config.api_style,
            "baseUrl": config.base_url,
            "model": config.model,
            "reasoningEffort": config.reasoning_effort,
            "enableThinkingToggle": config.enable_thinking_toggle,
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
        let provider = json!({"id":provider_id.clone(),"name":text(body.get("name"),80).if_empty("未命名 Provider"),"apiStyle":current.api_style,"baseUrl":current.base_url,"model":current.model,"reasoningEffort":current.reasoning_effort,"enableThinkingToggle":current.enable_thinking_toggle,"allowNoKey":current.allow_no_key,"apiKey":current.api_key});
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
    fn duplicate_entry(&self, fragment: &str) -> Option<Value> {
        let normalized = fragment.trim().to_lowercase();
        self.entries()
            .iter()
            .find(|entry| {
                [entry.get("raw"), entry.get("displayText")]
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .any(|value| value.trim().to_lowercase() == normalized)
            })
            .cloned()
    }
    fn save_library(&mut self) -> Result<(), String> {
        let serialized = serde_json::to_string(&self.library).map_err(|error| error.to_string())?;
        if serialized == self.library_serialized {
            return Ok(());
        }
        write_private_json(&self.library_path, &self.library)?;
        self.library_serialized = serialized;
        Ok(())
    }

    async fn fetch_json(
        &self,
        method: Method,
        url: String,
        config: &AiConfig,
        body: Option<Value>,
    ) -> Result<Value, String> {
        fetch_json_with_client(&self.client, method, url, config, body).await
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

    async fn explain_cancellable(
        &self,
        payload: &Value,
        config: &AiConfig,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<Value, String> {
        explain_cancellable_with_client(&self.client, payload, config, cancellation).await
    }

    fn prepare_new_entry(&self, body: &Value) -> Result<(String, String, Value, AiConfig), String> {
        let fragment = text(body.get("text"), 5_000);
        if fragment.is_empty() {
            return Err("请输入一个语言片段".into());
        }
        let source = text(body.get("source"), 24);
        let payload = json!({"mode":"new","text":fragment,"source":source,"kindHint":infer_kind(&fragment, "")});
        let config = self.resolve_config(None)?;
        Ok((fragment, source, payload, config))
    }

    fn commit_new_entry(
        &mut self,
        fragment: String,
        source: String,
        result: Value,
        config: &AiConfig,
        force_new: bool,
    ) -> Result<Value, String> {
        if !force_new {
            if let Some(entry) = self.duplicate_entry(&fragment) {
                return Ok(
                    json!({"entry":entry.clone(),"entries":[entry],"duplicate":true,"demo":false}),
                );
            }
        }
        let split_words = if text(result.get("kind"), 24) == "word_list" {
            let words = result
                .get("words")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if words.len() > 1 {
                words
            } else {
                word_parts(&fragment)
                    .into_iter()
                    .map(|word| json!({"text":word}))
                    .collect()
            }
        } else {
            Vec::new()
        };
        let split_words = split_words
            .into_iter()
            .filter(|word| !text(word.get("text"), 200).is_empty())
            .collect::<Vec<_>>();
        if split_words.len() > 1 {
            let created = now_ms();
            let original_parts = word_parts(&fragment);
            let mut used = std::collections::HashSet::new();
            let entries = split_words
                .into_iter()
                .filter_map(|word| {
                    let word_text = capitalize_word(&text(word.get("text"), 200));
                    if word_text.is_empty() {
                        return None;
                    }
                    let raw = claim_original(&original_parts, &mut used, &word_text, &text(word.get("original"), 200));
                    let raw = if raw.is_empty() { word_text.clone() } else { raw };
                    let pronunciation = text(word.get("pronunciation"), 500);
                    let correction = normalize_word_correction(&raw, &word_text, &text(word.get("correction"), 200));
                    let meaning = {
                        let value = text(word.get("meaning"), 1_000);
                        if value.is_empty() {
                            text(result.get("meaning"), 5_000)
                        } else {
                            value
                        }
                    };
                    let context = {
                        let value = text(word.get("context"), 2_000);
                        if value.is_empty() {
                            text(result.get("context"), 2_000)
                        } else {
                            value
                        }
                    };
                    let usage = word
                        .get("usage")
                        .and_then(Value::as_array)
                        .filter(|items| !items.is_empty())
                        .cloned()
                        .or_else(|| result.get("usage").and_then(Value::as_array).cloned())
                        .unwrap_or_default();
                    let difficulty = word
                        .get("difficulty")
                        .cloned()
                        .or_else(|| result.get("difficulty").cloned())
                        .unwrap_or(Value::Null);
                    clean_entry(&json!({
                        "id":Uuid::new_v4().to_string(), "raw":raw, "kind":"word", "words":[{
                            "text":word_text, "pronunciation":pronunciation, "meaning":meaning
                        }], "displayText":word_text, "correction":correction, "pronunciation":pronunciation,
                        "meaning":meaning, "context":context, "usage":usage, "difficulty":difficulty, "chunks":[],
                        "source":source.clone(), "status":"review", "starred":false, "createdAt":created, "updatedAt":created,
                        "baseConclusion":meaning, "conclusion":meaning, "review":{"dueAt":created + 600_000.0}, "thread":[]
                    }))
                })
                .collect::<Vec<_>>();
            let mut returned = Vec::with_capacity(entries.len());
            let mut created_entries = Vec::with_capacity(entries.len());
            let mut seen = HashMap::new();
            let mut reused_count = 0;
            for entry in &entries {
                let raw = text(entry.get("raw"), 200);
                let display = text(entry.get("displayText"), 200);
                let display_key = display.to_lowercase();
                let duplicate = if force_new {
                    None
                } else {
                    seen.get(&display_key)
                        .cloned()
                        .or_else(|| self.duplicate_entry(&raw))
                        .or_else(|| self.duplicate_entry(&display))
                };
                if let Some(duplicate) = duplicate {
                    returned.push(duplicate);
                    reused_count += 1;
                } else {
                    returned.push(entry.clone());
                    seen.insert(display_key, entry.clone());
                    created_entries.push(entry.clone());
                }
            }
            for entry in created_entries.iter().rev() {
                self.entries_mut().insert(0, entry.clone());
            }
            self.save_library()?;
            return Ok(
                json!({"entry":returned.first().cloned().unwrap_or(Value::Null),"entries":returned,"split":true,"duplicate":reused_count > 0,"createdCount":created_entries.len(),"reusedCount":reused_count,"demo":!config.configured()}),
            );
        }
        let created = now_ms();
        let entry = clean_entry(&json!({
            "id": Uuid::new_v4().to_string(), "raw": fragment,
            "kind": text(result.get("kind"), 24), "words": result.get("words").cloned().unwrap_or(json!([])),
            "displayText": text(result.get("displayText"), 5_000),
            "correction": text(result.get("correction"), 500), "pronunciation": text(result.get("pronunciation"), 500),
            "meaning": text(result.get("meaning"), 5_000), "context": text(result.get("context"), 5_000),
            "usage": result.get("usage").cloned().unwrap_or(json!([])), "difficulty": result.get("difficulty").cloned().unwrap_or(Value::Null), "chunks": result.get("chunks").cloned().unwrap_or(json!([])),
            "source": source, "status":"review", "starred":false, "createdAt":created, "updatedAt":created,
            "baseConclusion": text(result.get("memoryCue").or_else(|| result.get("meaning")), 2_000),
            "conclusion": text(result.get("memoryCue").or_else(|| result.get("meaning")), 2_000),
            "review":{"dueAt":created + 600_000.0}, "thread":[]
        })).ok_or("无法创建片段")?;
        self.entries_mut().insert(0, entry.clone());
        self.save_library()?;
        Ok(json!({"entry": entry, "entries":[entry], "demo": !config.configured()}))
    }

    fn prepare_followup(
        &self,
        id: &str,
        body: &Value,
    ) -> Result<(String, Value, AiConfig), String> {
        let entry = self
            .entries()
            .iter()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        let question = text(body.get("text"), 1_000);
        if question.is_empty() {
            return Err("请输入追问内容".into());
        }
        let root = text(entry.get("displayText").or_else(|| entry.get("raw")), 5_000);
        let payload = json!({"mode":"followup","text":question,"root":root,"conclusion":entry["conclusion"],"recentTurns":entry["thread"]});
        let config = self.resolve_config(None)?;
        Ok((question, payload, config))
    }

    fn commit_followup(
        &mut self,
        id: &str,
        question: String,
        result: Value,
        config: &AiConfig,
    ) -> Result<Value, String> {
        let current = self
            .entries_mut()
            .iter_mut()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        current["thread"].as_array_mut().expect("thread array").push(json!({"id":Uuid::new_v4().to_string(),"question":question,"answer":text(result.get("answer"),2_000),"summary":text(result.get("summary"),2_000),"createdAt":now_ms()}));
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

    async fn create_entry(
        &mut self,
        body: &Value,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<Value, String> {
        let (fragment, source, payload, config) = self.prepare_new_entry(body)?;
        let force_new = boolean(body.get("forceNew"), false);
        if !force_new {
            if let Some(entry) = self.duplicate_entry(&fragment) {
                return Ok(
                    json!({"entry":entry.clone(),"entries":[entry],"duplicate":true,"demo":false}),
                );
            }
            if text(payload.get("kindHint"), 24) == "word_list" {
                let parts = word_parts(&fragment);
                let hits = parts
                    .iter()
                    .map(|part| self.duplicate_entry(part))
                    .collect::<Option<Vec<_>>>();
                if parts.len() > 1 {
                    if let Some(entries) = hits {
                        return Ok(
                            json!({"entry":entries.first().cloned().unwrap_or(Value::Null),"entries":entries,"split":true,"duplicate":true,"createdCount":0,"reusedCount":parts.len(),"demo":false}),
                        );
                    }
                }
            }
        }
        let result = self
            .explain_cancellable(&payload, &config, cancellation)
            .await?;
        self.commit_new_entry(fragment, source, result, &config, force_new)
    }

    async fn add_followup(
        &mut self,
        id: &str,
        body: &Value,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<Value, String> {
        let (question, payload, config) = self.prepare_followup(id, body)?;
        let result = self
            .explain_cancellable(&payload, &config, cancellation)
            .await?;
        self.commit_followup(id, question, result, &config)
    }

    fn rewind_followups(&mut self, id: &str, body: &Value) -> Result<Value, String> {
        let entry = self
            .entries_mut()
            .iter_mut()
            .find(|entry| entry.get("id").and_then(Value::as_str) == Some(id))
            .ok_or("没有找到这个片段")?;
        let turn_id = text(body.get("turnId"), 80);
        let index = if turn_id.is_empty() {
            None
        } else {
            Some(
                entry["thread"]
                    .as_array()
                    .and_then(|turns| {
                        turns.iter().position(|turn| {
                            turn.get("id").and_then(Value::as_str) == Some(&turn_id)
                        })
                    })
                    .ok_or("没有找到这一轮追问")?,
            )
        };
        let turns = entry["thread"].as_array_mut().expect("thread array");
        turns.truncate(index.map_or(0, |value| value + 1));
        let conclusion = turns
            .last()
            .and_then(|turn| turn.get("summary"))
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .map(str::to_string)
            .unwrap_or_else(|| {
                text(
                    entry.get("baseConclusion").or_else(|| entry.get("meaning")),
                    2_000,
                )
            });
        entry["conclusion"] = json!(conclusion);
        entry["updatedAt"] = json!(now_ms());
        let updated = entry.clone();
        self.save_library()?;
        Ok(json!({"entry":updated}))
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
        entry["review"] = schedule_review(&entry["review"], &grade, id);
        let difficulty = adjust_difficulty(entry.get("difficulty"), &grade);
        entry["difficulty"] = json!(difficulty);
        entry["status"] = json!(if grade == "again" {
            "review"
        } else {
            "learned"
        });
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

    fn append_entries(&mut self, body: &Value) -> Result<Value, String> {
        let source = body
            .get("entries")
            .and_then(Value::as_array)
            .ok_or("片段数据格式不正确")?;
        let source = source.iter().take(10_000);
        let mut existing_keys = std::collections::HashSet::new();
        let mut used_ids = std::collections::HashSet::new();
        for entry in self.entries() {
            for field in ["raw", "displayText"] {
                if let Some(value) = entry.get(field).and_then(Value::as_str) {
                    let key = value.trim().to_lowercase();
                    if !key.is_empty() {
                        existing_keys.insert(key);
                    }
                }
            }
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                used_ids.insert(id.to_string());
            }
        }
        let mut additions = Vec::new();
        let mut skipped_count = 0;
        let mut invalid_count = 0;
        for value in source {
            let Some(mut entry) = clean_entry(value) else {
                invalid_count += 1;
                continue;
            };
            let keys = ["raw", "displayText"]
                .into_iter()
                .filter_map(|field| entry.get(field).and_then(Value::as_str))
                .map(|value| value.trim().to_lowercase())
                .filter(|value| !value.is_empty())
                .collect::<Vec<_>>();
            if keys.iter().any(|key| existing_keys.contains(key)) {
                skipped_count += 1;
                continue;
            }
            let id = entry
                .get("id")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_string();
            if used_ids.contains(&id) {
                entry["id"] = json!(Uuid::new_v4().to_string());
            }
            if let Some(id) = entry.get("id").and_then(Value::as_str) {
                used_ids.insert(id.to_string());
            }
            for key in keys {
                existing_keys.insert(key);
            }
            additions.push(entry);
        }
        let truncated_count = body
            .get("entries")
            .and_then(Value::as_array)
            .map_or(0, |entries| entries.len().saturating_sub(10_000));
        let mut merged = additions.clone();
        merged.extend(self.entries().iter().cloned());
        self.library = json!({"version":2,"entries":merged});
        self.save_library()?;
        Ok(json!({
            "version": 2,
            "entries": self.entries(),
            "importedCount": additions.len(),
            "skippedCount": skipped_count,
            "invalidCount": invalid_count,
            "truncatedCount": truncated_count
        }))
    }

    async fn handle(
        &mut self,
        request: ApiRequest,
        cancellation: Option<watch::Receiver<bool>>,
    ) -> Result<(u16, Value), String> {
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
        if path == "/api/entries/import" && method == "POST" {
            return Ok((200, self.append_entries(&request.body)?));
        }
        if path == "/api/entries" && method == "POST" {
            return Ok((200, self.create_entry(&request.body, cancellation).await?));
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
            return Ok((
                201,
                self.add_followup(parts[2], &request.body, cancellation)
                    .await?,
            ));
        }
        if parts.len() == 4
            && parts[..2] == ["api", "entries"]
            && parts[3] == "followups"
            && method == "PATCH"
        {
            return Ok((200, self.rewind_followups(parts[2], &request.body)?));
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

async fn fetch_json_with_client(
    client: &reqwest::Client,
    method: Method,
    url: String,
    config: &AiConfig,
    body: Option<Value>,
) -> Result<Value, String> {
    for attempt in 0..3 {
        let mut request = client
            .request(method.clone(), url.clone())
            .header("Content-Type", "application/json");
        if !config.api_key.is_empty() {
            request = request.bearer_auth(&config.api_key);
        }
        if let Some(body) = body.clone() {
            request = request.json(&body);
        }
        let response = match request.send().await {
            Ok(response) => response,
            Err(_error) if attempt < 2 => {
                tokio::time::sleep(std::time::Duration::from_millis(250 * 2_u64.pow(attempt)))
                    .await;
                continue;
            }
            Err(error) => return Err(format!("无法连接 AI 服务：{error}")),
        };
        let status = response.status();
        let content_type = response
            .headers()
            .get(reqwest::header::CONTENT_TYPE)
            .and_then(|value| value.to_str().ok())
            .unwrap_or("")
            .to_string();
        let bytes = response.bytes().await.map_err(|error| error.to_string())?;
        let value: Value = if content_type.contains("text/event-stream") {
            parse_sse(&String::from_utf8_lossy(&bytes))
        } else {
            serde_json::from_slice(&bytes)
                .unwrap_or_else(|_| json!({"raw": String::from_utf8_lossy(&bytes)}))
        };
        if !status.is_success() {
            if matches!(status.as_u16(), 429 | 500 | 502 | 503 | 504) && attempt < 2 {
                tokio::time::sleep(std::time::Duration::from_millis(250 * 2_u64.pow(attempt)))
                    .await;
                continue;
            }
            let message = format!(
                "上游请求失败 ({})：{}",
                status.as_u16(),
                value
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .or_else(|| value.get("message").and_then(Value::as_str))
                    .unwrap_or("上游请求失败")
            );
            return Err(status_error(status.as_u16(), &message));
        }
        if value.get("status").and_then(Value::as_str) == Some("incomplete")
            && value
                .pointer("/incomplete_details/reason")
                .and_then(Value::as_str)
                == Some("max_output_tokens")
        {
            return Err(status_error(
                502,
                "模型输出被推理过程耗尽，请提高输出上限或降低推理程度",
            ));
        }
        return Ok(value);
    }
    Err("上游请求失败".into())
}

fn capability_error_dimensions(error: &str) -> (bool, bool) {
    let error = error.to_lowercase();
    let generic = error.contains("unsupported")
        || error.contains("unrecognized")
        || error.contains("unknown parameter")
        || error.contains("invalid parameter");
    (
        generic || error.contains("response_format") || error.contains("json_schema"),
        generic
            || error.contains("reasoning")
            || error.contains("chat_template")
            || error.contains("thinking"),
    )
}

async fn explain_with_client(
    client: &reqwest::Client,
    payload: &Value,
    config: &AiConfig,
) -> Result<Value, String> {
    if !config.configured() {
        return Ok(demo_explain(payload));
    }
    let input = serde_json::to_string(payload).map_err(|error| error.to_string())?;
    let schema = response_schema(payload);
    let capability_key = format!(
        "{}|{}|{}|{}|{}",
        config.provider_id,
        config.api_style,
        config.base_url,
        config.model,
        config.enable_thinking_toggle
    );
    let cached = AI_CAPABILITIES
        .get_or_init(|| StdMutex::new(HashMap::new()))
        .lock()
        .ok()
        .and_then(|capabilities| capabilities.get(&capability_key).copied())
        .filter(|capability| now_ms() - capability.at < CAPABILITY_TTL_MS)
        .unwrap_or_default();
    let has_reasoning = config.reasoning_effort != "auto";
    let supports_chat_template = config.enable_thinking_toggle;
    let request = |structured: bool, include_reasoning: bool| {
        let input = input.clone();
        let schema = schema.clone();
        let reasoning_effort = config.reasoning_effort.clone();
        async move {
            if config.api_style == "responses" {
                let mut body = json!({
                        "model": config.model,
                        "instructions": SYSTEM_PROMPT,
                        "input": input,
                        "max_output_tokens": MAX_OUTPUT_TOKENS
                });
                if include_reasoning && reasoning_effort != "auto" {
                    body["reasoning"] = json!({"effort":reasoning_effort});
                }
                if structured {
                    body["text"] = json!({"format":{"type":"json_schema","name":schema["name"],"strict":true,"schema":schema["schema"]}});
                }
                fetch_json_with_client(
                    client,
                    Method::POST,
                    format!("{}/responses", config.base_url),
                    config,
                    Some(body),
                )
                .await
            } else {
                let mut body = json!({
                        "model": config.model,
                        "temperature": 0.2,
                        "max_tokens": MAX_OUTPUT_TOKENS,
                        "messages": [{"role":"system","content":SYSTEM_PROMPT},{"role":"user","content":input}]
                });
                if include_reasoning && reasoning_effort != "auto" {
                    body["reasoning_effort"] = json!(reasoning_effort);
                    if supports_chat_template {
                        body["chat_template_kwargs"] =
                            json!({"enable_thinking":reasoning_effort != "none"});
                    }
                }
                if structured {
                    body["response_format"] = json!({"type":"json_schema","json_schema":{"name":schema["name"],"strict":true,"schema":schema["schema"]}});
                }
                fetch_json_with_client(
                    client,
                    Method::POST,
                    format!("{}/chat/completions", config.base_url),
                    config,
                    Some(body),
                )
                .await
            }
        }
    };
    let mut attempts = Vec::new();
    let mut add_attempt = |structured: bool, include_reasoning: bool| {
        if !attempts.contains(&(structured, include_reasoning)) {
            attempts.push((structured, include_reasoning));
        }
    };
    if cached.structured != Some(false) {
        if has_reasoning && cached.reasoning != Some(false) {
            add_attempt(true, true);
        }
        add_attempt(true, false);
    }
    if has_reasoning && cached.reasoning != Some(false) {
        add_attempt(false, true);
    }
    add_attempt(false, false);
    let mut value = None;
    let mut last_error = None;
    let mut structured_capability_error = false;
    let mut reasoning_capability_error = false;
    for (structured, include_reasoning) in attempts {
        match request(structured, include_reasoning).await {
            Ok(result) => {
                if let Ok(mut capabilities) = AI_CAPABILITIES
                    .get_or_init(|| StdMutex::new(HashMap::new()))
                    .lock()
                {
                    capabilities.insert(
                        capability_key.clone(),
                        AiCapabilities {
                            structured: if structured {
                                Some(true)
                            } else if structured_capability_error {
                                Some(false)
                            } else {
                                cached.structured
                            },
                            reasoning: if has_reasoning && include_reasoning {
                                Some(true)
                            } else if has_reasoning && reasoning_capability_error {
                                Some(false)
                            } else {
                                cached.reasoning
                            },
                            at: now_ms(),
                        },
                    );
                }
                value = Some(result);
                break;
            }
            Err(error) if error.contains("(400)") => {
                let (structured_error, reasoning_error) = capability_error_dimensions(&error);
                structured_capability_error |= structured_error;
                reasoning_capability_error |= reasoning_error;
                last_error = Some(error);
            }
            Err(error) => return Err(error),
        }
    }
    let value =
        value.ok_or_else(|| last_error.unwrap_or_else(|| "上游不支持当前请求格式 (400)".into()))?;
    let output = if config.api_style == "responses" {
        response_text(&value)
    } else {
        content_text(value.pointer("/choices/0/message/content"))
    };
    parse_model_json(&output)
}

fn response_schema(payload: &Value) -> Value {
    if payload.get("mode").and_then(Value::as_str) == Some("followup") {
        json!({
            "name": "shici_followup",
            "schema": {"type":"object","additionalProperties":false,"properties":{"type":{"type":"string"},"answer":{"type":"string"},"summary":{"type":"string"}},"required":["type","answer","summary"]}
        })
    } else {
        json!({
            "name": "shici_entry",
            "schema": {"type":"object","additionalProperties":false,"properties":{
                "type":{"type":"string"},"kind":{"type":"string","enum":["word","word_list","phrase","sentence","other"]},"displayText":{"type":"string"},"correction":{"type":"string"},"pronunciation":{"type":"string"},"meaning":{"type":"string"},"context":{"type":"string"},"difficulty":{"type":"number","minimum":1,"maximum":5},
                "words":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"original":{"type":"string"},"correction":{"type":"string"},"pronunciation":{"type":"string"},"meaning":{"type":"string"},"context":{"type":"string"},"usage":{"type":"array","items":{"type":"string"}},"difficulty":{"type":"number","minimum":1,"maximum":5}},"required":["text","original","correction","pronunciation","meaning","context","usage","difficulty"]}},
                "usage":{"type":"array","items":{"type":"string"}},"chunks":{"type":"array","items":{"type":"object","additionalProperties":false,"properties":{"text":{"type":"string"},"meaning":{"type":"string"}},"required":["text","meaning"]}},"memoryCue":{"type":"string"}
            },"required":["type","kind","displayText","correction","pronunciation","meaning","context","difficulty","words","usage","chunks","memoryCue"]}
        })
    }
}

fn parse_sse(raw: &str) -> Value {
    let mut response_text = String::new();
    let mut chat_text = String::new();
    for line in raw.lines().filter(|line| line.starts_with("data:")) {
        let chunk = line.trim_start_matches("data:").trim();
        if chunk.is_empty() || chunk == "[DONE]" {
            continue;
        }
        let Ok(event) = serde_json::from_str::<Value>(chunk) else {
            continue;
        };
        if event.get("type").and_then(Value::as_str) == Some("response.output_text.delta") {
            response_text.push_str(event.get("delta").and_then(Value::as_str).unwrap_or(""));
        }
        chat_text.push_str(
            event
                .pointer("/choices/0/delta/content")
                .and_then(Value::as_str)
                .unwrap_or(""),
        );
        if event.get("type").and_then(Value::as_str) == Some("response.completed") {
            if let Some(response) = event.get("response") {
                return response.clone();
            }
        }
    }
    if !response_text.is_empty() {
        json!({"output_text":response_text})
    } else {
        json!({"choices":[{"message":{"content":chat_text}}]})
    }
}

async fn explain_cancellable_with_client(
    client: &reqwest::Client,
    payload: &Value,
    config: &AiConfig,
    mut cancellation: Option<watch::Receiver<bool>>,
) -> Result<Value, String> {
    if cancellation
        .as_ref()
        .is_some_and(|receiver| *receiver.borrow())
    {
        return Err("请求已暂停".into());
    }
    match cancellation.as_mut() {
        Some(receiver) => tokio::select! {
            result = explain_with_client(client, payload, config) => result,
            _ = receiver.changed() => Err("请求已暂停".into()),
        },
        None => explain_with_client(client, payload, config).await,
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

fn stable_jitter(id: &str) -> f64 {
    let mut hash = 2_166_136_261_u32;
    for byte in id.as_bytes() {
        hash ^= u32::from(*byte);
        hash = hash.wrapping_mul(16_777_619);
    }
    0.9 + f64::from(hash % 21) / 100.0
}

fn schedule_review(review: &Value, grade: &str, id: &str) -> Value {
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
    let mut interval = interval;
    if repetitions > 1 && grade != "again" {
        interval *= stable_jitter(id);
    }
    interval = (interval * 100.0).round() / 100.0;
    json!({"dueAt":now + interval * DAY_MS,"intervalDays":interval,"ease":(ease*100.0).round()/100.0,"repetitions":repetitions,"lapses":lapses,"leech":lapses >= 8,"lastReviewedAt":now,"lastGrade":grade})
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
    let mut clean = value.replace("<think>", "");
    if let Some(index) = clean.find("</think>") {
        clean.replace_range(..index + "</think>".len(), "");
    }
    let mut clean = clean.trim();
    if let Some(value) = clean.strip_prefix("```json") {
        clean = value.trim();
    } else if let Some(value) = clean.strip_prefix("```") {
        clean = value.trim();
    }
    if let Some(value) = clean.strip_suffix("```") {
        clean = value.trim();
    }
    if let Some(start) = clean.find(['{', '[']) {
        clean = &clean[start..];
    }
    let mut depth = 0_i32;
    let mut quoted = false;
    let mut escaped = false;
    let mut end = None;
    for (index, character) in clean.char_indices() {
        if quoted {
            if escaped {
                escaped = false;
            } else if character == '\\' {
                escaped = true;
            } else if character == '"' {
                quoted = false;
            }
            continue;
        }
        if character == '"' {
            quoted = true;
        } else if matches!(character, '{' | '[') {
            depth += 1;
        } else if matches!(character, '}' | ']') {
            depth -= 1;
            if depth == 0 {
                end = Some(index + character.len_utf8());
                break;
            }
        }
    }
    if let Some(end) = end {
        clean = &clean[..end];
    }
    serde_json::from_str(clean)
        .map_err(|error| status_error(502, &format!("模型返回了无法解析的 JSON：{error}")))
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

fn status_error(status: u16, message: &str) -> String {
    format!("[shici-status:{status}] {message}")
}

fn error_message(message: &str) -> String {
    message
        .strip_prefix("[shici-status:")
        .and_then(|value| value.split_once("] "))
        .map_or_else(|| message.to_string(), |(_, message)| message.to_string())
}

fn error_status(message: &str) -> u16 {
    if let Some(status) = message
        .strip_prefix("[shici-status:")
        .and_then(|value| value.split_once(']'))
        .and_then(|(status, _)| status.parse::<u16>().ok())
    {
        return status;
    }
    if message == "请求已暂停" {
        499
    } else if message.contains("没有找到") {
        404
    } else if message.contains("请输入")
        || message.contains("格式不正确")
        || message.contains("Base URL")
        || message.contains("请填写")
        || message.contains("API 方式")
    {
        400
    } else {
        502
    }
}

#[tauri::command]
async fn api_request(
    request: ApiRequest,
    state: State<'_, AppState>,
) -> Result<ApiResponse, String> {
    let request_id = request.request_id.clone();
    let cancellation = if request_id.is_empty() {
        None
    } else {
        let already_cancelled = state
            .cancellations
            .lock()
            .map_err(|_| "取消状态不可用")?
            .remove(&request_id)
            .is_some_and(|sender| *sender.borrow());
        let (sender, receiver) = watch::channel(already_cancelled);
        state
            .cancellations
            .lock()
            .map_err(|_| "取消状态不可用")?
            .insert(request_id.clone(), sender);
        Some(receiver)
    };
    let method = request.method.to_uppercase();
    let path = request.url.split('?').next().unwrap_or("").to_string();
    let result = if path == "/api/entries" && method == "POST" {
        let force_new = boolean(request.body.get("forceNew"), false);
        let duplicate = if force_new {
            None
        } else {
            let backend = state.backend.lock().await;
            let fragment = text(request.body.get("text"), 5_000);
            backend.duplicate_entry(&fragment)
        };
        if let Some(entry) = duplicate {
            Ok((
                200,
                json!({"entry":entry.clone(),"entries":[entry],"duplicate":true,"demo":false}),
            ))
        } else {
            let (fragment, source, payload, config, client) = {
                let backend = state.backend.lock().await;
                let (fragment, source, payload, config) =
                    backend.prepare_new_entry(&request.body)?;
                (fragment, source, payload, config, backend.client.clone())
            };
            let generated =
                explain_cancellable_with_client(&client, &payload, &config, cancellation).await;
            let mut backend = state.backend.lock().await;
            generated.and_then(|result| {
                backend
                    .commit_new_entry(fragment, source, result, &config, force_new)
                    .map(|body| (200, body))
            })
        }
    } else if method == "POST" && path.starts_with("/api/entries/") && path.ends_with("/followups")
    {
        let id = path
            .trim_start_matches("/api/entries/")
            .trim_end_matches("/followups")
            .trim_end_matches('/')
            .to_string();
        let (question, payload, config, client) = {
            let backend = state.backend.lock().await;
            let (question, payload, config) = backend.prepare_followup(&id, &request.body)?;
            (question, payload, config, backend.client.clone())
        };
        let generated =
            explain_cancellable_with_client(&client, &payload, &config, cancellation).await;
        let mut backend = state.backend.lock().await;
        generated.and_then(|result| {
            backend
                .commit_followup(&id, question, result, &config)
                .map(|body| (201, body))
        })
    } else {
        let mut backend = state.backend.lock().await;
        backend.handle(request, cancellation).await
    };
    if !request_id.is_empty() {
        state
            .cancellations
            .lock()
            .map_err(|_| "取消状态不可用")?
            .remove(&request_id);
    }
    Ok(match result {
        Ok((status, body)) => ApiResponse { status, body },
        Err(message) => ApiResponse {
            status: error_status(&message),
            body: json!({"error":error_message(&message)}),
        },
    })
}

#[tauri::command]
fn cancel_request(request_id: String, state: State<'_, AppState>) -> bool {
    let Ok(mut cancellations) = state.cancellations.lock() else {
        return false;
    };
    if let Some(sender) = cancellations.get(&request_id) {
        sender.send(true).is_ok()
    } else {
        if cancellations.len() >= 100 {
            cancellations.retain(|_, sender| sender.receiver_count() > 0);
        }
        let (sender, _) = watch::channel(true);
        cancellations.insert(request_id, sender);
        true
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let backend = Backend::new(data_dir).map_err(std::io::Error::other)?;
            app.manage(AppState {
                backend: Mutex::new(backend),
                cancellations: StdMutex::new(HashMap::new()),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![api_request, cancel_request])
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
            schedule_review(&review, "again", "entry-a")["intervalDays"],
            json!(0.01)
        );
        assert_eq!(
            schedule_review(&review, "good", "entry-a")["intervalDays"],
            json!(1.0)
        );
        assert_eq!(
            schedule_review(&review, "easy", "entry-a")["intervalDays"],
            json!(4.0)
        );
        let repeated = json!({"ease":2.5,"repetitions":2,"lapses":0,"intervalDays":3});
        assert_ne!(
            schedule_review(&repeated, "good", "entry-a")["intervalDays"],
            schedule_review(&repeated, "good", "entry-b")["intervalDays"]
        );
    }

    #[test]
    fn fragment_kinds_keep_words_separate_from_phrases() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("../../test/fixtures/fragment-cases.json")).unwrap();
        for case in cases {
            assert_eq!(
                infer_kind(text(case.get("text"), 5_000).as_str(), ""),
                text(case.get("kind"), 24)
            );
        }
    }

    #[test]
    fn legacy_full_sentence_correction_is_promoted() {
        let entry = clean_entry(&json!({
            "raw":"her foodsteps hurried as she all but fled the room",
            "displayText":"her foodsteps hurried as she all but fled the room",
            "correction":"her footsteps hurried as she all but fled the room",
            "pronunciation":"old sentence pronunciation",
            "kind":"sentence"
        }))
        .unwrap();
        assert_eq!(
            entry["displayText"],
            json!("her footsteps hurried as she all but fled the room")
        );
        assert_eq!(entry["correction"], json!("foodsteps → footsteps"));
        assert_eq!(entry["pronunciation"], json!(""));
    }

    #[test]
    fn word_list_claims_original_tokens_without_index_assumptions() {
        let mut used = std::collections::HashSet::new();
        let original = word_parts("cherry, apple, banana");
        assert_eq!(claim_original(&original, &mut used, "apple", ""), "apple");
        assert_eq!(claim_original(&original, &mut used, "banana", ""), "banana");
        assert_eq!(claim_original(&original, &mut used, "cherry", ""), "cherry");

        let mut used = std::collections::HashSet::new();
        let original = word_parts("running, jumped");
        assert_eq!(
            claim_original(&original, &mut used, "run", "running"),
            "running"
        );
        assert_eq!(
            claim_original(&original, &mut used, "jump", "jumped"),
            "jumped"
        );
        assert_eq!(normalize_word_correction("jumped", "jump", ""), "");
        assert_eq!(
            normalize_word_correction("betta", "beta", "betta → beta"),
            "betta → beta"
        );
    }

    #[test]
    fn words_are_capitalized_during_cleanup() {
        let entry = clean_entry(&json!({
            "raw":"sloppy", "kind":"word", "displayText":"sloppy", "meaning":"草率的",
            "words":[{"text":"sloppy","pronunciation":"/test/","meaning":"草率的"}]
        }))
        .unwrap();
        assert_eq!(entry["raw"], json!("sloppy"));
        assert_eq!(entry["displayText"], json!("Sloppy"));
        assert_eq!(entry["words"][0]["text"], json!("Sloppy"));
    }

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

    #[test]
    fn sse_deltas_are_aggregated() {
        let value = parse_sse(
            "data: {\"type\":\"response.output_text.delta\",\"delta\":\"hello\"}\ndata: [DONE]\n",
        );
        assert_eq!(value["output_text"], json!("hello"));
    }

    #[test]
    fn qwen_wrapped_json_is_parsed() {
        let value =
            parse_model_json("<think>先判断类型</think>\n```json\n{\"type\":\"entry\"}\n```")
                .unwrap();
        assert_eq!(value["type"], json!("entry"));
    }
}
