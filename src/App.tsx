import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
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
  elapsed_ms: number;
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

  async function handlePickFiles() {
    if (!isTauri()) return;
    try {
      const selection = await open({
        multiple: true,
        filters: [
          { name: "Documentos", extensions: ["txt", "md", "pdf"] },
        ],
      });
      if (selection === null) return;
      const paths = Array.isArray(selection) ? selection : [selection];
      await handleDrop(paths);
    } catch (e) {
      setError(`No pude abrir el selector: ${String(e)}`);
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
        const totalMs = fresh.reduce((s, r) => s + r.elapsed_ms, 0);
        parts.push(
          `${fresh.length} archivo${fresh.length === 1 ? "" : "s"} ingresado${
            fresh.length === 1 ? "" : "s"
          } (${totalChunks} chunks · ${formatElapsed(totalMs)})`,
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

    // The listener registration is async; React.StrictMode in dev runs
    // mount → cleanup → mount, so cleanup may fire before the .then()
    // resolves. Track activity with a flag so a late-arriving unlisten
    // function is invoked immediately rather than being abandoned, which
    // would leave a duplicate listener and double-fire every drop.
    let active = true;
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
        if (!active) {
          u();
        } else {
          unlisten = u;
        }
      })
      .catch((e) => {
        setError(`No pude registrar el listener de drag&drop: ${String(e)}`);
      });

    return () => {
      active = false;
      if (unlisten) unlisten();
    };
  }, []);

  return (
    <main className="app">
      <header className="hero">
        <h1>Local Zero</h1>
        <p className="hint">
          Arrastrá archivos <code>.txt</code>, <code>.md</code> o <code>.pdf</code>{" "}
          a la zona de abajo para ingresarlos.
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
              : "Arrastrá un archivo .txt, .md o .pdf acá"}
        </span>
        {!busy && !dragOver && (
          <button
            type="button"
            className="dropzone__picker"
            onClick={handlePickFiles}
          >
            o elegí archivos…
          </button>
        )}
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

function formatElapsed(ms: number): string {
  if (ms < 1000) return `${ms} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
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
