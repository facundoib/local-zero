use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};

use crate::db::DbState;

#[derive(Serialize, Deserialize, Clone)]
pub struct AppSettings {
    pub backend_url: String,
    pub llm_model: String,
    pub embed_model: String,
    pub voice_enabled: bool,
    pub tts_voice: String,
    pub top_k: u32,
    pub theme: String,
}

// Arc-wrapped so it can be cloned into background threads (same pattern as DbState).
pub struct SettingsState(pub Arc<Mutex<AppSettings>>);

fn read_str(conn: &rusqlite::Connection, key: &str, default: &str) -> String {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get::<_, String>(0),
    )
    .unwrap_or_else(|_| default.to_string())
}

pub fn load_from_db(conn: &rusqlite::Connection) -> AppSettings {
    AppSettings {
        backend_url: read_str(conn, "backend_url", "http://localhost:13305/api/v1"),
        llm_model: read_str(conn, "llm_model", "Qwen3-4B-Instruct-2507-GGUF"),
        embed_model: read_str(conn, "embed_model", "Qwen3-Embedding-0.6B-GGUF"),
        voice_enabled: read_str(conn, "voice_enabled", "false") == "true",
        tts_voice: read_str(conn, "tts_voice", "ef_dora"),
        top_k: read_str(conn, "top_k", "6").parse().unwrap_or(6),
        theme: read_str(conn, "theme", "system"),
    }
}

#[tauri::command]
pub fn get_settings(state: tauri::State<SettingsState>) -> AppSettings {
    state.0.lock().unwrap().clone()
}

#[tauri::command]
pub fn set_settings(
    settings: AppSettings,
    s_state: tauri::State<SettingsState>,
    db: tauri::State<DbState>,
) -> Result<(), String> {
    let top_k_str = settings.top_k.to_string();
    let voice_str = if settings.voice_enabled { "true" } else { "false" };
    let pairs: &[(&str, &str)] = &[
        ("backend_url", settings.backend_url.as_str()),
        ("llm_model", settings.llm_model.as_str()),
        ("embed_model", settings.embed_model.as_str()),
        ("voice_enabled", voice_str),
        ("tts_voice", settings.tts_voice.as_str()),
        ("top_k", top_k_str.as_str()),
        ("theme", settings.theme.as_str()),
    ];
    let conn = db.0.lock().map_err(|e| format!("db lock: {e}"))?;
    for (key, value) in pairs {
        conn.execute(
            "INSERT OR REPLACE INTO settings (key, value) VALUES (?1, ?2)",
            params![key, value],
        )
        .map_err(|e| format!("persisting {key}: {e}"))?;
    }
    drop(conn);
    *s_state.0.lock().map_err(|e| format!("settings lock: {e}"))? = settings;
    Ok(())
}
