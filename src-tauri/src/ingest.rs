use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::db::DbState;

const MAX_BYTES: u64 = 50 * 1024 * 1024;
// ~512-token target via a char-based proxy until tiktoken-rs lands in iter 2.
// Spanish averages ~3.5–4 chars per token in BPE-style tokenizers; 2048 chars
// is a conservative approximation that fits inside Qwen3's context budget.
const TARGET_CHUNK_CHARS: usize = 2048;

#[derive(Serialize, Clone)]
pub struct IngestResult {
    pub id: i64,
    pub filename: String,
    pub byte_size: i64,
    pub chunk_count: i64,
    pub deduped: bool,
}

#[derive(Serialize, Clone)]
pub struct DocumentRow {
    pub id: i64,
    pub filename: String,
    pub byte_size: i64,
    pub chunk_count: i64,
    pub ingested_at: i64,
}

#[tauri::command]
pub fn ingest_paths(
    paths: Vec<String>,
    state: tauri::State<DbState>,
) -> Result<Vec<IngestResult>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        match ingest_one(&p, &state) {
            Ok(r) => out.push(r),
            Err(e) => return Err(format!("{p}: {e}")),
        }
    }
    Ok(out)
}

#[tauri::command]
pub fn list_documents(state: tauri::State<DbState>) -> Result<Vec<DocumentRow>, String> {
    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
    let mut stmt = conn
        .prepare(
            "SELECT documents.id,
                    documents.filename,
                    documents.byte_size,
                    COUNT(chunks.id) AS chunk_count,
                    documents.ingested_at
             FROM documents
             LEFT JOIN chunks ON chunks.document_id = documents.id
             GROUP BY documents.id
             ORDER BY documents.ingested_at DESC",
        )
        .map_err(|e| format!("prepare list: {e}"))?;
    let rows = stmt
        .query_map([], |row| {
            Ok(DocumentRow {
                id: row.get(0)?,
                filename: row.get(1)?,
                byte_size: row.get(2)?,
                chunk_count: row.get(3)?,
                ingested_at: row.get(4)?,
            })
        })
        .map_err(|e| format!("query list: {e}"))?;
    let mut out = Vec::new();
    for r in rows {
        out.push(r.map_err(|e| format!("row list: {e}"))?);
    }
    Ok(out)
}

fn ingest_one(path: &str, state: &DbState) -> Result<IngestResult, String> {
    let p = Path::new(path);
    let filename = p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or("nombre de archivo inválido")?
        .to_string();

    let metadata = fs::metadata(p).map_err(|e| format!("no se pudo leer el archivo: {e}"))?;
    let byte_size = metadata.len();

    if byte_size > MAX_BYTES {
        return Err(format!(
            "el archivo supera los 50 MB ({} bytes)",
            byte_size
        ));
    }

    let ext = p
        .extension()
        .and_then(|s| s.to_str())
        .map(|s| s.to_ascii_lowercase())
        .unwrap_or_default();

    let mime = mime_for_ext(&ext)
        .ok_or_else(|| format!("formato '.{ext}' no soportado en esta iteración"))?;

    let bytes = fs::read(p).map_err(|e| format!("error leyendo el archivo: {e}"))?;
    let text = extract_text(&ext, &bytes)?;

    let mut hasher = Sha256::new();
    hasher.update(&bytes);
    let sha = hex(&hasher.finalize());

    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0);

    let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;

    if let Some((id, chunk_count)) = find_doc_by_sha(&conn, &sha)? {
        return Ok(IngestResult {
            id,
            filename,
            byte_size: byte_size as i64,
            chunk_count,
            deduped: true,
        });
    }

    conn.execute(
        "INSERT INTO documents (filename, path, mime_type, byte_size, sha256, ingested_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![
            filename,
            path,
            mime,
            byte_size as i64,
            sha,
            now
        ],
    )
    .map_err(|e| format!("insertando documento: {e}"))?;
    let doc_id = conn.last_insert_rowid();

    let chunks = chunk_text(&text, TARGET_CHUNK_CHARS);
    let chunk_count = chunks.len() as i64;

    {
        let mut stmt = conn
            .prepare(
                "INSERT INTO chunks (document_id, ordinal, text, token_count)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("preparando chunks: {e}"))?;
        for (i, c) in chunks.iter().enumerate() {
            let est_tokens = (c.chars().count() / 4) as i64;
            stmt.execute(params![doc_id, i as i64, c, est_tokens])
                .map_err(|e| format!("insertando chunk {i}: {e}"))?;
        }
    }

    Ok(IngestResult {
        id: doc_id,
        filename,
        byte_size: byte_size as i64,
        chunk_count,
        deduped: false,
    })
}

fn mime_for_ext(ext: &str) -> Option<&'static str> {
    match ext {
        "txt" => Some("text/plain"),
        "md" => Some("text/markdown"),
        "pdf" => Some("application/pdf"),
        _ => None,
    }
}

const MIN_PDF_TEXT_CHARS: usize = 100;

fn extract_text(ext: &str, bytes: &[u8]) -> Result<String, String> {
    match ext {
        "txt" | "md" => String::from_utf8(bytes.to_vec())
            .map_err(|_| "el archivo no es UTF-8 válido".to_string()),
        "pdf" => {
            let text = pdf_extract::extract_text_from_mem(bytes)
                .map_err(|e| format!("no pude leer el PDF: {e}"))?;
            if text.trim().chars().count() < MIN_PDF_TEXT_CHARS {
                return Err(
                    "el PDF parece ser una imagen escaneada (poco o ningún texto extraído). \
                     Esta versión no soporta OCR.".to_string(),
                );
            }
            Ok(text)
        }
        _ => Err(format!("formato '.{ext}' no soportado")),
    }
}

fn find_doc_by_sha(conn: &Connection, sha: &str) -> Result<Option<(i64, i64)>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT documents.id, COUNT(chunks.id)
             FROM documents
             LEFT JOIN chunks ON chunks.document_id = documents.id
             WHERE sha256 = ?1
             GROUP BY documents.id",
        )
        .map_err(|e| format!("preparando find: {e}"))?;
    let mut rows = stmt
        .query(params![sha])
        .map_err(|e| format!("ejecutando find: {e}"))?;
    if let Some(row) = rows.next().map_err(|e| format!("leyendo row find: {e}"))? {
        let id: i64 = row.get(0).map_err(|e| format!("columna id: {e}"))?;
        let cnt: i64 = row.get(1).map_err(|e| format!("columna count: {e}"))?;
        Ok(Some((id, cnt)))
    } else {
        Ok(None)
    }
}

fn chunk_text(s: &str, target_chars: usize) -> Vec<String> {
    if s.is_empty() {
        return Vec::new();
    }
    let chars: Vec<char> = s.chars().collect();
    chars
        .chunks(target_chars)
        .map(|c| c.iter().collect::<String>())
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
