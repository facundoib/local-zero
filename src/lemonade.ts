// Lemonade client — direct fetch from the WebView, no Tauri plugin-http.
// SPEC §F5 / §OQ#6: the @tauri-apps/plugin-http path has documented streaming
// bugs; the native window.fetch() inside WebView2 handles SSE cleanly.

export const LEMONADE_URL = "http://localhost:13305/api/v1";

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

// SPEC §5.3 default; if not loaded we fall back to whatever chat model
// Lemonade reports. The 14B is a 8.5 GB download and may not be present
// on a fresh dev machine.
const PREFERRED_CHAT_MODELS = ["Qwen3-14B-GGUF", "Qwen3-4B-Instruct-2507-GGUF"];

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
