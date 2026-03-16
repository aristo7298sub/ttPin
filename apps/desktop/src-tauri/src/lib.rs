use tauri::Manager;
use tauri::{
  menu::{Menu, MenuItem},
  tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent},
};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, ShortcutState};

use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};

use base64::Engine;

// ── Entra ID token cache (client-credentials) ──────────────────────────────

#[derive(Clone, Debug)]
struct TokenCache {
  access_token: String,
  expires_at: u64, // unix epoch seconds
  // Credentials needed for auto-refresh
  tenant_id: String,
  client_id: String,
  client_secret: String,
}

static TOKEN_CACHE: OnceLock<Mutex<Option<TokenCache>>> = OnceLock::new();

fn token_cache() -> &'static Mutex<Option<TokenCache>> {
  TOKEN_CACHE.get_or_init(|| Mutex::new(None))
}

fn now_epoch_secs() -> u64 {
  SystemTime::now()
    .duration_since(UNIX_EPOCH)
    .unwrap_or_default()
    .as_secs()
}

/// Return a valid client-credentials token, re-acquiring if expired (60s grace).
async fn get_valid_token() -> Result<String, String> {
  let snapshot = {
    let guard = token_cache().lock().map_err(|_| "Token cache poisoned")?;
    guard.clone()
  };

  let cache = snapshot.ok_or("No Entra token available. Please acquire a client-credentials token first.")?;

  if now_epoch_secs() + 60 < cache.expires_at {
    return Ok(cache.access_token.clone());
  }

  // Token expired – re-acquire via client-credentials
  let new_cache = client_credentials_request(&cache.tenant_id, &cache.client_id, &cache.client_secret).await?;
  let token = new_cache.access_token.clone();
  let mut guard = token_cache().lock().map_err(|_| "Token cache poisoned")?;
  *guard = Some(new_cache);
  Ok(token)
}

// ── Entra ID HTTP helpers ───────────────────────────────────────────────────

const ENTRA_SCOPE: &str = "https://cognitiveservices.azure.com/.default";

async fn client_credentials_request(
  tenant_id: &str,
  client_id: &str,
  client_secret: &str,
) -> Result<TokenCache, String> {
  let url = format!(
    "https://login.microsoftonline.com/{}/oauth2/v2.0/token",
    tenant_id
  );
  let params = [
    ("grant_type", "client_credentials"),
    ("client_id", client_id),
    ("client_secret", client_secret),
    ("scope", ENTRA_SCOPE),
  ];

  let client = reqwest::Client::new();
  let resp = client
    .post(&url)
    .form(&params)
    .send()
    .await
    .map_err(|e| format!("Entra token request failed: {e}"))?;

  let status = resp.status();
  let body: serde_json::Value = resp
    .json()
    .await
    .map_err(|e| format!("Entra token response read failed: {e}"))?;

  if !status.is_success() {
    let desc = body["error_description"]
      .as_str()
      .unwrap_or("unknown error");
    return Err(format!("Entra token failed ({status}): {desc}"));
  }

  let access_token = body["access_token"]
    .as_str()
    .ok_or("Missing access_token in Entra response")?
    .to_string();
  let expires_in = body["expires_in"].as_u64().unwrap_or(3600);

  Ok(TokenCache {
    access_token,
    expires_at: now_epoch_secs() + expires_in,
    tenant_id: tenant_id.to_string(),
    client_id: client_id.to_string(),
    client_secret: client_secret.to_string(),
  })
}

// ── Azure CLI token cache ───────────────────────────────────────────────────

struct AzCliCachedToken {
  token: String,
  expires_on: u64,
}

static AZ_CLI_TOKEN_CACHE: OnceLock<Mutex<Option<AzCliCachedToken>>> = OnceLock::new();
static STS_TOKEN_CACHE: OnceLock<Mutex<Option<AzCliCachedToken>>> = OnceLock::new();

/// Obtain an AAD token for Azure Cognitive Services via Azure CLI.
/// Tokens are cached and automatically refreshed 5 minutes before expiry.
fn get_aad_token_sync() -> Result<String, String> {
  let cache = AZ_CLI_TOKEN_CACHE.get_or_init(|| Mutex::new(None));

  // Check cache
  {
    let guard = cache.lock().map_err(|e| format!("Token cache lock error: {e}"))?;
    if let Some(cached) = guard.as_ref() {
      if now_epoch_secs() + 300 < cached.expires_on {
        return Ok(cached.token.clone());
      }
    }
  }

  // Get new token via Azure CLI.
  // On Windows, `az` is actually `az.cmd` so we must run it through `cmd /C`.
  let output = if cfg!(target_os = "windows") {
    std::process::Command::new("cmd")
      .args([
        "/C",
        "az",
        "account",
        "get-access-token",
        "--resource",
        "https://cognitiveservices.azure.com",
        "--output",
        "json",
      ])
      .output()
  } else {
    std::process::Command::new("az")
      .args([
        "account",
        "get-access-token",
        "--resource",
        "https://cognitiveservices.azure.com",
        "--output",
        "json",
      ])
      .output()
  }
  .map_err(|e| {
    format!(
      "Failed to run 'az' CLI: {e}. Please install Azure CLI and run 'az login'."
    )
  })?;

  if !output.status.success() {
    let stderr = String::from_utf8_lossy(&output.stderr);
    return Err(format!(
      "Azure CLI failed: {stderr}. Please run 'az login' first."
    ));
  }

  let json: serde_json::Value = serde_json::from_slice(&output.stdout)
    .map_err(|e| format!("Failed to parse az cli output: {e}"))?;

  let token = json
    .get("accessToken")
    .and_then(|v| v.as_str())
    .ok_or("Missing accessToken in az cli output")?
    .to_string();

  let expires_on = json
    .get("expires_on")
    .and_then(|v| v.as_str())
    .and_then(|s| s.parse::<u64>().ok())
    .or_else(|| json.get("expires_on").and_then(|v| v.as_u64()))
    .unwrap_or_else(|| now_epoch_secs() + 3600);

  // Cache the token
  {
    let mut guard = cache.lock().map_err(|e| format!("Token cache lock error: {e}"))?;
    *guard = Some(AzCliCachedToken {
      token: token.clone(),
      expires_on,
    });
  }

  Ok(token)
}

/// Exchange an AAD token for a short-lived STS token via the resource's issueToken endpoint.
/// Required for Speech (TTS) service. Cached for 8 minutes (STS tokens last ~10 min).
async fn get_sts_token(translate_endpoint: &str) -> Result<String, String> {
  let cache = STS_TOKEN_CACHE.get_or_init(|| Mutex::new(None));

  // Check cache (STS tokens expire in ~10 min, refresh at 8 min)
  {
    let guard = cache.lock().map_err(|e| format!("STS cache lock error: {e}"))?;
    if let Some(cached) = guard.as_ref() {
      if now_epoch_secs() < cached.expires_on {
        return Ok(cached.token.clone());
      }
    }
  }

  let aad_token = get_aad_token_sync()?;

  // Normalize endpoint to .cognitiveservices.azure.com
  let base = translate_endpoint
    .trim()
    .trim_end_matches('/')
    .replace(".services.ai.azure.com", ".cognitiveservices.azure.com")
    .split("/translator")
    .next()
    .unwrap_or(translate_endpoint)
    .to_string();

  let sts_url = format!("{base}/sts/v1.0/issueToken");

  let client = reqwest::Client::new();
  let resp = client
    .post(&sts_url)
    .header("Authorization", format!("Bearer {aad_token}"))
    .header("Content-Length", "0")
    .send()
    .await
    .map_err(|e| format!("STS token exchange failed: {e}"))?;

  let status = resp.status();
  let sts_token = resp.text().await.map_err(|e| format!("STS read failed: {e}"))?;

  if !status.is_success() {
    return Err(format!("STS issueToken failed: {status}. {sts_token}"));
  }

  // Cache for 8 minutes
  let expires_on = now_epoch_secs() + 480;

  {
    let mut guard = cache.lock().map_err(|e| format!("STS cache lock error: {e}"))?;
    *guard = Some(AzCliCachedToken {
      token: sts_token.clone(),
      expires_on,
    });
  }

  Ok(sts_token)
}

// ── Entra ID / Azure CLI Tauri commands ─────────────────────────────────────

#[derive(serde::Deserialize)]
struct EntraClientCredentialsArgs {
  tenant_id: String,
  client_id: String,
  client_secret: String,
}

#[tauri::command]
async fn entra_acquire_token_client_credentials(
  args: EntraClientCredentialsArgs,
) -> Result<(), String> {
  let cache = client_credentials_request(&args.tenant_id, &args.client_id, &args.client_secret).await?;
  let mut guard = token_cache().lock().map_err(|_| "Token cache poisoned")?;
  *guard = Some(cache);
  Ok(())
}

#[tauri::command]
fn az_cli_check_login() -> Result<bool, String> {
  match get_aad_token_sync() {
    Ok(_) => Ok(true),
    Err(e) => Err(e),
  }
}

#[tauri::command]
fn entra_clear_token() {
  if let Ok(mut guard) = token_cache().lock() {
    *guard = None;
  }
}

#[tauri::command]
fn entra_token_status() -> bool {
  if let Ok(guard) = token_cache().lock() {
    if let Some(ref cache) = *guard {
      return now_epoch_secs() + 60 < cache.expires_at;
    }
  }
  false
}

#[derive(serde::Deserialize, serde::Serialize)]
struct TranslatorTarget {
  language: String,
  #[serde(rename = "deploymentName")]
  #[serde(skip_serializing_if = "Option::is_none")]
  deployment_name: Option<String>,
}

#[derive(serde::Deserialize, serde::Serialize)]
struct TranslatorInput {
  text: String,
  #[serde(skip_serializing_if = "Option::is_none")]
  language: Option<String>,
  targets: Vec<TranslatorTarget>,
}

#[derive(serde::Deserialize)]
struct TranslateArgs {
  translate_endpoint: String,
  key: Option<String>,
  region: Option<String>,
  deployment_name: String,
  text: String,
  from: Option<String>,
  to: String,
  auth_mode: Option<String>, // "key" (default) | "entra"
}

#[derive(serde::Serialize)]
struct TranslateResult {
  translated_text: String,
  detected_language: Option<String>,
}

#[derive(serde::Deserialize)]
struct LanguagesArgs {
  languages_endpoint: Option<String>,
}

fn with_api_version(mut base: reqwest::Url, api_version: &str) -> reqwest::Url {
  let mut pairs: Vec<(String, String)> = base
    .query_pairs()
    .map(|(k, v)| (k.to_string(), v.to_string()))
    .collect();

  if !pairs.iter().any(|(k, _)| k == "api-version") {
    pairs.push(("api-version".to_string(), api_version.to_string()));
  }

  base.set_query(None);
  base.query_pairs_mut().extend_pairs(pairs);
  base
}

#[tauri::command]
async fn translator_languages(args: LanguagesArgs) -> Result<serde_json::Value, String> {
  let endpoint = args
    .languages_endpoint
    .unwrap_or_else(|| "https://api.cognitive.microsofttranslator.com/languages".to_string());

  let base = reqwest::Url::parse(&endpoint).map_err(|e| format!("Invalid languages endpoint: {e}"))?;
  let url = {
    let mut url = with_api_version(base, "2025-10-01-preview");
    // ensure scope=translation
    let mut pairs: Vec<(String, String)> = url
      .query_pairs()
      .map(|(k, v)| (k.to_string(), v.to_string()))
      .collect();
    if !pairs.iter().any(|(k, _)| k == "scope") {
      pairs.push(("scope".to_string(), "translation".to_string()));
    }
    url.set_query(None);
    url.query_pairs_mut().extend_pairs(pairs);
    url
  };

  let client = reqwest::Client::new();
  let resp = client.get(url).send().await.map_err(|e| format!("Request failed: {e}"))?;
  let status = resp.status();
  let text = resp.text().await.map_err(|e| format!("Read response failed: {e}"))?;

  if !status.is_success() {
    return Err(format!("Languages request failed: {status}. {text}"));
  }

  serde_json::from_str(&text).map_err(|e| format!("Invalid JSON: {e}"))
}

#[tauri::command]
async fn translator_translate(args: TranslateArgs) -> Result<TranslateResult, String> {
  let auth = args.auth_mode.as_deref().unwrap_or("key");

  // For az-cli mode, use the v3.0 Translator API at cognitiveservices.azure.com with Bearer token.
  // The preview API path (/translator/text/translate) does NOT accept Bearer tokens — only
  // the standard v3.0 path works with AAD auth. This matches the reference repo approach.
  // Note: v3.0 does not support deploymentName (LLM); it uses standard NMT translation.
  if auth == "az-cli" {
    let endpoint = args.translate_endpoint.trim().trim_end_matches('/');
    let base_endpoint = endpoint
      .replace(".services.ai.azure.com", ".cognitiveservices.azure.com")
      .split("/translator")
      .next()
      .unwrap_or(endpoint)
      .to_string();

    // v3.0 URL: {base}/translator/text/v3.0/translate?to={to}[&from={from}]
    let mut url_str = format!(
      "{base_endpoint}/translator/text/v3.0/translate?to={}", args.to
    );

    if let Some(ref from) = args.from {
      let from = from.trim();
      if !from.is_empty() && from.to_lowercase() != "auto" {
        url_str.push_str(&format!("&from={from}"));
      }
    }

    let bearer_token = get_aad_token_sync()?;

    // v3.0 body: [{"Text": "..."}]
    let payload = serde_json::json!([{ "Text": args.text }]);

    let client = reqwest::Client::new();
    let resp = client
      .post(&url_str)
      .header("content-type", "application/json; charset=utf-8")
      .header("Authorization", format!("Bearer {bearer_token}"))
      .json(&payload)
      .send()
      .await
      .map_err(|e| format!("Request failed: {e}"))?;

    let resp_status = resp.status();
    let resp_text = resp.text().await.map_err(|e| format!("Read response failed: {e}"))?;

    if !resp_status.is_success() {
      return Err(format!("Translate request failed: {resp_status}. {resp_text}"));
    }

    // v3.0 response: [{"detectedLanguage":{"language":"en","score":1.0},"translations":[{"text":"...","to":"zh-Hans"}]}]
    let data: serde_json::Value = serde_json::from_str(&resp_text).map_err(|e| format!("Invalid JSON: {e}"))?;
    let translated_text = data
      .get(0)
      .and_then(|v| v.get("translations"))
      .and_then(|v| v.get(0))
      .and_then(|v| v.get("text"))
      .and_then(|v| v.as_str())
      .ok_or_else(|| "Translate response missing [0].translations[0].text".to_string())?
      .to_string();

    let detected_language = data
      .get(0)
      .and_then(|v| v.get("detectedLanguage"))
      .and_then(|v| v.get("language"))
      .and_then(|v| v.as_str())
      .map(|s| s.to_string());

    return Ok(TranslateResult {
      translated_text,
      detected_language,
    });
  }

  // key / entra modes: use the preview API as before
  let base = reqwest::Url::parse(&args.translate_endpoint)
    .map_err(|e| format!("Invalid translate endpoint: {e}"))?;
  let url = with_api_version(base, "2025-10-01-preview");

  let auth = args.auth_mode.as_deref().unwrap_or("key");

  let mut input = TranslatorInput {
    text: args.text.clone(),
    language: None,
    targets: vec![TranslatorTarget {
      language: args.to.clone(),
      deployment_name: Some(args.deployment_name.clone()),
    }],
  };

  if let Some(from) = args.from.clone() {
    let from = from.trim().to_string();
    if !from.is_empty() && from.to_lowercase() != "auto" {
      input.language = Some(from);
    }
  }

  let client = reqwest::Client::new();

  async fn do_request(
    client: &reqwest::Client,
    url: reqwest::Url,
    key: Option<&str>,
    region: Option<&str>,
    input: &TranslatorInput,
    bearer_token: Option<&str>,
  ) -> Result<(reqwest::StatusCode, String), String> {
    let payload = serde_json::json!({ "inputs": [input] });
    let mut req = client
      .post(url)
      .header("content-type", "application/json");

    if let Some(token) = bearer_token {
      req = req.header("authorization", format!("Bearer {}", token));
    } else {
      if let Some(k) = key {
        req = req.header("ocp-apim-subscription-key", k);
      }
      if let Some(r) = region {
        req = req.header("ocp-apim-subscription-region", r);
      }
    }

    let resp = req
      .json(&payload)
      .send()
      .await
      .map_err(|e| format!("Request failed: {e}"))?;

    let status = resp.status();
    let text = resp.text().await.map_err(|e| format!("Read response failed: {e}"))?;
    Ok((status, text))
  }

  let bearer_token = match auth {
    "entra" => Some(get_valid_token().await?),
    "az-cli" => Some(get_aad_token_sync()?),
    _ => None,
  };

  let (mut status, mut text) = do_request(
    &client,
    url.clone(),
    args.key.as_deref(),
    args.region.as_deref(),
    &input,
    bearer_token.as_deref(),
  )
  .await?;

  // Some language pairs may reject an explicit source language; retry once without it.
  if status == reqwest::StatusCode::BAD_REQUEST && input.language.is_some() {
    let mut input2 = input;
    input2.language = None;
    let retry = do_request(
      &client,
      url.clone(),
      args.key.as_deref(),
      args.region.as_deref(),
      &input2,
      bearer_token.as_deref(),
    )
    .await;
    if let Ok((st, tx)) = retry {
      status = st;
      text = tx;
    }
  }

  if !status.is_success() {
    return Err(format!("Translate request failed: {status}. {text}"));
  }

  let data: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("Invalid JSON: {e}"))?;
  let translated_text = data
    .get("value")
    .and_then(|v| v.get(0))
    .and_then(|v| v.get("translations"))
    .and_then(|v| v.get(0))
    .and_then(|v| v.get("text"))
    .and_then(|v| v.as_str())
    .ok_or_else(|| "Translate response missing value[0].translations[0].text".to_string())?
    .to_string();

  let detected_language = data
    .get("value")
    .and_then(|v| v.get(0))
    .and_then(|v| v.get("detectedLanguage"))
    .and_then(|v| v.get("language"))
    .and_then(|v| v.as_str())
    .map(|s| s.to_string());

  Ok(TranslateResult {
    translated_text,
    detected_language,
  })
}

#[tauri::command]
fn set_always_on_top(window: tauri::WebviewWindow, enabled: bool) -> Result<(), String> {
  window
    .set_always_on_top(enabled)
    .map_err(|e| format!("Failed to set always-on-top: {e}"))
}

#[derive(serde::Deserialize)]
struct TtsSynthesizeArgs {
  region: String,
  key: Option<String>,
  /// Preferred language/locale (e.g. "zh-CN", "en-US", "en").
  lang: String,
  text: String,
  auth_mode: Option<String>,          // "key" (default) | "entra" | "az-cli"
  resource_id: Option<String>,         // Required for Entra client-credentials TTS
  translate_endpoint: Option<String>,  // Required for az-cli TTS (STS token exchange)
}

#[derive(serde::Serialize)]
struct TtsSynthesizeResult {
  audio_base64: String,
  locale: String,
  voice: String,
}

#[derive(Clone, serde::Deserialize)]
struct TtsVoice {
  #[serde(rename = "ShortName")]
  short_name: String,
  #[serde(rename = "Locale")]
  locale: String,
}

static VOICES_CACHE: OnceLock<Mutex<HashMap<String, Vec<TtsVoice>>>> = OnceLock::new();

fn xml_escape_text(input: &str) -> String {
  // Minimal XML escaping for text nodes.
  input
    .replace('&', "&amp;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

fn xml_escape_attr(input: &str) -> String {
  // Minimal XML escaping for attribute values.
  input
    .replace('&', "&amp;")
    .replace('"', "&quot;")
    .replace('<', "&lt;")
    .replace('>', "&gt;")
}

fn normalize_region(input: &str) -> String {
  input.trim().to_lowercase()
}

fn normalize_lang_or_locale(input: &str) -> (String, String) {
  // Returns (preferred_locale, preferred_lang_prefix)
  let raw = input.trim();
  if raw.is_empty() {
    return ("en-US".to_string(), "en".to_string());
  }

  // If it's already like en-US or zh-CN, keep as locale.
  if raw.contains('-') && raw.len() >= 4 {
    let parts: Vec<&str> = raw.split('-').collect();
    let lang = parts[0].to_lowercase();
    // Preserve original casing for locale-ish strings.
    return (raw.to_string(), lang);
  }

  let lang = raw.to_lowercase();
  (lang.clone(), lang)
}

async fn fetch_tts_voices(region: &str, key: Option<&str>, bearer_token: Option<&str>) -> Result<Vec<TtsVoice>, String> {
  let region = normalize_region(region);
  let url = format!(
    "https://{region}.tts.speech.microsoft.com/cognitiveservices/voices/list"
  );

  let client = reqwest::Client::new();
  let mut req = client.get(url);

  if let Some(token) = bearer_token {
    req = req.header("authorization", format!("Bearer {}", token));
  } else if let Some(k) = key {
    req = req.header("ocp-apim-subscription-key", k);
  }

  let resp = req
    .send()
    .await
    .map_err(|e| format!("TTS voices request failed: {e}"))?;

  let status = resp.status();
  let text = resp
    .text()
    .await
    .map_err(|e| format!("TTS voices read response failed: {e}"))?;

  if !status.is_success() {
    return Err(format!("TTS voices request failed: {status}. {text}"));
  }

  let voices: Vec<TtsVoice> = serde_json::from_str(&text).map_err(|e| format!("Invalid voices JSON: {e}"))?;
  Ok(voices)
}

fn pick_default_voice<'a>(voices: &'a [TtsVoice], preferred: &str) -> Option<&'a TtsVoice> {
  let (preferred_locale, preferred_lang) = normalize_lang_or_locale(preferred);
  let preferred_locale_lc = preferred_locale.to_lowercase();
  let preferred_lang_lc = preferred_lang.to_lowercase();

  // Per requirement: pick the first voice for that language from the API response.
  // 1) Exact locale match
  if let Some(v) = voices.iter().find(|v| v.locale.to_lowercase() == preferred_locale_lc) {
    return Some(v);
  }

  // 2) Locale starts with language prefix (e.g., en-*)
  let prefix = format!("{}-", preferred_lang_lc);
  if let Some(v) = voices.iter().find(|v| v.locale.to_lowercase().starts_with(&prefix)) {
    return Some(v);
  }

  // 3) Fallback: first available
  voices.first()
}

#[tauri::command]
async fn tts_synthesize(args: TtsSynthesizeArgs) -> Result<TtsSynthesizeResult, String> {
  let key = args.key.as_deref().map(|s| s.trim()).unwrap_or("");
  let region = args.region.trim();
  let text = args.text.trim();
  let auth = args.auth_mode.as_deref().unwrap_or("key");

  if auth == "key" && key.is_empty() {
    return Err("Missing subscription key".to_string());
  }
  if region.is_empty() {
    return Err("Missing region".to_string());
  }
  if text.is_empty() {
    return Err("Text is empty".to_string());
  }

  let region_norm = normalize_region(region);

  // Build the TTS bearer token based on auth mode
  let tts_bearer = match auth {
    "entra" => {
      // Client-credentials: use aad#<resource_id>#<token> format
      let resource_id = args
        .resource_id
        .as_deref()
        .ok_or("Resource ID is required for Entra TTS authentication")?;
      let token = get_valid_token().await?;
      Some(format!("aad#{}#{}", resource_id.trim(), token))
    }
    "az-cli" => {
      // Azure CLI: exchange AAD token for STS token via issueToken endpoint
      let endpoint = args
        .translate_endpoint
        .as_deref()
        .ok_or("Translate endpoint is required for Azure CLI TTS authentication")?;
      let sts_token = get_sts_token(endpoint).await?;
      Some(sts_token)
    }
    _ => None,
  };

  // Get voices from cache or fetch.
  let cache = VOICES_CACHE.get_or_init(|| Mutex::new(HashMap::new()));
  let cached = {
    let guard = cache.lock().map_err(|_| "Voices cache poisoned".to_string())?;
    guard.get(&region_norm).cloned()
  };

  let voices = if let Some(v) = cached {
    v
  } else {
    let key_opt = if key.is_empty() { None } else { Some(key) };
    let v = fetch_tts_voices(&region_norm, key_opt, tts_bearer.as_deref()).await?;
    let mut guard = cache.lock().map_err(|_| "Voices cache poisoned".to_string())?;
    guard.insert(region_norm.clone(), v.clone());
    v
  };

  let voice = pick_default_voice(&voices, &args.lang).ok_or_else(|| "No available TTS voices".to_string())?;
  let chosen_locale = voice.locale.clone();
  let chosen_voice = voice.short_name.clone();

  // Azure examples commonly use lowercase for xml:lang (e.g. "zh-cn").
  // The value is case-insensitive per BCP-47, but normalizing helps avoid strict parsers.
  let speak_lang = chosen_locale.to_lowercase();

  let ssml = format!(
    "<speak xmlns=\"http://www.w3.org/2001/10/synthesis\" xmlns:mstts=\"http://www.w3.org/2001/mstts\" xmlns:emo=\"http://www.w3.org/2009/10/emotionml\" version=\"1.0\" xml:lang=\"{}\"><voice name=\"{}\">{}</voice></speak>",
    xml_escape_attr(&speak_lang),
    xml_escape_attr(&chosen_voice),
    xml_escape_text(text)
  );

  let url = format!(
    "https://{region}.tts.speech.microsoft.com/cognitiveservices/v1",
    region = region_norm
  );

  let client = reqwest::Client::new();
  let mut req = client
    .post(url)
    .header("content-type", "application/ssml+xml")
    .header("x-microsoft-outputformat", "riff-24khz-16bit-mono-pcm")
    .header("user-agent", "ttPin");

  if let Some(ref token) = tts_bearer {
    req = req.header("authorization", format!("Bearer {}", token));
  } else {
    req = req.header("ocp-apim-subscription-key", key);
  }

  let resp = req
    .body(ssml)
    .send()
    .await
    .map_err(|e| format!("TTS synth request failed: {e}"))?;

  let status = resp.status();

  if !status.is_success() {
    let msg = resp
      .text()
      .await
      .unwrap_or_else(|_| "".to_string());
    let msg = msg.trim();
    if msg.is_empty() {
      return Err(format!("TTS synth failed: {status}."));
    }
    return Err(format!("TTS synth failed: {status}. {msg}"));
  }

  let bytes = resp
    .bytes()
    .await
    .map_err(|e| format!("TTS synth read response failed: {e}"))?;

  let audio_base64 = base64::engine::general_purpose::STANDARD.encode(&bytes);

  Ok(TtsSynthesizeResult {
    audio_base64,
    locale: chosen_locale,
    voice: chosen_voice,
  })
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_shell::init())
    .plugin(tauri_plugin_global_shortcut::Builder::new().build())
    .plugin(tauri_plugin_store::Builder::new().build())
    .plugin(tauri_plugin_sql::Builder::new().build())
    .invoke_handler(tauri::generate_handler![
      translator_languages,
      translator_translate,
      tts_synthesize,
      set_always_on_top,
      entra_acquire_token_client_credentials,
      az_cli_check_login,
      entra_clear_token,
      entra_token_status,
    ])
    .setup(|app| {
      // Use the generated Tauri icon for both the window and tray.
      // This makes the icon update immediately in dev, instead of relying on cached defaults.
      fn load_png_icon(bytes: &[u8]) -> Option<tauri::image::Image<'static>> {
        let decoded = image::load_from_memory_with_format(bytes, image::ImageFormat::Png).ok()?;
        let rgba = decoded.to_rgba8();
        let (width, height) = rgba.dimensions();
        Some(tauri::image::Image::new_owned(rgba.into_raw(), width, height))
      }

      // Pick size-appropriate assets to reduce jaggies from heavy OS scaling.
      // - Window: use a larger icon (256x256) for titlebar/taskbar.
      // - Tray: use 32x32 (Windows will downscale to 16x16, but from a closer size).
      #[cfg(not(target_os = "windows"))]
      let window_icon = load_png_icon(include_bytes!("../icons/128x128@2x.png"));
      let tray_icon = load_png_icon(include_bytes!("../icons/32x32.png"));

      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }

      // 获取主窗口并定位到右下角
      if let Some(window) = app.get_webview_window("main") {
        // NOTE (Windows): avoid overriding the native multi-size ICO (ICON_SMALL/ICON_BIG)
        // with a single bitmap. Windows will resample it for the titlebar and it can look
        // noticeably blurry compared to other apps.
        #[cfg(not(target_os = "windows"))]
        {
          if let Some(icon) = window_icon.clone() {
            // Best-effort: if it fails on a platform, keep running.
            let _ = window.set_icon(icon);
          }
        }
        position_window_bottom_right(&window);

        // 阻止窗口关闭，改为隐藏
        let window_for_close = window.clone();
        window.on_window_event(move |event| {
          if let tauri::WindowEvent::CloseRequested { api, .. } = event {
            api.prevent_close();
            let _ = window_for_close.hide();
          }
        });

        // 注册全局快捷键：优先 Ctrl+Shift+T；如果被系统占用则降级为其它组合。
        // 关键点：热键占用不能导致 setup 失败，否则应用会直接崩溃。
        // 说明：tauri_plugin_global_shortcut 的 `on_shortcut` 本身会完成注册+回调绑定。
        // 不要再单独调用 `register`，否则会触发“already registered”。
        let shortcuts = ["ctrl+shift+t", "ctrl+alt+t", "ctrl+shift+g"];
        let mut shortcut_registered = false;

        for shortcut in shortcuts {
          let window_for_shortcut = window.clone();
          let handler_result = app.global_shortcut().on_shortcut(
            shortcut,
            move |_app, _shortcut, event| {
              if event.state == ShortcutState::Pressed {
                if let Ok(is_visible) = window_for_shortcut.is_visible() {
                  if is_visible {
                    let _ = window_for_shortcut.hide();
                  } else {
                    let _ = window_for_shortcut.show();
                    let _ = window_for_shortcut.set_focus();
                  }
                }
              }
            },
          );

          if let Err(err) = handler_result {
            log::warn!("Global shortcut handler setup failed ({shortcut}): {err}");
            continue;
          }

          log::info!("Global shortcut registered: {shortcut}");
          shortcut_registered = true;
          break;
        }

        if !shortcut_registered {
          log::warn!("No global shortcut registered (all candidates occupied). App will run without hotkey.");
        }

        // 创建托盘菜单
        let show_i = MenuItem::with_id(app, "show", "显示窗口", true, None::<&str>)?;
        let settings_i = MenuItem::with_id(app, "settings", "设置", true, None::<&str>)?;
        let quit_i = MenuItem::with_id(app, "quit", "退出", true, None::<&str>)?;
        let menu = Menu::with_items(app, &[&show_i, &settings_i, &quit_i])?;

        // 构建托盘图标
        let window_for_tray = window.clone();
        let tray = TrayIconBuilder::new()
          .icon(
            tray_icon
              .clone()
              .or_else(|| app.default_window_icon().cloned())
              .expect("default window icon missing"),
          )
          .menu(&menu)
          .show_menu_on_left_click(false)
          .on_menu_event(move |app, event| match event.id.as_ref() {
            "show" => {
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "settings" => {
              // TODO: 打开设置对话框
              if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.set_focus();
              }
            }
            "quit" => {
              app.exit(0);
            }
            _ => {}
          })
          .on_tray_icon_event(move |_tray, event| {
            if let TrayIconEvent::Click {
              button: MouseButton::Left,
              button_state: MouseButtonState::Up,
              ..
            } = event
            {
              // 左键单击托盘图标显示/隐藏窗口
              if let Ok(is_visible) = window_for_tray.is_visible() {
                if is_visible {
                  let _ = window_for_tray.hide();
                } else {
                  let _ = window_for_tray.show();
                  let _ = window_for_tray.set_focus();
                }
              }
            }
          })
          .build(app)?;

        // 重要：确保托盘句柄在应用生命周期内不被 drop（避免未来某些环境下出现托盘偶发消失/重复创建）。
        std::mem::forget(tray);
      }

      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}

/// 将窗口定位到屏幕右下角
fn position_window_bottom_right(window: &tauri::WebviewWindow) {
  use tauri::PhysicalPosition;

  // 获取当前显示器
  if let Ok(Some(monitor)) = window.current_monitor() {
    let monitor_pos = monitor.position();
    let monitor_size = monitor.size();

    // 获取窗口外部尺寸（包含边框和标题栏）
    if let Ok(window_size) = window.outer_size() {
      // 计算右下角位置，留出 20 像素边距
      let margin = 20;

      let mut x = monitor_pos.x + monitor_size.width as i32 - window_size.width as i32 - margin;
      let mut y = monitor_pos.y + monitor_size.height as i32 - window_size.height as i32 - margin;

      // clamp：避免负值/出屏（多显示器、缩放、极端分辨率下更稳）
      let min_x = monitor_pos.x;
      let min_y = monitor_pos.y;
      let max_x = monitor_pos.x + monitor_size.width as i32 - window_size.width as i32;
      let max_y = monitor_pos.y + monitor_size.height as i32 - window_size.height as i32;
      x = x.clamp(min_x, max_x);
      y = y.clamp(min_y, max_y);

      let position = PhysicalPosition::new(x, y);
      let _ = window.set_position(position);
    }
  }
}
