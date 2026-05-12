use rusqlite::params;
use serde::Serialize;
use std::cmp::Ordering;
use std::time::Instant;

use crate::db::DbState;
use crate::embed::embed_query;
use crate::settings::SettingsState;

// Hard ceiling so a malformed call doesn't drag back thousands of chunks.
const MAX_TOP_K: usize = 50;

#[derive(Serialize, Clone)]
pub struct RetrievedChunk {
    pub chunk_id: i64,
    pub document_id: i64,
    pub document_filename: String,
    pub ordinal: i64,
    pub text: String,
    pub score: f32,
}

#[derive(Serialize)]
pub struct RetrievalResult {
    pub query: String,
    pub matches: Vec<RetrievedChunk>,
    pub embed_ms: u64,
    pub search_ms: u64,
    pub total_chunks: i64,
    pub query_vector_preview: Vec<f32>,
    pub query_vector_dim: usize,
}

#[tauri::command]
pub fn retrieve(
    query: String,
    top_k: Option<usize>,
    state: tauri::State<DbState>,
    s_state: tauri::State<SettingsState>,
) -> Result<RetrievalResult, String> {
    let (backend_url, embed_model, settings_top_k) = {
        let s = s_state.0.lock().map_err(|e| format!("settings lock: {e}"))?;
        (s.backend_url.clone(), s.embed_model.clone(), s.top_k as usize)
    };
    let trimmed = query.trim();
    if trimmed.is_empty() {
        return Err("la consulta no puede estar vacía".to_string());
    }
    let k = top_k.unwrap_or(settings_top_k).clamp(1, MAX_TOP_K);

    // Step 1: embed the question. Hits Lemonade once, no batching.
    let q_started = Instant::now();
    let q_vec = embed_query(trimmed, &backend_url, &embed_model)?;
    let embed_ms = q_started.elapsed().as_millis() as u64;
    if q_vec.is_empty() {
        return Err("Lemonade devolvió un embedding vacío para la consulta".to_string());
    }
    let q_norm = norm(&q_vec);
    if q_norm == 0.0 {
        return Err("la consulta produjo un vector nulo".to_string());
    }
    let q_dim = q_vec.len();
    let q_preview: Vec<f32> = q_vec.iter().take(8).copied().collect();

    // Step 2: brute-force cosine over the active document set. SPEC §F3
    // budgets ≤50 ms for ≤5,000 chunks on recommended hardware. We pull
    // every embedding under the lock, drop the lock, then score in
    // memory so a long scoring loop doesn't block other DB consumers.
    let s_started = Instant::now();
    let candidates: Vec<(i64, i64, String, i64, String, Vec<u8>, i64)> = {
        let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "SELECT embeddings.chunk_id,
                        chunks.document_id,
                        documents.filename,
                        chunks.ordinal,
                        chunks.text,
                        embeddings.vector,
                        embeddings.dim
                 FROM embeddings
                 JOIN chunks ON chunks.id = embeddings.chunk_id
                 JOIN documents ON documents.id = chunks.document_id",
            )
            .map_err(|e| format!("preparing retrieval scan: {e}"))?;
        let rows = stmt
            .query_map(params![], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Vec<u8>>(5)?,
                    row.get::<_, i64>(6)?,
                ))
            })
            .map_err(|e| format!("scanning embeddings: {e}"))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row scan: {e}"))?);
        }
        out
    };

    let total_chunks = candidates.len() as i64;

    let mut scored: Vec<RetrievedChunk> = Vec::with_capacity(candidates.len());
    for (chunk_id, doc_id, filename, ordinal, text, bytes, dim) in candidates {
        if dim as usize != q_vec.len() {
            // Skip rather than abort: a stale row from a different model
            // shouldn't poison the whole search. Logged as score=0 and
            // dropped in the sort; we could surface this in a v0.2 audit.
            continue;
        }
        let v = bytes_to_floats(&bytes);
        if v.len() != q_vec.len() {
            continue;
        }
        let score = cosine_with_query(&q_vec, q_norm, &v);
        scored.push(RetrievedChunk {
            chunk_id,
            document_id: doc_id,
            document_filename: filename,
            ordinal,
            text,
            score,
        });
    }

    scored.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(Ordering::Equal));
    scored.truncate(k);

    let search_ms = s_started.elapsed().as_millis() as u64;

    Ok(RetrievalResult {
        query: trimmed.to_string(),
        matches: scored,
        embed_ms,
        search_ms,
        total_chunks,
        query_vector_preview: q_preview,
        query_vector_dim: q_dim,
    })
}

fn bytes_to_floats(b: &[u8]) -> Vec<f32> {
    b.chunks_exact(4)
        .map(|c| f32::from_le_bytes([c[0], c[1], c[2], c[3]]))
        .collect()
}

fn norm(v: &[f32]) -> f32 {
    let mut s = 0.0f32;
    for x in v {
        s += x * x;
    }
    s.sqrt()
}

// Cosine where the query norm is precomputed (the query is reused across
// every candidate). For the candidate side we recompute its norm inside
// the loop; pre-normalizing the stored vectors at write time would be a
// v0.2 micro-opt if §11 budget ever gets tight.
fn cosine_with_query(q: &[f32], q_norm: f32, v: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut vn = 0.0f32;
    for (x, y) in q.iter().zip(v.iter()) {
        dot += x * y;
        vn += y * y;
    }
    let vn = vn.sqrt();
    if vn == 0.0 || q_norm == 0.0 {
        return 0.0;
    }
    dot / (q_norm * vn)
}
