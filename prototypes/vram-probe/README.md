# vram-probe

Throwaway prototype to validate the **DXGI-based VRAM detection** approach for [Local Zero](../../) on Windows.

This is the experimental code for [OQ#3](../../docs/decisions/v0.1-open-questions.md#oq3) (Phase B). Once validated, the same DXGI calls migrate into the Tauri app's `src-tauri` module.

## What it does

1. Enumerates every DXGI adapter on the host.
2. Prints vendor, device ID, total VRAM, shared system RAM, current memory budget, and free VRAM (approx).
3. Prints which Qwen3 model tier Local Zero would auto-select for each adapter.

## How to run

Requires Rust ≥ 1.78 (`rustc --version` to check) and Microsoft C++ Build Tools.

```powershell
cd local-zero\prototypes\vram-probe
cargo run --release
```

First build pulls the `windows` crate (~30-60 s on a fresh machine). Subsequent runs are instant.

## Expected output (RTX 5060 Ti 16 GB example)

```
Adapter 0 — NVIDIA GeForce RTX 5060 Ti
  Vendor:    NVIDIA (0x10DE)
  Device ID: 0xXXXX
  Software:  false
  Dedicated VRAM (total):  16375 MB  (16.0 GiB)
  Shared system RAM:       16375 MB
  Budget (this process):   15800 MB
  Currently in use:          250 MB
  Free (approx):           15550 MB  (15.2 GiB)

  Local Zero verdict:
    → default to Qwen3-14B-Instruct-GGUF (Q4_K_M, ~9 GB) — comfortable
```

## Why DXGI

- Cross-vendor on Windows (NVIDIA, AMD, Intel — same API).
- Reports both **total** dedicated VRAM (`DedicatedVideoMemory`) and **free** budget (`QueryVideoMemoryInfo`).
- Native Windows API, no extra binaries to ship.
- Documented and stable since Windows 10 1709.

Alternatives considered (and rejected): NVML (NVIDIA only), ADL (AMD only), wgpu (no VRAM info exposed), nvidia-smi (subprocess fragility).

## License

Apache 2.0 (inherits from the parent repository).
