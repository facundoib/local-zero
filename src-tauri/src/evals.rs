use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::DbState;

#[derive(Serialize, Deserialize)]
pub struct EvalCase {
    pub id: i64,
    pub question: String,
    pub expected_substring: String,
    pub created_at: i64,
}

#[tauri::command]
pub fn list_evals(state: tauri::State<DbState>) -> Result<Vec<EvalCase>, String> {
    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT id, question, expected_substring, created_at
             FROM evals ORDER BY created_at ASC",
        )
        .map_err(|e| format!("preparing list_evals: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(EvalCase {
                id: row.get(0)?,
                question: row.get(1)?,
                expected_substring: row.get(2)?,
                created_at: row.get(3)?,
            })
        })
        .map_err(|e| format!("querying evals: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("reading eval row: {e}"))?);
    }
    Ok(out)
}

#[tauri::command]
pub fn add_eval(
    question: String,
    expected_substring: String,
    state: tauri::State<DbState>,
) -> Result<EvalCase, String> {
    let q = question.trim().to_string();
    let s = expected_substring.trim().to_string();
    if q.is_empty() {
        return Err("la pregunta no puede estar vacía".to_string());
    }
    if s.is_empty() {
        return Err("la subcadena esperada no puede estar vacía".to_string());
    }
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs() as i64;
    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute(
        "INSERT INTO evals (question, expected_substring, created_at) VALUES (?1, ?2, ?3)",
        params![q, s, now],
    )
    .map_err(|e| format!("inserting eval: {e}"))?;
    let id = conn.last_insert_rowid();
    Ok(EvalCase {
        id,
        question: q,
        expected_substring: s,
        created_at: now,
    })
}

#[tauri::command]
pub fn delete_eval(id: i64, state: tauri::State<DbState>) -> Result<(), String> {
    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
    conn.execute("DELETE FROM evals WHERE id = ?1", params![id])
        .map_err(|e| format!("deleting eval: {e}"))?;
    Ok(())
}
