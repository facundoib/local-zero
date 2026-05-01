import { useRef, useState } from "react";

// OQ#5 mic-permission probe — drop-in replacement for src/App.tsx.
// Validates: WebView2 getUserMedia → Windows mic permission flow →
// MediaRecorder capture → Lemonade /v1/audio/transcriptions round-trip.
// To use: copy this file over src/App.tsx, run `npm run tauri dev`.
// Pre-req: Whisper-Large-v3-Turbo loadable in Lemonade.

const LEMONADE_URL = "http://localhost:13305/api/v1";
const WHISPER_MODEL = "Whisper-Large-v3-Turbo";

type Status =
  | "idle"
  | "requesting-mic"
  | "recording"
  | "transcribing"
  | "done"
  | "error";

function App() {
  const [status, setStatus] = useState<Status>("idle");
  const [transcription, setTranscription] = useState("");
  const [error, setError] = useState("");
  const [elapsedMs, setElapsedMs] = useState(0);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const startTimeRef = useRef<number>(0);
  const elapsedTimerRef = useRef<number | null>(null);

  async function startRecording() {
    setError("");
    setTranscription("");
    setStatus("requesting-mic");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mediaRecorder = new MediaRecorder(stream);
      mediaRecorderRef.current = mediaRecorder;
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = async () => {
        stream.getTracks().forEach((t) => t.stop());
        await transcribe();
      };

      mediaRecorder.start();
      startTimeRef.current = Date.now();
      setElapsedMs(0);
      elapsedTimerRef.current = window.setInterval(() => {
        setElapsedMs(Date.now() - startTimeRef.current);
      }, 100);
      setStatus("recording");
    } catch (err: unknown) {
      const e = err as DOMException;
      setError(`getUserMedia falló: ${e.name}: ${e.message}`);
      setStatus("error");
    }
  }

  function stopRecording() {
    if (elapsedTimerRef.current !== null) {
      clearInterval(elapsedTimerRef.current);
      elapsedTimerRef.current = null;
    }
    mediaRecorderRef.current?.stop();
    setStatus("transcribing");
  }

  async function transcribe() {
    try {
      const blob = new Blob(chunksRef.current, { type: "audio/webm" });
      const file = new File([blob], "recording.webm", { type: "audio/webm" });

      const formData = new FormData();
      formData.append("file", file);
      formData.append("model", WHISPER_MODEL);

      const response = await fetch(`${LEMONADE_URL}/audio/transcriptions`, {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const errText = await response.text();
        throw new Error(`HTTP ${response.status}: ${errText}`);
      }

      const data = await response.json();
      setTranscription(data.text ?? JSON.stringify(data, null, 2));
      setStatus("done");
    } catch (err: unknown) {
      const e = err as Error;
      setError(`Transcripción falló: ${e.message}`);
      setStatus("error");
    }
  }

  return (
    <main style={{ maxWidth: "720px", margin: "0 auto", padding: "2rem" }}>
      <h1>Local Zero — mic-test (OQ#5)</h1>
      <p style={{ opacity: 0.7 }}>Backend: <code>{LEMONADE_URL}</code> · Modelo: <code>{WHISPER_MODEL}</code></p>

      <div style={{ marginTop: "2rem", minHeight: "5rem" }}>
        {status === "idle" && <button onClick={startRecording}>🎤 Empezar a grabar</button>}
        {status === "requesting-mic" && <p>Pidiendo permiso al sistema operativo…</p>}
        {status === "recording" && (
          <>
            <p style={{ color: "#d33", fontWeight: "bold" }}>● Grabando — {(elapsedMs / 1000).toFixed(1)} s</p>
            <button onClick={stopRecording}>⏹ Detener y transcribir</button>
          </>
        )}
        {status === "transcribing" && <p>Transcribiendo con Whisper…</p>}
        {status === "done" && (
          <>
            <p style={{ color: "#393" }}>✅ Listo.</p>
            <button onClick={() => setStatus("idle")}>Grabar otra</button>
          </>
        )}
        {status === "error" && <button onClick={() => setStatus("idle")}>Reintentar</button>}
      </div>

      {transcription && (
        <div style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #393", borderRadius: "0.5rem" }}>
          <strong>Transcripción:</strong>
          <p style={{ fontStyle: "italic" }}>{transcription}</p>
        </div>
      )}

      {error && (
        <div style={{ marginTop: "1.5rem", padding: "1rem", border: "1px solid #d33", borderRadius: "0.5rem", color: "#d33" }}>
          <strong>Error:</strong>
          <pre style={{ whiteSpace: "pre-wrap" }}>{error}</pre>
        </div>
      )}
    </main>
  );
}

export default App;
