# mic-test

Drop-in replacement for `src/App.tsx` to validate the microphone permission + Whisper transcription round-trip.

This is the prototype for [OQ#5](../../docs/decisions/v0.1-open-questions.md#oq5) (Phase B), **deferred to F6 (Voice I/O) implementation**. The code is preserved here so it can be re-applied when F6 work begins, without re-deriving the approach.

## What it tests

1. WebView2 exposes `navigator.mediaDevices.getUserMedia` correctly.
2. Windows surfaces a microphone permission prompt (or honors the existing setting).
3. `MediaRecorder` captures `audio/webm` cleanly.
4. Lemonade `POST /v1/audio/transcriptions` accepts the multipart upload.
5. `Whisper-Large-v3-Turbo` returns a Spanish transcription that matches the speech.

## How to run (when ready)

Pre-requisites:
- Lemonade Server running on `http://localhost:13305`
- `Whisper-Large-v3-Turbo` pulled (or trust auto-pull on first request)
- Tauri build toolchain working (Rust + MSVC). On Windows 11, **Smart App Control may block Cargo build scripts** with `os error 4551`. Workarounds: turn off Smart App Control (irreversible), use a different machine, or build inside WSL2 with cross-compile to Windows.

Steps:

```bash
# from the repo root
cp prototypes/mic-test/src/App.tsx src/App.tsx
npm install        # if not already
npm run tauri dev  # first build is 5–10 min
```

Click the record button, allow the mic permission dialog, speak Spanish for 5–10 s, click stop. The transcription appears below.

When done, restore the original `src/App.tsx` from git (`git checkout src/App.tsx`).

## Why this is deferred

OQ#5 was blocked on the dev machine by Smart App Control (Windows 11 code integrity policy) preventing Cargo from running build scripts of unsigned binaries. The web-platform APIs in use here (`getUserMedia`, `MediaRecorder`, `fetch` multipart) are well-trodden and Tauri 2 imposes no extra restrictions on them. Risk of failure when the test eventually runs is estimated low (~10%). Validation will happen as a side effect of building F6 (Voice I/O) per [SPEC §8.6](../../SPEC.md).

## License

Apache 2.0 (inherits from the parent repository).
