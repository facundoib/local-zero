use rusqlite::Connection;
use std::path::Path;
use std::sync::{Arc, Mutex};

// Arc-wrapped so background tasks (e.g. auto-embed spawned from
// ingest_paths) can hold their own owned reference to the same Mutex
// without borrowing from a Tauri `State`.
pub struct DbState(pub Arc<Mutex<Connection>>);

pub fn open(db_path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        std::fs::create_dir_all(parent).ok();
    }
    let conn = Connection::open(db_path)?;
    bootstrap(&conn)?;
    Ok(conn)
}

fn bootstrap(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS documents (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            filename    TEXT    NOT NULL,
            path        TEXT    NOT NULL,
            mime_type   TEXT    NOT NULL,
            byte_size   INTEGER NOT NULL,
            sha256      TEXT    NOT NULL UNIQUE,
            ingested_at INTEGER NOT NULL
         );
         CREATE TABLE IF NOT EXISTS chunks (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            document_id INTEGER NOT NULL REFERENCES documents(id),
            ordinal     INTEGER NOT NULL,
            text        TEXT    NOT NULL,
            token_count INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_chunks_document ON chunks(document_id);
         CREATE TABLE IF NOT EXISTS embeddings (
            chunk_id INTEGER PRIMARY KEY REFERENCES chunks(id),
            vector   BLOB    NOT NULL,
            dim      INTEGER NOT NULL,
            model    TEXT    NOT NULL
         );
         CREATE TABLE IF NOT EXISTS evals (
            id                 INTEGER PRIMARY KEY AUTOINCREMENT,
            question           TEXT    NOT NULL,
            expected_substring TEXT    NOT NULL,
            created_at         INTEGER NOT NULL
         );",
    )
}
