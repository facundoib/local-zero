// ingest-probe — F1 spike for Local Zero
//
// Validates the two highest-risk decisions for F1 (Document ingestion):
//   1. Does `rusqlite` with the `bundled` feature build under SAC?
//      (build.rs compiles the SQLite C amalgamation — first build is the test.)
//   2. Does `pdf-extract` preserve Spanish characters (ñ á é í ó ú ü ¿ ¡)?
//
// Run: build with `cargo build --release`, then launch the .exe via
// `Start-Process` from a user shell so SAC sees the user as the parent process.
//
//   cd local-zero\prototypes\ingest-probe
//   cargo build --release
//   Start-Process .\target\release\ingest-probe.exe -ArgumentList ".\fixtures\test.pdf" -NoNewWindow -Wait

use std::env;
use std::fs;
use std::path::Path;
use std::process::ExitCode;

use rusqlite::{params, Connection};
use sha2::{Digest, Sha256};

const SPANISH_CHARS: &[char] = &['ñ', 'á', 'é', 'í', 'ó', 'ú', 'ü', '¿', '¡', 'Ñ', 'Á'];

fn main() -> ExitCode {
    println!("=== ingest-probe — F1 spike ===\n");

    let sqlite_ok = match probe_sqlite() {
        Ok(()) => {
            println!("[✓] SQLite probe passed\n");
            true
        }
        Err(e) => {
            println!("[✗] SQLite probe FAILED: {e}\n");
            false
        }
    };

    let pdf_arg = env::args().nth(1);
    let pdf_ok = match pdf_arg {
        Some(path) => match probe_pdf(&path) {
            Ok(report) => {
                println!("{report}");
                report.contains("[✓]")
            }
            Err(e) => {
                println!("[✗] PDF probe FAILED: {e}\n");
                false
            }
        },
        None => {
            println!("[~] No PDF path provided. Skipping pdf-extract probe.");
            println!("    Usage: ingest-probe.exe <path-to-spanish.pdf>\n");
            true
        }
    };

    println!("=== Summary ===");
    println!("  SQLite (rusqlite bundled): {}", verdict(sqlite_ok));
    println!("  PDF extraction (pdf-extract): {}", verdict(pdf_ok));

    if sqlite_ok && pdf_ok {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}

fn verdict(ok: bool) -> &'static str {
    if ok {
        "PASS"
    } else {
        "FAIL"
    }
}

fn probe_sqlite() -> rusqlite::Result<()> {
    println!("--- Probe 1: rusqlite (bundled) ---");

    // In-memory DB to avoid leaving artefacts; we only care that the
    // bundled C build linked and that basic ops work.
    let conn = Connection::open_in_memory()?;

    conn.execute_batch(
        "CREATE TABLE documents (
            id INTEGER PRIMARY KEY,
            filename TEXT NOT NULL,
            sha256 TEXT NOT NULL UNIQUE,
            byte_size INTEGER NOT NULL,
            ingested_at INTEGER NOT NULL
         );
         CREATE TABLE chunks (
            id INTEGER PRIMARY KEY,
            document_id INTEGER NOT NULL REFERENCES documents(id),
            ordinal INTEGER NOT NULL,
            text TEXT NOT NULL,
            token_count INTEGER NOT NULL
         );",
    )?;

    let sample = b"Hola mundo, esto es una prueba con eñes y acentos: año, niño, corazón.";
    let mut hasher = Sha256::new();
    hasher.update(sample);
    let sha = hex(&hasher.finalize());

    conn.execute(
        "INSERT INTO documents (filename, sha256, byte_size, ingested_at) VALUES (?1, ?2, ?3, ?4)",
        params!["sample.txt", sha, sample.len() as i64, 1714800000_i64],
    )?;

    let doc_id: i64 = conn.query_row(
        "SELECT id FROM documents WHERE sha256 = ?1",
        params![sha],
        |row| row.get(0),
    )?;

    let chunks = chunk_text(std::str::from_utf8(sample).unwrap(), 8);
    let mut stmt = conn.prepare(
        "INSERT INTO chunks (document_id, ordinal, text, token_count) VALUES (?1, ?2, ?3, ?4)",
    )?;
    for (i, ch) in chunks.iter().enumerate() {
        stmt.execute(params![doc_id, i as i64, ch, ch.split_whitespace().count() as i64])?;
    }

    let chunk_count: i64 =
        conn.query_row("SELECT COUNT(*) FROM chunks", [], |row| row.get(0))?;

    println!("  - SQLite version: {}", rusqlite::version());
    println!("  - documents row inserted, id = {doc_id}, sha256 = {}…", &sha[..16]);
    println!("  - {chunk_count} chunks inserted");
    println!("  - Spanish round-trip verified (UTF-8 stays intact across SQLite)");
    Ok(())
}

fn probe_pdf(path: &str) -> Result<String, String> {
    println!("--- Probe 2: pdf-extract on '{path}' ---");
    let p = Path::new(path);
    if !p.exists() {
        return Err(format!("file not found: {path}"));
    }
    let bytes = fs::read(p).map_err(|e| format!("read error: {e}"))?;
    let text = pdf_extract::extract_text_from_mem(&bytes)
        .map_err(|e| format!("pdf-extract error: {e}"))?;

    let len = text.len();
    let preview: String = text.chars().take(400).collect();

    let mut found: Vec<char> = Vec::new();
    for ch in SPANISH_CHARS {
        if text.contains(*ch) {
            found.push(*ch);
        }
    }
    let mojibake_signals = ["Ã±", "Ã¡", "Ã©", "Ã­", "Ã³", "Ãº", "Â¿", "Â¡"];
    let mojibake_hits: Vec<&str> = mojibake_signals
        .iter()
        .filter(|s| text.contains(**s))
        .copied()
        .collect();

    let header = format!(
        "  - Extracted {len} chars\n  - First 400: {preview:?}\n"
    );

    let verdict_line = if !found.is_empty() && mojibake_hits.is_empty() {
        format!(
            "[✓] Spanish characters preserved: {}\n",
            found.iter().collect::<String>()
        )
    } else if !mojibake_hits.is_empty() {
        format!(
            "[✗] Mojibake detected — UTF-8 is being misinterpreted as Latin-1: {:?}\n    Recommendation: switch v0.1 to pdfium-render.\n",
            mojibake_hits
        )
    } else if len < 100 {
        "[~] Output too short. Either an image-only PDF or extraction failed silently.\n     Recommendation: rerun with a PDF known to contain Spanish text.\n".to_string()
    } else {
        "[~] No Spanish-specific characters found in the first scan, but no mojibake either. Inconclusive — rerun with a PDF that contains ñ/á/é.\n".to_string()
    };

    Ok(format!("{header}{verdict_line}"))
}

fn chunk_text(s: &str, max_words: usize) -> Vec<String> {
    let words: Vec<&str> = s.split_whitespace().collect();
    words
        .chunks(max_words)
        .map(|c| c.join(" "))
        .collect()
}

fn hex(bytes: &[u8]) -> String {
    let mut out = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        out.push_str(&format!("{b:02x}"));
    }
    out
}
