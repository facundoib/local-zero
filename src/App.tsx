import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import "./App.css";

function isTauri(): boolean {
  return (
    typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window
  );
}

interface DocumentRow {
  id: number;
  filename: string;
  byte_size: number;
  chunk_count: number;
  ingested_at: number;
}

interface IngestResult {
  id: number;
  filename: string;
  byte_size: number;
  chunk_count: number;
  deduped: boolean;
}

function App() {
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await invoke<DocumentRow[]>("list_documents");
      setDocs(list);
    } catch (e) {
      setError(`No pude leer la lista de documentos: ${String(e)}`);
    }
  }

  async function handleDrop(paths: string[]) {
    if (paths.length === 0) return;
    setBusy(true);
    setError(null);
    setLastResult(null);
    try {
      const results = await invoke<IngestResult[]>("ingest_paths", { paths });
      const fresh = results.filter((r) => !r.deduped);
      const dup = results.filter((r) => r.deduped);
      const parts: string[] = [];
      if (fresh.length > 0) {
        const totalChunks = fresh.reduce((s, r) => s + r.chunk_count, 0);
        parts.push(
          `${fresh.length} archivo${fresh.length === 1 ? "" : "s"} ingresado${
            fresh.length === 1 ? "" : "s"
          } (${totalChunks} chunks)`,
        );
      }
      if (dup.length > 0) {
        parts.push(
          `${dup.length} ya estaba${dup.length === 1 ? "" : "n"} en la base (sin cambios)`,
        );
      }
      setLastResult(parts.join(" · "));
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => {
    if (!isTauri()) {
      setError(
        "Esta vista necesita el WebView de Tauri. Lanzá la app con scripts/dev.ps1, no la abras en un browser regular.",
      );
      return;
    }

    refresh();

    let unlisten: (() => void) | undefined;
    getCurrentWebview()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragOver(true);
        } else if (event.payload.type === "leave") {
          setDragOver(false);
        } else if (event.payload.type === "drop") {
          setDragOver(false);
          handleDrop(event.payload.paths);
        }
      })
      .then((u) => {
        unlisten = u;
      })
      .catch((e) => {
        setError(`No pude registrar el listener de drag&drop: ${String(e)}`);
      });

    return () => {
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <main className="app">
      <header className="hero">
        <h1>Local Zero</h1>
        <p className="hint">
          Arrastrá archivos <code>.txt</code> o <code>.pdf</code> a la zona de abajo
          para ingresarlos. MD llega en la próxima iteración.
        </p>
      </header>

      <section
        className={`dropzone ${dragOver ? "dropzone--over" : ""} ${
          busy ? "dropzone--busy" : ""
        }`}
      >
        <span className="dropzone__label">
          {busy
            ? "Procesando…"
            : dragOver
              ? "Soltá para ingresar"
              : "Arrastrá un archivo .txt o .pdf acá"}
        </span>
      </section>

      {lastResult && <p className="status status--ok">{lastResult}</p>}
      {error && <p className="status status--err">Error: {error}</p>}

      <section className="docs">
        <h2>
          Documentos <span className="count">({docs.length})</span>
        </h2>
        {docs.length === 0 ? (
          <p className="empty">Aún no ingresaste ningún documento.</p>
        ) : (
          <ul>
            {docs.map((d) => (
              <li key={d.id} className="doc-row">
                <span className="filename" title={d.filename}>
                  {d.filename}
                </span>
                <span className="meta">
                  {d.chunk_count} chunks · {formatBytes(d.byte_size)} ·{" "}
                  {formatRelative(d.ingested_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function formatRelative(unixSecs: number): string {
  const now = Math.floor(Date.now() / 1000);
  const diff = now - unixSecs;
  if (diff < 60) return "hace instantes";
  if (diff < 3600) return `hace ${Math.floor(diff / 60)} min`;
  if (diff < 86400) return `hace ${Math.floor(diff / 3600)} h`;
  return `hace ${Math.floor(diff / 86400)} d`;
}

export default App;
