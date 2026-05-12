mod db;
mod embed;
mod evals;
mod export;
mod ingest;
mod retrieval;

use std::sync::{Arc, Mutex};
use tauri::Manager;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .setup(|app| {
            let app_data = app.path().app_data_dir()?;
            let db_path = app_data.join("local-zero.db");
            let conn = db::open(&db_path)
                .map_err(|e| format!("inicializando base de datos: {e}"))?;
            app.manage(db::DbState(Arc::new(Mutex::new(conn))));
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            ingest::ingest_paths,
            ingest::list_documents,
            embed::embed_document,
            retrieval::retrieve,
            evals::list_evals,
            evals::add_eval,
            evals::delete_eval,
            export::check_export_gates,
            export::export_starter
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
