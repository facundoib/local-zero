# embed-probe

F2 spike for Local Zero — validates the Lemonade `/v1/embeddings` contract
before the pipeline lands in `src-tauri/`.

## What it checks

1. `Qwen3-Embedding-0.6B-GGUF` is present in `/v1/models`.
2. Single-input request returns OpenAI-compatible shape: `data[].embedding` (Float32), `data[].index`.
3. A batch of 32 Spanish chunks returns 32 embeddings, all indices `0..31` accounted for, equal dim.
4. Spanish UTF-8 round-trips (no mojibake from the HTTP body).
5. Latency on a batch of 32 — projected to 100 chunks vs SPEC §11 budget (8 s).
6. Cosine sanity: a Spanish-similar pair scores higher than an unrelated pair.

## Run

Lemonade Server live on `http://localhost:13305`.

```powershell
cd prototypes\embed-probe
cargo run --release
```

Exit code 0 = all four probes passed. Output prints dim, latencies, and the
cosine numbers — capture them in the F2 walking-skeleton commit message.
