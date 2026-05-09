# Local Zero

> Build your first local AI app — from zero, on your own machine.

A Spanish-language tutorial companion that walks you through building a portfolio-grade RAG application running entirely on your own hardware. No API keys, no cloud, no recurring cost.

**Status:** pre-alpha. The end-to-end RAG pipeline (ingest → embed → retrieve → chat) is functional on the dev path; voice (F6), educational panel (F7), exportable starter (F8), and settings UI (F9) are not yet implemented. See [SPEC.md](./SPEC.md) for the full v0.1 scope.

## What works today

- **F1 — Document ingest.** Drag-and-drop or file-picker for `.txt`, `.md`, `.pdf`. SHA-256 deduplication, tiktoken-rs `cl100k` chunking at 512 tokens / 64 overlap. 10-page Spanish PDF ingests in ~400 ms.
- **F2 — Embedding pipeline.** New documents auto-embed in the background after ingest. Per-batch progress events surface as `embedding N/M…` hints in the document list. A boot health probe banners if Lemonade is unreachable or the embedding model is missing.
- **F3 + F4 — Retrieval.** Top-6 cosine retrieval over a Float32 BLOB store. Question embedding hits the same `Qwen3-Embedding-0.6B-GGUF` model as the corpus.
- **F5 — RAG chat.** Streaming Spanish chat over `Qwen3-4B-Instruct-2507-GGUF` with a hardened anti-drift system prompt and FIFO history dropping when the SPEC §F5 32K context budget is exceeded. Each assistant turn shows which fragments and how many docs it consulted.

What does *not* work yet, in v0.1 scope: voice I/O (Whisper STT + Kokoro TTS), the educational side panel that exposes the pipeline step-by-step, the exportable runnable-starter feature, and the settings UI. See SPEC.md §F6–F9.

## Stack

- Tauri 2 + React 19 + TypeScript + Vite
- [Lemonade SDK](https://github.com/lemonade-sdk/lemonade) as the local LLM backend (OpenAI-compatible)
- Targets AMD Ryzen + Radeon hardware first; works on NVIDIA / Intel via Vulkan
- Default chat model: `Qwen3-4B-Instruct-2507-GGUF` (Q4_K_M, ~2.5 GB). The 14B variant is documented as an opt-in upgrade once Lemonade fixes its reasoning-template propagation — see [`docs/decisions/v0.1-model-selection.md`](./docs/decisions/v0.1-model-selection.md).

## Documentation

- **[SPEC.md](./SPEC.md)** — v0.1 technical specification (source of truth for behavior, scope, and acceptance)
- **[docs/decisions/](./docs/decisions/)** — locked design decisions with evidence

## Roadmap

This README will grow as the project takes shape. The companion video tutorial (Spanish, LATAM-targeted) is in production.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
