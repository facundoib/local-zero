use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::time::Instant;

use crate::db::DbState;

const LEMONADE_URL: &str = "http://localhost:13305/api/v1";
const EMBED_MODEL: &str = "Qwen3-Embedding-0.6B-GGUF";
// SPEC §F2: 32 chunks per HTTP request to Lemonade /embeddings.
const BATCH_SIZE: usize = 32;
// Conservative ceiling for the slowest expected case (cold model load + a
// large batch). The probe measured ~3 s warm; the model can take a few
// seconds to lift on the first call.
const REQUEST_TIMEOUT_SECS: u64 = 60;

#[derive(Serialize, Clone)]
pub struct EmbedResult {
    pub doc_id: i64,
    pub embedded: i64,
    pub already: i64,
    pub dim: i64,
    pub model: String,
    pub elapsed_ms: u64,
}

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
}

#[derive(Deserialize)]
struct EmbedItem {
    embedding: Vec<f32>,
    index: usize,
}

#[tauri::command]
pub fn embed_document(
    doc_id: i64,
    state: tauri::State<DbState>,
) -> Result<EmbedResult, String> {
    let started = Instant::now();

    // Step 1: snapshot pending chunks under the lock, then drop it so the
    // multi-second HTTP calls don't block other DB consumers.
    let (pending, already) = {
        let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
        let already: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM embeddings
                 JOIN chunks ON chunks.id = embeddings.chunk_id
                 WHERE chunks.document_id = ?1",
                params![doc_id],
                |row| row.get(0),
            )
            .map_err(|e| format!("counting existing embeddings: {e}"))?;

        let mut stmt = conn
            .prepare(
                "SELECT chunks.id, chunks.text
                 FROM chunks
                 LEFT JOIN embeddings ON embeddings.chunk_id = chunks.id
                 WHERE chunks.document_id = ?1
                   AND embeddings.chunk_id IS NULL
                 ORDER BY chunks.ordinal",
            )
            .map_err(|e| format!("preparing pending chunks: {e}"))?;
        let rows = stmt
            .query_map(params![doc_id], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| format!("querying pending chunks: {e}"))?;
        let mut out: Vec<(i64, String)> = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| format!("row pending chunk: {e}"))?);
        }
        (out, already)
    };

    if pending.is_empty() {
        return Ok(EmbedResult {
            doc_id,
            embedded: 0,
            already,
            dim: 0,
            model: EMBED_MODEL.to_string(),
            elapsed_ms: started.elapsed().as_millis() as u64,
        });
    }

    let mut total_dim: usize = 0;
    let mut embedded: i64 = 0;

    for batch in pending.chunks(BATCH_SIZE) {
        let inputs: Vec<String> = batch.iter().map(|(_, t)| t.clone()).collect();
        let resp = call_embeddings(&inputs)?;

        if resp.data.len() != batch.len() {
            return Err(format!(
                "Lemonade returned {} embeddings for a batch of {}",
                resp.data.len(),
                batch.len()
            ));
        }

        // Re-acquire the lock per batch to insert. Holding across the HTTP
        // call would freeze the UI on /list_documents and friends.
        let conn = state.0.lock().map_err(|e| format!("db lock: {e}"))?;
        let mut stmt = conn
            .prepare(
                "INSERT INTO embeddings (chunk_id, vector, dim, model)
                 VALUES (?1, ?2, ?3, ?4)",
            )
            .map_err(|e| format!("preparing embeddings insert: {e}"))?;

        for item in resp.data {
            if item.index >= batch.len() {
                return Err(format!(
                    "Lemonade response index {} out of range for batch of {}",
                    item.index,
                    batch.len()
                ));
            }
            let (chunk_id, _) = batch[item.index];
            let dim = item.embedding.len();
            if dim == 0 {
                return Err(format!("empty embedding for chunk {chunk_id}"));
            }
            if total_dim == 0 {
                total_dim = dim;
            } else if dim != total_dim {
                return Err(format!(
                    "dim mismatch: chunk {chunk_id} returned {dim}, expected {total_dim}"
                ));
            }
            let bytes = floats_to_bytes(&item.embedding);
            stmt.execute(params![chunk_id, bytes, dim as i64, EMBED_MODEL])
                .map_err(|e| format!("inserting embedding for chunk {chunk_id}: {e}"))?;
            embedded += 1;
        }
    }

    Ok(EmbedResult {
        doc_id,
        embedded,
        already,
        dim: total_dim as i64,
        model: EMBED_MODEL.to_string(),
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

fn call_embeddings(inputs: &[String]) -> Result<EmbedResponse, String> {
    let url = format!("{LEMONADE_URL}/embeddings");
    let body = EmbedRequest {
        model: EMBED_MODEL,
        input: inputs.to_vec(),
    };
    let resp = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(REQUEST_TIMEOUT_SECS))
        .set("content-type", "application/json")
        .send_json(serde_json::to_value(&body).map_err(|e| format!("serializing request: {e}"))?)
        .map_err(|e| format!("POST {url}: {e}"))?;
    resp.into_json::<EmbedResponse>()
        .map_err(|e| format!("decoding /embeddings response: {e}"))
}

fn floats_to_bytes(v: &[f32]) -> Vec<u8> {
    let mut out = Vec::with_capacity(v.len() * 4);
    for f in v {
        out.extend_from_slice(&f.to_le_bytes());
    }
    out
}
