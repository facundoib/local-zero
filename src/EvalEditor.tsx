import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

interface EvalCase {
  id: number;
  question: string;
  expected_substring: string;
  created_at: number;
}

interface Props {
  onCountChange: () => void;
}

export function EvalEditor({ onCountChange }: Props) {
  const [evals, setEvals] = useState<EvalCase[]>([]);
  const [question, setQuestion] = useState("");
  const [expectedSubstring, setExpectedSubstring] = useState("");
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    try {
      const list = await invoke<EvalCase[]>("list_evals");
      setEvals(list);
      onCountChange();
    } catch (e) {
      setError(`No pude cargar las evaluaciones: ${String(e)}`);
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function handleAdd() {
    const q = question.trim();
    const s = expectedSubstring.trim();
    if (!q || !s) return;
    setAdding(true);
    setError(null);
    try {
      await invoke("add_eval", { question: q, expectedSubstring: s });
      setQuestion("");
      setExpectedSubstring("");
      await refresh();
    } catch (e) {
      setError(String(e));
    } finally {
      setAdding(false);
    }
  }

  async function handleDelete(id: number) {
    try {
      await invoke("delete_eval", { id });
      await refresh();
    } catch (e) {
      setError(String(e));
    }
  }

  const remaining = Math.max(0, 5 - evals.length);

  return (
    <section className="eval-editor">
      <header className="eval-editor__header">
        <h2>Evaluaciones</h2>
        <span
          className={`eval-editor__count${evals.length >= 5 ? " eval-editor__count--ok" : ""}`}
        >
          {evals.length}/5{evals.length >= 5 ? " ✓" : ` — faltan ${remaining}`}
        </span>
      </header>
      <p className="eval-editor__desc">
        Escribí preguntas sobre tu corpus y la subcadena que esperás en la
        respuesta. Se necesitan ≥5 para habilitar el export (Gate G2).
      </p>

      {evals.length > 0 && (
        <ul className="eval-list">
          {evals.map((e) => (
            <li key={e.id} className="eval-item">
              <div className="eval-item__body">
                <span className="eval-item__question">{e.question}</span>
                <span className="eval-item__arrow">→</span>
                <span className="eval-item__expected">
                  {e.expected_substring}
                </span>
              </div>
              <button
                type="button"
                className="eval-item__delete"
                onClick={() => handleDelete(e.id)}
                title="Eliminar esta evaluación"
              >
                ✕
              </button>
            </li>
          ))}
        </ul>
      )}

      {error && <p className="status status--err">{error}</p>}

      <div className="eval-add">
        <input
          className="eval-add__input"
          type="text"
          placeholder="Pregunta (ej: ¿Cuál es la función principal de X?)"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <input
          className="eval-add__input"
          type="text"
          placeholder="Subcadena esperada en la respuesta (ej: autenticación)"
          value={expectedSubstring}
          onChange={(e) => setExpectedSubstring(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleAdd();
          }}
        />
        <button
          type="button"
          className="eval-add__btn"
          onClick={handleAdd}
          disabled={!question.trim() || !expectedSubstring.trim() || adding}
        >
          {adding ? "…" : "Agregar"}
        </button>
      </div>
    </section>
  );
}
