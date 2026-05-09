import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { chatStream, pickChatModel, type ChatMessage } from "./lemonade";

// SPEC §F5 — locked Spanish system prompt for RAG-aware chat. The
// "fragmentos" / "Si la respuesta no está en los fragmentos" lines turn
// this into RAG instead of free-form chat. The two ES-locking lines
// harden against the documented Qwen3 English-thinking defect (arXiv
// 2508.10355). The three "PREGUNTA ACTUAL" lines harden against
// multi-turn drift observed on Qwen3-4B-Instruct-2507: when a follow-up
// question's retrieved fragments overlap semantically with the previous
// answer, the small model anchors on the prior assistant turn and
// re-emits its content instead of answering the new question. Evidence:
// Amazon-PDF multi-turn smoke 2026-05-09 (Q2 returned A1 verbatim).
const SYSTEM_PROMPT_RAG = `Sos un asistente que responde en español rioplatense, formal y al grano.
Respondé SIEMPRE en español, sin alternar al inglés bajo ninguna circunstancia.
No "pienses" en inglés y traduzcas: razoná directamente en español.
Cada mensaje del usuario trae sus propios fragmentos y una PREGUNTA ACTUAL.
Respondé únicamente la PREGUNTA ACTUAL del último mensaje, usando solo sus fragmentos.
Las respuestas anteriores en el chat son contexto conversacional, no fuente de información: no las repitas ni elabores sobre ellas.
Si la respuesta no está en los fragmentos, decilo explícitamente.
No inventes datos. No agregues frases tipo "como modelo de lenguaje" ni "as an AI".
No insertes palabras en inglés salvo nombres propios técnicos.`;

// Variant for when the corpus is empty: drop the fragment-related lines
// so the model doesn't reference context it never received.
const SYSTEM_PROMPT_NO_RAG = `Sos un asistente que responde en español rioplatense, formal y al grano.
Respondé SIEMPRE en español, sin alternar al inglés bajo ninguna circunstancia.
No "pienses" en inglés y traduzcas: razoná directamente en español.
No inventes datos. No agregues frases tipo "como modelo de lenguaje" ni "as an AI".
No insertes palabras en inglés salvo nombres propios técnicos.`;

interface RetrievedChunk {
  chunk_id: number;
  document_id: number;
  document_filename: string;
  ordinal: number;
  text: string;
  score: number;
}

interface RetrievalResult {
  query: string;
  matches: RetrievedChunk[];
  embed_ms: number;
  search_ms: number;
  total_chunks: number;
}

interface VisibleMessage {
  role: "user" | "assistant";
  content: string;
  retrieval?: { chunksUsed: number; docsConsulted: number };
  droppedTurns?: number;
}

// SPEC §F5 budget: 32K context window, with the persistent ctx_size
// bump landed in scripts/dev.ps1 (issue #4 part A). We reserve
// ~4K for the streamed response (max_tokens=1024 + safety margin) and
// use 28K as the prompt budget. Approximate token counter is good
// enough here -- cl100k_base BPE on Spanish text yields ~3.5 chars/
// token, and we round up to err on the side of dropping earlier
// rather than overflowing Lemonade's hard 32K limit.
const MAX_PROMPT_TOKENS = 28000;

function approxTokens(s: string): number {
  return Math.ceil(s.length / 3.5);
}

// Formats the user message so the question lands first (small models
// drop attention after long context blocks) and the fragments follow as
// a clearly-labeled reference list. The "PREGUNTA ACTUAL" tag matches
// the SYSTEM_PROMPT_RAG anchor so the model can disambiguate this
// turn's question from prior assistant content.
function formatRagUserMessage(question: string, chunks: RetrievedChunk[]): string {
  const blocks = chunks.map((c, i) =>
    `[${i + 1}] ${c.document_filename} · fragmento ${c.ordinal}\n${c.text}`,
  );
  return [
    `PREGUNTA ACTUAL: ${question}`,
    "",
    "Para responderla, usá solo los siguientes fragmentos:",
    "",
    blocks.join("\n\n"),
  ].join("\n");
}

// SPEC §F5 FIFO drop: when the prompt budget is exceeded, drop the
// oldest user+assistant pair from the history until the prompt fits.
// The system message [0] and the current user message [last] are
// inviolable -- system is the contract, current user is what we're
// trying to answer. Returns the trimmed message list and the number
// of conversational turns (user+assistant pairs) that were dropped,
// so the UI can surface the FIFO event in the assistant turn's hint.
function applyContextBudget(messages: ChatMessage[]): {
  trimmed: ChatMessage[];
  droppedTurns: number;
} {
  if (messages.length < 4) return { trimmed: messages, droppedTurns: 0 };
  const out = [...messages];
  let droppedTurns = 0;
  // Guard `>= 4` is required: splice(1, 2) needs at least 2 history items
  // (length = system + ≥2 history + currentUser ≥ 4) so we never remove
  // the inviolable system [0] or currentUser [last]. Well-formed
  // histories always have a user at index 1 and its assistant at
  // index 2; the orphan-user edge case from a failed turn is a
  // pre-existing bug not addressed here.
  while (out.length >= 4) {
    const total = out.reduce((s, m) => s + approxTokens(m.content), 0);
    if (total <= MAX_PROMPT_TOKENS) break;
    out.splice(1, 2);
    droppedTurns += 1;
  }
  return { trimmed: out, droppedTurns };
}

export function Chat() {
  const [messages, setMessages] = useState<VisibleMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    pickChatModel()
      .then(setModel)
      .catch((e) => setError(`No pude detectar un modelo de chat: ${String(e)}`));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({
      top: scrollRef.current.scrollHeight,
      behavior: "smooth",
    });
  }, [messages]);

  async function handleSend() {
    const text = input.trim();
    if (!text || streaming || !model) return;

    setError(null);
    setInput("");

    // SPEC §F4: top-K = 6 by default. retrieve() embeds the question and
    // scores all chunks; an empty corpus returns matches=[] and we
    // silently degrade to no-RAG so the first-run experience (no docs
    // ingested yet) still works. A hard failure here (Lemonade
    // embedding endpoint down) is also non-fatal — chatStream will
    // surface the underlying error if the LLM endpoint is also down.
    let chunks: RetrievedChunk[] = [];
    try {
      const r = await invoke<RetrievalResult>("retrieve", {
        query: text,
        topK: 6,
      });
      chunks = r.matches;
    } catch {
      // fall through to no-RAG
    }

    const useRag = chunks.length > 0;
    const docsConsulted = useRag
      ? new Set(chunks.map((c) => c.document_id)).size
      : 0;

    const nextMessages: VisibleMessage[] = [
      ...messages,
      { role: "user", content: text },
      {
        role: "assistant",
        content: "",
        retrieval: useRag
          ? { chunksUsed: chunks.length, docsConsulted }
          : undefined,
      },
    ];
    setMessages(nextMessages);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    // Past turns stay clean — we don't keep stale fragments from earlier
    // questions in the context window. Only the current question carries
    // its retrieved fragments.
    const history = nextMessages
      .slice(0, -2)
      .map((m) => ({ role: m.role, content: m.content }) as ChatMessage);
    const currentUserContent = useRag
      ? formatRagUserMessage(text, chunks)
      : text;
    const fullMessages: ChatMessage[] = [
      {
        role: "system",
        content: useRag ? SYSTEM_PROMPT_RAG : SYSTEM_PROMPT_NO_RAG,
      },
      ...history,
      { role: "user", content: currentUserContent },
    ];
    const { trimmed: apiMessages, droppedTurns } = applyContextBudget(fullMessages);
    if (droppedTurns > 0) {
      // Stamp the dropped-turn count onto the assistant placeholder we
      // just appended to messages, so the hint renders alongside the
      // retrieval line for this turn.
      setMessages((prev) => {
        const out = prev.slice();
        const last = out[out.length - 1];
        if (last && last.role === "assistant") {
          out[out.length - 1] = { ...last, droppedTurns };
        }
        return out;
      });
    }

    try {
      await chatStream({
        messages: apiMessages,
        model,
        signal: controller.signal,
        onToken: (token) => {
          setMessages((prev) => {
            const out = prev.slice();
            const last = out[out.length - 1];
            if (last && last.role === "assistant") {
              out[out.length - 1] = { ...last, content: last.content + token };
            }
            return out;
          });
        },
      });
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // User cancelled — leave whatever tokens arrived in place.
      } else {
        setError(String(e));
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  }

  function handleCancel() {
    abortRef.current?.abort();
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <section className="chat">
      <header className="chat__header">
        <h2>Chat</h2>
        <span className="chat__model">{model ?? "detectando modelo…"}</span>
      </header>

      <div className="chat__messages" ref={scrollRef}>
        {messages.length === 0 ? (
          <p className="chat__empty">
            Cargá documentos arriba y preguntame en español sobre su contenido.
            Si todavía no cargaste nada, igual respondo — sin consultar RAG.
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`chat__msg chat__msg--${m.role}`}>
              <span className="chat__role">{m.role === "user" ? "Vos" : "Asistente"}</span>
              {(m.retrieval || m.droppedTurns) && (
                <span className="chat__retrieval">
                  {m.retrieval && (
                    <>
                      📄 {m.retrieval.chunksUsed} fragmento
                      {m.retrieval.chunksUsed === 1 ? "" : "s"} consultado
                      {m.retrieval.chunksUsed === 1 ? "" : "s"} de{" "}
                      {m.retrieval.docsConsulted} doc
                      {m.retrieval.docsConsulted === 1 ? "" : "s"}
                    </>
                  )}
                  {m.droppedTurns ? (
                    <>
                      {m.retrieval ? " · " : ""}
                      ✂️ {m.droppedTurns} turno
                      {m.droppedTurns === 1 ? "" : "s"} antiguo
                      {m.droppedTurns === 1 ? "" : "s"} descartado
                      {m.droppedTurns === 1 ? "" : "s"}
                    </>
                  ) : null}
                </span>
              )}
              <div className="chat__content">
                {m.content || (streaming && i === messages.length - 1 ? "…" : "")}
              </div>
            </div>
          ))
        )}
      </div>

      {error && <p className="status status--err">Error: {error}</p>}

      <div className="chat__input-row">
        <textarea
          className="chat__input"
          rows={2}
          placeholder="Escribí tu mensaje (Enter para enviar, Shift+Enter para nueva línea)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          disabled={streaming || !model}
        />
        {streaming ? (
          <button type="button" className="chat__btn chat__btn--cancel" onClick={handleCancel}>
            Cancelar
          </button>
        ) : (
          <button
            type="button"
            className="chat__btn"
            onClick={handleSend}
            disabled={!input.trim() || !model}
          >
            Enviar
          </button>
        )}
      </div>
    </section>
  );
}
