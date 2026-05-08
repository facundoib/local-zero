use rusqlite::{params, Connection};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::sync::OnceLock;
use std::time::{Instant, SystemTime, UNIX_EPOCH};
use tiktoken_rs::{cl100k_base, CoreBPE};

use crate::db::DbState;

const MAX_BYTES: u64 = 50 * 1024 * 1024;
// SPEC §F1: 512-token target with 64-token overlap.
// cl100k_base is OpenAI's GPT-4 BPE — used here as a stable proxy because
// Qwen3's tokenizer is not exposed in pure Rust. Token counts are
// approximate vs Qwen3 but consistent across the corpus, which is what
// chunk-budget enforcement actually needs.
const TARGET_TOKENS: usize = 512;
const OVERLAP_TOKENS: usize = 64;

fn bpe() -> &'static CoreBPE {
    static BPE: OnceLock<CoreBPE> = OnceLock::new();
    BPE.get_or_init(|| cl100k_base().expect("inicializando tokenizer cl100k_base"))
}

#[derive(Serialize, Clone)]
pub struct IngestResult {
    pub id: i64,
    pub filename: String,
    pub byte_size: i64,
    pub chunk_count: i64,
    pub deduped: bool,
    pub elapsed_ms: u64,
}

#[derive(Serialize, Clone)]
pub struct DocumentRow {
    pub id: i64,
    pub filename: String,
    pub byte_size: i64,
    pub chunk_count: i64,
    pub embedded_count: i64,
    pub ingested_at: i64,
}

#[tauri::command]
pub fn ingest_paths(
    app: tauri::AppHandle,
    paths: Vec<String>,
    state: tauri::State<DbState>,
) -> Result<Vec<IngestResult>, String> {
    let mut out = Vec::with_capacity(paths.len());
    for p in paths {
        match ingest_one(&p, &state) {
            Ok(r) => {
                // Auto-embed every newly ingested doc on a background
                // thread. The synchronous embed_document_impl path takes
                // multiple seconds per doc (Lemonade /embeddings batched
                // 32 chunks at a time + cold-load latency on first call),
                // and we want ingest_paths to return as soon as the rows
                // are in the DB so the UI can render the new doc in the
                // left rail without waiting. The spawned task emits
                // `embed-progress` events on `app` per batch so the UI
                // can render per-doc progress without polling.
                if !r.deduped {
                    let db = state.0.clone();
                    let app_clone = app.clone();
                    let doc_id = r.id;
                    std::thread::spawn(move || {
                        if let Err(e) = crate::embed::embed_document_impl(app_clone, doc_id, db) {
                            eprintln!("auto-embed doc {doc_id}: {e}");
                        }
                    });
                }
                out.push(r);
            }
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
                    COUNT(DISTINCT chunks.id)     AS chunk_count,
                    COUNT(DISTINCT embeddings.chunk_id) AS embedded_count,
                    documents.ingested_at
             FROM documents
             LEFT JOIN chunks     ON chunks.document_id = documents.id
             LEFT JOIN embeddings ON embeddings.chunk_id = chunks.id
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
                embedded_count: row.get(4)?,
                ingested_at: row.get(5)?,
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
    let started = Instant::now();
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
            elapsed_ms: started.elapsed().as_millis() as u64,
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

    let chunks = chunk_text(&text);
    let chunk_count = chunks.len() as i64;

    {
        let mut stmt = conn
            .prepare(
                "INSERT INTO chunks (document_id, ordinal, text, token_count)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("preparando chunks: {e}"))?;
        for (i, (chunk_text, tok_count)) in chunks.iter().enumerate() {
            stmt.execute(params![doc_id, i as i64, chunk_text, *tok_count as i64])
                .map_err(|e| format!("insertando chunk {i}: {e}"))?;
        }
    }

    Ok(IngestResult {
        id: doc_id,
        filename,
        byte_size: byte_size as i64,
        chunk_count,
        deduped: false,
        elapsed_ms: started.elapsed().as_millis() as u64,
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

fn chunk_text(s: &str) -> Vec<(String, usize)> {
    if s.trim().is_empty() {
        return Vec::new();
    }
    let tokens = bpe().encode_with_special_tokens(s);
    let n = tokens.len();
    if n == 0 {
        return Vec::new();
    }

    let mut out = Vec::new();
    let mut start = 0usize;
    let stride = TARGET_TOKENS.saturating_sub(OVERLAP_TOKENS).max(1);

    while start < n {
        let end = (start + TARGET_TOKENS).min(n);
        let slice = tokens[start..end].to_vec();
        let count = slice.len();
        match bpe().decode(slice) {
            Ok(text) => out.push((text, count)),
            Err(_) => {
                // Token slice not decodable on its own (rare with BPE byte-pair
                // splits across chunk boundaries). Skip rather than abort the
                // ingest; we still capture the rest of the document.
            }
        }
        if end == n {
            break;
        }
        start += stride;
    }
    out
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
