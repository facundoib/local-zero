import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open as openFolder } from "@tauri-apps/plugin-dialog";

interface GateStatus {
  g1_ok: boolean;
  g2_ok: boolean;
  g2_count: number;
  doc_count: number;
}

interface Props {
  refreshKey: number;
}

export function ExportPanel({ refreshKey }: Props) {
  const [gates, setGates] = useState<GateStatus | null>(null);
  const [g3Problem, setG3Problem] = useState("");
  const [g3Domain, setG3Domain] = useState("");
  const [g3Learnings, setG3Learnings] = useState("");
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const successRef = useRef<HTMLDialogElement>(null);

  async function refresh() {
    try {
      const status = await invoke<GateStatus>("check_export_gates");
      setGates(status);
    } catch {
      // Non-fatal: gates stay null, button stays disabled.
    }
  }

  useEffect(() => {
    refresh();
  }, [refreshKey]);

  const g3Ready =
    g3Problem.trim().length > 30 &&
    g3Domain.trim().length > 30 &&
    g3Learnings.trim().length > 30;

  const allReady = (gates?.g1_ok && gates?.g2_ok) ?? false;

  function openExportDialog() {
    setExportError(null);
    dialogRef.current?.showModal();
  }

  async function handleExport() {
    if (!g3Ready) return;
    setExporting(true);
    setExportError(null);
    try {
      const folder = await openFolder({
        directory: true,
        title: "Elegir carpeta para exportar el starter",
      });
      if (!folder) {
        setExporting(false);
        return;
      }
      await invoke("export_starter", {
        outputDir: folder as string,
        g3Problem: g3Problem.trim(),
        g3Domain: g3Domain.trim(),
        g3Learnings: g3Learnings.trim(),
      });
      setExportedPath(folder as string);
      dialogRef.current?.close();
      successRef.current?.showModal();
    } catch (e) {
      setExportError(String(e));
    } finally {
      setExporting(false);
    }
  }

  return (
    <section className="export-panel">
      <header className="export-panel__header">
        <h2>Exportar starter</h2>
        <span
          className={`export-panel__badge${allReady ? " export-panel__badge--ok" : ""}`}
        >
          {allReady ? "listo para exportar" : "gates pendientes"}
        </span>
      </header>

      <div className="export-gates">
        <div
          className={`export-gate${gates?.g1_ok ? " export-gate--ok" : " export-gate--fail"}`}
        >
          <span className="export-gate__icon">{gates?.g1_ok ? "✓" : "✗"}</span>
          <span className="export-gate__text">
            G1 — Corpus propio ({gates?.doc_count ?? 0} doc
            {gates?.doc_count !== 1 ? "s" : ""})
            {!gates?.g1_ok && (
              <span className="export-gate__hint">
                {" "}
                — Cargá al menos un documento.
              </span>
            )}
          </span>
        </div>
        <div
          className={`export-gate${gates?.g2_ok ? " export-gate--ok" : " export-gate--fail"}`}
        >
          <span className="export-gate__icon">{gates?.g2_ok ? "✓" : "✗"}</span>
          <span className="export-gate__text">
            G2 — Evaluaciones ({gates?.g2_count ?? 0}/5)
            {!gates?.g2_ok && (
              <span className="export-gate__hint">
                {" "}
                — Escribí {5 - (gates?.g2_count ?? 0)} más arriba.
              </span>
            )}
          </span>
        </div>
        <div className="export-gate export-gate--g3">
          <span className="export-gate__icon">○</span>
          <span className="export-gate__text">
            G3 — Contexto del README (en el diálogo de exportación)
          </span>
        </div>
      </div>

      <button
        type="button"
        className="export-btn"
        disabled={!allReady}
        onClick={openExportDialog}
        title={
          !allReady
            ? "Completá G1 y G2 antes de exportar"
            : "Abrir diálogo de exportación"
        }
      >
        Exportar starter
      </button>

      {/* G3 dialog */}
      <dialog ref={dialogRef} className="export-dialog">
        <h3 className="export-dialog__title">Contexto del README (G3)</h3>
        <p className="export-dialog__desc">
          Estas respuestas se inyectan verbatim en el README exportado. Mínimo
          30 caracteres cada una.
        </p>

        <label className="export-dialog__label">
          ¿Qué problema resuelve este proyecto?
          <textarea
            className="export-dialog__textarea"
            rows={3}
            value={g3Problem}
            onChange={(e) => setG3Problem(e.target.value)}
            placeholder="Ej: Quería poder hacerle preguntas a los PDFs de mi facultad sin depender de Internet ni pagar APIs..."
          />
          <span
            className={`export-dialog__char${g3Problem.trim().length > 30 ? " export-dialog__char--ok" : ""}`}
          >
            {g3Problem.trim().length}/30+
          </span>
        </label>

        <label className="export-dialog__label">
          ¿Por qué elegiste este dominio?
          <textarea
            className="export-dialog__textarea"
            rows={3}
            value={g3Domain}
            onChange={(e) => setG3Domain(e.target.value)}
            placeholder="Ej: Trabajo en ciberseguridad y quería indexar reportes de amenazas que leo semanalmente..."
          />
          <span
            className={`export-dialog__char${g3Domain.trim().length > 30 ? " export-dialog__char--ok" : ""}`}
          >
            {g3Domain.trim().length}/30+
          </span>
        </label>

        <label className="export-dialog__label">
          ¿Qué aprendiste y qué harías distinto?
          <textarea
            className="export-dialog__textarea"
            rows={3}
            value={g3Learnings}
            onChange={(e) => setG3Learnings(e.target.value)}
            placeholder="Ej: Aprendí que el chunking tiene un impacto enorme en la calidad del retrieval. Haría overlap más grande..."
          />
          <span
            className={`export-dialog__char${g3Learnings.trim().length > 30 ? " export-dialog__char--ok" : ""}`}
          >
            {g3Learnings.trim().length}/30+
          </span>
        </label>

        {exportError && (
          <p className="export-dialog__error">{exportError}</p>
        )}

        <div className="export-dialog__actions">
          <button
            type="button"
            className="export-dialog__cancel"
            onClick={() => dialogRef.current?.close()}
          >
            Cancelar
          </button>
          <button
            type="button"
            className="export-dialog__submit"
            disabled={!g3Ready || exporting}
            onClick={handleExport}
          >
            {exporting ? "Exportando…" : "Elegir carpeta y exportar"}
          </button>
        </div>
      </dialog>

      {/* Post-export success modal */}
      <dialog ref={successRef} className="export-dialog export-dialog--success">
        <h3 className="export-dialog__title">¡Starter exportado!</h3>
        <p className="export-dialog__desc">Para subir tu starter a GitHub:</p>
        <pre className="export-dialog__code">{`cd "${exportedPath ?? "<carpeta>"}"
git init && git add . && git commit -m "Initial commit"
gh repo create <nombre> --public --source=. --push`}</pre>
        <p className="export-dialog__reminder">
          Recordá: este repo todavía <strong>no es un portfolio</strong>. Lo
          que lo convierte en portfolio son los commits que hagas encima:
          agregá features, escribí más evaluaciones, deployalo, documentá lo
          que aprendiste.
        </p>
        <div className="export-dialog__actions">
          <button
            type="button"
            className="export-dialog__submit"
            onClick={() => successRef.current?.close()}
          >
            Entendido
          </button>
        </div>
      </dialog>
    </section>
  );
}
