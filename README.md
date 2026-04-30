# Local Zero

> Build your first local AI app — from zero, on your own machine.

A Spanish-language tutorial companion that walks you through building a portfolio-grade RAG application running entirely on your own hardware. No API keys, no cloud, no recurring cost.

**Status:** pre-alpha. Repository scaffold + spec only — no functional code yet.

## Stack

- Tauri 2 + React 19 + TypeScript + Vite
- [Lemonade SDK](https://github.com/lemonade-sdk/lemonade) as the local LLM backend (OpenAI-compatible)
- Targets AMD Ryzen + Radeon hardware first; works on NVIDIA / Intel via Vulkan

## Documentation

- **[SPEC.md](./SPEC.md)** — v0.1 technical specification (source of truth for behavior, scope, and acceptance)
- **[docs/decisions/](./docs/decisions/)** — locked design decisions with evidence

## Roadmap

This README will grow as the project takes shape. The companion video tutorial (Spanish, LATAM-targeted) is in production.

## License

Apache 2.0 — see [LICENSE](./LICENSE).
