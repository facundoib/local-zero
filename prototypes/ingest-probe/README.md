# ingest-probe

Throwaway prototype to de-risk **F1 (Document ingestion)** for [Local Zero](../../) before wiring it into the Tauri app.

Validates two unknowns that could invalidate the F1 implementation plan:

1. **Does `rusqlite` with `bundled` build under Smart App Control?** The bundled feature compiles the SQLite C amalgamation via a `build.rs`, which is exactly the lineage SAC may block. If this fails (`os error 4551`), we switch to system-SQLite or pre-bake `target/` in CI.
2. **Does `pdf-extract` preserve Spanish characters?** The crate is locked in [OQ#4](../../docs/decisions/v0.1-open-questions.md#oq4) with `pdfium-render` as a documented fallback. We trip the fallback with the first real Spanish PDF, not at day 4 of implementation.

## How to run

```powershell
cd local-zero\prototypes\ingest-probe
cargo build --release

# SQLite-only check (no PDF arg)
Start-Process .\target\release\ingest-probe.exe -NoNewWindow -Wait

# Full check — point at any Spanish-language PDF (e.g. your CV)
Start-Process .\target\release\ingest-probe.exe `
    -ArgumentList "C:\path\to\spanish.pdf" -NoNewWindow -Wait
```

Use `Start-Process` from a user shell so SAC sees the user as the parent process — `cargo run` would put cargo in that role and trip 4551.

## Pass criteria

- `cargo build --release` finishes (no 4551).
- `[✓] SQLite probe passed` in stdout.
- `[✓] Spanish characters preserved: ñáé...` for the PDF probe (no `Ã±`/`Ã¡` mojibake signals).

If any of those fail, the SPEC's F1 implementation plan needs revision before code lands in `src-tauri`.

## CI

The local build is blocked by Smart App Control on the maintainer's machine (see [docs/decisions/v0.1-f1-spike.md](../../docs/decisions/v0.1-f1-spike.md) for the deterministic 4551 reproduction). Validation runs in [`.github/workflows/ingest-probe.yml`](../../.github/workflows/ingest-probe.yml) on `ubuntu-latest`, which has no SAC. The workflow generates a Spanish PDF inline with `fpdf2` and fails if the binary reports mojibake or no Spanish characters found.

## License

Apache 2.0 (inherits from the parent repository).
