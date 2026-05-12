import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import {
  chatStream,
  pickChatModel,
  transcribeAudio,
  synthesizeSpeech,
  EMBED_MODEL,
  type ChatMessage,
} from "./lemonade";

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
  query_vector_preview: number[];
  query_vector_dim: number;
}

// SPEC §F7: per-turn educational data shown in the side panel.
interface EduTurnData {
  vectorPreview: number[];
  vectorDim: number;
  chunks: RetrievedChunk[];
  promptMessages: ChatMessage[];
  tokenCount: number;
  tokensPerSec: number;
}

interface VisibleMessage {
  role: "user" | "assistant";
  content: string;
  retrieval?: { chunksUsed: number; docsConsulted: number };
  droppedTurns?: number;
  edu?: EduTurnData;
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

// SPEC §F7: renders the full prompt as labeled blocks for display in the edu panel.
function formatPromptForDisplay(messages: ChatMessage[]): string {
  return messages
    .map((m) => {
      const header = `[${m.role.toUpperCase()}]`;
      const body =
        m.content.length > 1200
          ? m.content.slice(0, 1200) + "\n[…truncado]"
          : m.content;
      return `${header}\n${body}`;
    })
    .join("\n\n---\n\n");
}

// SPEC §F7: pre-written static Spanish explanations. NOT LLM-generated.
const EDU_EXPLANATIONS = {
  vector: (dim: number) =>
    `El modelo de embeddings (${EMBED_MODEL}) codificó tu pregunta como un vector de ${dim} números de punto flotante. ` +
    `Cada dimensión captura una faceta del significado semántico. ` +
    `Preguntas con significados similares producen vectores que apuntan en la misma dirección en ese espacio, ` +
    `por eso la búsqueda funciona sin palabras clave exactas. ` +
    `Los primeros 8 valores son una muestra del vector completo.`,

  chunks: (k: number) =>
    `Para cada fragmento del corpus, el sistema calculó la similitud coseno entre su vector y el de tu pregunta. ` +
    `La similitud coseno mide cuánto se parecen dos vectores en dirección, con valores entre -1 (opuestos) y 1 (idénticos). ` +
    `Se seleccionaron los ${k} fragmentos con mayor score y se inyectaron en el prompt como contexto. ` +
    `Scores por debajo de 0.3 indican poca relevancia — en esos casos el modelo puede alucinar aunque responda con confianza.`,

  prompt: () =>
    `Este es el prompt completo que recibió el LLM. ` +
    `Incluye: el system prompt (que define rol y restricciones del asistente), ` +
    `el historial de turnos anteriores si los hay, y el mensaje del usuario actual con los fragmentos recuperados bajo "FRAGMENTOS PROVISTOS". ` +
    `El modelo no tiene acceso a Internet ni a los documentos completos — solo ve lo que está en este prompt. ` +
    `Por eso el diseño del prompt y la calidad del retrieval son tan críticos en RAG.`,

  stats: () =>
    `Durante el streaming, el LLM generó tokens de a uno y los envió vía Server-Sent Events (SSE). ` +
    `Cada token corresponde aproximadamente a una sílaba, palabra corta, o signo de puntuación. ` +
    `La velocidad en tok/s refleja el rendimiento de la GPU con este modelo. ` +
    `El conteo es una aproximación basada en los eventos SSE recibidos; el conteo exacto requeriría el tokenizador del modelo.`,
};

// SPEC §F7 side panel component.
function EduPanel({
  data,
  streaming,
  liveStats,
}: {
  data: EduTurnData | null;
  streaming: boolean;
  liveStats: { tokens: number; tps: number } | null;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());

  function toggle(section: string) {
    setOpen((prev) => {
      const next = new Set(prev);
      if (next.has(section)) next.delete(section);
      else next.add(section);
      return next;
    });
  }

  const displayStats =
    streaming && liveStats
      ? liveStats
      : data && data.tokenCount > 0
        ? { tokens: data.tokenCount, tps: data.tokensPerSec }
        : null;

  if (!data && !streaming) {
    return (
      <aside className="edu-panel">
        <h3 className="edu-panel__title">Pipeline RAG</h3>
        <p className="edu-panel__empty">
          Enviá un mensaje para ver el pipeline en acción.
        </p>
      </aside>
    );
  }

  return (
    <aside className="edu-panel">
      <h3 className="edu-panel__title">Pipeline RAG</h3>

      {/* 1 — Embedding de la pregunta */}
      <div className="edu-section">
        <div className="edu-section__header">
          <span className="edu-section__num">1</span>
          <span className="edu-section__label">Embedding de la pregunta</span>
          {data && (
            <button
              type="button"
              className="edu-section__explain-btn"
              onClick={() => toggle("vector")}
            >
              {open.has("vector") ? "Ocultar" : "Explicar"}
            </button>
          )}
        </div>
        {data ? (
          <div className="edu-section__body">
            <code className="edu-vector">
              [{data.vectorPreview.map((v) => v.toFixed(3)).join(", ")}
              {data.vectorDim > 8 ? ", …" : ""}]
            </code>
            <span className="edu-vector__dim">{data.vectorDim} dim</span>
          </div>
        ) : (
          <p className="edu-section__pending">Recuperando…</p>
        )}
        {open.has("vector") && data && (
          <p className="edu-section__explanation">
            {EDU_EXPLANATIONS.vector(data.vectorDim)}
          </p>
        )}
      </div>

      {/* 2 — Fragmentos recuperados */}
      <div className="edu-section">
        <div className="edu-section__header">
          <span className="edu-section__num">2</span>
          <span className="edu-section__label">Fragmentos recuperados</span>
          {data && (
            <button
              type="button"
              className="edu-section__explain-btn"
              onClick={() => toggle("chunks")}
            >
              {open.has("chunks") ? "Ocultar" : "Explicar"}
            </button>
          )}
        </div>
        {data ? (
          data.chunks.length === 0 ? (
            <p className="edu-section__empty-note">
              Sin corpus — no se usó RAG.
            </p>
          ) : (
            <ol className="edu-chunks">
              {data.chunks.map((c, i) => (
                <li key={i} className="edu-chunk">
                  <div className="edu-chunk__meta">
                    <span
                      className="edu-chunk__doc"
                      title={c.document_filename}
                    >
                      {c.document_filename.length > 22
                        ? c.document_filename.slice(0, 20) + "…"
                        : c.document_filename}
                    </span>
                    <span className="edu-chunk__score">
                      {c.score.toFixed(3)}
                    </span>
                  </div>
                  <p className="edu-chunk__excerpt">
                    {c.text.slice(0, 100)}
                    {c.text.length > 100 ? "…" : ""}
                  </p>
                </li>
              ))}
            </ol>
          )
        ) : (
          <p className="edu-section__pending">Recuperando…</p>
        )}
        {open.has("chunks") && data && (
          <p className="edu-section__explanation">
            {EDU_EXPLANATIONS.chunks(data.chunks.length)}
          </p>
        )}
      </div>

      {/* 3 — Prompt enviado al LLM */}
      <div className="edu-section">
        <div className="edu-section__header">
          <span className="edu-section__num">3</span>
          <span className="edu-section__label">Prompt enviado al LLM</span>
          {data && (
            <button
              type="button"
              className="edu-section__explain-btn"
              onClick={() => toggle("prompt")}
            >
              {open.has("prompt") ? "Ocultar" : "Explicar"}
            </button>
          )}
        </div>
        {data ? (
          <pre className="edu-prompt">
            {formatPromptForDisplay(data.promptMessages)}
          </pre>
        ) : (
          <p className="edu-section__pending">Construyendo prompt…</p>
        )}
        {open.has("prompt") && (
          <p className="edu-section__explanation">
            {EDU_EXPLANATIONS.prompt()}
          </p>
        )}
      </div>

      {/* 4 — Generación */}
      <div className="edu-section">
        <div className="edu-section__header">
          <span className="edu-section__num">4</span>
          <span className="edu-section__label">Generación</span>
          <button
            type="button"
            className="edu-section__explain-btn"
            onClick={() => toggle("stats")}
          >
            {open.has("stats") ? "Ocultar" : "Explicar"}
          </button>
        </div>
        {displayStats ? (
          <div className="edu-stats">
            <span>{displayStats.tokens} tokens</span>
            <span className="edu-stats__sep">·</span>
            <span>
              {displayStats.tps > 0
                ? displayStats.tps.toFixed(1)
                : "…"}{" "}
              tok/s
            </span>
            {streaming && (
              <span className="edu-stats__live" title="Generando">
                ⬤
              </span>
            )}
          </div>
        ) : (
          <p className="edu-section__pending">Esperando respuesta…</p>
        )}
        {open.has("stats") && (
          <p className="edu-section__explanation">
            {EDU_EXPLANATIONS.stats()}
          </p>
        )}
      </div>
    </aside>
  );
}

interface ChatProps {
  backendUrl: string;
  llmModel: string;
  ttsVoice: string;
  topK: number;
  voiceDefault: boolean;
}

export function Chat({ backendUrl, llmModel, ttsVoice, topK, voiceDefault }: ChatProps) {
  const [messages, setMessages] = useState<VisibleMessage[]>([]);
  const [input, setInput] = useState("");
  const [model, setModel] = useState<string | null>(null);
  const [streaming, setStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const [voiceEnabled, setVoiceEnabled] = useState(voiceDefault);
  const [micState, setMicState] = useState<
    "idle" | "requesting" | "recording" | "transcribing" | "denied"
  >("idle");
  const [ttsPlaying, setTtsPlaying] = useState(false);
  const [ttsError, setTtsError] = useState<string | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const audioRef = useRef(new Audio());

  // SPEC §F7: panel state persisted per session, not across restarts.
  const [panelOpen, setPanelOpen] = useState(
    () => sessionStorage.getItem("lz_edu_panel") === "1",
  );
  const [liveStats, setLiveStats] = useState<{
    tokens: number;
    tps: number;
  } | null>(null);

  useEffect(() => {
    document.body.classList.toggle("edu-open", panelOpen);
    sessionStorage.setItem("lz_edu_panel", panelOpen ? "1" : "0");
    return () => {
      document.body.classList.remove("edu-open");
    };
  }, [panelOpen]);

  useEffect(() => {
    pickChatModel(backendUrl, llmModel || undefined)
      .then(setModel)
      .catch((e) => setError(`No pude detectar un modelo de chat: ${String(e)}`));
  }, [backendUrl, llmModel]);

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
    let eduVectorPreview: number[] = [];
    let eduVectorDim = 0;
    try {
      const r = await invoke<RetrievalResult>("retrieve", {
        query: text,
        topK,
      });
      chunks = r.matches;
      eduVectorPreview = r.query_vector_preview;
      eduVectorDim = r.query_vector_dim;
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
    const { trimmed: apiMessages, droppedTurns } =
      applyContextBudget(fullMessages);

    // Stamp droppedTurns + edu sections 1-3 in one setState, pre-streaming.
    // Section 4 (token count / tps) gets updated in finally.
    setMessages((prev) => {
      const out = prev.slice();
      const last = out[out.length - 1];
      if (last && last.role === "assistant") {
        out[out.length - 1] = {
          ...last,
          ...(droppedTurns > 0 ? { droppedTurns } : {}),
          edu: {
            vectorPreview: eduVectorPreview,
            vectorDim: eduVectorDim,
            chunks,
            promptMessages: apiMessages,
            tokenCount: 0,
            tokensPerSec: 0,
          },
        };
      }
      return out;
    });

    const streamStart = performance.now();
    let streamTokens = 0;
    let finalResponseText = "";
    try {
      await chatStream({
        messages: apiMessages,
        model,
        signal: controller.signal,
        baseUrl: backendUrl,
        onToken: (token) => {
          streamTokens++;
          finalResponseText += token;
          // Update live stats every 8 tokens (~6×/s at 50 tok/s).
          if (streamTokens % 8 === 0) {
            const elapsedSec = (performance.now() - streamStart) / 1000;
            setLiveStats({
              tokens: streamTokens,
              tps: elapsedSec > 0 ? streamTokens / elapsedSec : 0,
            });
          }
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
      if (voiceEnabled && finalResponseText) speakResponse(finalResponseText);
    } catch (e) {
      if ((e as Error).name === "AbortError") {
        // User cancelled — leave whatever tokens arrived in place.
      } else {
        setError(String(e));
        setMessages((prev) => prev.slice(0, -1));
      }
    } finally {
      const elapsedSec = (performance.now() - streamStart) / 1000;
      const finalTps = elapsedSec > 0.1 ? streamTokens / elapsedSec : 0;
      // Stamp final token count + tps onto edu section 4.
      setMessages((prev) => {
        const out = prev.slice();
        const last = out[out.length - 1];
        if (last?.role === "assistant" && last.edu) {
          out[out.length - 1] = {
            ...last,
            edu: {
              ...last.edu,
              tokenCount: streamTokens,
              tokensPerSec: finalTps,
            },
          };
        }
        return out;
      });
      setLiveStats(null);
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

  async function handleMicClick() {
    if (micState === "recording") {
      mediaRecorderRef.current?.stop();
      return;
    }

    setMicState("requesting");
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if ((e as DOMException).name === "NotAllowedError") {
        setMicState("denied");
      } else {
        setError(`Micrófono: ${String(e)}`);
        setMicState("idle");
      }
      return;
    }

    chunksRef.current = [];
    const mr = new MediaRecorder(stream);
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => {
      if (e.data.size > 0) chunksRef.current.push(e.data);
    };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setMicState("transcribing");
      try {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        const text = await transcribeAudio(blob, backendUrl);
        setInput((prev) => (prev ? `${prev} ${text}` : text));
      } catch (e) {
        setError(`Transcripción falló: ${String(e)}`);
      } finally {
        setMicState("idle");
      }
    };
    mr.start();
    setMicState("recording");
  }

  function speakResponse(text: string) {
    setTtsError(null);
    audioRef.current.pause();
    audioRef.current.src = "";
    synthesizeSpeech(text, backendUrl, ttsVoice)
      .then((blob) => {
        const url = URL.createObjectURL(blob);
        const audio = audioRef.current;
        audio.src = url;
        audio.onplay = () => setTtsPlaying(true);
        audio.onended = () => {
          setTtsPlaying(false);
          URL.revokeObjectURL(url);
        };
        audio.onerror = () => {
          setTtsPlaying(false);
          URL.revokeObjectURL(url);
        };
        audio.play().catch(() => setTtsPlaying(false));
      })
      .catch(() => {
        setTtsError(
          "TTS falló — verificá que kokoro-v1 esté cargado en Lemonade.",
        );
      });
  }

  function handleCancelTts() {
    audioRef.current.pause();
    audioRef.current.src = "";
    setTtsPlaying(false);
  }

  // Edu data for the most recent assistant turn (drives the panel).
  const lastEduData =
    [...messages].reverse().find((m) => m.role === "assistant")?.edu ?? null;

  return (
    <div className={`chat-wrapper${panelOpen ? " chat-wrapper--edu" : ""}`}>
      <section className="chat">
        <header className="chat__header">
          <h2>Chat</h2>
          <span className="chat__model">{model ?? "detectando modelo…"}</span>
          <button
            type="button"
            className={`chat__edu-toggle${panelOpen ? " chat__edu-toggle--on" : ""}`}
            onClick={() => setPanelOpen((v) => !v)}
            title={panelOpen ? "Cerrar panel educativo" : "Ver pipeline RAG"}
          >
            🎓
          </button>
          <button
            type="button"
            className={`chat__voice-toggle${voiceEnabled ? " chat__voice-toggle--on" : ""}`}
            onClick={() => setVoiceEnabled((v) => !v)}
            title={voiceEnabled ? "Desactivar voz" : "Activar voz"}
          >
            {voiceEnabled ? "🔊" : "🔇"}
          </button>
        </header>

        <div className="chat__messages" ref={scrollRef}>
          {messages.length === 0 ? (
            <p className="chat__empty">
              Cargá documentos arriba y preguntame en español sobre su
              contenido. Si todavía no cargaste nada, igual respondo — sin
              consultar RAG.
            </p>
          ) : (
            messages.map((m, i) => (
              <div key={i} className={`chat__msg chat__msg--${m.role}`}>
                <span className="chat__role">
                  {m.role === "user" ? "Vos" : "Asistente"}
                </span>
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
                  {m.content ||
                    (streaming && i === messages.length - 1 ? "…" : "")}
                </div>
              </div>
            ))
          )}
        </div>

        {error && <p className="status status--err">Error: {error}</p>}
        {micState === "denied" && (
          <p className="status status--err">
            Permiso de micrófono denegado. Habilitalo en Configuración →
            Privacidad → Micrófono.
          </p>
        )}
        {ttsError && <p className="status status--warn">{ttsError}</p>}

        <div className="chat__input-row">
          {voiceEnabled && (
            <button
              type="button"
              className={`chat__mic${micState === "recording" ? " chat__mic--recording" : ""}`}
              onClick={handleMicClick}
              disabled={
                micState === "requesting" ||
                micState === "transcribing" ||
                streaming
              }
              title={
                micState === "recording"
                  ? "Detener grabación"
                  : "Grabar mensaje de voz"
              }
            >
              {micState === "recording"
                ? "⏹"
                : micState === "transcribing"
                  ? "…"
                  : "🎤"}
            </button>
          )}
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
            <button
              type="button"
              className="chat__btn chat__btn--cancel"
              onClick={handleCancel}
            >
              Cancelar
            </button>
          ) : ttsPlaying ? (
            <button
              type="button"
              className="chat__btn chat__btn--cancel"
              onClick={handleCancelTts}
            >
              Silenciar
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

      {panelOpen && (
        <EduPanel
          data={lastEduData}
          streaming={streaming}
          liveStats={liveStats}
        />
      )}
    </div>
  );
}
