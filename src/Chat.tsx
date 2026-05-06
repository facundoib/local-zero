import { useEffect, useRef, useState } from "react";
import { chatStream, pickChatModel, type ChatMessage } from "./lemonade";

// SPEC §F5 system prompt — RAG-aware variant talks about "fragmentos".
// In this slice (chat without retrieval) we drop those lines so the model
// doesn't hallucinate references to context it never received. The full
// SPEC prompt comes back when F4 (retrieval) is wired in.
//
// The "respondé SIEMPRE en español" + "no pienses en inglés" lines are
// hardening against the documented Qwen3-family English-thinking defect
// (arXiv 2508.10355, QwenLM/Qwen3.5#35). See
// docs/decisions/v0.1-model-selection.md for the evidence.
const SYSTEM_PROMPT = `Sos un asistente que responde en español rioplatense, formal y al grano.
Respondé SIEMPRE en español, sin alternar al inglés bajo ninguna circunstancia.
No "pienses" en inglés y traduzcas: razoná directamente en español.
No inventes datos. No agregues frases tipo "como modelo de lenguaje" ni "as an AI".
No insertes palabras en inglés salvo nombres propios técnicos.`;

interface VisibleMessage {
  role: "user" | "assistant";
  content: string;
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
    const nextMessages: VisibleMessage[] = [
      ...messages,
      { role: "user", content: text },
      { role: "assistant", content: "" },
    ];
    setMessages(nextMessages);
    setStreaming(true);

    const controller = new AbortController();
    abortRef.current = controller;

    const apiMessages: ChatMessage[] = [
      { role: "system", content: SYSTEM_PROMPT },
      ...nextMessages
        .slice(0, -1)
        .map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
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
              out[out.length - 1] = { role: "assistant", content: last.content + token };
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
            Escribí una pregunta. Por ahora respondo sin mirar tus documentos —
            la integración con RAG llega en el próximo slice.
          </p>
        ) : (
          messages.map((m, i) => (
            <div key={i} className={`chat__msg chat__msg--${m.role}`}>
              <span className="chat__role">{m.role === "user" ? "Vos" : "Asistente"}</span>
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
