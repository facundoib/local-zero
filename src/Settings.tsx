import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { LEMONADE_URL } from "./lemonade";

export interface AppSettings {
  backend_url: string;
  llm_model: string;
  embed_model: string;
  voice_enabled: boolean;
  tts_voice: string;
  top_k: number;
  theme: string;
}

interface ModelEntry {
  id: string;
  labels?: string[];
}

const NON_CHAT_LABELS = new Set(["embeddings", "audio", "transcription", "tts"]);
const EMBED_LABELS = new Set(["embeddings"]);

const TTS_VOICES = [
  { id: "ef_dora", label: "Dora (f, LATAM)" },
  { id: "ef_bella", label: "Bella (f)" },
  { id: "em_alex", label: "Alex (m)" },
  { id: "em_santa", label: "Santa (m)" },
];

interface Props {
  initial: AppSettings;
  onSave: (s: AppSettings) => void;
  onBack: () => void;
}

export function Settings({ initial, onSave, onBack }: Props) {
  const [form, setForm] = useState<AppSettings>(initial);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [chatModels, setChatModels] = useState<string[]>([]);
  const [embedModels, setEmbedModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);

  useEffect(() => {
    fetchModels(form.backend_url);
  }, []);

  async function fetchModels(baseUrl: string) {
    setModelsError(null);
    try {
      const resp = await fetch(`${baseUrl}/models`);
      if (!resp.ok) throw new Error(`/models respondió ${resp.status}`);
      const json = (await resp.json()) as { data: ModelEntry[] };
      const chat = json.data
        .filter((m) => !(m.labels ?? []).some((l) => NON_CHAT_LABELS.has(l)))
        .map((m) => m.id);
      const embed = json.data
        .filter((m) => (m.labels ?? []).some((l) => EMBED_LABELS.has(l)))
        .map((m) => m.id);
      setChatModels(chat);
      setEmbedModels(embed);
    } catch (e) {
      setModelsError(
        `No se pudo conectar a Lemonade (${baseUrl}). Los dropdowns de modelo no se pueden poblar.`,
      );
    }
  }

  function set<K extends keyof AppSettings>(key: K, value: AppSettings[K]) {
    setForm((prev) => ({ ...prev, [key]: value }));
  }

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      await invoke("set_settings", { settings: form });
      onSave(form);
    } catch (e) {
      setError(String(e));
    } finally {
      setSaving(false);
    }
  }

  const topKValid = form.top_k >= 3 && form.top_k <= 10;

  return (
    <section className="settings">
      <header className="settings__header">
        <button type="button" className="settings__back" onClick={onBack}>
          ← Volver
        </button>
        <div>
          <h1 className="settings__title">Configuración</h1>
          <p className="settings__subtitle">
            Los cambios se aplican al guardar y persisten entre sesiones.
          </p>
        </div>
      </header>

      {modelsError && (
        <p className="status status--err">{modelsError}</p>
      )}

      <form
        className="settings__form"
        onSubmit={(e) => {
          e.preventDefault();
          handleSave();
        }}
      >
        {/* Backend URL */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-backend-url">
            URL del backend
          </label>
          <input
            id="s-backend-url"
            className="settings__input"
            type="text"
            value={form.backend_url}
            onChange={(e) => set("backend_url", e.target.value)}
            onBlur={() => fetchModels(form.backend_url)}
            spellCheck={false}
          />
          <span className="settings__hint">
            Default: <code>{LEMONADE_URL}</code>
          </span>
        </div>

        {/* LLM model */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-llm-model">
            Modelo de chat (LLM)
          </label>
          {chatModels.length > 0 ? (
            <select
              id="s-llm-model"
              className="settings__select"
              value={form.llm_model}
              onChange={(e) => set("llm_model", e.target.value)}
            >
              {chatModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="s-llm-model"
              className="settings__input"
              type="text"
              value={form.llm_model}
              onChange={(e) => set("llm_model", e.target.value)}
              spellCheck={false}
            />
          )}
        </div>

        {/* Embed model */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-embed-model">
            Modelo de embeddings
          </label>
          {embedModels.length > 0 ? (
            <select
              id="s-embed-model"
              className="settings__select"
              value={form.embed_model}
              onChange={(e) => set("embed_model", e.target.value)}
            >
              {embedModels.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="s-embed-model"
              className="settings__input"
              type="text"
              value={form.embed_model}
              onChange={(e) => set("embed_model", e.target.value)}
              spellCheck={false}
            />
          )}
          <span className="settings__hint">
            Debe coincidir con el modelo usado al ingestar el corpus actual.
          </span>
        </div>

        {/* Top-K */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-top-k">
            Top-K (fragmentos recuperados)
          </label>
          <input
            id="s-top-k"
            className={`settings__input settings__input--narrow${!topKValid ? " settings__input--invalid" : ""}`}
            type="number"
            min={3}
            max={10}
            value={form.top_k}
            onChange={(e) => set("top_k", Number(e.target.value))}
          />
          {!topKValid && (
            <span className="settings__hint settings__hint--err">
              Debe estar entre 3 y 10.
            </span>
          )}
        </div>

        {/* Voice enabled */}
        <div className="settings__field settings__field--inline">
          <input
            id="s-voice"
            className="settings__checkbox"
            type="checkbox"
            checked={form.voice_enabled}
            onChange={(e) => set("voice_enabled", e.target.checked)}
          />
          <label className="settings__label settings__label--inline" htmlFor="s-voice">
            Voz activada por defecto
          </label>
        </div>

        {/* TTS voice */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-tts-voice">
            Voz TTS (Kokoro)
          </label>
          <select
            id="s-tts-voice"
            className="settings__select"
            value={form.tts_voice}
            onChange={(e) => set("tts_voice", e.target.value)}
          >
            {TTS_VOICES.map((v) => (
              <option key={v.id} value={v.id}>
                {v.label}
              </option>
            ))}
          </select>
        </div>

        {/* Theme */}
        <div className="settings__field">
          <label className="settings__label" htmlFor="s-theme">
            Tema
          </label>
          <select
            id="s-theme"
            className="settings__select"
            value={form.theme}
            onChange={(e) => set("theme", e.target.value)}
          >
            <option value="system">Sistema (automático)</option>
            <option value="dark">Oscuro</option>
            <option value="light">Claro</option>
          </select>
        </div>

        {error && <p className="status status--err">{error}</p>}

        <div className="settings__actions">
          <button
            type="button"
            className="settings__cancel"
            onClick={onBack}
          >
            Cancelar
          </button>
          <button
            type="submit"
            className="settings__save"
            disabled={saving || !topKValid}
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </form>
    </section>
  );
}
