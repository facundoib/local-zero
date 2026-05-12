import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open } from "@tauri-apps/plugin-dialog";
import { Chat } from "./Chat";
import { EvalEditor } from "./EvalEditor";
import { ExportPanel } from "./ExportPanel";
import { Settings, type AppSettings } from "./Settings";
import { LEMONADE_URL, EMBED_MODEL } from "./lemonade";
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
  embedded_count: number;
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

interface EmbedProgress {
  doc_id: number;
  done: number;
  total: number;
}


type LemonadeHealth =
  | { kind: "checking" }
  | { kind: "ok" }
  | { kind: "down" }
  | { kind: "embed-missing" };

type View = "home" | "export" | "settings";

const DEFAULT_SETTINGS: AppSettings = {
  backend_url: LEMONADE_URL,
  llm_model: "Qwen3-4B-Instruct-2507-GGUF",
  embed_model: EMBED_MODEL,
  voice_enabled: false,
  tts_voice: "ef_dora",
  top_k: 6,
  theme: "system",
};

function applyTheme(theme: string) {
  const root = document.documentElement;
  if (theme === "dark") root.dataset.theme = "dark";
  else if (theme === "light") root.dataset.theme = "light";
  else delete root.dataset.theme;
}

function App() {
  const [view, setView] = useState<View>("home");
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [docs, setDocs] = useState<DocumentRow[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastResult, setLastResult] = useState<string | null>(null);
  // Live override of embedded_count while a background embed is in
  // flight. The persisted column from list_documents is the
  // authoritative source after completion; this keeps UI snappy without
  // re-querying every batch.
  const [embedProgress, setEmbedProgress] = useState<
    Record<number, { done: number; total: number }>
  >({});
  const [health, setHealth] = useState<LemonadeHealth>({ kind: "checking" });
  const [evalRefreshKey, setEvalRefreshKey] = useState(0);
  const [pendingDelete, setPendingDelete] = useState<number | null>(null);

  async function checkLemonadeHealth(backendUrl?: string) {
    setHealth({ kind: "checking" });
    const url = `${backendUrl ?? settings.backend_url}/models`;
    try {
      const resp = await fetch(url);
      if (!resp.ok) {
        setHealth({ kind: "down" });
        return;
      }
      const json = (await resp.json()) as { data?: { id: string }[] };
      const has = (json.data ?? []).some((m) => m.id === EMBED_MODEL);
      setHealth({ kind: has ? "ok" : "embed-missing" });
    } catch {
      // fetch throws on TypeError network failure (server not running,
      // DNS, etc). HTTP non-200 doesn't throw — that's handled above.
      setHealth({ kind: "down" });
    }
  }

  async function refresh() {
    try {
      const list = await invoke<DocumentRow[]>("list_documents");
      setDocs(list);
    } catch (e) {
      setError(`No pude leer la lista de documentos: ${String(e)}`);
    }
  }

  async function handleDelete(id: number) {
    try {
      await invoke("delete_document", { id });
      setPendingDelete(null);
      await refresh();
    } catch (e) {
      setError(`No pude eliminar el documento: ${String(e)}`);
      setPendingDelete(null);
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
    invoke<AppSettings>("get_settings")
      .then((s) => {
        setSettings(s);
        applyTheme(s.theme);
        checkLemonadeHealth(s.backend_url);
      })
      .catch(() => checkLemonadeHealth());

    // The listener registration is async; React.StrictMode in dev runs
    // mount → cleanup → mount, so cleanup may fire before the .then()
    // resolves. Track activity with a flag so a late-arriving unlisten
    // function is invoked immediately rather than being abandoned, which
    // would leave a duplicate listener and double-fire every drop.
    let active = true;
    let unlistenDrop: (() => void) | undefined;
    let unlistenEmbed: (() => void) | undefined;

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
          unlistenDrop = u;
        }
      })
      .catch((e) => {
        setError(`No pude registrar el listener de drag&drop: ${String(e)}`);
      });

    listen<EmbedProgress>("embed-progress", (event) => {
      const { doc_id, done, total } = event.payload;
      setEmbedProgress((prev) => ({ ...prev, [doc_id]: { done, total } }));
      // On completion, re-query list_documents so the authoritative
      // embedded_count column reflects the persisted state. The live
      // override stays in place until the refresh resolves; once docs
      // are refetched, embedded_count == chunk_count and the UI hides
      // the "embedding…" hint regardless of the override.
      if (done >= total) {
        refresh();
      }
    })
      .then((u) => {
        if (!active) {
          u();
        } else {
          unlistenEmbed = u;
        }
      })
      .catch((e) => {
        setError(`No pude registrar el listener de embed-progress: ${String(e)}`);
      });

    return () => {
      active = false;
      unlistenDrop?.();
      unlistenEmbed?.();
    };
  }, []);

  if (view === "settings") {
    return (
      <main className="app">
        <Settings
          initial={settings}
          onBack={() => setView("home")}
          onSave={(s) => {
            setSettings(s);
            applyTheme(s.theme);
            checkLemonadeHealth(s.backend_url);
            setView("home");
          }}
        />
      </main>
    );
  }

  if (view === "export") {
    return (
      <main className="app">
        <header className="export-view__header">
          <button
            type="button"
            className="export-view__back"
            onClick={() => setView("home")}
          >
            ← Volver
          </button>
          <div>
            <h1 className="export-view__title">Exportar mi starter</h1>
            <p className="export-view__desc">
              Documentá tus evaluaciones y exportá un proyecto TypeScript listo
              para hacer fork. No es un portfolio todavía — se convierte en uno
              con los commits que hagas encima.
            </p>
          </div>
        </header>
        <EvalEditor onCountChange={() => setEvalRefreshKey((k) => k + 1)} />
        <ExportPanel refreshKey={evalRefreshKey} />
      </main>
    );
  }

  return (
    <main className="app">
      <header className="hero">
        <div className="hero__top">
          <h1>Local Zero</h1>
          <button
            type="button"
            className="hero__gear"
            onClick={() => setView("settings")}
            title="Configuración"
          >
            ⚙️
          </button>
        </div>
        <p className="hint">
          Arrastrá archivos <code>.txt</code>, <code>.md</code> o <code>.pdf</code>{" "}
          a la zona de abajo para ingresarlos.
        </p>
      </header>

      {(health.kind === "down" || health.kind === "embed-missing") && (
        <div className="lemonade-banner" role="alert">
          <span className="lemonade-banner__msg">
            {health.kind === "down" ? (
              <>
                Lemonade Server no responde en <code>localhost:13305</code>.
                Iniciá el server (menú Inicio → Lemonade, o{" "}
                <code>LemonadeServer.exe</code> en una terminal) y reintentá.
              </>
            ) : (
              <>
                Falta el modelo de embeddings <code>{EMBED_MODEL}</code>{" "}
                en Lemonade. Ejecutá:{" "}
                <code>lemonade pull {EMBED_MODEL}</code>
              </>
            )}
          </span>
          <button
            type="button"
            className="lemonade-banner__retry"
            onClick={() => checkLemonadeHealth()}
          >
            Reintentar
          </button>
        </div>
      )}

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
            {docs.map((d) => {
              const live = embedProgress[d.id];
              const done = live?.done ?? d.embedded_count;
              const total = d.chunk_count;
              const embedding = total > 0 && done < total;
              const confirming = pendingDelete === d.id;
              return (
                <li key={d.id} className={`doc-row${confirming ? " doc-row--confirming" : ""}`}>
                  {confirming ? (
                    <>
                      <span className="doc-row__confirm-label">
                        ¿Eliminar <strong>{d.filename}</strong>?
                      </span>
                      <span className="doc-row__confirm-actions">
                        <button
                          type="button"
                          className="doc-row__confirm-cancel"
                          onClick={() => setPendingDelete(null)}
                        >
                          Cancelar
                        </button>
                        <button
                          type="button"
                          className="doc-row__confirm-ok"
                          onClick={() => handleDelete(d.id)}
                        >
                          Eliminar
                        </button>
                      </span>
                    </>
                  ) : (
                    <>
                      <span className="filename" title={d.filename}>
                        {d.filename}
                      </span>
                      <span className="meta">
                        {d.chunk_count} chunks · {formatBytes(d.byte_size)} ·{" "}
                        {formatRelative(d.ingested_at)}
                        {embedding && (
                          <>
                            {" · "}
                            <span className="meta__embed">
                              embedding {done}/{total}…
                            </span>
                          </>
                        )}
                      </span>
                      <button
                        type="button"
                        className="doc-row__delete"
                        onClick={() => setPendingDelete(d.id)}
                        title="Eliminar documento"
                      >
                        ✕
                      </button>
                    </>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      <footer className="app-footer">
        <button
          type="button"
          className="app-footer__export-btn"
          onClick={() => setView("export")}
        >
          Exportar mi starter →
        </button>
      </footer>

      <Chat
        backendUrl={settings.backend_url}
        llmModel={settings.llm_model}
        ttsVoice={settings.tts_voice}
        topK={settings.top_k}
        voiceDefault={settings.voice_enabled}
      />
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
