// Lemonade client — direct fetch from the WebView, no Tauri plugin-http.
// SPEC §F5 / §OQ#6: the @tauri-apps/plugin-http path has documented streaming
// bugs; the native window.fetch() inside WebView2 handles SSE cleanly.

export const LEMONADE_URL = "http://localhost:13305/api/v1";
export const EMBED_MODEL = "Qwen3-Embedding-0.6B-GGUF";
export const WHISPER_MODEL = "Whisper-Large-v3-Turbo";
export const KOKORO_MODEL = "kokoro-v1";
export const KOKORO_VOICE = "ef_dora";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ModelEntry {
  id: string;
  labels?: string[];
}

interface ModelsResponse {
  data: ModelEntry[];
}

// SPEC §5.3 default order. The 4B-Instruct-2507 is primary because
// Qwen3-14B-GGUF (the registry recipe is the reasoning variant) was
// observed to collapse into garbage tokens on every prompt — including
// 2-token sanity checks — even with `enable_thinking:false` set on the
// request. Evidence: docs/decisions/v0.1-model-selection.md, 2026-05-08
// re-open. The 14B stays in the list as opt-in for future work; if
// Lemonade fixes the reasoning template propagation it gets re-evaluated.
const PREFERRED_CHAT_MODELS = ["Qwen3-4B-Instruct-2507-GGUF", "Qwen3-14B-GGUF"];

const NON_CHAT_LABELS = new Set(["embeddings", "audio", "transcription", "tts"]);

let cachedChatModel: string | null = null;

export async function pickChatModel(): Promise<string> {
  if (cachedChatModel) return cachedChatModel;

  const resp = await fetch(`${LEMONADE_URL}/models`);
  if (!resp.ok) {
    throw new Error(`Lemonade /models respondió ${resp.status}`);
  }
  const json = (await resp.json()) as ModelsResponse;

  for (const preferred of PREFERRED_CHAT_MODELS) {
    if (json.data.some((m) => m.id === preferred)) {
      cachedChatModel = preferred;
      return preferred;
    }
  }

  const fallback = json.data.find((m) => {
    const labels = m.labels ?? [];
    return !labels.some((l) => NON_CHAT_LABELS.has(l));
  });

  if (!fallback) {
    throw new Error(
      "Lemonade no tiene ningún modelo de chat disponible. Cargá un modelo desde la UI de Lemonade.",
    );
  }
  cachedChatModel = fallback.id;
  return fallback.id;
}

export interface ChatStreamOptions {
  messages: ChatMessage[];
  model: string;
  signal?: AbortSignal;
  onToken: (token: string) => void;
}

// Streams tokens from /v1/chat/completions. Resolves when the SSE
// stream emits `data: [DONE]` or the response body closes; rejects on
// HTTP error or abort. The caller owns the AbortController.
export async function chatStream(opts: ChatStreamOptions): Promise<void> {
  const { messages, model, signal, onToken } = opts;

  const resp = await fetch(`${LEMONADE_URL}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    signal,
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: 0.4,
      max_tokens: 1024,
      // SPEC §F5: mandatory for the reasoning-variant Qwen3 models.
      // Without this flag, content arrives in `reasoning_content` and the
      // visible `delta.content` stream stays empty.
      chat_template_kwargs: { enable_thinking: false },
    }),
  });

  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Lemonade /chat/completions ${resp.status}: ${body}`);
  }
  if (!resp.body) {
    throw new Error("Lemonade devolvió una respuesta sin body.");
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let nl: number;
    while ((nl = buffer.indexOf("\n")) !== -1) {
      const rawLine = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      const line = rawLine.trim();
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") return;
      try {
        const parsed = JSON.parse(data);
        const token: string | undefined = parsed?.choices?.[0]?.delta?.content;
        if (token) onToken(token);
      } catch {
        // Lemonade sometimes interleaves non-JSON keep-alive lines on
        // certain backends; ignoring keeps the stream resilient.
      }
    }
  }
}

// Sends a recorded audio blob to Lemonade /audio/transcriptions (Whisper).
export async function transcribeAudio(blob: Blob): Promise<string> {
  const form = new FormData();
  form.append("file", new File([blob], "recording.webm", { type: blob.type }));
  form.append("model", WHISPER_MODEL);
  const resp = await fetch(`${LEMONADE_URL}/audio/transcriptions`, {
    method: "POST",
    body: form,
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Whisper ${resp.status}: ${body}`);
  }
  const data = (await resp.json()) as { text?: string };
  return (data.text ?? "").trim();
}

// Sends text to Lemonade /audio/speech (Kokoro) and returns the audio blob.
export async function synthesizeSpeech(text: string): Promise<Blob> {
  const resp = await fetch(`${LEMONADE_URL}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: KOKORO_MODEL, input: text, voice: KOKORO_VOICE }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Kokoro ${resp.status}: ${body}`);
  }
  return resp.blob();
}
