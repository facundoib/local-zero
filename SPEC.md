# Local Zero — Technical Specification

**Status:** Draft v0.0.1
**Target release:** v0.1
**Last updated:** 2026-04-29
**License:** Apache-2.0

This document is the source of truth for what Local Zero v0.1 does and how it is built. If code and SPEC diverge, SPEC wins until updated by PR.

---

## 1. Overview

Local Zero is a Tauri 2 desktop application that walks a self-taught LATAM developer through building a portfolio-grade Retrieval-Augmented Generation (RAG) app running entirely on their own machine. The app is both a working RAG tool (the user can use it to ask questions about their own documents) and a teaching artifact (each step of the pipeline is exposed and explained in Spanish).

It uses Lemonade SDK as the local LLM backend via its OpenAI-compatible HTTP API. No cloud calls, no API keys, no recurring costs.

---

## 2. Goals (v0.1)

1. Run end-to-end on a junior dev's machine (Windows 11 primary; Linux/macOS best-effort) with a single installer for Lemonade and `npm install && npm run tauri dev` for the app.
2. Let the user drop a folder of plain-text documents (PDF, TXT, MD) and chat with them in Spanish.
3. Expose the RAG pipeline in a side panel: which chunks were retrieved, with what similarity score, what prompt was sent, what tokens came back.
4. Provide an optional voice loop: speak the question, hear the answer (Whisper + Kokoro via Lemonade).
5. Export a self-contained portfolio repository the user can push to their own GitHub with one CLI command.
6. Stay 100% offline after Lemonade and the chosen models are downloaded. Verifiable by disconnecting the network.

## 3. Non-goals (v0.1)

1. Multi-document workspaces or projects. One document collection at a time.
2. Multi-user auth, accounts, cloud sync.
3. Fine-tuning, training, or model creation.
4. Image, audio, or video embeddings (text only).
5. Function calling, tool use, multi-step agent loops.
6. Persistent conversation history across app restarts.
7. UI translations beyond Spanish (no English UI in v0.1).
8. Mobile or web builds.
9. Plugin / extension system.
10. User-customizable system prompts (sane defaults only; advanced users edit JSON).

---

## 4. Target hardware

### 4.1 Recommended
- CPU: AMD Ryzen 7 9700X (Zen 5, 8C/16T) or equivalent
- GPU: AMD Radeon RX 9070 XT 16 GB (RDNA 4, Vulkan)
- RAM: 64 GB DDR5-6000
- Storage: 4 GB free for Lemonade + 10 GB free per LLM model
- OS: Windows 11 24H2+

### 4.2 Minimum
- CPU: any modern x86_64 with AVX2 (Ryzen 5 5600X / Intel Core i5-12400 or above)
- GPU: 16 GB VRAM dGPU on Vulkan (NVIDIA RTX 4060 Ti 16 GB / 5060 Ti 16 GB / AMD RX 7600 XT 16 GB / RX 9060 XT 16 GB)
- RAM: 32 GB DDR4/DDR5
- OS: Windows 10 22H2+ / Ubuntu 24.04+ / macOS 14+

### 4.3 Fallback (degraded experience)
- 8 GB VRAM card OR no dGPU at all: app loads but defaults to a smaller LLM (Qwen3 4B Q4 ≈ 2.5 GB) and disables voice. Document ingestion works at reduced speed.
- CPU-only: supported via Lemonade's CPU backend; expect ≤5 tok/s on 8B class models.

### 4.4 Not supported in v0.1
- Cards with <8 GB VRAM and <16 GB system RAM combined.
- Apple Silicon: best-effort via Lemonade Metal path; not a v0.1 acceptance target.

---

## 5. Software dependencies

> **End user vs developer.** Section 5.1 is everything an end user needs. Section 5.2 is for developers building the app from source. End users do **not** install Node, Rust, or build tools — they download a single Tauri-bundled installer from GitHub Releases.

### 5.1 Runtime (end user)
- **Lemonade Server** ≥ 10.2 (Windows installer or platform equivalent), serving on `http://localhost:13305/api/v1`
- **AMD Adrenalin** ≥ 25.5 (AMD GPU users) OR **NVIDIA driver** ≥ 550 (NVIDIA users)
- **WebView2** runtime (auto-installed on Windows 11)

### 5.2 Build (developer)
- Node.js ≥ 20 LTS
- npm ≥ 10
- Rust toolchain (stable, ≥ 1.78) installed via `rustup`
- Platform Tauri prerequisites per https://tauri.app/start/prerequisites/

### 5.3 Default models (auto-downloaded by Lemonade on first run)
| Role | Model | Quantization | Approx. VRAM |
|---|---|---|---|
| LLM (chat) | `Qwen3-14B-Instruct-GGUF` | Q4_K_M | ~9 GB |
| LLM fallback (small) | `Qwen3-4B-Instruct-GGUF` | Q4_K_M | ~2.5 GB |
| Embeddings | `Qwen3-Embedding-0.6B-GGUF` | Q8_0 | ~640 MB |
| STT (voice in) | `Whisper-Large-v3-Turbo` | default | ~1.5 GB |
| TTS (voice out) | `Kokoro-v1`, voice `ef_dora` | default | ~80 MB |

`Qwen3-Embedding-0.6B-GGUF` is in Lemonade's default `server_models.json` registry — no custom recipe needed. Verified against `lemonade-sdk/lemonade@main` source on 2026-04-30. See [docs/decisions/v0.1-open-questions.md](docs/decisions/v0.1-open-questions.md) §OQ#1 for the full registry of bundled embedding models.

---

## 6. Architecture

```
┌───────────────────────────────────────────────────────────────────┐
│                    Local Zero (Tauri Desktop App)                 │
│                                                                   │
│  ┌────────────────────────┐   ┌────────────────────────────────┐  │
│  │   React + TS Frontend  │   │   Rust (Tauri commands)        │  │
│  │   - Chat UI            │   │   - File system access         │  │
│  │   - Pipeline panel     │◄──┤   - SQLite (app state, vecs)   │  │
│  │   - Document drop zone │   │   - PDF/text extractors        │  │
│  │   - Voice controls     │   │   - Export-to-portfolio writer │  │
│  │   - Educational drawer │   └─────────────┬──────────────────┘  │
│  └────────────┬───────────┘                 │                     │
│               │                             │                     │
│               └────────────┬────────────────┘                     │
│                            │                                      │
│                  HTTP (fetch / Tauri http plugin)                 │
└────────────────────────────┼──────────────────────────────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │   Lemonade Server v10.2+     │
              │   localhost:13305/api/v1     │
              │                              │
              │   /chat/completions          │
              │   /embeddings                │
              │   /audio/transcriptions      │
              │   /audio/speech              │
              │   /models                    │
              └──────────────┬───────────────┘
                             │
                             ▼
              ┌──────────────────────────────┐
              │  Backend (auto-selected):    │
              │  Vulkan / ROCm / CUDA / CPU  │
              └──────────────────────────────┘
```

The Tauri app is a thin client. All AI compute runs in Lemonade. Local Zero owns: document ingestion, chunking, the vector store, the RAG orchestration, the UI, and the export feature.

---

## 7. Data model

All data lives in a single SQLite database at the Tauri app data dir (`%APPDATA%/Local Zero/local-zero.db` on Windows; equivalent on other OS).

### 7.1 Tables

- **`documents`** — `(id, filename, path, mime_type, byte_size, ingested_at)`
- **`chunks`** — `(id, document_id, ordinal, text, token_count)`
- **`embeddings`** — `(chunk_id, vector BLOB, dim, model)`
- **`sessions`** — `(id, started_at, ended_at)` (one session = one app launch)
- **`messages`** — `(id, session_id, role, content, created_at)` (chat history per session, not persisted across launches per non-goal #6)
- **`settings`** — `(key, value)` (KV store for backend URL, voice on/off, chosen model, etc.)

### 7.2 Vector index

Vectors are stored as `BLOB` (Float32Array). For v0.1, similarity search is brute-force cosine similarity computed in Rust over all embeddings in the active document set. Acceptable up to ~5,000 chunks (~2 MB of vectors at 1024-dim Float32). Above that, defer to v0.2 with `sqlite-vec` extension.

### 7.3 No migrations in v0.1

The schema is created once on first launch. Schema changes between v0.0.x releases drop and recreate the database with a user warning. Migrations land in v0.2.

---

## 8. Functional specification

Each feature has: ID, description, inputs, outputs, key behaviors, error handling.

### F1. Document ingestion

- **ID:** F1
- **Description:** User drops one or more files into the app; app extracts text, splits into chunks, stores in SQLite.
- **Supported formats:** `.pdf` (text-based, no OCR), `.txt`, `.md`. Image-only PDFs are detected and rejected with a Spanish-language warning.
- **Input:** drag-and-drop event OR file picker dialog.
- **Output:** rows in `documents` and `chunks` tables; UI shows a list of ingested files with chunk counts.
- **Behaviors:**
  - PDF text extracted via the `pdf-extract` Rust crate (MIT, pure Rust, no native deps). Locked v0.1 choice — see [docs/decisions/v0.1-open-questions.md](docs/decisions/v0.1-open-questions.md) §OQ#4. Fallback to `pdfium-render` if Spanish character handling fails in integration testing.
  - Chunking: recursive character splitter, 512-token target, 64-token overlap. Token count estimated by `tiktoken-rs` or a llama.cpp-compatible BPE.
  - Idempotent: re-dropping the same file (by SHA-256 of contents) updates the timestamp but does not duplicate chunks.
- **Errors:**
  - File too large (>50 MB): rejected with message.
  - Unsupported MIME type: rejected with message and link to docs.
  - PDF parse failure: rejected with hint about scanned PDFs.

### F2. Embedding pipeline

- **ID:** F2
- **Description:** For each new chunk, request an embedding from Lemonade and store in the `embeddings` table.
- **Input:** chunk rows without embeddings.
- **Output:** rows in `embeddings` table.
- **Behaviors:**
  - Batch size: 32 chunks per HTTP request to Lemonade `/embeddings`.
  - Concurrency: 1 request in flight at a time (Lemonade is single-process; concurrent requests serialize anyway).
  - Progress streamed to UI: "Embedding chunk 47 of 312…"
- **Errors:**
  - Lemonade unreachable: surfaced as banner with troubleshooting link.
  - Model not loaded: app sends `/models` check on startup; if embedding model is missing, prompts user to load it via Lemonade's UI.

### F3. Vector store

- **ID:** F3
- **Description:** Persist embeddings; retrieve top-K nearest by cosine similarity.
- **Storage:** SQLite as per §7. Vectors as Float32 BLOB.
- **Retrieval:** brute-force cosine similarity in Rust. Top-K = 6 chunks for v0.1 (configurable in settings, default 6).
- **Performance budget:** ≤50 ms for ≤5,000 chunks on the recommended hardware. If exceeded at impl time, escalate.

### F4. Retrieval

- **ID:** F4
- **Description:** Given a user question, embed it and return the top-K most similar chunks plus their parent document metadata.
- **Input:** user question string.
- **Output:** `Array<{ chunk_id, document_filename, text, score }>`.
- **Behaviors:**
  - Query embedded with the same model as the corpus (`Qwen3-Embedding-0.6B-GGUF`).
  - Returns chunks ordered by descending cosine similarity.
  - Each retrieval is logged (in-session only) so the educational panel can show "what was retrieved for question X".

### F5. Generation / chat

- **ID:** F5
- **Description:** Send retrieved chunks + user question + system prompt to Lemonade `/chat/completions` and stream the response into the chat UI.
- **Input:** user question, retrieved chunks, in-session message history.
- **Output:** streamed assistant message rendered token-by-token.
- **System prompt (Spanish, locked for v0.1):**
  ```
  Sos un asistente que responde en español rioplatense, formal y al grano.
  Usás únicamente la información de los fragmentos provistos para responder.
  Si la respuesta no está en los fragmentos, decilo explícitamente.
  No inventes datos. No agregues frases tipo "como modelo de lenguaje" ni "as an AI".
  No insertes palabras en inglés salvo nombres propios técnicos.
  ```
- **Model parameters (v0.1 defaults):**
  - `model`: `Qwen3-14B-Instruct-GGUF` (or fallback `Qwen3-4B-Instruct-GGUF` if VRAM detection says <12 GB)
  - `temperature`: 0.4
  - `max_tokens`: 1024
  - `stream`: true
  - Thinking mode: **disabled** (Qwen3 thinking leaks `<think>` blocks; not desired for v0.1)
- **Behaviors:**
  - Multi-turn within session: prior messages included up to a 32K context budget; older turns dropped FIFO.
  - Streaming uses Server-Sent Events parsed in the frontend. **Implementation note**: use the WebView's native `window.fetch()` for SSE — NOT `@tauri-apps/plugin-http`, which has documented streaming bugs. See [docs/decisions/v0.1-open-questions.md](docs/decisions/v0.1-open-questions.md) §OQ#6.
- **Errors:**
  - Lemonade timeout: cancel and show retry button.
  - Token limit exceeded: drop oldest turns and retry once.

### F6. Voice I/O (optional)

- **ID:** F6
- **Description:** Optional voice input (microphone → Whisper transcription) and voice output (TTS via Kokoro).
- **Default state:** off. User toggles in the UI.
- **Voice in:**
  - Push-to-talk button OR auto-VAD (configurable; v0.1 defaults to push-to-talk for predictability).
  - Recording captured via `tauri-plugin-mic-recorder` v2+, written to a temp WAV file, sent to Lemonade `/audio/transcriptions` (`Whisper-Large-v3-Turbo`).
  - `language` parameter is left unset (auto-detect) so Spanish↔English code-switching works.
  - Latency target: ≤500 ms end-to-end for utterances ≤10 seconds on recommended hardware.
- **Voice out:**
  - When voice mode is on, the streamed assistant response is also sent to Lemonade `/audio/speech` once complete (not per-token) using `Kokoro-v1` voice `ef_dora`.
  - Audio playback via the browser's `<audio>` element.
  - User can cancel playback mid-stream.
- **Errors:**
  - Microphone permission denied: voice in disabled with persistent banner.
  - TTS model not loaded: voice out disabled with hint.

### F7. Educational mode (the side panel)

- **ID:** F7
- **Description:** A persistent side panel that, for each chat turn, exposes the underlying RAG pipeline. The whole point of Local Zero — the user is supposed to *understand* what is happening.
- **Content per turn:**
  1. **Question embedding.** Show first 8 dimensions of the query vector + total dim.
  2. **Retrieved chunks.** List of `(document, chunk text excerpt, cosine score)`.
  3. **Prompt sent to LLM.** Full prompt (system + retrieved context + history + question), formatted as a code block.
  4. **Response stream.** Live token count and tokens/sec while streaming.
  5. **Explain button.** Toggles a Spanish-language plain-text explanation of each step (~3-5 sentences each).
- **Behaviors:**
  - Panel is collapsible; remembered per session.
  - All explanations are pre-written static Spanish strings shipped with the app, not LLM-generated, so they stay correct and reproducible.

### F8. Export to portfolio

- **ID:** F8
- **Description:** One-click action that creates a self-contained, runnable mini-project the user can push to their own GitHub as a portfolio piece.
- **Trigger:** "Exportar a GitHub" button in the main UI.
- **Output:** a folder selected by the user containing:
  - `README.md` — Spanish-first description of what the user built, with an English summary at the bottom for international recruiters. Includes a quickstart, a stack list, and a one-paragraph "what this proves about me as a developer".
  - `main.ts` — minimal TypeScript script (Node 20+) that reproduces the RAG pipeline against Lemonade. Loads docs from `./docs/`, embeds, retrieves, generates. ~150 lines.
  - `package.json` — minimal deps (just `node-fetch` or native fetch on Node 20+).
  - `.gitignore` — node_modules, .env, *.db.
  - `LICENSE` — MIT (different from Local Zero itself; the user owns their portfolio repo).
  - `docs/sample.md` — placeholder document so the script runs out of the box.
- **Post-export instructions** shown in a modal:
  ```
  ¡Listo! Para subir tu repo a GitHub:

  cd <carpeta-elegida>
  git init && git add . && git commit -m "Initial commit"
  gh repo create mi-primera-app-de-ia --public --source=. --push
  ```
- **Behaviors:**
  - Local Zero never pushes on the user's behalf in v0.1. The user runs `gh` themselves.
  - The exported `main.ts` is the same logic as Local Zero's RAG, simplified and free of UI code, so it stands as readable evidence of skill.
- **Errors:**
  - Folder write permission denied: standard OS error surface.

### F9. Settings

- **ID:** F9
- **Description:** Minimal settings page.
- **Settings exposed in v0.1:**
  - Backend URL (default `http://localhost:13305/api/v1`)
  - LLM model name (dropdown populated from Lemonade `/models`)
  - Embedding model name (dropdown)
  - Voice mode on/off
  - TTS voice (dropdown of Kokoro Spanish voices)
  - Top-K (default 6, range 3-10)
  - Theme (light/dark/system)
- **Settings NOT exposed in v0.1** (advanced users edit `settings` table directly): system prompt, temperature, max tokens, chunk size, chunk overlap.

---

## 9. UI structure

Three-region layout:

```
┌─────────────────────────────────────────────────────────────┐
│ Header: Local Zero · model badge · backend status indicator │
├──────────────┬──────────────────────────┬───────────────────┤
│              │                          │                   │
│  Documents   │     Chat                 │  Pipeline panel   │
│  (left rail) │     (main area)          │  (right rail,     │
│              │                          │   collapsible)    │
│  [+ drop]    │   ┌────────────────┐     │                   │
│  - cv.pdf    │   │ assistant: ... │     │  Last turn:       │
│  - jd.txt    │   └────────────────┘     │  - Embedding ✓    │
│  - notes.md  │   ┌────────────────┐     │  - Retrieved 6 ✓  │
│              │   │ you: ...       │     │  - Prompt: 1.2k   │
│              │   └────────────────┘     │  - Tokens: 423    │
│              │                          │                   │
│              │   [type or 🎤]            │  [Explain]        │
└──────────────┴──────────────────────────┴───────────────────┘
              Footer: Export to GitHub button
```

UI strings: Spanish (es-AR-leaning, neutral-LATAM acceptable). No translations in v0.1.

Theme: dark mode default; light mode supported.

Window: 1024×720 minimum, resizable, no chrome customization in v0.1.

---

## 10. Privacy and offline guarantees

- After Lemonade and the chosen models are downloaded, the app must function fully with the network disabled. This is verified as part of acceptance (§12.5).
- No telemetry. No analytics. No phone-home. No update checks.
- All user data (documents, chunks, embeddings, chat) stays in the local SQLite file. No cloud sync, ever.
- Outbound network requests in v0.1 are limited to: the Lemonade API on `localhost`. Anything outside `localhost` is a bug.
- The "Export to GitHub" feature is the *only* user-initiated egress, and the user runs `gh` manually.

---

## 11. Performance targets

On recommended hardware (§4.1):

| Operation | Budget |
|---|---|
| Cold app launch to interactive | ≤3 s |
| Ingest a 10-page PDF (text only) | ≤5 s |
| Embed 100 chunks | ≤8 s |
| Retrieval (top-6 over 1,000 chunks) | ≤50 ms |
| First token of LLM response | ≤2 s (Qwen3 14B Q4, prompt ~2K tokens) |
| LLM throughput | ≥30 tok/s |
| Whisper transcription (5 s utterance) | ≤500 ms |
| Kokoro TTS (50-word response) | ≤1.5 s |

On minimum hardware (§4.2): targets are 2× looser. Outside that, "best effort, no SLA".

---

## 12. Acceptance criteria for v0.1

The release is shippable when **all** of the following pass on a clean Windows 11 machine with Lemonade pre-installed and no other dev tools:

1. `git clone && npm install && npm run tauri dev` produces a running window in <90 s (excluding Rust toolchain install time).
2. Drag a 10-page Spanish PDF + a 1-page job description into the app. Both ingest, embed, and appear in the left rail.
3. Type a Spanish question referencing the PDF. The LLM streams a Spanish-language answer that cites information from the PDF. No English leakage. No `<think>` blocks. No "as an AI" phrases.
4. Toggle voice mode. Ask the same question by voice. Receive a spoken Spanish answer via `ef_dora`.
5. **Offline test.** Disable network adapter. Repeat steps 2-4. App functions identically. Pipeline panel updates correctly.
6. Click "Exportar a GitHub". App writes a folder with the 6 files described in F8. `node main.ts` from that folder reproduces a basic RAG response against the same Lemonade instance.
7. App runs without crashes for 30 minutes of active use (4 different document sets, 20 chat turns, voice toggled on and off).
8. Cold launch on minimum hardware (RTX 4060 Ti 16 GB / RX 9060 XT 16 GB, 32 GB RAM) succeeds and an 8B fallback model loads automatically if VRAM detection reports <12 GB free.

Each criterion has an automated test where feasible (1, 7) and a manual repro script where not (2-6, 8).

---

## 13. Out of scope for v0.1

Restated for emphasis. Anything in this list is a bug if requested:

- Cloud anything
- Auth / multi-user
- Multi-document workspaces
- Plugins / extensions
- Image, audio, video embeddings
- Function calling / tool use / agents
- Persistent chat history across launches
- Mobile, web, or signed installers
- UI translations
- User-customizable system prompt via UI
- Fine-tuning / training
- Auto-updater
- Telemetry / analytics
- Auto-push to GitHub from the app
- Conversation branching
- Theming beyond dark/light/system

---

## 14. v0.2+ roadmap (sketch — non-binding)

Captured here so contributors don't accidentally implement them in v0.1 PRs. Order is not commitment.

- Multiple workspaces (one DB per workspace)
- `sqlite-vec` for >5k chunks
- Migrations
- Persistent chat history with search
- Conversation branching
- Optional function calling for "search the web", "open file", "run shell command"
- User-customizable system prompt
- Plugin API for custom retrievers / embedders
- Spanish-flavor voice swap (Piper `es_AR/daniela` as bundled alternative)
- Image input (CLIP embeddings, multimodal LLM via Lemonade if available)
- macOS code-signing + DMG
- Windows code-signing + MSI
- Auto-updater (Tauri's built-in updater plugin)

---

## 15. Open questions

Phase A (resolved 2026-04-30) — see [docs/decisions/v0.1-open-questions.md](docs/decisions/v0.1-open-questions.md) for evidence and rationale:

1. ~~Lemonade `/embeddings` for `bge-m3`~~ → **Resolved.** Lemonade has first-class `/v1/embeddings`. `bge-m3` not in registry; chose `Qwen3-Embedding-0.6B-GGUF` (managed recipe, multilingual).
2. ~~Spanish-quality embedding model~~ → **Resolved for v0.1.** `Qwen3-Embedding-0.6B-GGUF`. Deeper benchmark eval deferred to v0.2.
4. ~~PDF extraction crate~~ → **Resolved.** `pdf-extract` (MIT, pure Rust). `pdfium-render` as fallback.
6. ~~Tauri 2 SSE streaming~~ → **Resolved.** Native `window.fetch()` in the WebView, not `@tauri-apps/plugin-http`.
7. ~~Cold-start UX without Lemonade~~ → **Resolved.** Banner with link, no auto-start. Educational alignment.

Phase B:

3. ~~VRAM detection on Windows~~ → **Resolved 2026-04-30.** Windows DXGI (`IDXGIFactory6`/`IDXGIAdapter4`), Windows-only scope. Validated with prototype on RTX 5060 Ti. See [decisions doc §OQ#3](docs/decisions/v0.1-open-questions.md#oq3).
5. ~~Tauri 2 + microphone permission flow~~ → **Deferred to F6 (Voice I/O) implementation.** Approach pre-built and stored in [`prototypes/mic-test/`](prototypes/mic-test/). Native `getUserMedia` + `MediaRecorder` in WebView2 expected to work; risk low. See [decisions doc §OQ#5](docs/decisions/v0.1-open-questions.md#oq5).

Each gets its own resolution doc under `docs/decisions/` when complete.

---

## 16. References

- Lemonade SDK: https://github.com/lemonade-sdk/lemonade
- Tauri 2 docs: https://tauri.app/
- Qwen3 model card: https://huggingface.co/Qwen
- Qwen3-Embedding-0.6B-GGUF: https://huggingface.co/Qwen/Qwen3-Embedding-0.6B-GGUF
- Whisper-large-v3-turbo: https://huggingface.co/openai/whisper-large-v3-turbo
- Kokoro-82M: https://huggingface.co/hexgrad/Kokoro-82M
- OpenAI API reference (the surface Lemonade implements): https://platform.openai.com/docs/api-reference

---

## Appendix A — Glossary

- **RAG**: Retrieval-Augmented Generation. The pattern of retrieving relevant document fragments and giving them to an LLM as context.
- **Chunk**: a fragment of a document, typically 200-1000 tokens, used as the unit of retrieval.
- **Embedding**: a fixed-length vector representation of text, used to compute similarity.
- **Top-K**: number of most-similar chunks retrieved per question.
- **GGUF**: a quantized model file format used by `llama.cpp` and Lemonade.
- **Quantization (Q4_K_M, Q5, Q8)**: precision reduction of model weights for lower memory + faster inference at small accuracy cost.

## Appendix B — Naming

- App name (display): **Local Zero**
- App name (CLI / package / repo): `local-zero`
- Identifier (Tauri / npm scope): `dev.facundoib.local-zero`
- Window title: `Local Zero`
