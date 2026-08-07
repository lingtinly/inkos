#!/usr/bin/env node

// Stable entrypoint used by the InkOS launcher.
// v5 fixes the app-server sandbox enum on Windows, keeps persistent streaming,
// adds a Chinese Han-character length contract, and reports Han counts in
// /diagnostics while retaining codex exec as a safe fallback.
import "./codex-openai-bridge-v5.mjs";
