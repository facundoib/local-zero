import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { chatStream, pickChatModel, type ChatMessage } from "./lemonade";

// SPEC §F5 — locked Spanish system prompt for RAG-aware chat. The two
// "fragmentos provistos" / "Si la respuesta no está en los fragmentos"
// lines are what turn this into RAG instead of free-form chat. The two
// ES-locking lines harden against the documented Qwen3 English-thinking
// defect (arXiv 2508.10355). See docs/decisions/v0.1-model-selection.md.
const SYSTEM_PROMPT_RAG = `Sos un asistente que responde en español rioplatense, formal y al grano.
Respondé SIEMPRE en español, sin alternar al inglés bajo ninguna circunstancia.
No "pienses" en inglés y traduzcas: razoná directamente en español.
Usás únicamente la información de los fragmentos provistos para responder.
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
}

function formatContext(chunks: RetrievedChunk[]): string {
  const blocks = chunks.map((c, i) =>
    `[${i + 1}] ${c.document_filename} · fragmento ${c.ordinal}\n${c.text}`,
  );
  return `FRAGMENTOS PROVISTOS:\n${blocks.join("\n\n")}`;
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
      ? `${formatContext(chunks)}\n\nPREGUNTA: ${text}`
      : text;
    const apiMessages: ChatMessage[] = [
      {
        role: "system",
        content: useRag ? SYSTEM_PROMPT_RAG : SYSTEM_PROMPT_NO_RAG,
      },
      ...history,
      { role: "user", content: currentUserContent },
    ];

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
              {m.retrieval && (
                <span className="chat__retrieval">
                  📄 {m.retrieval.chunksUsed} fragmento
                  {m.retrieval.chunksUsed === 1 ? "" : "s"} consultado
                  {m.retrieval.chunksUsed === 1 ? "" : "s"} de{" "}
                  {m.retrieval.docsConsulted} doc
                  {m.retrieval.docsConsulted === 1 ? "" : "s"}
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
