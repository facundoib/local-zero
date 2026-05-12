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

// Always fetches /models so the selected model is guaranteed to be loaded
// in Lemonade's runtime. If preferredModel is provided and loaded, it wins;
// otherwise falls back to PREFERRED_CHAT_MODELS order, then any chat model.
export async function pickChatModel(
  baseUrl: string = LEMONADE_URL,
  preferredModel?: string,
): Promise<string> {
  const resp = await fetch(`${baseUrl}/models`);
  if (!resp.ok) {
    throw new Error(`Lemonade /models respondió ${resp.status}`);
  }
  const json = (await resp.json()) as ModelsResponse;

  if (preferredModel && json.data.some((m) => m.id === preferredModel)) {
    return preferredModel;
  }

  for (const preferred of PREFERRED_CHAT_MODELS) {
    if (json.data.some((m) => m.id === preferred)) {
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
export async function chatStream(opts: ChatStreamOptions & { baseUrl?: string }): Promise<void> {
  const { messages, model, signal, onToken, baseUrl = LEMONADE_URL } = opts;

  const resp = await fetch(`${baseUrl}/chat/completions`, {
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

// Converts any browser-decodable audio blob to 16-bit mono PCM WAV.
// Required because Lemonade's Whisper server rejects audio/webm (OQ#5-b).
async function blobToWav(blob: Blob): Promise<Blob> {
  const arrayBuffer = await blob.arrayBuffer();
  const audioCtx = new AudioContext();
  const decoded = await audioCtx.decodeAudioData(arrayBuffer);
  await audioCtx.close();

  const numSamples = decoded.length;
  const sampleRate = decoded.sampleRate;
  const mixed = new Float32Array(numSamples);
  for (let ch = 0; ch < decoded.numberOfChannels; ch++) {
    const chan = decoded.getChannelData(ch);
    for (let i = 0; i < numSamples; i++) mixed[i] += chan[i];
  }
  if (decoded.numberOfChannels > 1) {
    for (let i = 0; i < numSamples; i++) mixed[i] /= decoded.numberOfChannels;
  }

  const dataBytes = numSamples * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  const w = (off: number, str: string) => {
    for (let i = 0; i < str.length; i++) v.setUint8(off + i, str.charCodeAt(i));
  };
  w(0, "RIFF"); v.setUint32(4, 36 + dataBytes, true);
  w(8, "WAVE"); w(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);              // PCM
  v.setUint16(22, 1, true);              // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true); // byte rate
  v.setUint16(32, 2, true);              // block align
  v.setUint16(34, 16, true);             // bit depth
  w(36, "data"); v.setUint32(40, dataBytes, true);
  let off = 44;
  for (let i = 0; i < numSamples; i++) {
    const s = Math.max(-1, Math.min(1, mixed[i]));
    v.setInt16(off, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    off += 2;
  }
  return new Blob([buf], { type: "audio/wav" });
}

// Sends a recorded audio blob to Lemonade /audio/transcriptions (Whisper).
// Converts to WAV first because Lemonade rejects audio/webm (OQ#5-b).
export async function transcribeAudio(blob: Blob, baseUrl: string = LEMONADE_URL): Promise<string> {
  const wav = await blobToWav(blob);
  const form = new FormData();
  form.append("file", new File([wav], "recording.wav", { type: "audio/wav" }));
  form.append("model", WHISPER_MODEL);
  const resp = await fetch(`${baseUrl}/audio/transcriptions`, {
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
export async function synthesizeSpeech(
  text: string,
  baseUrl: string = LEMONADE_URL,
  voice: string = KOKORO_VOICE,
): Promise<Blob> {
  const resp = await fetch(`${baseUrl}/audio/speech`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ model: KOKORO_MODEL, input: text, voice }),
  });
  if (!resp.ok) {
    const body = await resp.text().catch(() => "");
    throw new Error(`Kokoro ${resp.status}: ${body}`);
  }
  return resp.blob();
}
