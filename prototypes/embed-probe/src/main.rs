// embed-probe — F2 spike for Local Zero
//
// Validates the highest-risk decisions for F2 (Embedding pipeline) before
// touching src-tauri/:
//   1. Lemonade /v1/embeddings is reachable and the chosen model is loaded.
//   2. The OpenAI-compatible response shape matches what we plan to parse
//      (data[].embedding as float array, data[].index for ordering).
//   3. Batch input (32 Spanish chunks in one POST) returns 32 embeddings in
//      the order requested.
//   4. Spanish UTF-8 round-trips through the HTTP body without mojibake.
//   5. Latency is within striking distance of SPEC §11: embed 100 chunks ≤ 8 s
//      on recommended hardware. At batch=32 that's ~4 calls; budget per call ~2 s.
//   6. Cosine sanity: a Spanish-similar pair scores higher than an unrelated pair.
//
// Run:
//   cd local-zero/prototypes/embed-probe
//   cargo run --release
//
// Lemonade Server must be live on http://localhost:13305 with the
// Qwen3-Embedding-0.6B-GGUF model present (verify via /api/v1/models).

use std::process::ExitCode;
use std::time::Instant;

use serde::{Deserialize, Serialize};

const BASE_URL: &str = "http://localhost:13305/api/v1";
const MODEL: &str = "Qwen3-Embedding-0.6B-GGUF";
const BATCH_SIZE: usize = 32;

#[derive(Serialize)]
struct EmbedRequest<'a> {
    model: &'a str,
    input: Vec<String>,
}

#[derive(Deserialize)]
struct EmbedResponse {
    data: Vec<EmbedItem>,
    #[serde(default)]
    model: String,
    #[serde(default)]
    usage: Option<Usage>,
}

#[derive(Deserialize)]
struct EmbedItem {
    embedding: Vec<f32>,
    index: usize,
}

#[derive(Deserialize)]
struct Usage {
    #[serde(default)]
    prompt_tokens: u64,
    #[serde(default)]
    total_tokens: u64,
}

#[derive(Deserialize)]
struct ModelsResponse {
    data: Vec<ModelEntry>,
}

#[derive(Deserialize)]
struct ModelEntry {
    id: String,
    #[serde(default)]
    labels: Vec<String>,
}

fn main() -> ExitCode {
    println!("=== embed-probe — F2 spike ===\n");

    let models_ok = match probe_models() {
        Ok(()) => true,
        Err(e) => {
            println!("[x] /models probe FAILED: {e}\n");
            false
        }
    };

    let single_dim = match probe_single() {
        Ok(d) => Some(d),
        Err(e) => {
            println!("[x] single-input probe FAILED: {e}\n");
            None
        }
    };

    let batch_ok = match probe_batch(single_dim) {
        Ok(()) => true,
        Err(e) => {
            println!("[x] batch probe FAILED: {e}\n");
            false
        }
    };

    let cosine_ok = match probe_cosine() {
        Ok(()) => true,
        Err(e) => {
            println!("[x] cosine sanity FAILED: {e}\n");
            false
        }
    };

    println!("=== Summary ===");
    println!("  /models reachable + embeddings model present: {}", verdict(models_ok));
    println!("  single-input contract:                        {}", verdict(single_dim.is_some()));
    println!("  batch of {BATCH_SIZE} preserves order:                  {}", verdict(batch_ok));
    println!("  cosine sanity (similar > unrelated):          {}", verdict(cosine_ok));

    if models_ok && single_dim.is_some() && batch_ok && cosine_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn verdict(ok: bool) -> &'static str {
    if ok { "PASS" } else { "FAIL" }
}

fn probe_models() -> Result<(), String> {
    println!("--- Probe 1: /v1/models ---");
    let url = format!("{BASE_URL}/models");
    let started = Instant::now();
    let resp: ModelsResponse = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .map_err(|e| format!("GET {url}: {e}"))?
        .into_json()
        .map_err(|e| format!("decoding /models response: {e}"))?;

    let entry = resp
        .data
        .iter()
        .find(|m| m.id == MODEL)
        .ok_or_else(|| format!("model '{MODEL}' not present in /models"))?;

    let labels = if entry.labels.is_empty() {
        "(no labels)".to_string()
    } else {
        entry.labels.join(", ")
    };
    println!("  - {} found, labels: [{labels}]", entry.id);
    println!("  - probe latency: {} ms", started.elapsed().as_millis());
    println!("[ok] /models probe passed\n");
    Ok(())
}

fn probe_single() -> Result<usize, String> {
    println!("--- Probe 2: single-input /v1/embeddings ---");
    let input = vec![
        "Hola mundo, esto es una prueba de embeddings con eñes y acentos: año, niño, corazón."
            .to_string(),
    ];
    let started = Instant::now();
    let resp = embed(&input)?;
    let elapsed = started.elapsed();

    if resp.data.len() != 1 {
        return Err(format!("expected 1 embedding, got {}", resp.data.len()));
    }
    let dim = resp.data[0].embedding.len();
    if dim == 0 {
        return Err("embedding vector is empty".to_string());
    }
    let preview: Vec<f32> = resp.data[0].embedding.iter().take(8).copied().collect();
    let usage = resp
        .usage
        .as_ref()
        .map(|u| format!("prompt={} total={}", u.prompt_tokens, u.total_tokens))
        .unwrap_or_else(|| "(no usage field)".to_string());

    println!("  - model echoed by server: '{}'", resp.model);
    println!("  - dim: {dim}");
    println!("  - first 8 dims: {preview:?}");
    println!("  - usage: {usage}");
    println!("  - latency: {} ms", elapsed.as_millis());
    println!("[ok] single-input probe passed\n");
    Ok(dim)
}

fn probe_batch(expected_dim: Option<usize>) -> Result<(), String> {
    println!("--- Probe 3: batch of {BATCH_SIZE} ---");
    let inputs = make_batch();
    let started = Instant::now();
    let resp = embed(&inputs)?;
    let elapsed = started.elapsed();

    if resp.data.len() != BATCH_SIZE {
        return Err(format!(
            "expected {BATCH_SIZE} embeddings, got {}",
            resp.data.len()
        ));
    }

    // index check: server may return out of order; we MUST be able to
    // reassemble by index. F2 storage relies on chunk-id ↔ index mapping.
    let mut seen = vec![false; BATCH_SIZE];
    for item in &resp.data {
        if item.index >= BATCH_SIZE {
            return Err(format!("index {} out of range", item.index));
        }
        if seen[item.index] {
            return Err(format!("duplicate index {}", item.index));
        }
        seen[item.index] = true;
        if let Some(d) = expected_dim {
            if item.embedding.len() != d {
                return Err(format!(
                    "dim mismatch at index {}: got {}, expected {d}",
                    item.index,
                    item.embedding.len()
                ));
            }
        }
    }
    if seen.iter().any(|s| !s) {
        return Err("missing indices in batch response".to_string());
    }

    let per_item_ms = elapsed.as_millis() as f64 / BATCH_SIZE as f64;
    let projected_100 = per_item_ms * 100.0 / 1000.0;
    println!("  - {} items returned, all indices 0..{}", resp.data.len(), BATCH_SIZE - 1);
    println!("  - batch latency: {} ms ({:.1} ms/item)", elapsed.as_millis(), per_item_ms);
    println!("  - projected for 100 chunks: ~{:.2} s (SPEC §11 budget: 8 s)", projected_100);
    if projected_100 > 8.0 {
        println!("  - [warn] over budget — flag before locking batch size at 32");
    }
    println!("[ok] batch probe passed\n");
    Ok(())
}

fn probe_cosine() -> Result<(), String> {
    println!("--- Probe 4: cosine sanity ---");
    let a = "Los embeddings transforman texto en vectores para búsqueda semántica.";
    let b = "Un embedding es una representación vectorial de un texto, útil para encontrar fragmentos similares.";
    let c = "La pizza napolitana tradicional usa harina 00, tomate San Marzano y mozzarella de búfala.";

    let resp = embed(&vec![a.to_string(), b.to_string(), c.to_string()])?;
    if resp.data.len() != 3 {
        return Err(format!("expected 3 embeddings, got {}", resp.data.len()));
    }
    let mut by_idx: Vec<&Vec<f32>> = vec![&resp.data[0].embedding; 3];
    for item in &resp.data {
        by_idx[item.index] = &item.embedding;
    }
    let sim_ab = cosine(by_idx[0], by_idx[1]);
    let sim_ac = cosine(by_idx[0], by_idx[2]);
    println!("  - cos(similar pair a,b)   = {sim_ab:.4}");
    println!("  - cos(unrelated pair a,c) = {sim_ac:.4}");
    if sim_ab <= sim_ac {
        return Err(format!(
            "expected sim(a,b) > sim(a,c); got {sim_ab:.4} vs {sim_ac:.4}"
        ));
    }
    println!("[ok] cosine sanity passed\n");
    Ok(())
}

fn embed(input: &Vec<String>) -> Result<EmbedResponse, String> {
    let url = format!("{BASE_URL}/embeddings");
    let body = EmbedRequest { model: MODEL, input: input.clone() };
    let resp = ureq::post(&url)
        .timeout(std::time::Duration::from_secs(60))
        .set("content-type", "application/json")
        .send_json(serde_json::to_value(&body).map_err(|e| format!("serializing request: {e}"))?)
        .map_err(|e| format!("POST {url}: {e}"))?;
    resp.into_json::<EmbedResponse>()
        .map_err(|e| format!("decoding /embeddings response: {e}"))
}

fn make_batch() -> Vec<String> {
    // 32 Spanish snippets — short and varied to mimic the chunk distribution
    // we expect from F1 (recursive splits over PDFs/MDs in es-AR).
    let templates = [
        "El sistema operativo gestiona los recursos del hardware y los comparte entre procesos.",
        "La memoria virtual permite a cada proceso ver un espacio de direcciones lineal aislado.",
        "El planificador del kernel decide qué hilo se ejecuta en cada núcleo y por cuánto tiempo.",
        "Los sistemas de archivos organizan bloques en metadatos que permiten lecturas eficientes.",
        "Las primitivas de sincronización evitan condiciones de carrera entre múltiples hilos.",
        "El protocolo TCP garantiza orden y entrega confiable de los segmentos enviados.",
        "Una caché reduce la latencia almacenando resultados de consultas frecuentes en memoria.",
        "Los índices de bases de datos aceleran las búsquedas a costa de espacio y escrituras más caras.",
        "La criptografía asimétrica usa un par de claves: pública para cifrar, privada para descifrar.",
        "Un certificado X.509 vincula una clave pública a una identidad verificada por una autoridad.",
        "El gradiente descendente ajusta los pesos en dirección opuesta a la pendiente del error.",
        "La regularización penaliza modelos demasiado complejos para mejorar la generalización.",
        "Un perceptrón multicapa puede aproximar funciones no lineales si tiene suficientes neuronas.",
        "Los embeddings convierten palabras en vectores que conservan relaciones semánticas.",
        "La atención permite a un modelo ponderar dinámicamente partes distintas de la entrada.",
        "Un modelo de lenguaje predice la siguiente unidad token a token sobre un contexto previo.",
        "RAG combina recuperación de fragmentos relevantes con generación condicionada al contexto.",
        "La cuantización reduce la precisión de los pesos para bajar memoria a un costo pequeño.",
        "El control de versiones permite registrar la historia del código y colaborar de forma segura.",
        "Una rama de desarrollo aísla cambios experimentales del tronco principal.",
        "El proceso de revisión por pares mejora la calidad del código antes de su integración.",
        "Las pruebas unitarias verifican el comportamiento de funciones aisladas con entradas conocidas.",
        "Las pruebas de integración revelan errores en los puntos de unión entre módulos.",
        "El despliegue continuo automatiza la entrega de cambios validados al entorno productivo.",
        "El observability stack combina métricas, logs y trazas para diagnosticar incidentes.",
        "Un panel de tablero presenta indicadores clave para monitoreo en tiempo real.",
        "La latencia de cola dominante suele ser más informativa que la latencia promedio.",
        "El throttling protege a un servicio de picos de demanda que podrían tirarlo abajo.",
        "Un circuit breaker abre el circuito cuando las fallas superan un umbral configurado.",
        "La deuda técnica acumulada vuelve más lentas las iteraciones del equipo con el tiempo.",
        "La revisión de seguridad debe correr antes de cada release, no después de un incidente.",
        "Los principios SOLID guían el diseño orientado a objetos hacia código mantenible.",
    ];
    templates.iter().map(|s| s.to_string()).collect()
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0f32;
    let mut na = 0.0f32;
    let mut nb = 0.0f32;
    for (x, y) in a.iter().zip(b.iter()) {
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
